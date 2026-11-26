import test from "node:test";
import assert from "node:assert/strict";
import { buildDiagnosticReport, type ManagerClient } from "../../apps/userscript/src/manager.js";

function fixture(request: ManagerClient["request"]): ManagerClient {
  return {
    request,
    health: async () => ({
      version: "0.1.3", paired: true, configured: true,
      schemaVersion: 1, providerWritesEnabled: false,
      secretCredential: "LEAK-ME-health",
    }),
    configuration: () => ({
      origin: "https://perch-mcp.workers.dev",
      paired: true,
    }),
    diagnostics: () => ({
      events: [
        {
          at: 1795700000000,
          route: "/api/v1/admin/approvals/deadbeef-1234-1234-1234-abcdefabcdef/decision?token=LEAK-ME",
          method: "POST", code: "GATEWAY_UNAVAILABLE", status: 0, elapsedMs: 431,
          secret: "LEAK-ME-transport",
        },
      ],
      adminCredential: "LEAK-ME-credential",
    }),
    pair: async () => {},
    currentIdentity: async () => ({ generatorId: "123", draftId: "", slug: "private-editor" }),
    copy: async () => {},
    download: () => {},
  };
}
test("diagnostic export contains OAuth trace and transport failure but no credentials, handles, bodies or source", async () => {
  const client = fixture(async (method, path) => {
    assert.equal(method, "GET");
    if (path.endsWith("/state")) return {
      revision: 3, policyRevision: 4, paused: false, workspaces: 1, agents: 1,
      version: "0.1.3", adminSecret: "LEAK-ME-state",
    };
    if (path.endsWith("/diagnostics")) return {
      events: [
        {
          at: 1795700000000, route: "authorize_complete", method: "POST",
          originClass: "null", code: "COMPLETE", status: 302,
          traceId: "a4eef3e9-ce3f-40be-961f-5c2d47d50250",
          handle: "LEAK-ME-handle", oauthToken: "LEAK-ME-oauth",
        },
      ],
      secret: "LEAK-ME-gateway",
    };
    throw new Error("Unexpected route");
  });
  const result = await buildDiagnosticReport(client, "0.1.3", { connection: "connected" });
  const text = JSON.stringify(result);
  assert.ok(text.length > 500, "export must contain useful evidence, unlike 39-byte empty operation log");
  assert.match(text, /authorize_complete/);
  assert.match(text, /GATEWAY_UNAVAILABLE/);
  assert.match(text, /a4eef3e9-ce3f-40be-961f-5c2d47d50250/);
  assert.doesNotMatch(text, /LEAK-ME|deadbeef|private-editor|\/decision\?token=/);
  assert.equal((result.oauthHandoff as Record<string, unknown>).tokenExchangeObservedAfterLastRedirect, false);
});
test("offline diagnostic export stays useful and projects only stable failure codes", async () => {
  const client = fixture(async () => {
    const error = new Error("LEAK-ME exception message");
    Object.assign(error, { code: "GATEWAY_UNAVAILABLE", status: 0 });
    throw error;
  });
  client.health = async () => { throw Object.assign(new Error("LEAK-ME health"), {code:"GATEWAY_TIMEOUT"}); };
  const result = await buildDiagnosticReport(client, "0.1.3");
  const serialized = JSON.stringify(result);
  assert.match(serialized, /GATEWAY_TIMEOUT/);
  assert.match(serialized, /GATEWAY_UNAVAILABLE/);
  assert.doesNotMatch(serialized, /LEAK-ME/);
});

test('preview diagnostics export exact failure codes and timing but never user JavaScript, console or private identifiers',async()=>{
 const client=fixture(async(method,path)=>{
  if(path.endsWith('/state'))return {version:'0.1.4',revision:1,policyRevision:1};
  return {events:[]};
 });
 const previous=client.diagnostics!;
 client.diagnostics=()=>({
  ...previous(),
  preview:{previewEvents:[
    {at:1795715000000,tool:'page_eval',durationMs:4100,outcome:'error',code:'UNSUPPORTED_INTERFACE',
     js:'LEAK-ME-js-body',privateConsole:'LEAK-ME-console'},
    {at:1795715001000,tool:'page_refresh',durationMs:320,outcome:'ok',code:'OK',
     source:'LEAK-ME-generator-source'},
    {at:1795715002000,tool:'exfiltrate_credentials',durationMs:12,outcome:'error',
     code:'LEAK-ME_UNSAFE',secret:'LEAK-ME-header'}
  ]},
 });
 const result=await buildDiagnosticReport(client,'0.1.6',{connection:'connected'});
 const serialized=JSON.stringify(result);
 assert.match(serialized,/page_eval/);
 assert.match(serialized,/UNSUPPORTED_INTERFACE/);
 assert.match(serialized,/page_refresh/);
 assert.doesNotMatch(serialized,/LEAK-ME|exfiltrate_credentials/);
 const events=(result.preview as {events:{tool:string;code:string}[]}).events;
 assert.equal(events.length,3);
 assert.equal(events[2]?.tool,'other');
 assert.equal(events[2]?.code,'UNKNOWN');
});
