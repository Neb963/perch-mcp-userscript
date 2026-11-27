import { test } from "node:test";
import assert from "node:assert/strict";
import { ImageTransferHandler, IMAGE_MAX_BYTES, IMAGE_CHUNK_BYTES, IMAGE_TTL_MS, type ImageLease, type ImageOperation } from "../../apps/gateway/src/image-transfer.js";
import { uploadImageResult } from "../../apps/userscript/src/image-transfer.js";
import { projectMcpImages } from "../../apps/gateway/src/mcp-media.js";

class MemoryRecords {
  rows = new Map<string, unknown>();
  get<T>(key: string, fallback?: T): T { return structuredClone(this.rows.has(key) ? this.rows.get(key) : fallback) as T; }
  put(key: string, value: unknown): void { this.rows.set(key, structuredClone(value)); }
  delete(key: string): void { this.rows.delete(key); }
  keys(prefix: string): string[] { return [...this.rows.keys()].filter((key) => key.startsWith(prefix)).sort(); }
  transaction<T>(fn: () => T): T {
    const old = structuredClone(this.rows);
    try { return fn(); } catch (error) { this.rows = old; throw error; }
  }
}
function fixture() {
  let now = 1000, authorizations = 0;
  const db = new MemoryRecords();
  const lease: ImageLease = { workspaceId: "ws", epoch: 7, bindingRevision: 3, tabInstanceId: "tab", expiresAt: now + 3600000 };
  const op: ImageOperation = { ...lease, operationId: "operation", agentId: "agent", tool: "read_image", phase: "RUNNING", deadlineMs: now + 3600000 };
  const operations = new Map([[op.operationId, op]]);
  let authorize = async (_op: ImageOperation) => { authorizations++; };
  const handler = new ImageTransferHandler(db, { getLease: () => lease, getOperation: (id) => operations.get(id), authorize: (operation) => authorize(operation), now: () => now });
  const operation = { workspaceId: lease.workspaceId, epoch: lease.epoch, bindingRevision: lease.bindingRevision, tabInstanceId: lease.tabInstanceId, operationId: op.operationId };
  const scope = { operationId: op.operationId, workspaceId: lease.workspaceId, bindingRevision: lease.bindingRevision, agentId: op.agentId };
  const send = (body: Record<string, unknown>) => handler.handle(body, lease);
  return { db, lease, op, operations, handler, operation, scope, send, setTime: (value: number) => { now = value; }, setAuthorize: (value: typeof authorize) => { authorize = value; }, authorizations: () => authorizations };
}
// Signature plus deterministic padding verifies transport/integrity, not image decoding or visible pixels.
function image(size: number): { mimeType: string; content: { type: string; mimeType: string; data: string }[] } {
  const bytes = Buffer.alloc(size, 37);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  return { mimeType: "image/png", content: [{ type: "image", mimeType: "image/png", data: bytes.toString("base64") }] };
}
function summary(result: unknown) {
  return { operationId: "operation", tool: "read_image", status: "SUCCEEDED", data: { operationId: "operation", status: "SUCCEEDED", effectState: "VERIFIED", data: result } };
}
async function hash(bytes: Uint8Array): Promise<string> { return Buffer.from(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)).toString("hex"); }
function errorCode(code: string) { return (error: unknown) => (error as { code: string }).code === code; }

test("1 MiB image crosses bounded chunks, publishes only at commit, and yields a standard MCP image", async () => {
  const f = fixture(), original = image(IMAGE_MAX_BYTES), requests: Record<string, unknown>[] = [];
  const uploaded = await uploadImageResult(original, { operation: f.operation, send: async (body) => { requests.push(body); return f.send(body); } });
  assert.ok(JSON.stringify(uploaded).length < 1024);
  assert.equal(requests.length, 8);
  assert.ok(requests.every((body) => JSON.stringify(body).length < 512 * 1024));
  assert.equal(f.authorizations(), requests.length + 1); // Commit revalidates authority again after asynchronous hashing.
  f.op.phase = "SUCCEEDED";
  const hydrated = await f.handler.hydrate(summary(uploaded), f.scope);
  const projected = projectMcpImages(hydrated);
  assert.deepEqual(projected.images, original.content);
  assert.ok(!JSON.stringify(projected.data).includes(original.content[0]!.data));
});

test("staged bytes cannot be read, exact duplicate chunk and manifest retry are idempotent", async () => {
  const f = fixture(), bytes = Buffer.from(image(24).content[0]!.data, "base64"), sha256 = await hash(bytes);
  const start = { ...f.operation, action: "start", index: 0, byteLength: bytes.length, sha256, mimeType: "image/png" };
  const chunk = { ...f.operation, action: "chunk", index: 0, offset: 0, data: bytes.toString("base64") };
  await f.send(start);
  await f.send(chunk);
  assert.equal((await f.send(start) as { nextOffset: number }).nextOffset, bytes.length);
  assert.deepEqual(await f.send(chunk), await f.send(chunk));
  f.op.phase = "SUCCEEDED";
  await assert.rejects(() => f.handler.read({ operationId: f.op.operationId, index: 0, byteLength: bytes.length, sha256 }, "image/png", f.scope), errorCode("INVALID_INPUT"));
  f.op.phase = "RUNNING";
  await f.send({ ...f.operation, action: "commit", index: 0 });
  assert.equal((await f.send({ ...f.operation, action: "commit", index: 0 }) as { committed: boolean }).committed, true);
});

test("manifest replacement, overlapping changes, skipped ranges and invalid chunk lengths are rejected", async () => {
  const f = fixture(), size = IMAGE_CHUNK_BYTES + 9, bytes = Buffer.from(image(size).content[0]!.data, "base64");
  const start = { ...f.operation, action: "start", index: 0, byteLength: size, sha256: await hash(bytes), mimeType: "image/png" };
  await f.send(start);
  await assert.rejects(() => f.send({ ...start, sha256: "0".repeat(64) }), errorCode("CONFLICT"));
  await assert.rejects(() => f.send({ ...f.operation, action: "chunk", index: 0, offset: IMAGE_CHUNK_BYTES, data: bytes.subarray(IMAGE_CHUNK_BYTES).toString("base64") }), errorCode("CONFLICT"));
  await assert.rejects(() => f.send({ ...f.operation, action: "chunk", index: 0, offset: 0, data: bytes.subarray(0, 8).toString("base64") }), errorCode("INVALID_INPUT"));
  await f.send({ ...f.operation, action: "chunk", index: 0, offset: 0, data: bytes.subarray(0, IMAGE_CHUNK_BYTES).toString("base64") });
  await assert.rejects(() => f.send({ ...f.operation, action: "chunk", index: 0, offset: 0, data: Buffer.alloc(IMAGE_CHUNK_BYTES, 39).toString("base64") }), errorCode("CONFLICT"));
  await assert.rejects(() => f.send({ ...f.operation, action: "commit", index: 0 }), errorCode("CONFLICT"));
});

test("hash mismatch, MIME mismatch, unsupported types and noncanonical base64 cannot publish", async () => {
  for (const variant of ["hash", "mime"]) {
    const f = fixture(), bytes = Buffer.from(image(24).content[0]!.data, "base64");
    await f.send({ ...f.operation, action: "start", index: 0, byteLength: bytes.length, sha256: variant === "hash" ? "0".repeat(64) : await hash(bytes), mimeType: variant === "mime" ? "image/jpeg" : "image/png" });
    await f.send({ ...f.operation, action: "chunk", index: 0, offset: 0, data: bytes.toString("base64") });
    await assert.rejects(() => f.send({ ...f.operation, action: "commit", index: 0 }), errorCode("INVALID_INPUT"));
  }
  const f = fixture();
  await assert.rejects(() => f.send({ ...f.operation, action: "start", index: 0, byteLength: 1, sha256: "a".repeat(64), mimeType: "image/svg+xml" }), errorCode("INVALID_INPUT"));
  await f.send({ ...f.operation, action: "start", index: 0, byteLength: 1, sha256: "a".repeat(64), mimeType: "image/png" });
  await assert.rejects(() => f.send({ ...f.operation, action: "chunk", index: 0, offset: 0, data: "AB==" }), errorCode("INVALID_INPUT"));
});

test("Grant revocation and lease replacement at asynchronous authorization stop transfer", async () => {
  const f = fixture(), start = { ...f.operation, action: "start", index: 0, byteLength: 8, sha256: "a".repeat(64), mimeType: "image/png" };
  f.setAuthorize(async () => { throw Object.assign(new Error("revoked"), { code: "AUTH_REQUIRED" }); });
  await assert.rejects(() => f.send(start), errorCode("AUTH_REQUIRED"));
  assert.equal(f.db.rows.size, 0);
  f.setAuthorize(async () => { f.lease.epoch++; });
  await assert.rejects(() => f.send(start), errorCode("STALE_EPOCH"));
  assert.equal(f.db.rows.size, 0);
});

test("unknown tool, stale document, expired operation and terminal transfer cannot store bytes", async () => {
  for (const mutation of [(f: ReturnType<typeof fixture>) => { f.op.tool = "read"; }, (f: ReturnType<typeof fixture>) => { f.op.phase = "SUCCEEDED"; }, (f: ReturnType<typeof fixture>) => { f.op.deadlineMs = 999; }, (f: ReturnType<typeof fixture>) => { f.op.tabInstanceId = "other"; }]) {
    const f = fixture(); mutation(f);
    await assert.rejects(() => f.send({ ...f.operation, action: "start", index: 0, byteLength: 8, sha256: "a".repeat(64), mimeType: "image/png" }));
    assert.equal(f.db.rows.size, 0);
  }
});

test("current Agent/binding, reference hash, expiry and storage integrity govern reads", async () => {
  const f = fixture(), uploaded = await uploadImageResult(image(24), { operation: f.operation, send: f.send }) as { content: { imageTransfer: unknown }[] };
  f.op.phase = "SUCCEEDED";
  const ref = uploaded.content[0]!.imageTransfer;
  for (const scope of [{ ...f.scope, agentId: "other" }, { ...f.scope, bindingRevision: 4 }, { ...f.scope, workspaceId: "other" }])
    await assert.rejects(() => f.handler.read(ref, "image/png", scope), errorCode("NOT_FOUND"));
  await assert.rejects(() => f.handler.read({ ...(ref as object), sha256: "b".repeat(64) }, "image/png", f.scope), errorCode("INVALID_INPUT"));
  f.db.put("image/chunk/operation/0/0", Buffer.alloc(24, 0).toString("base64"));
  await assert.rejects(() => f.handler.read(ref, "image/png", f.scope), errorCode("INVALID_INPUT"));
  f.setTime(1000 + IMAGE_TTL_MS);
  await assert.rejects(() => f.handler.read(ref, "image/png", f.scope), errorCode("RESULT_EXPIRED"));
});

test("8 MiB reservation budget, four-block operation budget and TTL recovery are deterministic", async () => {
  const f = fixture();
  for (let index = 0; index < 8; index++) {
    const op = { ...f.op, operationId: "operation-" + index };
    f.operations.set(op.operationId, op);
    await f.send({ ...f.operation, operationId: op.operationId, action: "start", index: 0, byteLength: IMAGE_MAX_BYTES, sha256: "a".repeat(64), mimeType: "image/png" });
  }
  await assert.rejects(() => f.send({ ...f.operation, action: "start", index: 0, byteLength: 8, sha256: "a".repeat(64), mimeType: "image/png" }), errorCode("LIMIT_EXCEEDED"));
  f.setTime(1000 + IMAGE_TTL_MS);
  await f.send({ ...f.operation, action: "start", index: 0, byteLength: IMAGE_MAX_BYTES, sha256: "a".repeat(64), mimeType: "image/png" });
  assert.equal(f.db.keys("image/manifest/").length, 1);
  await assert.rejects(() => f.send({ ...f.operation, action: "start", index: 1, byteLength: 8, sha256: "a".repeat(64), mimeType: "image/png" }), errorCode("LIMIT_EXCEEDED"));
});

test("the existing Workspace alarm can schedule and physically remove all expired image rows", async () => {
  const f = fixture();
  assert.equal(f.handler.nextExpiry(), undefined);
  await uploadImageResult(image(IMAGE_CHUNK_BYTES + 8), { operation: f.operation, send: f.send });
  assert.equal(f.handler.nextExpiry(), 1000 + IMAGE_TTL_MS);
  assert.equal(f.db.keys("image/chunk/").length, 2);
  f.setTime(1000 + IMAGE_TTL_MS - 1);
  f.handler.expire();
  assert.equal(f.db.keys("image/chunk/").length, 2);
  f.setTime(1000 + IMAGE_TTL_MS);
  f.handler.expire();
  assert.equal(f.db.rows.size, 0);
  assert.equal(f.handler.nextExpiry(), undefined);
});

test("concurrent identical uploads converge on one manifest and complete chunk set", async () => {
  const f = fixture(), original = image(IMAGE_CHUNK_BYTES + 24);
  const [first, second] = await Promise.all([
    uploadImageResult(original, { operation: f.operation, send: f.send }),
    uploadImageResult(original, { operation: f.operation, send: f.send }),
  ]);
  assert.deepEqual(first, second);
  assert.equal(f.db.keys("image/manifest/").length, 1);
  assert.equal(f.db.keys("image/chunk/").length, 2);
  f.op.phase = "SUCCEEDED";
  assert.deepEqual(projectMcpImages(await f.handler.hydrate(summary(first), f.scope)).images, original.content);
});

test("manifest count and byte boundaries reject tiny-record floods and invalid reservations", async () => {
  const f = fixture();
  for (const byteLength of [0, -1, IMAGE_MAX_BYTES + 1, 0.5, NaN, Infinity])
    await assert.rejects(() => f.send({ ...f.operation, action: "start", index: 0, byteLength, sha256: "a".repeat(64), mimeType: "image/png" }), errorCode("INVALID_INPUT"));
  for (let index = 0; index < 64; index++) {
    const op = { ...f.op, operationId: "tiny-" + index };
    f.operations.set(op.operationId, op);
    await f.send({ ...f.operation, operationId: op.operationId, action: "start", index: 0, byteLength: 8, sha256: "a".repeat(64), mimeType: "image/png" });
  }
  await assert.rejects(() => f.send({ ...f.operation, action: "start", index: 0, byteLength: 8, sha256: "a".repeat(64), mimeType: "image/png" }), errorCode("LIMIT_EXCEEDED"));
  assert.equal(f.db.keys("image/manifest/").length, 64);
});

test("browser validates all images before uploading, validates progress, and stops without retry on failure", async () => {
  const f = fixture();
  let calls = 0;
  const send = async (_body: Record<string, unknown>) => { calls++; return {}; };
  await assert.rejects(() => uploadImageResult({ content: [...image(24).content, { type: "image", mimeType: "image/svg+xml", data: "YQ==" }] }, { operation: f.operation, send }));
  assert.equal(calls, 0);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(() => uploadImageResult(image(24), { operation: f.operation, send, signal: abort.signal }), errorCode("EFFECT_UNKNOWN"));
  assert.equal(calls, 0);
  await assert.rejects(() => uploadImageResult(image(24), { operation: f.operation, send }));
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(() => uploadImageResult(image(24), { operation: f.operation, send: async (body) => { calls++; if (body.action === "chunk") throw new Error("disconnected"); return f.send(body); } }));
  assert.equal(calls, 2);
});

test("image commit checks current authority after asynchronous hashing before publication", async () => {
  const f = fixture(), bytes = Buffer.from(image(24).content[0]!.data, "base64"), sha256 = await hash(bytes);
  await f.send({ ...f.operation, action: "start", index: 0, byteLength: bytes.length, sha256, mimeType: "image/png" });
  await f.send({ ...f.operation, action: "chunk", index: 0, offset: 0, data: bytes.toString("base64") });
  let checks = 0;
  f.setAuthorize(async () => { if (++checks === 2) throw Object.assign(new Error("revoked during digest"), { code: "AUTH_REQUIRED" }); });
  await assert.rejects(() => f.send({ ...f.operation, action: "commit", index: 0 }), errorCode("AUTH_REQUIRED"));
  assert.equal(checks, 2);
  assert.equal(f.db.get<{ state: string }>("image/manifest/operation/0").state, "STAGING");
});

test("image result cannot outlive its TTL during the post-hash authority check", async () => {
  const f = fixture(), uploaded = await uploadImageResult(image(24), { operation: f.operation, send: f.send }) as { content: { imageTransfer: unknown }[] };
  f.op.phase = "SUCCEEDED";
  f.setAuthorize(async () => { f.setTime(1000 + IMAGE_TTL_MS); });
  await assert.rejects(() => f.handler.read(uploaded.content[0]!.imageTransfer, "image/png", f.scope), errorCode("RESULT_EXPIRED"));
});

test("an unknown image payload format never falls back to readable legacy bytes", async () => {
  const f = fixture(), uploaded = await uploadImageResult(image(24), { operation: f.operation, send: f.send }) as { content: { imageTransfer: unknown }[] };
  f.op.phase = "SUCCEEDED";
  const manifest = f.db.get<Record<string, unknown>>("image/manifest/operation/0"); manifest.payloadFormat = "BLOB_FUTURE";
  f.db.put("image/manifest/operation/0", manifest);
  await assert.rejects(() => f.handler.read(uploaded.content[0]!.imageTransfer, "image/png", f.scope), errorCode("INCOMPATIBLE_VERSION"));
});


test("malformed image expiry never becomes an unlimited-lived result", async () => {
  for(const expiresAt of [undefined,null,NaN,Infinity,-1,"1000"]) {
    const f=fixture(), uploaded=await uploadImageResult(image(24),{operation:f.operation,send:f.send}) as {content:{imageTransfer:unknown}[]};
    f.op.phase="SUCCEEDED";const manifest=f.db.get<Record<string,unknown>>("image/manifest/operation/0");manifest.expiresAt=expiresAt;f.db.put("image/manifest/operation/0",manifest);
    await assert.rejects(()=>f.handler.read(uploaded.content[0]!.imageTransfer,"image/png",f.scope),/SQLITE_RECORD_CORRUPT/);
  }
});
