import { test } from "node:test";
import assert from "node:assert/strict";
import { createCapacityHarness } from "./gateway-capacity-harness.js";
import { uploadImageResult } from "../../apps/userscript/src/image-transfer.js";
import { projectMcpImages } from "../../apps/gateway/src/mcp-media.js";

test("actual local SQLite gateway transfers >512 KiB image through bounded lease requests and enforces read scope", async () => {
  const h = await createCapacityHarness(2);
  try {
    const f = h.fixtures[0]!, other = h.fixtures[1]!;
    const admitted = await h.admit(f, "read_image", { path: "images/fixture.png" }), operationId = String(admitted.operationId);
    await h.browser(f, "poll", { waitMs: 0 });
    await h.browser(f, "reply", { operationId, phase: "RUNNING" });
    // A transport signature fixture. This does not assert browser decoder, provider, or visible-pixel behavior.
    const bytes = Buffer.alloc(768 * 1024, 43);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
    const original = { path: "images/fixture.png", mimeType: "image/png", content: [{ type: "image", mimeType: "image/png", data: bytes.toString("base64") }] };
    let requests = 0;
    const uploaded = await uploadImageResult(original, {
      operation: { operationId, workspaceId: f.workspaceId, epoch: Number(f.lease.epoch), bindingRevision: Number(f.lease.bindingRevision), tabInstanceId: String(f.lease.tabInstanceId) },
      send: async (body) => {
        requests++;
        assert.ok(JSON.stringify(body).length < 512 * 1024);
        return h.browser(f, "image", body);
      },
    });
    assert.equal(requests, 6);
    assert.ok(JSON.stringify(uploaded).length < 1024);
    await h.browser(f, "reply", { operationId, phase: "SUCCEEDED", result: { operationId, status: "SUCCEEDED", effectState: "VERIFIED", data: uploaded } });
    const stub = h.wns.get(h.wns.idFromName(f.workspaceId));
    const status = await h.internal(stub, "/internal/status", { workspaceId: f.workspaceId, operationId, bindingRevision: f.lease.bindingRevision, agentId: f.agentId });
    const projected = projectMcpImages(status);
    assert.deepEqual(projected.images, original.content);
    assert.ok(JSON.stringify(projected.data).length < 2048);
    await assert.rejects(() => h.internal(stub, "/internal/status", { workspaceId: f.workspaceId, operationId, bindingRevision: Number(f.lease.bindingRevision) + 1, agentId: f.agentId }));
    await assert.rejects(() => h.internal(stub, "/internal/status", { workspaceId: f.workspaceId, operationId, bindingRevision: f.lease.bindingRevision, agentId: other.agentId }));
    await assert.rejects(() => h.browser(other, "image", { operationId, action: "commit", index: 0, bindingRevision: other.lease.bindingRevision }));
    await assert.rejects(() => h.browser(f, "image", { operationId, action: "commit", index: 0, bindingRevision: f.lease.bindingRevision }));
    assert.equal((await h.status(f, operationId)).status, "SUCCEEDED");
  } finally { await h.close(); }
});

test("actual gateway revalidates Workspace policy before accepting the next image chunk", async () => {
  const h = await createCapacityHarness(1);
  try {
    const f = h.fixtures[0]!, admitted = await h.admit(f, "read_image", { path: "images/fixture.png" });
    const operationId = String(admitted.operationId);
    await h.browser(f, "poll", { waitMs: 0 });
    await h.browser(f, "reply", { operationId, phase: "RUNNING" });
    const body = { operationId, bindingRevision: f.lease.bindingRevision, index: 0 };
    await h.browser(f, "image", { ...body, action: "start", byteLength: 8, sha256: "a".repeat(64), mimeType: "image/png" });
    const list = await h.get("/api/v1/admin/workspaces"), workspace = (list.items as Record<string, unknown>[])[0]!;
    await h.update("/api/v1/admin/workspaces/" + f.workspaceId, { expectedRevision: workspace.revision, permissions: ["READ_RESOURCES"] });
    await assert.rejects(() => h.browser(f, "image", { ...body, action: "chunk", offset: 0, data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64") }));
    const status = await h.status(f, operationId);
    assert.equal(status.operationId, operationId);
    assert.equal(status.status, "RUNNING");
    const poll = await h.browser(f, "poll", { waitMs: 0 });
    assert.deepEqual(poll.operations, []);
  } finally { await h.close(); }
});
