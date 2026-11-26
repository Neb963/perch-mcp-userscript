import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import vm from "node:vm";
import { JSDOM } from "jsdom";

test("bundled Violentmonkey content script reads real Firefox page identity without unisolating credentials", async () => {
  const bundled = await build({
    entryPoints: ["apps/userscript/src/main.ts"],
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    target: "firefox128",
    define: { __COMPUTE_WORKER_SOURCE__: JSON.stringify("/* no compute invoked */") },
  });
  const dom = new JSDOM("<!doctype html><body></body>", {
    url: "https://perchance.org/aleph-alpha#edit",
  });
  let capturedShadow: ShadowRoot | undefined;
  // jsdom cannot construct a real trusted MouseEvent. Capture the native
  // manager listener and invoke it as the browser would after trusted input.
  // Do not weaken the production event.isTrusted security gate.
  const buttonListeners = new WeakMap<HTMLButtonElement, EventListenerOrEventListenerObject>();
  const originalAddListener = dom.window.EventTarget.prototype.addEventListener;
  dom.window.EventTarget.prototype.addEventListener = function (type, callback, options) {
    if (type === "click" && this instanceof dom.window.HTMLButtonElement && callback)
      buttonListeners.set(this, callback);
    return originalAddListener.call(this, type, callback, options);
  };
  const nativeAttach = dom.window.Element.prototype.attachShadow;
  dom.window.Element.prototype.attachShadow = function (options: ShadowRootInit) {
    const shadow = nativeAttach.call(this, options);
    capturedShadow = shadow;
    return shadow;
  };
  const page = {
    app: { data: { generator: { id: 142, name: "aleph-alpha" } } },
    srcState: {
      getDraftId: () => "",
      ready: async () => {},
      list: () => ({}),
      readFile: () => new Uint8Array(0),
    },
    modelTextEditor: { getValue: () => "output = 'hello'", state: { readOnly: false } },
    outputTemplateEditor: { getValue: () => "<div>hello</div>", state: { readOnly: false } },
    currentInterfaceMode: "edit",
    __editorReady: true,
    __draftChoiceSettled: true,
    aiAgentActivityState: () => ({ active: false, unknown: false, reason: "" }),
    __aiGeneratorGuard: { blocked: () => false },
  };
  // Content-context unsafeWindow cannot see page globals directly.
  const unsafeWindow = { wrappedJSObject: page };
  const values = new Map<string, unknown>();
  let menu: (() => void) | undefined;
  const context = vm.createContext({
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    unsafeWindow,
    GM_info: { injectInto: "content", version: "synthetic", scriptHandler: "Violentmonkey" },
    GM_getValue: (key: string) => values.get(key),
    GM_setValue: (key: string, value: unknown) => values.set(key, value),
    GM_deleteValue: (key: string) => values.delete(key),
    GM_listValues: () => [...values.keys()],
    GM_registerMenuCommand: (_label: string, callback: () => void) => { menu = callback; },
    GM_setClipboard: () => {},
    crypto, fetch: async () => { throw new Error("No remote fetch in read-only probe test"); },
    TextEncoder, TextDecoder, Blob, URL, AbortSignal, AbortController, console,
    setTimeout, clearTimeout, setInterval, clearInterval, structuredClone, atob, btoa,
  });
  try {
    vm.runInContext(bundled.outputFiles[0]!.text, context);
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));
    for (let i = 0; i < 40 && !menu; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(menu, "menu is registered in isolated VM realm");
    menu();
    for (let i = 0; i < 40 && !capturedShadow?.textContent?.includes("Read-only editor probe"); i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(capturedShadow, "manager uses isolated shadow root");
    const buttons = [...capturedShadow!.querySelectorAll("button")];
    const probe = buttons.find((element) => element.textContent?.includes("Read-only editor probe"));
    assert.ok(probe, "manager exposes a read-only capability probe");
    const trustedListener = buttonListeners.get(probe);
    assert.equal(typeof trustedListener, "function");
    (trustedListener as EventListener).call(probe, { isTrusted: true } as MouseEvent);
    for (let i = 0; i < 40 && !capturedShadow!.textContent?.includes('"generatorId": "142"'); i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    const output = capturedShadow!.textContent || "";
    assert.match(output, /generatorId/);
    assert.match(output, /142/);
    assert.match(output, /aleph-alpha/);
    assert.equal(values.has("perch:pairing"), false, "read-only inspection does not persist pairing credentials");
    assert.ok([...values.keys()].every((key) => !/credential|secret|token/i.test(key)), "no secret storage is created by the probe");
    assert.equal((unsafeWindow as Record<string, unknown>).GM_getValue, undefined, "GM APIs are not exported to page");
  } finally {
    dom.window.close();
  }
});
