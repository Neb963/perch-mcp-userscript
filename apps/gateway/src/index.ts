import { projectMcpImages, type McpImageBlock } from "./mcp-media.js";
import {
  OAuthAuthorizationServer,
  OAuthResourceServer,
  AuthorizationError,
  OAuthError,
  authorizationErrorRedirect,
  type AuthRequest,
} from "@cloudflare/workers-oauth-provider";
import {
  Server,
  WebStandardStreamableHTTPServerTransport,
  createMcpHandler,
  isLegacyRequest,
  type Tool,
} from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import {
  toolDefinitions,
  validateToolCall,
  ToolError,
  permissionsForTool,
} from "../../../packages/contracts/src/index.js";
import {
  ApiError,
  MAX_BODY,
  VERSION,
  errorResponse,
  json,
  origin,
  parseBody,
  registry,
  rpc,
  workspace,
  type Env,
} from "./common.js";
import type { AuthProps, WorkspaceRecord, AgentRecord } from "./registry.js";
import type { ExecutionContext } from "@cloudflare/workers-types";
export { Registry } from "./registry.js";
export { Workspace } from "./workspace.js";
interface Configuration {
  issuer: string | null;
  paired: boolean;
  resources: string[];
}
/**
 * Privileged installation routes remain Perchance-origin-only.
 *
 * OAuth discovery, registration, authorization and token exchange (and MCP
 * resource requests) are intentionally cross-origin protocols. ChatGPT web
 * clients can send Origin: https://chatgpt.com. That origin is not an
 * authorization credential: OAuth PKCE, Grant checks and bearer validation
 * remain authoritative. Allow the known client origins on public endpoints
 * only, not on admin/tab/approval management routes.
 */
export function allowedOrigin(
  request: Request,
  env: Env,
  issuer?: string | null,
): boolean {
  const o = request.headers.get("origin");
  if (!o) return true;
  if (
    o === "https://perchance.org" ||
    o === issuer ||
    o === new URL(request.url).origin ||
    (env.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .includes(o)
  ) return true;
  const pathname = new URL(request.url).pathname;
  const publicProtocolPath =
    pathname === "/authorize" ||
    pathname === "/register" ||
    pathname === "/token" ||
    pathname === "/revoke" ||
    pathname.startsWith("/.well-known/") ||
    /^\/mcp\/[a-zA-Z0-9_-]+$/.test(pathname);
  return publicProtocolPath &&
    (o === "https://chatgpt.com" || o === "https://chat.openai.com");
}
function cors(
  response: Response,
  request: Request,
  env: Env,
  issuer?: string | null,
): Response {
  const o = request.headers.get("origin");
  const headers = new Headers(response.headers);
  if (o && allowedOrigin(request, env, issuer)) {
    headers.set("Access-Control-Allow-Origin", o);
    headers.set("Vary", "Origin");
    headers.set(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type, Idempotency-Key, MCP-Protocol-Version, MCP-Session-Id, Mcp-Method, Mcp-Name",
    );
    headers.set(
      "Access-Control-Allow-Methods",
      "GET, POST, PATCH, PUT, DELETE, OPTIONS",
    );
    headers.set(
      "Access-Control-Expose-Headers",
      "WWW-Authenticate, MCP-Session-Id",
    );
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
function escape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
function html(body: string): Response {
  return new Response(
    '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Perch MCP authorization</title><style>body{font:16px system-ui;max-width:48rem;margin:3rem auto;padding:1rem}code{font-weight:bold}dt{font-weight:bold}dd{overflow-wrap:anywhere}button,a{padding:.5rem}</style><main>' +
      body +
      "</main></html>",
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
function oauthServer(config: Configuration) {
  if (!config.issuer)
    throw new ApiError(
      "SETUP_REQUIRED",
      "Pair the gateway before connector configuration.",
      503,
    );
  return new OAuthAuthorizationServer<Env>({
    issuer: config.issuer,
    resources: config.resources.length
      ? config.resources
      : [config.issuer + "/mcp/unassigned"],
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    scopesSupported: ["mcp", "offline_access"],
    accessTokenTTL: 900,
    refreshTokenTTL: 30 * 86400,
    clientIdMetadataDocumentEnabled: true,
    clientIdMetadataDocumentFallback: false,
    tokenExchangeCallback: async (options) => {
      try {
        await rpc(registry(options.env), "/internal/authorize", {
          props: options.props,
          agentId: options.props.agentId,
          permissions: [],
        });
      } catch (error) {
        throw new OAuthError(
          error instanceof ApiError &&
            ["REVOKED", "AUTH_REQUIRED", "NOT_FOUND"].includes(error.code)
            ? "invalid_grant"
            : "temporarily_unavailable",
          {
            description:
              "Grant is unavailable under current assignment or policy.",
          },
        );
      }
    },
    onError: () => undefined,
  });
}
function capabilityAvailable(name: string, env: Env): boolean {
  if (name === "generate_music")
    return (
      env.PAID_MEDIA_ENABLED === "true" &&
      !!env.ELEVENLABS_API_KEY &&
      env.PROVIDER_WRITES_ENABLED === "true"
    );
  return ![
    "generate_music",
    "download_server_plugin_state",
    "upload_server_plugin_state",
    "capture_page_image",
    "create_generator",
    "rename_generator",
    "duplicate_generator",
    "set_listing",
    "delete_generator",
    "upload_file",
    "generate_image",
  ].includes(name);
}
async function mcp(
  request: Request,
  env: Env,
  props: AuthProps,
  agentId: string,
): Promise<Response> {
  const authorized = await rpc<{
    workspace: WorkspaceRecord;
    agent: AgentRecord;
  }>(registry(env), "/internal/authorize", { props, agentId, permissions: [] });
  const factory = () => {
    const server = new Server(
      { name: "perch-mcp", version: VERSION },
      {
        capabilities: { tools: {} },
        supportedProtocolVersions: ["2026-07-28", "2025-11-25", "2025-06-18"],
        instructions:
          "Call workspace_status then get_instructions and list_skills. Browser tools return durable operation handles; poll operation_status until terminal. Unknown effects must be reconciled, never replayed. Tools marked unavailable remain release blockers.",
        jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
      },
    );
    server.setRequestHandler("tools/list", () => ({
      tools: toolDefinitions.map(
        (t) =>
          ({
            name: t.name,
            description:
              t.description +
              (capabilityAvailable(t.name, env)
                ? t.browser
                  ? " Requires a connected matching Workspace and native feature detection; inspect workspace_status. Gateway enablement is not external acceptance evidence."
                  : ""
                : " UNAVAILABLE in this candidate: authorized provider interface remains unverified. Do not call expecting success."),
            inputSchema: t.inputSchema,
            annotations: t.annotations,
            _meta: t.browser
              ? {
                  gatewayEnabled: capabilityAvailable(t.name, env),
                  availability: capabilityAvailable(t.name, env)
                    ? "workspace-probe-required"
                    : "unavailable",
                }
              : { available: true },
          }) as unknown as Tool,
      ),
    }));
    server.setRequestHandler("tools/call", async (req) => {
      let data: unknown;
      let isError = false;
      let imageContent: McpImageBlock[] = [];
      try {
        const args = validateToolCall(
            req.params.name,
            req.params.arguments ?? {},
          ),
          definition = toolDefinitions.find((t) => t.name === req.params.name)!;
        const needed = permissionsForTool(req.params.name, args);
        const auth = await rpc<{
          workspace: WorkspaceRecord;
          grant: { permissions: string[] };
        }>(registry(env), "/internal/authorize", {
          props,
          agentId,
          permissions: needed,
          mutating: definition.mutating,
        });
        if (
          req.params.name === "operation_status" ||
          req.params.name === "cancel_operation"
        )
          data = await rpc(
            workspace(env, auth.workspace.id),
            req.params.name === "operation_status"
              ? "/internal/status"
              : "/internal/cancel",
            {
              workspaceId: auth.workspace.id,
              operationId: args.operationId,
              bindingRevision: auth.workspace.bindingRevision,
              agentId,
            },
          );
        else if (!definition.browser)
          data = await rpc(registry(env), "/internal/resource-tool", {
            props,
            agentId,
            permissions: needed,
            tool: req.params.name,
            args,
          });
        else if (!capabilityAvailable(req.params.name, env))
          throw new ApiError(
            "UNSUPPORTED_INTERFACE",
            "Capability is unavailable pending an authorized verified native/provider implementation.",
            409,
            "See the release evidence report; do not substitute a non-equivalent result.",
          );
        else
          data = await rpc(
            workspace(env, auth.workspace.id),
            "/internal/admit",
            {
              workspace: auth.workspace,
              props,
              agentId,
              tool: req.params.name,
              args,
              permissions: auth.grant.permissions.filter((p) =>
                auth.workspace.permissions.includes(p),
              ),
              requiredPermissions: needed,
              mutating: definition.mutating,
            },
          );
        if (req.params.name === "operation_status") {
          const projected = projectMcpImages(data);
          data = projected.data;
          imageContent = projected.images;
        }
      } catch (error) {
        imageContent = [];
        isError = true;
        data = {
          status: "REJECTED",
          effectState: "NONE",
          error: {
            code:
              error instanceof ApiError || error instanceof ToolError
                ? error.code
                : "INTERNAL_ERROR",
            message:
              error instanceof ApiError || error instanceof ToolError
                ? error.message
                : "Tool request failed.",
            retryable: false,
            recovery:
              "Inspect workspace_status and operation_status; do not replay an unknown effect.",
          },
        };
      }
      if (new TextEncoder().encode(JSON.stringify(data)).byteLength > 262144) {
        isError = true;
        imageContent = [];
        data = {
          status: "REJECTED",
          effectState: "NONE",
          error: {
            code: "LIMIT_EXCEEDED",
            message:
              "Result exceeds inline MCP budget; use paged reads or local artifact download.",
            retryable: false,
            recovery:
              "Use read_documentation offset/limit or the manager artifact download.",
          },
        };
      }
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data) },
          ...imageContent,
        ],
        structuredContent: data as Record<string, unknown>,
        isError,
      };
    });
    return server;
  };
  // The SDK's classifier owns malformed-modern behavior; never guess from one header.
  if (
    await isLegacyRequest(request, undefined, { maxRequestBodySize: MAX_BODY })
  ) {
    const server = factory();
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
      maxRequestBodySize: MAX_BODY,
      supportedProtocolVersions: ["2025-11-25", "2025-06-18"],
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  }
  const modern = createMcpHandler(factory, {
    legacy: "reject",
    responseMode: "auto",
    maxRequestBodySize: MAX_BODY,
  });
  return modern.fetch(request);
}
async function route(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const u = new URL(request.url),
    path = u.pathname;
  if (path === "/health")
    return registry(env).fetch(
      new Request("https://internal/internal/health") as never,
    ) as unknown as Promise<Response>;
  if (path === "/setup")
    return html(
      "<h1>Perch MCP gateway</h1><p>Install the userscript in Firefox with Violentmonkey. Open its Settings, enter this gateway origin and the dashboard bootstrap secret. The URL grants no access.</p><p>This candidate requires the live acceptance checklist before a full release.</p>",
    );
  if (path.startsWith("/api/v1/admin/")) {
    if (/^\/api\/v1\/admin\/workspaces\/[^/]+\/resolve$/.test(path)) {
      const check = new Request(new URL("/api/v1/admin/state", request.url), {
        headers: request.headers,
      });
      const authenticated = (await registry(env).fetch(
        check as never,
      )) as unknown as Response;
      if (!authenticated.ok) return authenticated;
      const b = await parseBody(request.clone());
      const workspaceId = path.split("/")[5]!;
      const op = await rpc(workspace(env, workspaceId), "/internal/status", {
        workspaceId,
        operationId: b.operationId,
      });
      if (
        op.epoch !== b.epoch ||
        op.bindingRevision !== b.bindingRevision ||
        !["UNKNOWN", "PARTIAL"].includes(String(op.status))
      )
        throw new ApiError(
          "APPROVAL_REQUIRED",
          "Exact unresolved operation metadata required.",
          409,
        );
    }
    const response = (await registry(env).fetch(
      request as never,
    )) as unknown as Response;
    if (
      response.ok &&
      /^\/api\/v1\/admin\/workspaces\/[^/]+\/resolve$/.test(path)
    ) {
      const resolution = (await response.json()) as Record<string, unknown>;
      const outcome = await rpc(
        workspace(env, String(resolution.workspaceId)),
        "/internal/resolve",
        resolution,
      );
      return json(outcome);
    }
    return response;
  }
  if (path.startsWith("/api/v1/tab/")) {
    const clone = request.clone(),
      body = await parseBody(clone);
    if (
      typeof body.workspaceId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(body.workspaceId)
    )
      throw new ApiError("INVALID_INPUT", "Workspace ID required.");
    return workspace(env, body.workspaceId).fetch(
      request as never,
    ) as unknown as Promise<Response>;
  }
  const config = await rpc<Configuration>(registry(env), "/internal/config");
  if (!config.issuer || u.origin !== config.issuer)
    throw new ApiError(
      "SETUP_REQUIRED",
      "Gateway canonical issuer is not configured for this origin.",
      503,
    );
  const authorizationServer = oauthServer(config);
  if (path === "/authorize") {
    const oauth = authorizationServer.getOAuthApi(env);
    let auth: AuthRequest;
    try {
      auth = await oauth.parseAuthRequest(request);
    } catch (error) {
      if (error instanceof AuthorizationError) {
        if (error.redirectTo) return Response.redirect(error.redirectTo, 302);
        return html(
          "<h1>Authorization refused</h1><p>" + escape(error.message) + "</p>",
        );
      }
      throw error;
    }
    if (auth.codeChallengeMethod !== "S256" || !auth.codeChallenge)
      throw new ApiError(
        "INVALID_INPUT",
        "PKCE S256 is required for every connector.",
      );
    if (auth.scope.some((s) => !["mcp", "offline_access"].includes(s)))
      throw new ApiError("SCOPE_DENIED", "Unsupported OAuth scope.", 403);
    const pending = await rpc<{
      id: string;
      code: string;
      handle: string;
      agentLabel: string;
      workspaceLabel: string;
      clientId: string;
      redirectUri: string;
      scope: string[];
    }>(registry(env), "/internal/oauth/pending", { request: auth });
    return html(
      "<h1>Approve in Perch MCP</h1><p>Open Perch MCP → Agents in the Perchance editor and match code <code>" +
        escape(pending.code) +
        "</code>.</p><dl><dt>Agent</dt><dd>" +
        escape(pending.agentLabel) +
        "</dd><dt>Workspace</dt><dd>" +
        escape(pending.workspaceLabel) +
        "</dd><dt>Client</dt><dd>" +
        escape(pending.clientId) +
        "</dd><dt>Callback</dt><dd>" +
        escape(pending.redirectUri) +
        "</dd><dt>Scopes</dt><dd>" +
        escape(pending.scope.join(" ")) +
        '</dd></dl><form method="POST" action="/authorize/complete"><input type="hidden" name="id" value="' +
        escape(pending.id) +
        '"><input type="hidden" name="handle" value="' +
        escape(pending.handle) +
        '"><button type="submit">Continue after approval</button></form><p>Expires in five minutes. Do not approve a request you did not initiate.</p>',
    );
  }
  if (path === "/authorize/complete") {
    if (request.method !== "POST")
      throw new ApiError("INVALID_INPUT", "POST required.", 405);
    const o = request.headers.get("origin");
    if (o !== config.issuer)
      throw new ApiError(
        "SCOPE_DENIED",
        "Same-origin authorization completion required.",
        403,
      );
    if (Number(request.headers.get("content-length") ?? 0) > 4096)
      throw new ApiError(
        "LIMIT_EXCEEDED",
        "Authorization form too large.",
        413,
      );
    if (
      !request.headers
        .get("content-type")
        ?.startsWith("application/x-www-form-urlencoded")
    )
      throw new ApiError(
        "INVALID_INPUT",
        "URL-encoded authorization form required.",
        415,
      );
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader)
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > 4096) {
          await reader.cancel();
          throw new ApiError(
            "LIMIT_EXCEEDED",
            "Authorization form too large.",
            413,
          );
        }
        chunks.push(next.value);
      }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const form = new URLSearchParams(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (
      [...form.keys()].some((k) => !["id", "handle"].includes(k)) ||
      form.getAll("id").length !== 1 ||
      form.getAll("handle").length !== 1
    )
      throw new ApiError(
        "INVALID_INPUT",
        "Exact authorization handle required.",
      );
    let result: {
      state: string;
      request?: AuthRequest;
      grant?: { id: string; permissions: string[] };
      props?: AuthProps;
    };
    try {
      result = await rpc<typeof result>(registry(env), "/internal/oauth/consume", {
        id: form.get("id"),
        handle: form.get("handle"),
      });
    } catch (error) {
      if (error instanceof ApiError && error.code === "EXPIRED")
        return html(
          "<h1>Authorization expired</h1><p>The five-minute approval window has closed. Restart connector authorization from ChatGPT; do not retry an expired code.</p>",
        );
      throw error;
    }
    if (result.state === "pending")
      // Preserve the one-time authorization handle so an early click can be
      // retried in place; never require browser Back or a new OAuth flow.
      return html(
        '<h1>Approval pending</h1><p>Open Perch MCP → Agents and approve the matching request. Return here and check again.</p>' +
          '<form method="POST" action="/authorize/complete"><input type="hidden" name="id" value="' +
          escape(form.get("id") ?? "") +
          '"><input type="hidden" name="handle" value="' +
          escape(form.get("handle") ?? "") +
          '"><button type="submit">Check approval again</button></form>' +
          "<p>Requests expire five minutes after they are created.</p>",
      );
    if (result.state === "denied" && result.request)
      return Response.redirect(
        authorizationErrorRedirect(result.request, "access_denied"),
        302,
      );
    if (result.state !== "approved" || !result.request || !result.props)
      return html(
        "<h1>Authorization denied or consumed</h1><p>Start connector authorization again if needed.</p>",
      );
    const completed = await authorizationServer
      .getOAuthApi(env)
      .completeAuthorization({
        request: result.request,
        userId: "operator",
        metadata: {
          grantId: result.props.grantId,
          agentId: result.props.agentId,
        },
        scope: [
          "mcp",
          ...(result.request.scope.includes("offline_access")
            ? ["offline_access"]
            : []),
        ],
        props: result.props,
        revokeExistingGrants: false,
      });
    return Response.redirect(completed.redirectTo, 302);
  }
  const match =
    /^\/(?:\.well-known\/oauth-protected-resource\/)?mcp\/([a-zA-Z0-9_-]+)$/.exec(
      path,
    );
  if (match) {
    const agentId = match[1]!,
      resource = config.issuer + "/mcp/" + agentId;
    if (!config.resources.includes(resource))
      throw new ApiError("NOT_FOUND", "Agent endpoint is unavailable.", 404);
    const host = new OAuthResourceServer<Env, AuthProps>({
      resourceMetadata: { resource, authorization_servers: [config.issuer] },
      requiredScopes: ["mcp"],
      validateToken: () => async (resource, token) => {
        const result = await authorizationServer.validateToken<AuthProps>(
          resource,
          token,
          env,
        );
        if (!result) return null;
        return result;
      },
      handler: {
        fetch: (req, _env, context) => mcp(req, env, context.props, agentId),
      },
    });
    return host.fetch(request, env, ctx as never);
  }
  if (path === "/register" && request.method === "POST")
    await rpc(registry(env), "/internal/registration-budget", {});
  return authorizationServer.fetch(request, env, ctx as never);
}
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    let issuer: string | null = env.ISSUER_URL ?? null;
    try {
      if (!allowedOrigin(request, env, issuer))
        throw new ApiError("SCOPE_DENIED", "Origin is not allowed.", 403);
      if (request.method === "OPTIONS")
        return cors(new Response(null, { status: 204 }), request, env, issuer);
      const response = await route(request, env, ctx);
      return cors(response, request, env, issuer);
    } catch (error) {
      return cors(errorResponse(error), request, env, issuer);
    }
  },
};
