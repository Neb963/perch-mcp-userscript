import test from "node:test";
import assert from "node:assert/strict";
import type { DurableObjectState, WebSocket as DurableSocket } from "@cloudflare/workers-types";
import { PushNotifications, validatePushUpgrade, type PushLease } from "../../apps/gateway/src/push-notifications.js";
import { SqlRecords } from "../../apps/gateway/src/sql.js";

class Records {
  data = new Map<string, unknown>();
  writes = 0;
  failWrite = false;
  get<T>(key: string): T { return structuredClone(this.data.get(key)) as T; }
  put(key: string, value: unknown): void {
    if (this.failWrite) throw new Error("SYNTHETIC_QUOTA");
    this.writes++; this.data.set(key, structuredClone(value));
  }
  transaction<T>(fn: () => T): T {
    const before = structuredClone(this.data);
    try { return fn(); } catch (error) { this.data = before; throw error; }
  }
}
function fixture() {
  const db = new Records(), frames: string[] = [], closes: number[] = [];
  let lease: PushLease = { workspaceId: "workspace", epoch: 2, bindingRevision: 1, tabInstanceId: "tab",
    secretHash: "lease-hash", expiresAt: Date.now() + 180_000 };
  const attachment = { version: 1, workspaceId: lease.workspaceId, epoch: lease.epoch,
    bindingRevision: lease.bindingRevision, tabInstanceId: lease.tabInstanceId, generation: crypto.randomUUID() };
  const socket = {
    readyState: 1,
    deserializeAttachment: () => attachment,
    send: (message: string) => frames.push(message),
    close: (code: number) => { closes.push(code); },
  } as unknown as DurableSocket;
  const sockets = [socket];
  const state = { getWebSockets: () => sockets, acceptWebSocket: () => {} } as unknown as DurableObjectState;
  const helper = () => new PushNotifications(db as unknown as SqlRecords, state,
    { enabled: true, getLease: () => lease, allowedOrigins: ["https://perchance.org"] });
  return { db, frames, closes, attachment, helper, lease, sockets, changeLease: (next: PushLease) => { lease = next; } };
}
test("notification upgrade shape is rejected before storage access", () => {
  const request = (protocol: string) => new Request("https://fixture.test/api/v1/tab/socket?workspaceId=workspace", {
    headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": protocol },
  });
  const ticket = "t".repeat(43);
  assert.equal(validatePushUpgrade(request("perch-notify-v1, ticket." + ticket)), ticket);
  for (const protocol of ["", "perch-notify-v1", "ticket." + ticket, "perch-notify-v1,ticket.short",
    "perch-notify-v1,ticket." + ticket + ",extra"])
    assert.throws(() => validatePushUpgrade(request(protocol)));
  assert.throws(() => validatePushUpgrade(new Request("https://fixture.test/api/v1/tab/socket")));
});
test("notification ticket persists only digest and exact scope; failed writes never acknowledge it", async () => {
  const f = fixture(), helper = f.helper();
  const ticket = await helper.issue(f.lease);
  const stored = f.db.data.get("push-state/v1") as Record<string, unknown>;
  assert.equal(ticket.version, 1); assert.equal(ticket.ticket.length, 43);
  assert.equal(stored.phase, "TICKET"); assert.equal(stored.workspaceId, f.lease.workspaceId);
  assert.match(String(stored.ticketDigest), /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(stored).includes(ticket.ticket));
  assert.ok(!JSON.stringify(stored).includes(f.lease.secretHash));
  const old = structuredClone(stored); f.db.failWrite = true;
  await assert.rejects(helper.issue(f.lease), /SYNTHETIC_QUOTA/);
  assert.deepEqual(f.db.data.get("push-state/v1"), old);
});
test("ticket hashing rechecks lease ownership at the commit boundary", async () => {
  const f = fixture(), pending = f.helper().issue(f.lease);
  f.changeLease({ ...f.lease, epoch: 3, secretHash: "replacement" });
  await assert.rejects(pending, (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "STALE_EPOCH");
  assert.equal(f.db.writes, 0);
});
test("hibernation reconstruction sends advisory data with no durable writes and fences stale generations", () => {
  const f = fixture();
  f.db.data.set("push-state/v1", { ...f.attachment, phase: "CONNECTED", expiresAt: Date.now() - 1 });
  // A ticket's short deadline does not expire an authenticated connection; its lease does.
  f.helper().notify(); f.helper().notify();
  assert.deepEqual(f.frames.map(frame => JSON.parse(frame)), [
    { version: 1, type: "available" }, { version: 1, type: "available" },
  ]);
  assert.equal(f.db.writes, 0);
  f.db.data.set("push-state/v1", { ...f.attachment, generation: crypto.randomUUID(), phase: "CONNECTED", expiresAt: Date.now() + 30_000 });
  f.helper().notify(); assert.equal(f.frames.length, 2); assert.deepEqual(f.closes, [1008]);
  f.changeLease({ ...f.lease, expiresAt: Date.now() - 1 }); f.helper().notify();
  assert.equal(f.frames.length, 2);
});
test("unrecognized auxiliary schema fails closed; notifications accept no application input", async () => {
  const f = fixture();
  f.db.data.set("push-state/v1", { version: 99 });
  await assert.rejects(f.helper().issue(f.lease), /PUSH_STATE_CORRUPT/);
  const socket = { close: (code: number) => f.closes.push(code) } as unknown as DurableSocket;
  f.helper().webSocketMessage(socket, "effect"); assert.deepEqual(f.closes, [1008]);
});
test("authenticated reconnect cannot allocate an unbounded closing-socket backlog", async () => {
  const f = fixture(), helper = f.helper(), ticket = await helper.issue(f.lease);
  f.sockets.push(f.sockets[0]!);
  const request = new Request("https://fixture.test/api/v1/tab/socket?workspaceId=workspace", {
    headers: { Origin: "https://perchance.org", Upgrade: "websocket", "Sec-WebSocket-Protocol": "perch-notify-v1,ticket." + ticket.ticket },
  });
  await assert.rejects(helper.upgrade(request), (error: unknown) => !!error && typeof error === "object" && "status" in error && error.status === 429);
  assert.equal((f.db.data.get("push-state/v1") as {phase:string}).phase, "TICKET");
});
test("auxiliary socket enumeration failure cannot break disabled startup or committed close", () => {
  const state = { getWebSockets: () => { throw new Error("SYNTHETIC_SOCKET_RUNTIME_UNAVAILABLE"); } } as unknown as DurableObjectState;
  const helper = new PushNotifications({} as SqlRecords, state, { enabled: false, getLease: () => undefined, allowedOrigins: [] });
  assert.equal(helper.enabled, false);
  assert.doesNotThrow(() => helper.close());
});
test("unexpected session fields and coerced digests cannot enter socket attachments", async () => {
  const f = fixture(), helper = f.helper();
  await helper.issue(f.lease);
  const valid = f.db.data.get("push-state/v1") as Record<string, unknown>;
  f.db.data.set("push-state/v1", { ...valid, unexpectedSecret: "fixture-private-source" });
  await assert.rejects(helper.issue(f.lease), /PUSH_STATE_CORRUPT/);
  f.db.data.set("push-state/v1", { ...valid, ticketDigest: [valid.ticketDigest] });
  await assert.rejects(helper.issue(f.lease), /PUSH_STATE_CORRUPT/);
});
