import test from "node:test";
import assert from "node:assert/strict";
import { DocumentDraftStore } from "../../apps/userscript/src/resource-drafts.js";
import { MemoryStore } from "../../apps/userscript/src/storage.js";
test("simultaneous documents preserve independent unpublished drafts and delete only their own", async () => {
  const store = new MemoryStore(),
    a = new DocumentDraftStore(store, "doc-a"),
    b = new DocumentDraftStore(store, "doc-b");
  await Promise.all([
    a.set("resource:skill", "first operator edit"),
    b.set("resource:skill", "second operator edit"),
  ]);
  assert.equal(await a.get("resource:skill"), "first operator edit");
  assert.equal(await b.get("resource:skill"), "second operator edit");
  assert.equal((await a.export()).drafts.length, 2);
  await a.delete("resource:skill");
  assert.equal(await b.get("resource:skill"), "second operator edit");
  assert.equal((await b.export()).drafts.length, 1);
});
test("reload can recover retained draft without granting publication or exporting credentials", async () => {
  const store = new MemoryStore();
  await store.set("perch:pairing", { adminCredential: "never-export-this" });
  await new DocumentDraftStore(store, "old-doc").set(
    "resource:skill",
    "retained original text",
  );
  const next = new DocumentDraftStore(store, "new-doc");
  assert.equal(await next.get("resource:skill"), "retained original text");
  const exported = await next.export();
  assert.equal(exported.requiresExplicitPublish, true);
  assert.ok(!JSON.stringify(exported).includes("never-export-this"));
});
