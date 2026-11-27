import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

test("bundled bootstrap stops automatic retries on classified Registry corruption", { timeout: 16000 }, async () => {
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
  let claims = 0, polls = 0, releases = 0, healthCalls = 0, errors: string[] = [];
  const automaticRetryDelays: number[] = [];
  let capturedShadow: ShadowRoot | undefined;
  const nativeAttach = dom.window.Element.prototype.attachShadow;
  dom.window.Element.prototype.attachShadow = function (options: ShadowRootInit) {
    const result = nativeAttach.call(this, options);
    capturedShadow = result;
    return result;
  };
  let source = "output = 'hello'";
  const page = {
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
    if (path === "/health") {
      healthCalls++;
      return Response.json({ok:false,dependency:"registry",code:"GATEWAY_DEGRADED",retryable:false,
        reason:"REGISTRY_STORAGE_CORRUPT",privateMessage:"DO-NOT-LEAK-PRIVATE-REASON"},{status:503});
    }
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
        expiresAt: Date.now() + 180000, permissions: ["READ_SOURCE"],
      });
    }
    if (path === "/api/v1/tab/poll") {
      polls++;
      // Actual Worker may wait 25 seconds. Here we verify a real Controller
      // starts its recurring poll without attempting another Workspace claim.
      await new Promise((resolve) => setTimeout(resolve, 25));
      return respond({ operations: [], expiresAt: Date.now() + 180000 });
    }
    if (path === "/api/v1/tab/release") {
      releases++;
      return respond({ ok: true });
    }
    throw new Error("Unexpected synthetic gateway path " + path);
  }) as typeof fetch;
  const context = vm.createContext({
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
    setTimeout: (fn: () => void, ms: number) => {
      if(ms>=2000)automaticRetryDelays.push(ms);
      return setTimeout(fn,ms);
    }, clearTimeout, setInterval, clearInterval, structuredClone, atob, btoa,
  });
  try {
    vm.runInContext(bundled.outputFiles[0]!.text, context);
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));
    const deadline=Date.now()+9000;
    while(Date.now()<deadline&&(!healthCalls||!capturedShadow?.textContent?.includes("needs repair")))
      await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(healthCalls,1);
    assert.match(capturedShadow?.textContent??"",/blocked/);
    assert.match(capturedShadow?.textContent??"",/Automatic connection retries stopped/);
    assert.equal(claims,0);assert.equal(polls,0);
    assert.deepEqual(automaticRetryDelays,[],"permanent readiness failure schedules no automatic retry timer");
    dom.window.dispatchEvent(new dom.window.Event("online"));
    dom.window.dispatchEvent(new dom.window.Event("visibilitychange"));
    await new Promise(resolve=>setTimeout(resolve,50));
    assert.equal(healthCalls,1,"network/visibility events do not reopen a permanent failure loop");
    assert.equal(source,"output = 'hello'");
    assert.doesNotMatch(capturedShadow?.textContent??"",/DO-NOT-LEAK/);
    assert.equal((unsafeWindow as Record<string,unknown>).GM_getValue,undefined);
    assert.deepEqual(errors,[]);
    dom.window.dispatchEvent(new dom.window.Event("pagehide"));
    await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(releases,0,"no lease was acquired or falsely released");
  } finally {
    dom.window.close();
  }
});
