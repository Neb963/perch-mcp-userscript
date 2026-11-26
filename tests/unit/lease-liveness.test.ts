import assert from "node:assert/strict";
import test from "node:test";
import { BrowserController } from "../../apps/userscript/src/controller.js";
import { GatewayTransport, TransportError } from "../../apps/userscript/src/transport.js";
import { MemoryStore } from "../../apps/userscript/src/storage.js";
import { NativeAdapter } from "../../apps/userscript/src/adapter.js";

type Lease = {
  workspaceId: string;
  epoch: number;
  bindingRevision: number;
  tabInstanceId: string;
  leaseCredential: string;
  expiresAt: number;
  permissions: string[];
};
type Internal = {
  lease: Lease;
  stopped: boolean;
  pollAbort: AbortController;
  poll(): Promise<void>;
  renew(lease: Lease): Promise<void>;
};
function fixture(handler: GatewayTransport["tab"]) {
  const statuses: { connection: string; reason?: string }[] = [];
  const transport = {
    configuration: () => ({ paired: true, origin: "https://fixture.workers.dev" }),
    tab: handler,
  } as GatewayTransport;
  const adapter = {} as NativeAdapter;
  const controller = new BrowserController(
    adapter, new MemoryStore(), transport, undefined, (status) => statuses.push(status),
  );
  const lease: Lease = {
    workspaceId: "w", epoch: 3, bindingRevision: 2,
    tabInstanceId: controller.tabInstanceId, leaseCredential: "secret",
    expiresAt: Date.now() + 180000, permissions: ["READ_SOURCE"],
  };
  const internal = controller as unknown as Internal;
  internal.lease = lease;
  internal.stopped = false;
  internal.pollAbort = new AbortController();
  return { controller, statuses, lease, internal };
}
test("transient long-poll loss reuses the same lease without dispatching or claiming another", async () => {
  let calls = 0;
  let fixtureRef!: ReturnType<typeof fixture>;
  const f = fixture(async (path, body, secret, options) => {
    assert.equal(path, "/api/v1/tab/poll");
    assert.equal(secret, "secret");
    assert.equal(options?.timeoutMs, 45000);
    assert.equal(options?.signal?.aborted, false);
    assert.equal((body as Record<string, unknown>).epoch, 3);
    calls++;
    if (calls === 1) throw new TransportError("GATEWAY_TIMEOUT", "synthetic timeout");
    if (calls === 3) fixtureRef.internal.stopped = true;
    return { operations: [], expiresAt: Date.now() + 180000 };
  });
  fixtureRef = f;
  await f.internal.poll();
  assert.equal(calls, 3);
  assert.ok(f.statuses.some((x) => x.connection === "degraded"));
  assert.ok(f.statuses.some((x) => x.connection === "connected"));
  const d = f.controller.diagnostics();
  assert.equal(d.consecutivePollFailures, 0);
  assert.ok(d.lastPollSuccessAt);
  assert.equal(d.leasePresent, true);
  assert.equal(d.reasonCode, undefined);
});
test("temporary heartbeat failures preserve the unexpired lease but revoked epochs fail closed", async () => {
  let code = "GATEWAY_UNAVAILABLE";
  const f = fixture(async () => {
    throw new TransportError(code, "synthetic failure");
  });
  await f.internal.renew(f.lease);
  assert.equal(f.internal.stopped, false);
  assert.equal(f.statuses.at(-1)?.connection, "degraded");
  assert.equal(f.controller.diagnostics().reasonCode, "GATEWAY_UNAVAILABLE");
  code = "STALE_EPOCH";
  await f.internal.renew(f.lease);
  assert.equal(f.internal.stopped, true);
  assert.equal(f.statuses.at(-1)?.connection, "blocked");
  assert.equal(f.controller.diagnostics().reasonCode, "STALE_EPOCH");
});
test("persistent long-poll outage stops after bounded retries with a causal failure code", async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    throw new TransportError("GATEWAY_UNAVAILABLE", "synthetic network outage");
  });
  await assert.rejects(f.internal.poll(), (e: unknown) =>
    e instanceof TransportError && e.code === "GATEWAY_UNAVAILABLE");
  assert.equal(calls, 3);
  assert.equal(f.controller.diagnostics().consecutivePollFailures, 3);
  assert.equal(f.controller.diagnostics().reasonCode, "GATEWAY_UNAVAILABLE");
});
