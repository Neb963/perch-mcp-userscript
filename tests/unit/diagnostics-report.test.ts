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
