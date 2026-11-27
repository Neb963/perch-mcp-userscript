import { build } from "esbuild";
import { Miniflare } from "miniflare";
import assert from "node:assert/strict";
export interface CapacityFixture {
  workspaceId: string;
  agentId: string;
  binding: Record<string, string>;
  lease: Record<string, unknown>;
  props: Record<string, unknown>;
  permissions: string[];
}
export async function createCapacityHarness(
  count: number,
  budgetOverrides: Record<string, string> = {},
) {
  const bundle = await build({
    entryPoints: ["apps/gateway/src/index.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["cloudflare:*", "node:*"],
    conditions: ["workerd", "worker", "browser"],
  });
  const base = "https://capacity.test",
    bootstrap = "capacity-test-".padEnd(64, "x");
  const mf = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0]!.text,
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
    kvNamespaces: ["OAUTH_KV"],
    durableObjects: {
      REGISTRY: { className: "Registry", useSQLite: true },
      WORKSPACES: { className: "Workspace", useSQLite: true },
    },
    bindings: {
      BOOTSTRAP_SECRET: bootstrap,
      ISSUER_URL: base,
      PROVIDER_WRITES_ENABLED: "false",
      ...budgetOverrides,
    },
  });
  try {
  await mf.ready;
  let admin = "",
    execution = "";
  async function request(
    path: string,
    body: unknown,
    credential = admin,
    method = "POST",
  ) {
    const response = await mf.dispatchFetch(base + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + credential,
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify(body),
    });
    const result = (await response.json()) as Record<string, unknown>;
    if (response.status !== 200)
      throw Object.assign(new Error(JSON.stringify(result)), {
        status: response.status,
      });
    return result;
  }
  const pair = await request(
    "/api/v1/admin/pair",
    { bootstrapSecret: bootstrap, browserInstallationId: "capacity-browser" },
    "",
  );
  admin = String(pair.adminCredential);
  execution = String(pair.executionCredential);
  const rns = await mf.getDurableObjectNamespace("REGISTRY"),
    wns = await mf.getDurableObjectNamespace("WORKSPACES"),
    registry = rns.get(rns.idFromName("installation"));
  async function internal(
    stub: { fetch: typeof registry.fetch },
    path: string,
    body: unknown,
  ) {
    const response = await stub.fetch("https://internal" + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = (await response.json()) as Record<string, unknown>;
    if (response.status !== 200)
      throw Object.assign(new Error(JSON.stringify(result)), {
        status: response.status,
      });
    return result;
  }
  const fixtures: CapacityFixture[] = [];
  for (let i = 0; i < count; i++) {
    const w = await request("/api/v1/admin/workspaces", {
      label: "Capacity " + i,
    });
    const binding = {
      generatorId: "capacity-generator-" + i,
      slug: "capacity-" + i,
      draftId: "",
      browserInstallationId: "capacity-browser",
    };
    const bound = await request("/api/v1/admin/workspaces/" + w.id + "/bind", {
      expectedRevision: w.revision,
      binding,
    });
    const a = await request("/api/v1/admin/agents", {
      workspaceId: w.id,
      label: "Agent " + i,
    });
    // Test-only trusted-AS fixture. Real S256/code/token exchange is separately exercised in gateway.test.ts.
    const pending = await internal(registry, "/internal/oauth/pending", {
      request: {
        clientId: "capacity-client-" + i,
        redirectUri: "https://client.test/callback",
        scope: ["mcp"],
        resource: a.endpoint,
        responseType: "code",
        state: "fixture",
        codeChallenge: "fixture",
        codeChallengeMethod: "S256",
      },
    });
    const approvals = await mf.dispatchFetch(base + "/api/v1/admin/approvals", {
      headers: { Authorization: "Bearer " + admin },
    });
    const list = (await approvals.json()) as {
      items: Record<string, unknown>[];
    };
    const approval = list.items.find((x) => x.id === pending.id)!;
    await request("/api/v1/admin/approvals/" + pending.id + "/decision", {
      expectedRevision: approval.revision,
      digest: approval.digest,
      decision: "approve",
    });
    const grant = await internal(registry, "/internal/oauth/consume", {
      id: pending.id,
      handle: pending.handle,
    });
    const lease = await request(
      "/api/v1/tab/claim",
      {
        workspaceId: w.id,
        binding,
        tabInstanceId: "capacity-tab-" + i,
        adapterVersion: "1",
      },
      execution,
    );
    fixtures.push({
      workspaceId: String(w.id),
      agentId: String(a.id),
      binding,
      lease,
      props: grant.props as Record<string, unknown>,
      permissions: bound.permissions as string[],
    });
  }
  async function browser(
    f: CapacityFixture,
    path: string,
    body: Record<string, unknown> = {},
  ) {
    return request(
      "/api/v1/tab/" + path,
      {
        workspaceId: f.workspaceId,
        epoch: f.lease.epoch,
        tabInstanceId: f.lease.tabInstanceId,
        ...body,
      },
      String(f.lease.leaseCredential),
    );
  }
  async function admit(
    f: CapacityFixture,
    tool = "read",
    args: Record<string, unknown> = { path: "main.pjs" },
    mutating = false,
    requiredPermissions = ["READ_SOURCE"],
  ) {
    const authorized = await internal(registry, "/internal/authorize", {
      props: f.props,
      agentId: f.agentId,
      permissions: requiredPermissions,
      mutating,
    });
    return internal(wns.get(wns.idFromName(f.workspaceId)), "/internal/admit", {
      workspace: authorized.workspace,
      props: f.props,
      agentId: f.agentId,
      tool,
      args,
      permissions: f.permissions,
      requiredPermissions,
      mutating,
    });
  }
  async function status(f: CapacityFixture, operationId: string) {
    return internal(
      wns.get(wns.idFromName(f.workspaceId)),
      "/internal/status",
      { workspaceId: f.workspaceId, operationId },
    );
  }
  async function cycle(f: CapacityFixture) {
    const started = performance.now();
    const admitted = await admit(f),
      operationId = String(admitted.operationId);
    const poll = await browser(f, "poll", { waitMs: 0 });
    const envelope = (poll.operations as Record<string, unknown>[])[0]!;
    assert.equal(envelope.operationId, operationId);
    assert.equal(envelope.workspaceId, f.workspaceId);
    assert.equal(envelope.tabInstanceId, f.lease.tabInstanceId);
    await browser(f, "reply", { operationId, phase: "RUNNING" });
    await browser(f, "reply", {
      operationId,
      phase: "SUCCEEDED",
      result: {
        operationId,
        status: "SUCCEEDED",
        effectState: "VERIFIED",
        data: { marker: f.workspaceId },
      },
    });
    const terminal = await status(f, operationId);
    assert.equal(
      (terminal.data as { data: { marker: string } }).data.marker,
      f.workspaceId,
    );
    return performance.now() - started;
  }
  async function get(path: string) {
    const r = await mf.dispatchFetch(base + path, {
      headers: { Authorization: "Bearer " + admin },
    });
    assert.equal(r.status, 200);
    return (await r.json()) as Record<string, unknown>;
  }
  async function reclaim(f: CapacityFixture) {
    f.lease = await request(
      "/api/v1/tab/claim",
      {
        workspaceId: f.workspaceId,
        binding: f.binding,
        tabInstanceId: "reclaimed-" + crypto.randomUUID(),
        adapterVersion: "1",
      },
      execution,
    );
    return f.lease;
  }
  async function update(path: string, body: unknown) {
    return request(path, body, admin, "PATCH");
  }
  return {
    mf,
    update,
    fixtures,
    browser,
    admit,
    status,
    cycle,
    request,
    get,
    reclaim,
    internal,
    registry,
    wns,
    close: () => mf.dispose(),
  };
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}
