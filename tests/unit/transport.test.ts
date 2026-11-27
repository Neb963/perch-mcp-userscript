import test from "node:test";
import assert from "node:assert/strict";
import {
  GatewayTransport,
  gatewayOrigin,
} from "../../apps/userscript/src/transport.js";
import { MemoryStore } from "../../apps/userscript/src/storage.js";
test("gateway origins reject token URLs, redirects and local addresses", () => {
  for (const url of [
    "http://x.workers.dev",
    "https://user:secret@x.workers.dev",
    "https://x.workers.dev/mcp",
    "https://x.workers.dev/?token=x",
    "https://127.0.0.1",
    "https://[::1]",
    "https://localhost",
  ])
    assert.throws(() => gatewayOrigin(url));
  assert.equal(
    gatewayOrigin("https://perch.example.workers.dev/"),
    "https://perch.example.workers.dev",
  );
});
test("authenticated transport uses separate credentials and never follows redirects", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string | URL | Request, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return Response.json(
      calls.length === 1
        ? {
            adminCredential: "admin-secret",
            executionCredential: "exec-secret",
          }
        : { ok: true },
    );
  }) as typeof fetch;
  const transport = new GatewayTransport(new MemoryStore(), fetcher);
  await transport.pair("https://perch.example.workers.dev", "a".repeat(64));
  await transport.request("GET", "/api/v1/admin/state");
  await transport.tab("/api/v1/tab/claim", {});
  assert.equal(
    new Headers(calls[1]!.init.headers).get("Authorization"),
    "Bearer admin-secret",
  );
  assert.equal(
    new Headers(calls[2]!.init.headers).get("Authorization"),
    "Bearer exec-secret",
  );
  for (const c of calls) {
    assert.equal(c.init.redirect, "error");
    assert.equal(c.init.credentials, "omit");
    assert.ok(!c.url.includes("secret"));
  }
  await assert.rejects(transport.request("GET", "//attacker.example/admin"));
});
test("network and hostile gateway errors do not leak credentials/provider messages", async () => {
  const store = new MemoryStore();
  await store.set("perch:pairing", {
    schemaVersion: 1,
    origin: "https://x.workers.dev",
    adminCredential: "secret",
    executionCredential: "exec",
    browserInstallationId: "b",
  });
  const transport = new GatewayTransport(store, (async () =>
    Response.json(
      { code: "REVOKED", message: "secret-private-source" },
      { status: 403 },
    )) as typeof fetch);
  await transport.initialize();
  await assert.rejects(
    transport.request("GET", "/api/v1/admin/state"),
    (e) =>
      e instanceof Error &&
      !e.message.includes("secret-private-source") &&
      e.message.includes("REVOKED"),
  );
});

test("transient management GET retries safely, while a failed POST never replays", async () => {
  const store = new MemoryStore();
  await store.set("perch:pairing", {
    schemaVersion: 1,
    origin: "https://perch.example.workers.dev",
    adminCredential: "local-management-secret",
    executionCredential: "local-execution-secret",
    browserInstallationId: "local",
  });
  let calls = 0;
  const transport = new GatewayTransport(store, (async () => {
    calls++;
    if (calls === 1) throw new TypeError("synthetic connectivity glitch");
    return Response.json({ items: [], revision: 1 });
  }) as typeof fetch);
  await transport.initialize();
  const approvals = await transport.request("GET", "/api/v1/admin/approvals") as { items: unknown[] };
  assert.deepEqual(approvals.items, []);
  assert.equal(calls, 2);
  const rejected = new GatewayTransport(store, (async () => {
    calls++;
    throw new TypeError("synthetic failure");
  }) as typeof fetch);
  await rejected.initialize();
  await assert.rejects(
    rejected.request("POST", "/api/v1/admin/approvals/someid/decision", {
      decision: "approve",
    }),
    (error: unknown) => error instanceof Error && error.message.includes("never automatically retried"),
  );
  assert.equal(calls, 3, "mutating POST must not be retried");
});

test("transport audit records safe route templates and gateway trace ID, never credentials", async () => {
  const store = new MemoryStore();
  await store.set("perch:pairing", {
    schemaVersion: 1,
    origin: "https://perch.example.workers.dev",
    browserInstallationId: "fixture-id",
    adminCredential: "DO-NOT-EXPORT-ADMIN",
    executionCredential: "DO-NOT-EXPORT-EXEC",
  });
  const transport = new GatewayTransport(store, (async () => Response.json({
    code: "SCOPE_DENIED",
    message: "DO-NOT-EXPORT-SERVER-MESSAGE",
    traceId: "a4eef3e9-ce3f-40be-961f-5c2d47d50250",
  }, { status: 403 })) as typeof fetch);
  await transport.initialize();
  await assert.rejects(transport.request("GET", "/api/v1/admin/approvals/client-private-id/decision?cursor=sensitive"), () => true);
  const data = transport.diagnostics();
  assert.equal(data.events.length, 1);
  assert.equal(data.events[0]?.route, "/api/v1/admin/approvals/:id/decision");
  assert.equal(data.events[0]?.status, 403);
  assert.equal(data.events[0]?.code, "SCOPE_DENIED");
  assert.equal(data.events[0]?.traceId, "a4eef3e9-ce3f-40be-961f-5c2d47d50250");
  assert.doesNotMatch(JSON.stringify(data), /DO-NOT-EXPORT|client-private-id|sensitive/);
});

test("gateway request deadlines exceed the 25-second Worker idle poll, including non-signaled POST", async () => {
  const store = new MemoryStore();
  await store.set("perch:pairing", {
    schemaVersion: 1, origin: "https://fixture.workers.dev",
    browserInstallationId: "fixture", adminCredential: "admin", executionCredential: "exec",
  });
  const durations: number[] = [];
  const original = AbortSignal.timeout;
  // Capture the actual timeout configured by fetch(), not a duplicated
  // constant in an isolated helper test.
  AbortSignal.timeout = ((duration: number) => {
    durations.push(duration);
    return new AbortController().signal;
  }) as typeof AbortSignal.timeout;
  try {
    const transport = new GatewayTransport(store, (async () =>
      Response.json({ operations: [], expiresAt: Date.now() + 180000 })) as typeof fetch);
    await transport.initialize();
    await transport.request("GET", "/api/v1/admin/state");
    await transport.request("POST", "/api/v1/admin/pause", { paused: true });
    await transport.tab("/api/v1/tab/poll", { workspaceId: "fixture" }, "lease");
    const signal = new AbortController();
    await transport.tab("/api/v1/tab/poll", { workspaceId: "fixture" }, "lease",
      { signal: signal.signal, timeoutMs: 45000 });
    assert.deepEqual(durations, [15000, 30000, 30000, 45000]);
    assert.ok(durations[2]! > 25000, "un-signaled poll must not abort before the Cloudflare hold finishes");
  } finally {
    AbortSignal.timeout = original;
  }
});

test('gateway 500 and bootstrap failures persist across reload without retaining credentials',async()=>{
  const store=new MemoryStore();
  const fail=(async()=>Response.json({code:'INTERNAL_ERROR',message:'DO-NOT-STORE-TOKEN'},
    {status:500})) as typeof fetch;
  const first=new GatewayTransport(store,fail);
  await assert.rejects(first.health('https://perch.example.workers.dev'),
    (e:unknown)=>e instanceof Error&&e.message.includes('INTERNAL_ERROR')&&!e.message.includes('DO-NOT-STORE-TOKEN'));
  first.recordBootstrapFailure('WORKSPACE_LOOKUP','INTERNAL_ERROR');
  await new Promise(resolve=>setTimeout(resolve,10));
  const second=new GatewayTransport(store,fail);
  await second.initialize();
  const history=second.diagnostics().preservedFailures;
  assert.ok(history.some(e=>e.code==='INTERNAL_ERROR'&&e.status===500));
  assert.ok(history.some(e=>e.code==='WORKSPACE_LOOKUP:INTERNAL_ERROR'&&e.method==='STATE'));
  assert.doesNotMatch(JSON.stringify(history),/DO-NOT-STORE-TOKEN/);
});
