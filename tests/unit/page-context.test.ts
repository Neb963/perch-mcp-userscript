import test from "node:test";
import assert from "node:assert/strict";
import { resolveNativePageRealm } from "../../apps/userscript/src/page-context.js";

test("Violentmonkey Firefox content mode resolves real page instead of isolated unsafeWindow", () => {
  const page = {
    app: { data: { generator: { id: 123, name: "fixture" } } },
    srcState: { getDraftId: () => "" },
  };
  const contentGlobal = { wrappedJSObject: page };
  assert.equal(resolveNativePageRealm(contentGlobal, contentGlobal), page);
  assert.equal(
    typeof (resolveNativePageRealm(contentGlobal, contentGlobal) as typeof page)
      .srcState.getDraftId,
    "function",
  );
});

test("Firefox wrapper on window is used when unsafeWindow has no page reference", () => {
  const page = { app: { data: { generator: { id: 123 } } } };
  assert.equal(
    resolveNativePageRealm({ wrappedJSObject: page }, {}),
    page,
  );
});

test("unavailable page wrapper falls back without synthesizing identity", () => {
  const contentGlobal = { GM_getValue: () => "secret" };
  assert.equal(resolveNativePageRealm(contentGlobal, contentGlobal), contentGlobal);
  assert.equal(resolveNativePageRealm(contentGlobal, undefined), contentGlobal);
});
