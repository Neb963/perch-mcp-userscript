import test from "node:test";
import assert from "node:assert/strict";
import { createCapacityHarness, type CapacityFixture } from "./gateway-capacity-harness.js";
import { activateSyntheticNative } from "../fixtures/optimization-client.js";
type Harness = Awaited<ReturnType<typeof createCapacityHarness>>;
interface Socket {
  accept(): void;
  send(value: string): void;
  close(code?: number): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
}
function next(socket: Socket, type = "message"): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const done = (event: unknown) => { clearTimeout(timer); socket.removeEventListener(type, done); resolve(event); };
    const timer = setTimeout(() => { socket.removeEventListener(type, done); reject(new Error("Local notification event timed out.")); }, 3000);
    socket.addEventListener(type, done);
  });
}
async function socket(h: Harness, f: CapacityFixture, ticket: string, origin = "https://perchance.org") {
  return h.mf.dispatchFetch("https://capacity.test/api/v1/tab/socket?workspaceId=" + encodeURIComponent(f.workspaceId), {
    headers: { Origin: origin, Upgrade: "websocket", "Sec-WebSocket-Protocol": "perch-notify-v1, ticket." + ticket },
  });
}
async function connect(h: Harness, f: CapacityFixture) {
  const ticket = await h.browser(f, "ticket");
  const response = await socket(h, f, String(ticket.ticket));
  assert.equal(response.status, 101);
  assert.equal(response.headers.get("Sec-WebSocket-Protocol"), "perch-notify-v1");
  const client = response.webSocket as unknown as Socket;
  const observed = { messages: 0 };
  assert.ok(client); client.addEventListener("message", () => { observed.messages++; });
  const ready = next(client); client.accept();
  assert.deepEqual(JSON.parse(String((await ready as { data: unknown }).data)), { version: 1, type: "ready" });
  return { client, ticket: String(ticket.ticket), observed };
}
async function control(h: Harness, f: CapacityFixture, body?: Record<string, unknown>) {
  const stub = h.wns.get(h.wns.idFromName(f.workspaceId));
  const response = await stub.fetch("https://internal/__fixture_push", body ? {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  } : undefined);
  assert.equal(response.status, 200);
  return response.json() as Promise<Record<string, number>>;
}
async function finish(h: Harness, f: CapacityFixture, operationId: string) {
  const poll = await h.browser(f, "poll", { waitMs: 0 });
  assert.equal((poll.operations as { operationId: string }[])[0]?.operationId, operationId);
  await h.browser(f, "reply", { operationId, phase: "RUNNING" });
  await h.browser(f, "reply", { operationId, phase: "SUCCEEDED", result: {
    operationId, status: "SUCCEEDED", effectState: "VERIFIED", data: { fixture: true },
  } });
}

test("notification flag defaults off; legacy authenticated HTTP still executes", { timeout: 30_000 }, async () => {
  const h = await createCapacityHarness(1);
  try {
    const f = h.fixtures[0]!;
    assert.equal(f.lease.notifications, undefined);
    await assert.rejects(h.browser(f, "ticket"), (error: unknown) => !!error && typeof error === "object" && "status" in error && error.status === 404);
    await h.cycle(f);
  } finally { await h.close(); }
});

test("pinned workerd notification upgrade is scoped, one-use and survives reconstructed Workspace", { timeout: 30_000 }, async () => {
  const h = await createCapacityHarness(2, { PUSH_NOTIFICATIONS_ENABLED: "true" }, { entryPoint: "tests/fixtures/push-runtime.ts" });
  let client: Socket | undefined;
  try {
    const f = h.fixtures[0]!, other = h.fixtures[1]!;
    assert.deepEqual(f.lease.notifications, { version: 1 });
    const joined = await connect(h, f); client = joined.client;
    assert.equal((await socket(h, f, joined.ticket)).status, 401);
    assert.equal((await socket(h, other, joined.ticket)).status, 401);
    const timings: number[] = [];
    const available = next(client), started = performance.now(), admitted = await h.admit(f);
    const frame = JSON.parse(String((await available as { data: unknown }).data));
    assert.deepEqual(frame, { version: 1, type: "available" });
    timings.push(performance.now() - started);
    await finish(h, f, String(admitted.operationId));
    await control(h, f, { restart: true });
    const afterRestart = next(client), second = await h.admit(f);
    assert.deepEqual(JSON.parse(String((await afterRestart as { data: unknown }).data)), { version: 1, type: "available" });
    await finish(h, f, String(second.operationId));
    for (let sample = 0; sample < 11; sample++) {
      const available = next(client), started = performance.now(), admitted = await h.admit(f);
      assert.deepEqual(JSON.parse(String((await available as { data: unknown }).data)), { version: 1, type: "available" });
      // Request start precedes the canonical admission commit: this is a
      // conservative local upper bound on commit-to-fetch-start latency.
      timings.push(performance.now() - started);
      await finish(h, f, String(admitted.operationId));
    }
    const sorted = [...timings].sort((a, b) => a - b), p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
    assert.ok(p95 < 1000, "local notification p95 must remain below one second");
    console.log(JSON.stringify({ kind: "push-local-latency", samples: timings.length, medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: p95, maxMs: sorted.at(-1), rawOutgoingObservedMessages: joined.observed.messages, basis: "admission-request-start-to-authoritative-fetch-start-upper-bound", production: "DEFERRED_LIVE" }));
    const metrics = await control(h, f); assert.equal(metrics.starts, 2); assert.equal(metrics.socketUpgrades, 1);
    const before = await control(h, f), closed = next(client, "close");
    client.send("unauthorized application input");
    assert.equal((await closed as { code: number }).code, 1008);
    const after = await control(h, f);
    assert.equal(after.sqlWrites, before.sqlWrites, "rejected application frames perform no SQL writes");
    assert.equal(after.incomingMessages, 1);
  } finally { try { client?.close(); } catch {} await h.close(); }
});

test("pinned workerd ticket expiry, failed persistence, origin denial and lease replacement fail closed", { timeout: 30_000 }, async () => {
  const h = await createCapacityHarness(1, { PUSH_NOTIFICATIONS_ENABLED: "true" }, { entryPoint: "tests/fixtures/push-runtime.ts" });
  try {
    const f = h.fixtures[0]!;
    await control(h, f, { failTicketWrite: true });
    await assert.rejects(h.browser(f, "ticket"));
    const ticket = await h.browser(f, "ticket");
    assert.equal((await socket(h, f, String(ticket.ticket), "https://attacker.test")).status, 403);
    await control(h, f, { now: Date.now() + 31_000, restart: true });
    assert.equal((await socket(h, f, String(ticket.ticket))).status, 401);
    await control(h, f, { now: Date.now() });
    const stale = await h.browser(f, "ticket");
    await h.browser(f, "release"); await h.reclaim(f);
    assert.equal((await socket(h, f, String(stale.ticket))).status, 401);
    const metrics = await control(h, f); assert.equal(metrics.sqlFailures, 1); assert.equal(metrics.socketUpgrades, 0);
  } finally { await h.close(); }
});

test("notifications coexist with verified native operation, Activity and Resource authority", { timeout: 30_000 }, async () => {
  const h = await createCapacityHarness(1, { PUSH_NOTIFICATIONS_ENABLED: "true", CANONICAL_STORAGE_MODE: "native" }, { entryPoint: "tests/fixtures/push-runtime.ts" });
  let client: Socket | undefined;
  try {
    const f = h.fixtures[0]!;
    await activateSyntheticNative(h, f);
    client = (await connect(h, f)).client;
    const available = next(client), admitted = await h.admit(f);
    assert.deepEqual(JSON.parse(String((await available as { data: unknown }).data)), { version: 1, type: "available" });
    await finish(h, f, String(admitted.operationId));
    const heartbeat = await h.browser(f, "heartbeat");
    assert.equal(heartbeat.workAvailable, false);
    await control(h, f, { restart: true });
    const afterRestart = next(client), another = await h.admit(f);
    await afterRestart;
    await finish(h, f, String(another.operationId));
  } finally { try { client?.close(); } catch {} await h.close(); }
});

test("actual native admission notification adds bounded reads and no SQL writes", { timeout: 30_000 }, async () => {
  const h = await createCapacityHarness(2, { PUSH_NOTIFICATIONS_ENABLED: "true", CANONICAL_STORAGE_MODE: "native" }, { entryPoint: "tests/fixtures/push-runtime.ts" });
  let client: Socket | undefined;
  try {
    const pushing = h.fixtures[0]!, legacyHttp = h.fixtures[1]!;
    for (const fixture of [pushing, legacyHttp]) {
      await activateSyntheticNative(h, fixture);
      await h.cycle(fixture);
    }
    client = (await connect(h, pushing)).client;
    const beforeHttp = await control(h, legacyHttp), httpAdmission = await h.admit(legacyHttp), afterHttp = await control(h, legacyHttp);
    const available = next(client), beforePush = await control(h, pushing), pushAdmission = await h.admit(pushing);
    await available;
    const afterPush = await control(h, pushing);
    const http = { reads: afterHttp.sqlReads! - beforeHttp.sqlReads!, writes: afterHttp.sqlWrites! - beforeHttp.sqlWrites! };
    const push = { reads: afterPush.sqlReads! - beforePush.sqlReads!, writes: afterPush.sqlWrites! - beforePush.sqlWrites! };
    console.log(JSON.stringify({ kind: "push-admission-sql", http, push, measurement: "actual-pinned-workerd-cursor-counters" }));
    assert.equal(push.writes, http.writes, "sending an advisory availability frame performs no SQL writes");
    assert.ok(push.reads <= http.reads + 2, "notification checks only current lease and exact connected session");
    await finish(h, legacyHttp, String(httpAdmission.operationId));
    await finish(h, pushing, String(pushAdmission.operationId));
  } finally { try { client?.close(); } catch {} await h.close(); }
});
