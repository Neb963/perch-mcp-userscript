import test from "node:test";
import assert from "node:assert/strict";
import { GatewayTransport, TransportError } from "../../apps/userscript/src/transport.js";
import { isRetryableGatewayFailure } from "../../apps/userscript/src/connection-failures.js";
import { MemoryStore } from "../../apps/userscript/src/storage.js";
import { BrowserController } from "../../apps/userscript/src/controller.js";
import type { NativeAdapter } from "../../apps/userscript/src/adapter.js";

const terminal = (reason = "REGISTRY_STORAGE_CORRUPT") => ({
  ok: false, dependency: "registry", code: "GATEWAY_DEGRADED", retryable: false, reason,
});
async function fixture(body: unknown) {
  const store = new MemoryStore();
  await store.set("perch:pairing", { schemaVersion: 1, origin: "https://fixture.workers.dev",
    browserInstallationId: "fixture", adminCredential: "fixture-admin", executionCredential: "fixture-execution" });
  let calls = 0;
  const transport = new GatewayTransport(store, (async () => {
    calls++; return Response.json(body, { status: 503 });
  }) as typeof fetch);
  await transport.initialize();
  return { transport, calls: () => calls };
}
test("only fixed nonretryable Registry readiness classifications stop connectivity retries", async () => {
  for (const reason of ["REGISTRY_STORAGE_CORRUPT", "REGISTRY_CONFIGURATION_INVALID", "REGISTRY_SCHEMA_INCOMPATIBLE"]) {
    const f = await fixture(terminal(reason));
    await assert.rejects(f.transport.health(), (error: unknown) => {
      assert.ok(error instanceof TransportError);
      assert.equal(error.connectivityRetryable, false);
      assert.equal(isRetryableGatewayFailure(error.code, error.connectivityRetryable), false);
      assert.ok(!error.message.includes(reason)); return true;
    });
    assert.equal(f.calls(), 1);
  }
});
test("unknown, malformed and operation retry flags cannot become permanent connectivity failures", async () => {
  const invalid = [terminal("UNRECOGNIZED_PRIVATE_REASON"), { ...terminal(), retryable: "false" },
    { ...terminal(), reason: ["REGISTRY_STORAGE_CORRUPT"] }, { ...terminal(), ok: true },
    { ...terminal(), dependency: "other" }, { ...terminal(), code: "HTTP_503" },
    { ...terminal(), retryable: true }, { code: "GATEWAY_DEGRADED", retryable: false }];
  for (const body of invalid) {
    const f = await fixture(body);
    await assert.rejects(f.transport.health(), (error: unknown) => {
      assert.ok(error instanceof TransportError); assert.equal(error.connectivityRetryable, undefined);
      assert.equal(isRetryableGatewayFailure(error.code, error.connectivityRetryable), true);
      assert.ok(!error.message.includes("PRIVATE_REASON")); return true;
    });
  }
  const operation = await fixture(terminal());
  await assert.rejects(operation.transport.request("GET", "/api/v1/admin/state"), (error: unknown) => {
    assert.ok(error instanceof TransportError); assert.equal(error.connectivityRetryable, undefined); return true;
  });
});
test("SQL quota still backs off connectivity despite generic mutation retryable:false", async () => {
  const f = await fixture({ ...terminal("REGISTRY_QUOTA"), connectivityRetryAfterSeconds: 300 });
  await assert.rejects(f.transport.health(), (error: unknown) => {
    assert.ok(error instanceof TransportError); assert.equal(error.connectivityRetryable, undefined);
    assert.equal(error.connectivityRetryAfterSeconds, 300);
    assert.equal(isRetryableGatewayFailure(error.code, error.connectivityRetryable), true); return true;
  });
  assert.ok(f.transport.connectivityRetryDelayMs() >= 299_000);
});
test("controller honors explicit permanent connectivity classification without retaining push or retrying", async () => {
  let requests = 0, socketStops = 0;
  const transport = { configuration: () => ({ paired: true }), tab: async () => {
    requests++; throw new TransportError("GATEWAY_DEGRADED", "Fixed readiness failure.", 503, undefined, undefined, false);
  } } as unknown as GatewayTransport;
  const controller = new BrowserController({} as NativeAdapter, new MemoryStore(), transport);
  const lease = { workspaceId: "workspace", epoch: 1, bindingRevision: 1, tabInstanceId: "tab",
    leaseCredential: "fixture", expiresAt: Date.now() + 180_000, permissions: ["READ_SOURCE"] };
  const internal = controller as unknown as { renew(current: typeof lease): Promise<void> };
  Object.assign(controller, { lease, stopped: false, push: { stop: () => { socketStops++; }, diagnostics: () => ({ state: "stopped" }) } });
  await internal.renew(lease);
  assert.equal(requests, 1); assert.equal(socketStops, 1);
  assert.equal(controller.diagnostics().connection, "blocked");
  assert.equal(controller.diagnostics().connectivityRetryable, false);
  await internal.renew(lease); assert.equal(requests, 1);
});
