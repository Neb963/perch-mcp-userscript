import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
let mf: Miniflare;
const base = "https://gateway.test";
const bootstrap = "fixture-bootstrap-".padEnd(64, "x");
let admin = "",
  execution = "";
let w: Record<string, unknown>, a: Record<string, unknown>;
let lease: Record<string, unknown>;
let token = "";
async function request(
  path: string,
  body?: unknown,
  credential = admin,
  method = body === undefined ? "GET" : "POST",
  extra: Record<string, string> = {},
) {
  return mf.dispatchFetch(base + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(credential ? { Authorization: "Bearer " + credential } : {}),
      "Idempotency-Key": crypto.randomUUID(),
      ...extra,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function data(
  path: string,
  body?: unknown,
  credential = admin,
  method?: string,
) {
  const r = await request(path, body, credential, method);
  const b = (await r.json()) as Record<string, unknown>;
  assert.equal(r.status, 200, JSON.stringify(b));
  return b;
}
async function mcp(
  name: string,
  args: Record<string, unknown> = {},
  access = token,
  endpoint = String(a.id),
) {
  const r = await request(
    "/mcp/" + endpoint,
    {
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: { name, arguments: args },
    },
    access,
    "POST",
    {
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-11-25",
    },
  );
  const raw = await r.text();
  if (r.status < 400) assert.ok(raw, `MCP ${name} empty response ${r.status}`);
  return {
    status: r.status,
    body: (raw ? JSON.parse(raw) : {}) as {
      result?: { structuredContent: Record<string, unknown>; isError: boolean };
      error?: unknown;
    },
  };
}
before(async () => {
  const result = await build({
    entryPoints: ["apps/gateway/src/index.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["cloudflare:*", "node:*"],
    conditions: ["workerd", "worker", "browser"],
  });
  mf = new Miniflare({
    modules: true,
    script: result.outputFiles[0]!.text,
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
    },
  });
  await mf.ready;
});
after(async () => {
  await mf?.dispose();
});
test("bootstrap, admin authentication, idempotency, native binding and Agent isolation", async () => {
  const health = await data("/health", undefined, "");
  assert.equal(health.paired, false);
  assert.equal(
    (await request("/api/v1/admin/state", undefined, "")).status,
    401,
  );
  assert.equal(
    (
      await request(
        "/api/v1/admin/pair",
        {
          bootstrapSecret: "wrong".padEnd(64, "x"),
          browserInstallationId: "browser-fixture",
        },
        "",
      )
    ).status,
    401,
  );
  const pair = await data(
    "/api/v1/admin/pair",
    { bootstrapSecret: bootstrap, browserInstallationId: "browser-fixture" },
    "",
  );
  admin = String(pair.adminCredential);
  execution = String(pair.executionCredential);
  assert.equal(
    (
      await request(
        "/api/v1/admin/pair",
        {
          bootstrapSecret: bootstrap,
          browserInstallationId: "browser-fixture",
        },
        "",
      )
    ).status,
    409,
  );
  const key = crypto.randomUUID();
  const first = await request(
    "/api/v1/admin/workspaces",
    { label: "First" },
    admin,
    "POST",
    { "Idempotency-Key": key },
  );
  w = (await first.json()) as Record<string, unknown>;
  assert.equal(first.status, 200);
  const repeat = await request(
    "/api/v1/admin/workspaces",
    { label: "First" },
    admin,
    "POST",
    { "Idempotency-Key": key },
  );
  assert.deepEqual(await repeat.json(), w);
  assert.equal(
    (
      await request(
        "/api/v1/admin/workspaces",
        { label: "Other" },
        admin,
        "POST",
        { "Idempotency-Key": key },
      )
    ).status,
    409,
  );
  const bind = {
    generatorId: "123",
    slug: "fixture-one",
    draftId: "",
    browserInstallationId: "browser-fixture",
  };
  w = await data("/api/v1/admin/workspaces/" + w.id + "/bind", {
    expectedRevision: w.revision,
    binding: bind,
  });
  a = await data("/api/v1/admin/agents", {
    workspaceId: w.id,
    label: "Agent one",
  });
  lease = await data(
    "/api/v1/tab/claim",
    {
      workspaceId: w.id,
      binding: bind,
      tabInstanceId: "tab-one",
      adapterVersion: "1",
    },
    execution,
  );
  assert.equal(
    (
      await request(
        "/api/v1/tab/claim",
        {
          workspaceId: w.id,
          binding: bind,
          tabInstanceId: "tab-clone",
          adapterVersion: "1",
        },
        execution,
      )
    ).status,
    409,
  );
  const second = await data("/api/v1/admin/workspaces", { label: "Second" });
  await data("/api/v1/admin/workspaces/" + second.id + "/bind", {
    expectedRevision: second.revision,
    binding: { ...bind, generatorId: "456", slug: "fixture-two" },
  });
  const a2 = await data("/api/v1/admin/agents", {
    workspaceId: second.id,
    label: "Agent two",
  });
  assert.notEqual(a2.endpoint, a.endpoint);
  assert.equal(
    (await request("/api/v1/admin/state", undefined, execution)).status,
    401,
  );
});
test("OAuth S256 approval, exact resource audience and MCP tool-only library", async () => {
  const registration = await request(
    "/register",
    {
      client_name: "Fixture connector",
      redirect_uris: ["https://client.example/callback"],
      token_endpoint_auth_method: "none",
    },
    "",
    "POST",
    { Origin: "https://chatgpt.com" },
  );
  const client = (await registration.json()) as { client_id: string };
  assert.equal(registration.status, 201, JSON.stringify(client));
  const verifier = "verifier-".padEnd(64, "v"),
    challenge = Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ).toString("base64url");
  const params = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: "https://client.example/callback",
    response_type: "code",
    scope: "mcp offline_access",
    state: "state-fixture",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: String(a.endpoint),
  });
  const authorize = await request("/authorize?" + params, undefined, "", "GET", { Origin: "https://chatgpt.com" });
  const page = await authorize.text();
  assert.equal(authorize.status, 200, page);
  assert.equal(authorize.headers.get("Referrer-Policy"), "origin", "form navigation must preserve a real Origin");
  const approvalId = /name="id" value="([^"]+)"/.exec(page)?.[1];
  const handle = /name="handle" value="([^"]+)"/.exec(page)?.[1];
  assert.ok(approvalId && handle);
  const pending = await data("/api/v1/admin/approvals");
  const approval = (pending.items as Record<string, unknown>[]).find(
    (x) => x.id === approvalId,
  )!;
  assert.ok(!("handleHash" in approval));
  assert.equal(
    (
      await request("/api/v1/admin/approvals/" + approvalId + "/decision", {
        expectedRevision: approval.revision,
        digest: "wrong",
        decision: "approve",
      })
    ).status,
    409,
  );
  const hostileCompletion = await mf.dispatchFetch(base + "/authorize/complete", {
    method: "POST",
    headers: {
      Origin: "https://evil.example",
      "Content-Type": "application/x-www-form-urlencoded",
      "Sec-Fetch-Site": "cross-site",
    },
    body: new URLSearchParams({ id: approvalId, handle }),
  });
  assert.equal(hostileCompletion.status, 403, "foreign origin cannot consume an approval");
  const opaqueCrossSite = await mf.dispatchFetch(base + "/authorize/complete", {
    method: "POST",
    headers: {
      Origin: "null",
      "Content-Type": "application/x-www-form-urlencoded",
      "Sec-Fetch-Site": "cross-site",
    },
    body: new URLSearchParams({ id: approvalId, handle }),
  });
  assert.equal(opaqueCrossSite.status, 403, "cross-site opaque origin is rejected");
  const early = await mf.dispatchFetch(base + "/authorize/complete", {
    method: "POST",
    headers: {
      Origin: "null",
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ id: approvalId, handle }),
  });
  assert.equal(early.status, 200);
  const earlyHtml = await early.text();
  assert.match(earlyHtml, /Check approval again/);
  assert.equal(early.headers.get("Referrer-Policy"), "origin");
  assert.match(earlyHtml, /name="handle"/);
  assert.ok(!earlyHtml.includes(String(approval.digest)), "pending form does not expose the approval digest");
  await data("/api/v1/admin/approvals/" + approvalId + "/decision", {
    expectedRevision: approval.revision,
    digest: approval.digest,
    decision: "approve",
  });
  const complete = await mf.dispatchFetch(base + "/authorize/complete", {
    redirect: "manual",
    method: "POST",
    headers: {
      Origin: "null",
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ id: approvalId, handle }),
  });
  assert.equal(complete.status, 302, await complete.clone().text());
  // Server-side audit must survive navigation: OAuth events are not ordinary
  // MCP Activity records. The event itself must not contain the one-time handle.
  let oauthAudit: Record<string, unknown> = {};
  for (let attempt = 0; attempt < 30; attempt++) {
    oauthAudit = await data("/api/v1/admin/diagnostics");
    const rows = oauthAudit.events as Record<string, unknown>[];
    if (rows?.some((row) =>
      row.route === "authorize_complete" && row.originClass === "null" &&
      row.status === 302 && row.code === "CALLBACK_REDIRECT_ISSUED")) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const auditRows = oauthAudit.events as Record<string, unknown>[];
  assert.ok(auditRows?.some((row) => row.route === "authorize_complete" && row.originClass === "null" && row.status === 302));
  assert.ok(auditRows?.some((row) => row.route === "authorize_complete" && row.code === "SCOPE_DENIED" && row.originClass === "other"));
  assert.ok(!JSON.stringify(oauthAudit).includes(handle), "authorization handles never enter diagnostic history");
  const callback = new URL(complete.headers.get("location")!);
  assert.equal(complete.headers.get("Cache-Control"), "no-store");
  const grantsBeforeReplay = await data("/api/v1/admin/grants");
  // Reproduce LibreWolf: browser receives a 302 but navigation is suppressed
  // by a routing/privacy extension. A second click MUST recover the *same*
  // callback without consuming the request twice or minting a new Grant.
  const replay = await mf.dispatchFetch(base + "/authorize/complete", {
    method: "POST",
    headers: {
      Origin: base,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ id: approvalId, handle }),
    redirect: "manual",
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get("X-Perch-OAuth-Outcome"), "CALLBACK_RECOVERY_AVAILABLE");
  const recoveryPage = await replay.text();
  assert.match(recoveryPage, /Continue to ChatGPT/);
  assert.match(recoveryPage, /referrerpolicy="no-referrer"/);
  assert.match(recoveryPage, /rel="noreferrer"/);
  assert.ok(recoveryPage.includes(callback.href.replaceAll("&", "&amp;")), "replay must offer the exact original OAuth callback");
  const replayAgain = await mf.dispatchFetch(base + "/authorize/complete", {
    method: "POST",
    headers: {
      Origin: base, "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ id: approvalId, handle }),
    redirect: "manual",
  });
  assert.equal(replayAgain.status, 200);
  assert.equal(await replayAgain.text(), recoveryPage, "recovery link remains deterministic");
  assert.deepEqual(await data("/api/v1/admin/grants"), grantsBeforeReplay, "no second grant or revision on replay");
  const badHandle = await mf.dispatchFetch(base + "/authorize/complete", {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ id: approvalId, handle: handle + "x" }),
    redirect: "manual",
  });
  assert.equal(badHandle.status, 401, "unrelated authorization handles cannot recover the code");
  assert.equal(callback.searchParams.get("state"), "state-fixture");
  assert.equal(callback.searchParams.get("iss"), base);
  const exchange = await mf.dispatchFetch(base + "/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://chatgpt.com" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.client_id,
      redirect_uri: "https://client.example/callback",
      code: callback.searchParams.get("code")!,
      code_verifier: verifier,
      resource: String(a.endpoint),
    }),
  });
  const exchangeRaw = await exchange.text();
  assert.ok(exchangeRaw, `Token exchange empty ${exchange.status}`);
  const issued = JSON.parse(exchangeRaw) as { access_token: string };
  assert.equal(exchange.status, 200, JSON.stringify(issued));
  // Redirect issuance is not proof of ChatGPT receiving a token.
  // A completed exchange is explicitly identifiable in the bounded audit.
  let tokenAudit: Record<string, unknown>[] = [];
  for (let attempt = 0; attempt < 30; attempt++) {
    const audit = await data("/api/v1/admin/diagnostics");
    tokenAudit = audit.events as Record<string, unknown>[];
    if (tokenAudit.some((row) => row.route === "token" && row.code === "TOKEN_EXCHANGE_SUCCEEDED")) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(tokenAudit.some((row) => row.route === "token" && row.code === "TOKEN_EXCHANGE_SUCCEEDED"));
  assert.ok(tokenAudit.some((row) => row.route === "authorize_complete" && row.code === "CALLBACK_RECOVERY_AVAILABLE"));
  assert.ok(!JSON.stringify(tokenAudit).includes(callback.searchParams.get("code")!),
    "diagnostic audit must never expose authorization codes");
  token = issued.access_token;
  assert.ok(token);
  const initialized = await request(
    "/mcp/" + a.id,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "fixture", version: "1" },
      },
    },
    token,
    "POST",
    { Accept: "application/json, text/event-stream" },
  );
  assert.equal(initialized.status, 200);
  const initializeRaw = await initialized.text();
  assert.ok(initializeRaw, "Initialize response empty");
  assert.equal(
    (JSON.parse(initializeRaw) as { result: { protocolVersion: string } })
      .result.protocolVersion,
    "2025-11-25",
  );
  const skills = await mcp("list_skills");
  assert.equal(skills.status, 200);
  assert.equal(
    (skills.body.result?.structuredContent.items as unknown[]).length,
    11,
  );
  const skill = await mcp("skill", { id: "perchance-platform" });
  assert.match(String(skill.body.result?.structuredContent.body), /Perchance/);
  const agents = await data("/api/v1/admin/agents");
  const other = (agents.items as Record<string, unknown>[]).find(
    (x) => x.id !== a.id,
  )!;
  const swapped = await mcp("workspace_status", {}, token, String(other.id));
  assert.equal(swapped.status, 401);
  const forged = await mcp("read", {
    path: "main.pjs",
    workspaceId: "another",
  });
  assert.equal(forged.body.result?.isError, true);
});
test("2026-07-28 per-request discovery, tool delivery and header/envelope rejection", async () => {
  async function modern(
    method: string,
    params: Record<string, unknown> = {},
    overrides: Record<string, string> = {},
  ) {
    const result = await request(
      "/mcp/" + a.id,
      {
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": {
              name: "modern-fixture",
              version: "1",
            },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      },
      token,
      "POST",
      {
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": method,
        ...(params.name ? { "Mcp-Name": String(params.name) } : {}),
        ...overrides,
      },
    );
    const raw = await result.text();
    return {
      status: result.status,
      body: JSON.parse(raw) as Record<string, unknown>,
    };
  }
  const discovered = await modern("server/discover");
  assert.equal(discovered.status, 200, JSON.stringify(discovered.body));
  assert.ok(
    (
      discovered.body.result as { supportedVersions: string[] }
    ).supportedVersions.includes("2026-07-28"),
  );
  const tools = await modern("tools/list");
  assert.equal(tools.status, 200, JSON.stringify(tools.body));
  assert.ok((tools.body.result as { tools: unknown[] }).tools.length > 40);
  const skills = await modern("tools/call", {
    name: "list_skills",
    arguments: {},
  });
  assert.equal(skills.status, 200, JSON.stringify(skills.body));
  const result = skills.body.result as {
    structuredContent: { items: unknown[] };
    resultType?: string;
  };
  assert.equal(result.structuredContent.items.length, 11);
  // Transport fixture only: this injection does not establish browser image decoding evidence.
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6N2sAAAAASUVORK5CYII=";
  const image = await mcp("read_image", { file_path: "scratch/pixel.png" }),
    operationId = String(image.body.result?.structuredContent.operationId),
    context = {
      workspaceId: w.id,
      epoch: lease.epoch,
      tabInstanceId: lease.tabInstanceId,
    },
    leaseToken = String(lease.leaseCredential);
  await data("/api/v1/tab/poll", { ...context, waitMs: 0 }, leaseToken);
  await data(
    "/api/v1/tab/reply",
    {
      ...context,
      operationId,
      phase: "SUCCEEDED",
      result: {
        operationId,
        status: "SUCCEEDED",
        effectState: "VERIFIED",
        data: {
          path: "scratch/pixel.png",
          width: 1,
          height: 1,
          mimeType: "image/png",
          content: [{ type: "image", mimeType: "image/png", data: png }],
        },
      },
    },
    leaseToken,
  );
  const imageStatus = await modern("tools/call", {
    name: "operation_status",
    arguments: { operationId },
  });
  assert.equal(imageStatus.status, 200);
  const imageResult = imageStatus.body.result as {
    content: {
      type: string;
      text?: string;
      data?: string;
      mimeType?: string;
    }[];
    structuredContent: unknown;
  };
  assert.equal(imageResult.content[1]?.type, "image");
  assert.equal(imageResult.content[1]?.mimeType, "image/png");
  assert.equal(imageResult.content[1]?.data, png);
  assert.ok(!imageResult.content[0]?.text?.includes(png));
  assert.ok(!JSON.stringify(imageResult.structuredContent).includes(png));
  const mismatch = await modern(
    "tools/list",
    {},
    { "Mcp-Method": "tools/call" },
  );
  assert.equal(mismatch.status, 400);
  assert.equal((mismatch.body.error as { code: number }).code, -32020);
  const missing = await request(
    "/mcp/" + a.id,
    { jsonrpc: "2.0", id: 12, method: "tools/list", params: {} },
    token,
    "POST",
    {
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/list",
    },
  );
  assert.equal(missing.status, 400);
  const legacy = await request(
    "/mcp/" + a.id,
    {
      jsonrpc: "2.0",
      id: 13,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "older-fixture", version: "1" },
      },
    },
    token,
    "POST",
    { Accept: "application/json, text/event-stream" },
  );
  assert.equal(legacy.status, 200);
  assert.equal(
    ((await legacy.json()) as { result: { protocolVersion: string } }).result
      .protocolVersion,
    "2025-06-18",
  );
});
test("durable browser queue, strict reply identity, terminal result recovery and immediate revocation", async () => {
  const call = await mcp("read", { path: "main.pjs" });
  const operationId = String(call.body.result?.structuredContent.operationId);
  assert.ok(operationId);
  assert.equal(call.body.result?.structuredContent.status, "ADMITTED");
  const auth = String(lease.leaseCredential),
    context = {
      workspaceId: w.id,
      epoch: lease.epoch,
      tabInstanceId: lease.tabInstanceId,
    };
  const poll = await data("/api/v1/tab/poll", { ...context, waitMs: 0 }, auth);
  const operation = (poll.operations as Record<string, unknown>[])[0]!;
  assert.equal(operation.operationId, operationId);
  assert.ok(Array.isArray(operation.permissions));
  assert.equal(
    (
      await request(
        "/api/v1/tab/reply",
        {
          ...context,
          epoch: Number(lease.epoch) + 1,
          operationId,
          phase: "RUNNING",
        },
        auth,
      )
    ).status,
    409,
  );
  await data(
    "/api/v1/tab/reply",
    { ...context, operationId, phase: "RUNNING" },
    auth,
  );
  const terminal = {
    operationId,
    status: "SUCCEEDED",
    effectState: "VERIFIED",
    data: { path: "main.pjs", text: "fixture" },
  };
  await data(
    "/api/v1/tab/reply",
    { ...context, operationId, phase: "SUCCEEDED", result: terminal },
    auth,
  );
  const status = await mcp("operation_status", { operationId });
  assert.equal(status.body.result?.structuredContent.status, "SUCCEEDED");
  assert.equal(
    (status.body.result?.structuredContent.data as { data: { text: string } })
      .data.text,
    "fixture",
  );
  const queued = await mcp("read", { path: "index.html" });
  assert.equal(queued.body.result?.structuredContent.status, "ADMITTED");
  const grants = await data("/api/v1/admin/grants");
  const grant = (grants.items as Record<string, unknown>[])[0]!;
  await data("/api/v1/admin/grants/" + grant.id + "/revoke", {
    expectedRevision: grant.revision,
  });
  const denied = await data(
    "/api/v1/tab/poll",
    { ...context, waitMs: 0 },
    auth,
  );
  assert.equal((denied.operations as unknown[]).length, 0);
  assert.equal((await mcp("list_skills")).status, 403); // Registry overlay rejects immediately, no stale KV authority
});
test("CORS accepts exact editor origin and rejects opaque/hostile origins", async () => {
  const good = await request("/health", undefined, "", "GET", {
    Origin: "https://perchance.org",
  });
  assert.equal(
    good.headers.get("access-control-allow-origin"),
    "https://perchance.org",
  );
  const bad = await request("/health", undefined, "", "GET", {
    Origin: "https://evil.example",
  });
  assert.equal(bad.status, 403);
  assert.equal(bad.headers.get("access-control-allow-origin"), null);
  const opaque = await request("/health", undefined, "", "GET", {
    Origin: "null",
  });
  assert.equal(opaque.status, 403);
});

test("ChatGPT public OAuth/MCP CORS is allowed without exposing private management routes", async () => {
  const origin = "https://chatgpt.com";
  const publicPaths = ["/authorize", "/register", "/token", "/.well-known/oauth-authorization-server", "/mcp/" + a.id, "/.well-known/oauth-protected-resource/mcp/" + a.id];
  for (const path of publicPaths) {
    const response = await mf.dispatchFetch(base + path, {
      method: "OPTIONS",
      headers: { Origin: origin, "Access-Control-Request-Method": "POST" },
    });
    assert.equal(response.status, 204, path);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), origin, path);
  }
  for (const path of ["/api/v1/admin/state", "/api/v1/admin/approvals", "/api/v1/tab/claim", "/authorize/complete"]) {
    const response = await mf.dispatchFetch(base + path, {
      method: "OPTIONS",
      headers: { Origin: origin, "Access-Control-Request-Method": "POST" },
    });
    assert.equal(response.status, 403, "private route " + path);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
    assert.equal((await response.json() as { code: string }).code, "SCOPE_DENIED");
  }
  const hostile = await mf.dispatchFetch(base + "/token", {
    method: "OPTIONS",
    headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" },
  });
  assert.equal(hostile.status, 403);
});
