import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

test("actual bundled userscript opts into isolated notifications and stops healthy idle polling", { timeout: 16000 }, async () => {
  const bundled = await build({
    entryPoints: ["apps/userscript/src/main.ts"],
    bundle: true, write: false, platform: "browser", format: "iife",
    target: "firefox128",
    define: { __COMPUTE_WORKER_SOURCE__: JSON.stringify("/* compute not invoked */") },
  });
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://perchance.org/aleph-alpha#edit",
  });
  const values = new Map<string, unknown>([
    ["perch:pairing", {
      schemaVersion: 1, origin: "https://gateway.example.workers.dev",
      browserInstallationId: "browser-fixture",
      adminCredential: "DO-NOT-LEAK-ADMIN",
      executionCredential: "DO-NOT-LEAK-EXEC",
    }],
    ["perch:installation-id", "browser-fixture"],
  ]);
  let claims = 0, polls = 0, releases = 0, tickets = 0, errors: string[] = [];
  const offered: {url: string; protocols: string[]}[] = [];
  const sockets: FakeSocket[] = [];
  let heartbeat: (() => void) | undefined, heartbeatCadence = 0;
  let capturedShadow: ShadowRoot | undefined;
  const nativeAttach = dom.window.Element.prototype.attachShadow;
  dom.window.Element.prototype.attachShadow = function (options: ShadowRootInit) {
    const result = nativeAttach.call(this, options);
    capturedShadow = result;
    return result;
  };
  let source = "output = 'hello'";
  const page = {
    WebSocket: () => { throw new Error("Untrusted page socket factory must never run."); },
    app: { data: { generator: { id: 142, name: "aleph-alpha" } } },
    srcState: {
      getDraftId: () => "", ready: async () => {},
      idle: async () => {}, list: () => ({}),
      readFile: async () => new Uint8Array(0),
    },
    modelTextEditor: { getValue: () => source, state: { readOnly: false } },
    outputTemplateEditor: { getValue: () => "<div>hello</div>", state: { readOnly: false } },
    currentInterfaceMode: "edit", __editorReady: true, __draftChoiceSettled: true,
    aiAgentActivityState: () => ({ active: false, unknown: false, reason: "" }),
    __aiGeneratorGuard: { blocked: () => false },
  };
  const unsafeWindow = { wrappedJSObject: page };
  const mockedFetch: typeof fetch = (async (url, init) => {
    const path = new URL(String(url)).pathname;
    const respond = (value: unknown) => Response.json(value);
    if (path === "/health") return respond({ version: "0.1.4", schemaVersion: 1, paired: true });
    if (path === "/api/v1/admin/workspaces")
      return respond({
        items: [{
          id: "workspace-fixture", label: "aleph-alpha",
          revision: 1, paused: false,
          binding: { generatorId: "142", slug: "aleph-alpha", draftId: "", browserInstallationId: "browser-fixture" },
        }],
        revision: 1, cursor: null,
      });
    if (path === "/api/v1/tab/claim") {
      claims++;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal((body.binding as Record<string, unknown>).generatorId, "142");
      return respond({
        workspaceId: "workspace-fixture", epoch: 1, bindingRevision: 1,
        tabInstanceId: body.tabInstanceId, leaseCredential: "synthetic-lease",
        expiresAt: Date.now() + 180000, permissions: ["READ_SOURCE"], notifications: {version:1},
      });
    }
    if (path === "/api/v1/tab/ticket") {
      tickets++;
      return respond({version:1,protocol:"perch-notify-v1",ticket:"t".repeat(43),expiresAt:Date.now()+30000});
    }
    if (path === "/api/v1/tab/heartbeat")
      return respond({expiresAt:Date.now()+180000,permissions:["READ_SOURCE"],workAvailable:true});
    if (path === "/api/v1/tab/poll") {
      polls++;
      // The real bundled controller remains asynchronous; the notification
      // channel carries no operations and only wakes this HTTP fetch.
      await new Promise((resolve) => setTimeout(resolve, 25));
      return respond({ operations: [], expiresAt: Date.now() + 180000 });
    }
    if (path === "/api/v1/tab/release") {
      releases++;
      return respond({ ok: true });
    }
    throw new Error("Unexpected synthetic gateway path " + path);
  }) as typeof fetch;
  class FakeSocket {
    readyState = 1;
    protocol = "perch-notify-v1";
    onopen: ((event: unknown) => void) | null = null;
    onmessage: ((event: {data: string}) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    onclose: ((event: unknown) => void) | null = null;
    constructor(url: string, protocols: string[]) {
      offered.push({url,protocols}); sockets.push(this);
      queueMicrotask(()=>{this.onopen?.({});this.onmessage?.({data:'{"version":1,"type":"ready"}'});});
    }
    close(): void {this.readyState=3;}
    available(): void {this.onmessage?.({data:'{"version":1,"type":"available"}'});}
  }
  const context = vm.createContext({
    WebSocket: FakeSocket,
    window: dom.window, document: dom.window.document, location: dom.window.location,
    unsafeWindow,
    GM_info: { injectInto: "content", version: "0.1.5", scriptHandler: "Violentmonkey" },
    GM_getValue: (key: string) => values.get(key),
    GM_setValue: (key: string, value: unknown) => values.set(key, value),
    GM_deleteValue: (key: string) => values.delete(key),
    GM_listValues: () => [...values.keys()],
    GM_registerMenuCommand: () => {},
    GM_setClipboard: () => {},
    crypto, fetch: mockedFetch, Response, Headers, Request,
    TextEncoder, TextDecoder, Blob, URL, AbortSignal, AbortController, console: {
      ...console, warn: (message: unknown) => { errors.push(String(message)); },
    },
    setTimeout, clearTimeout,
    setInterval: (fn: () => void, ms: number) => {
      if(ms===60000){heartbeat=fn;heartbeatCadence=ms;}
      return setInterval(fn,ms);
    }, clearInterval, structuredClone, atob, btoa,
  });
  try {
    vm.runInContext(bundled.outputFiles[0]!.text, context);
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));
    const deadline = Date.now() + 9000;
    while (Date.now() < deadline && (!claims || !polls ||
      !capturedShadow?.textContent?.includes("connected")))
      await new Promise((r) => setTimeout(r, 25));
    assert.equal(claims, 1, "exact-bound editor auto-claims only once");
    assert.equal(polls, 1, "initial authoritative fetch follows ready");
    await new Promise(resolve=>setTimeout(resolve,250));
    assert.equal(polls,1,"healthy notification idle has no recurring work fetch");
    assert.equal(tickets,1);assert.equal(offered.length,1);
    assert.match(offered[0]!.url,/^wss:\/\/gateway\.example\.workers\.dev\/api\/v1\/tab\/socket\?workspaceId=workspace-fixture$/);
    assert.ok(!offered[0]!.url.includes("t".repeat(43)));
    assert.deepEqual(Array.from(offered[0]!.protocols),["perch-notify-v1","ticket."+"t".repeat(43)]);
    sockets[0]!.available();sockets[0]!.available();
    const signaledDeadline=Date.now()+1000;
    while(polls<2&&Date.now()<signaledDeadline)await new Promise(resolve=>setTimeout(resolve,5));
    await new Promise(resolve=>setTimeout(resolve,50));
    assert.equal(polls,2,"notification bursts coalesce in the bundled controller");
    assert.equal(heartbeatCadence,60000,"silent-loss reconciliation uses the existing sixty-second heartbeat");
    assert.ok(heartbeat);heartbeat();
    const heartbeatDeadline=Date.now()+1000;
    while(polls<3&&Date.now()<heartbeatDeadline)await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(polls,3,"an authoritative heartbeat recovers a missing socket signal");
    assert.ok(!capturedShadow?.textContent?.includes("t".repeat(43)));
    assert.match(capturedShadow?.textContent ?? "", /connected/);
    assert.equal(source, "output = 'hello'", "auto-reconnect must not modify native source");
    assert.deepEqual(
      values.get("perch:pairing"),
      {
        schemaVersion: 1, origin: "https://gateway.example.workers.dev",
        browserInstallationId: "browser-fixture",
        adminCredential: "DO-NOT-LEAK-ADMIN",
        executionCredential: "DO-NOT-LEAK-EXEC",
      },
    );
    assert.doesNotMatch(capturedShadow?.textContent ?? "", /DO-NOT-LEAK/);
    assert.equal((unsafeWindow as Record<string, unknown>).GM_getValue, undefined);
    assert.deepEqual(errors, []);
    dom.window.dispatchEvent(new dom.window.Event("pagehide"));
    const end = Date.now() + 1000;
    while (!releases && Date.now() < end)
      await new Promise((r) => setTimeout(r, 25));
    assert.equal(releases, 1, "document closing releases its exact lease");
  } finally {
    dom.window.close();
  }
});
