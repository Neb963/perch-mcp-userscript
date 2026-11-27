import test from "node:test";
import assert from "node:assert/strict";
import { BrowserController } from "../../apps/userscript/src/controller.js";
import type { NativeAdapter } from "../../apps/userscript/src/adapter.js";
import type { GatewayTransport } from "../../apps/userscript/src/transport.js";
import { MemoryStore } from "../../apps/userscript/src/storage.js";
import { NotificationChannel, type NotificationSocket } from "../../apps/userscript/src/notifications.js";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 1000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("Synthetic scheduler did not settle."); await new Promise<void>(done => setImmediate(done)); }
}
async function fixture(poll: (call: number) => Promise<Record<string, unknown>> = async () => ({ operations: [] })) {
  let calls = 0, executing = 0, peakExecuting = 0;
  const bodies: Record<string, unknown>[] = [];
  const socket: NotificationSocket = { readyState: 1, protocol: "perch-notify-v1", onopen: null, onmessage: null, onerror: null, onclose: null, close: () => {} };
  const channel = new NotificationChannel({
    url: "wss://fixture.workers.dev/api/v1/tab/socket?workspaceId=workspace",
    requestTicket: async () => ({ version: 1, protocol: "perch-notify-v1", ticket: "t".repeat(43), expiresAt: Date.now() + 30_000 }),
    socket: () => socket,
  });
  const connected = channel.connectIfDue(); await Promise.resolve();
  socket.onmessage?.({ data: '{"version":1,"type":"ready"}' } as MessageEvent); await connected;
  const lease = { workspaceId: "workspace", epoch: 2, bindingRevision: 1, tabInstanceId: "tab", leaseCredential: "test-lease-secret", expiresAt: Date.now() + 180_000, permissions: ["READ_SOURCE"] };
  const transport = {
    configuration: () => ({ paired: true, origin: "https://fixture.workers.dev" }),
    tab: async (path: string, body: Record<string, unknown>) => {
      if (path.endsWith("/poll")) { bodies.push(body); return poll(++calls); }
      if (path.endsWith("/heartbeat")) return { expiresAt: lease.expiresAt, permissions: lease.permissions, workAvailable: true };
      return { ok: true };
    },
  } as unknown as GatewayTransport;
  const controller = new BrowserController({} as NativeAdapter, new MemoryStore(), transport);
  const internal = controller as unknown as {
    lease: typeof lease; stopped: boolean; push: NotificationChannel; pollAbort: AbortController;
    poll(): Promise<void>; renew(current: typeof lease): Promise<void>; execute(raw: unknown, current: typeof lease): Promise<void>;
  };
  Object.assign(internal, { lease, stopped: false, push: channel, pollAbort: new AbortController() });
  const execute = deferred<void>();
  internal.execute = async () => { executing++; peakExecuting = Math.max(peakExecuting, executing); await execute.promise; executing--; };
  return { controller, internal, lease, channel, bodies, socket, calls: () => calls,
    executing: () => executing, peak: () => peakExecuting, finishExecute: () => execute.resolve(),
    available: () => socket.onmessage?.({ data: '{"version":1,"type":"available"}' } as MessageEvent) };
}
test("healthy controller notification idle has no periodic work fetch and burst signals coalesce", async () => {
  const f = await fixture(), running = f.internal.poll();
  try {
    await until(() => f.calls() === 1);
    await new Promise<void>(done => setTimeout(done, 10)); assert.equal(f.calls(), 1);
    f.available(); f.available(); f.available();
    await until(() => f.calls() === 2);
    await new Promise<void>(done => setTimeout(done, 10)); assert.equal(f.calls(), 2);
    assert.deepEqual(f.bodies.map(body => body.waitMs), [0, 0]);
  } finally { await f.controller.pause(); await running; }
});
test("a notification during an in-flight empty snapshot produces exactly one rescan", async () => {
  const first = deferred<Record<string, unknown>>();
  const f = await fixture(async call => call === 1 ? first.promise : ({ operations: [] })), running = f.internal.poll();
  try {
    await until(() => f.calls() === 1); f.available(); f.available(); first.resolve({ operations: [] });
    await until(() => f.calls() === 2);
    await new Promise<void>(done => setTimeout(done, 10)); assert.equal(f.calls(), 2);
  } finally { first.resolve({ operations: [] }); await f.controller.pause(); await running; }
});
test("notification during execution latches work without parallel fetch or execution", async () => {
  const f = await fixture(async call => ({ operations: call === 1 ? [{ operationId: "operation" }] : [] })), running = f.internal.poll();
  try {
    await until(() => f.executing() === 1); f.available(); f.available();
    await new Promise<void>(done => setTimeout(done, 10)); assert.equal(f.calls(), 1);
    f.finishExecute(); await until(() => f.calls() === 2);
    assert.equal(f.peak(), 1);
  } finally { f.finishExecute(); await f.controller.pause(); await running; }
});
test("authoritative heartbeat recovers a silently dropped notification on the existing cadence", async () => {
  const f = await fixture(), running = f.internal.poll();
  try {
    await until(() => f.calls() === 1);
    // No socket notification is emitted. The existing heartbeat is the only wake.
    await f.internal.renew(f.lease); await until(() => f.calls() === 2);
    assert.equal(f.channel.healthy, true);
  } finally { await f.controller.pause(); await running; }
});
