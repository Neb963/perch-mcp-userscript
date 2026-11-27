import { developmentToolDefinitions, hasEffectV2, parseDevelopmentCall, requiredPermissionsV2,
  type developmentToolArgs } from '../../../packages/contracts/src/development-v2.js';
import { parseTarget } from '../../../packages/contracts/src/target.js';
import { pollWaitMs, paceIdlePoll } from "./poll-pacing.js";
import { validatePushUpgrade } from './push-notifications.js';
import {validateIngress,IngressAdmission,OAuthAuditAdmission} from './ingress.js';
import { projectMcpImages, type McpImageBlock } from "./mcp-media.js";
import { incident, reportIncident, probeRegistryHealth } from "./incident.js";
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
  HAR_NATIVE_ACTIONS,
  permitsHarNativeAction,
  ApiError,
  bearer,
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
import type { ExecutionContext, ScheduledController } from "@cloudflare/workers-types";
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
  // Firefox and Chromium may send Origin:null for ordinary HTML form POSTs
  // under a no-referrer policy. An OAuth completion is authorized by its
  // one-use 256-bit handle and exact server-side approval, not by Origin.
  // Still reject an explicitly cross-site Fetch Metadata request.
  if (
    pathname === "/authorize/complete" &&
    request.method === "POST" &&
    o === "null"
  ) return request.headers.get("sec-fetch-site") !== "cross-site";
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
  // A reconstructed Response discards workerd's socket attachment.
  if(response.status===101)return response;
  const o = request.headers.get("origin");
  const headers = new Headers(response.headers);
  if (o && o !== "null" && allowedOrigin(request, env, issuer)) {
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
function html(body: string, formPost = false): Response {
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
        // origin transmits neither the authorization query nor its handle,
        // and prevents null Origin on same-origin form navigation.
        "Referrer-Policy": formPost ? "origin" : "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
/** Never cache authorization codes and never persist the callback URL in diagnostics. */
function callbackRedirect(url: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: url,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Perch-OAuth-Outcome": "CALLBACK_REDIRECT_ISSUED",
    },
  });
}
function retryCompletionForm(id: string, handle: string, title: string): Response {
  return html(
    "<h1>" + title + "</h1><p>Authorization is still processing. This retry checks the same request; it does not create another Grant or authorization code.</p>" +
      '<form method="POST" action="/authorize/complete"><input type="hidden" name="id" value="' +
      escape(id) + '"><input type="hidden" name="handle" value="' + escape(handle) +
      '"><button type="submit">Check completion again</button></form>',
    true,
  );
}
function manualCallback(url: string): Response {
  // URL was sealed in Registry after the SDK validated the exact client.
  // User-initiated navigation is a fallback when an extension suppresses an
  // HTTP 302; no script, open redirect, cross-origin fetch or token in logs.
  const result = html(
    '<h1>Authorization ready</h1><p>The gateway issued the ChatGPT callback, but the browser did not finish navigating. ' +
      'Use the link below to finish the same authorization. Do not create another approval.</p>' +
      '<p><a rel="noreferrer" referrerpolicy="no-referrer" href="' +
      escape(url) + '">Continue to ChatGPT</a></p>' +
      '<p>If this link is blocked, inspect the browser extension or persona routing policy for ChatGPT. ' +
      'Allow only the intended route; do not turn off privacy enforcement globally. ' +
      'If the code has expired, restart the ChatGPT connector authorization.</p>',
  );
  const headers = new Headers(result.headers);
  headers.set("X-Perch-OAuth-Outcome", "CALLBACK_RECOVERY_AVAILABLE");
  return new Response(result.body, { status: result.status, headers });
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
          ...(options.props.contractVersion === 2 ? { authenticatedClientId: options.clientId } : {}),
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
  if (Object.prototype.hasOwnProperty.call(HAR_NATIVE_ACTIONS,name))
    return env.PROVIDER_WRITES_ENABLED === "true" ||
      permitsHarNativeAction(env,name,[HAR_NATIVE_ACTIONS[name]]);
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
    "duplicate_generator",
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
  if (props.contractVersion === 2) {
    await rpc(registry(env), '/internal/authorize', {
      props, agentId, resource: new URL('/mcp/' + agentId, request.url).href,
    });
    if (env.DEVELOPMENT_CONTRACT_V2_EXECUTION_ENABLED !== 'true')
      throw new ApiError('UPGRADE_REQUIRED', 'The v2 tool catalog is disabled during rollout.', 409);
    return mcpDevelopment(request,env,props,agentId);
  }
  const authorized = await rpc<{
    workspace: WorkspaceRecord;
    agent: AgentRecord;
    grant: { permissions: string[] };
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
        // This immutable snapshot belongs to this MCP request only. Registry
        // already checked grant/assignment/revocation; dispatch/child permits
        // still obtain fresh Registry authority after asynchronous boundaries.
        const auth = authorized;
        if (!needed.every((permission) =>
          auth.grant.permissions.includes(permission) &&
          auth.workspace.permissions.includes(permission)))
          throw new ApiError("SCOPE_DENIED", "Required permission was not granted.", 403);
        if (definition.mutating && needed.some((p) =>
          ["SAVE", "CREATE", "RENAME", "DUPLICATE", "LISTING", "DELETE",
            "UPLOAD_PUBLIC", "MEDIA", "PRODUCTION_RESTORE"].includes(p)) &&
          env.PROVIDER_WRITES_ENABLED !== "true" &&
          !permitsHarNativeAction(env, req.params.name, needed))
          throw new ApiError("UNSUPPORTED_INTERFACE",
            "External provider effects remain disabled until live adapter acceptance.",409);
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
              error instanceof ApiError || error instanceof ToolError ? error.recovery :
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
  return transportMcp(request,factory);
}
async function transportMcp(request: Request, factory: () => Server): Promise<Response> {
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
function mcpDevelopment(request: Request, env: Env, props: AuthProps, agentId: string): Promise<Response> {
  const make = () => {
    const server = new Server({name:'perch-mcp',version:VERSION},{
      capabilities:{tools:{}}, supportedProtocolVersions:['2026-07-28','2025-11-25','2025-06-18'],
      instructions:'Discover assigned Workspaces with workspace_status. Use the explicitly intended canonical Target. Retain operationKey across transport retry. Reconcile uncertain effects before requesting new work.',
      jsonSchemaValidator:new CfWorkerJsonSchemaValidator(),
    });
    server.setRequestHandler('tools/list',()=>({tools:developmentToolDefinitions as unknown as Tool[]}));
    server.setRequestHandler('tools/call',async (incoming)=>{
      let data: Record<string,unknown>, images: McpImageBlock[] = [], isError = false;
      let target: string | undefined;
      try {
        const call = parseDevelopmentCall(incoming.params.name,incoming.params.arguments ?? {});
        target = call.delivery?.target ?? (typeof call.args.target === 'string' ? call.args.target : undefined);
        const inputScope = {props,agentId,...(target ? {target} : {})};
        if (call.name === 'workspace_status' && call.args.verifySource !== true) {
          data = await rpc(registry(env),'/internal/v2/discover',{...inputScope,args:call.args});
        } else {
          const requested = parseTarget(target);
          const resultOp = call.name === 'operation_status' || call.name === 'cancel_operation';
          const name = call.name as keyof typeof developmentToolArgs;
          const verifiedStatus = call.name === 'workspace_status';
          const needed = resultOp ? [] : verifiedStatus ? ['READ_SOURCE'] : requiredPermissionsV2(name,call.args);
          const auth = await rpc<{ workspace: WorkspaceRecord; grant: {permissions:string[]}; policyRevision:number }>(
            registry(env), '/internal/authorize', {...inputScope,permissions:needed,resultAccess:true});
          const stub = workspace(env,requested.workspaceId);
          if (resultOp) {
            data = await rpc(stub, call.name === 'operation_status' ? '/internal/status' : '/internal/cancel', {
              ...inputScope,workspaceId:requested.workspaceId,bindingRevision:auth.workspace.bindingRevision,
              operationId:call.args.operationId,operationKey:call.args.operationKey,
            });
          } else {
            const key = call.delivery?.operationKey ?? ('k2.'+Date.now()+'.'+crypto.randomUUID());
            data = await rpc(stub,'/internal/admit',{
              ...inputScope,workspace:auth.workspace,policyRevision:auth.policyRevision,
              tool:verifiedStatus?'workspace_status_verified':call.name,args:verifiedStatus?{}:call.args,
              operationKey:key,mutating:!verifiedStatus&&hasEffectV2(name,call.args),
              requiredPermissions:needed,permissions:auth.grant.permissions.filter(permission=>auth.workspace.permissions.includes(permission)),
            });
          }
          const projected = projectMcpImages(data);
          data = projected.data as Record<string,unknown>;
          images = projected.images;
          if (new TextEncoder().encode(JSON.stringify(data)).length > 248_000) {
            const {data: _, resolution: __, lateObservation: ___, ...metadata} = data;
            data = {...metadata,resultAvailability:'TOO_LARGE'};
            images=[];
          }
        }
      } catch(error) {
        isError = true;
        data = {contractVersion:2,target:target ?? null,operationId:null,serverTimeMs:Date.now(),
          phase:'REJECTED',effectState:'NONE',result:null,
          error:{code:error instanceof ApiError || error instanceof ToolError ? error.code : 'INTERNAL_ERROR',
            message:error instanceof ApiError || error instanceof ToolError ? error.message : 'Request failed before a receipt was available.',
            retryable:false,
            recovery:error instanceof ApiError || error instanceof ToolError ? error.recovery : 'Reconcile by operationKey before retrying an intent.'}};
      }
      return {content:[{type:'text' as const,text:JSON.stringify(data)},...images],structuredContent:data,isError};
    });
    return server;
  };
  return transportMcp(request,make);
}
async function route(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const u = new URL(request.url),
    path = u.pathname;
  // Liveness must remain available when the Registry Durable Object is failing.
  if (path === "/live")
    return json({ ok: true, version: VERSION, role: "worker-liveness" });
  if (path === "/health") {
    const probe = await probeRegistryHealth(() => registry(env).fetch(
      new Request("https://internal/internal/health") as never,
    ) as unknown as Promise<Response>);
    if (probe.failure?.error)
      reportIncident(env, ctx, incident("worker", "/health", 503,
        probe.failure.error, probe.failure.traceId));
    return probe.response;
  }
  if (path === "/setup")
    return html(
      "<h1>Perch MCP gateway</h1><p>Install the userscript in Firefox with Violentmonkey. Open its Settings, enter this gateway origin and the dashboard bootstrap secret. The URL grants no access.</p><p>This candidate requires the live acceptance checklist before a full release.</p>",
    );
  const migrationMatch=/^\/api\/v1\/admin\/workspaces\/([A-Za-z0-9_-]+)\/storage-migration$/.exec(path);
  if(migrationMatch) {
    if(!["GET","POST"].includes(request.method))
      throw new ApiError("INVALID_INPUT","GET or POST required.",405);
    bearer(request); // Shape only; Registry verifies the current admin credential.
    const authenticated=await registry(env).fetch(new Request(
      new URL('/api/v1/admin/workspaces/'+migrationMatch[1],request.url),
      {method:'GET',headers:request.headers}) as never) as unknown as Response;
    if(!authenticated.ok)return authenticated;
    const current=await authenticated.json() as {revision:number};
    let body:Record<string,unknown>={action:'status'};
    if(request.method==='POST') {
      body=await parseBody(request,1024);
      if(Object.keys(body).some(key=>!['action','expectedRevision'].includes(key))||
          !['step','resume'].includes(String(body.action))||body.expectedRevision!==current.revision)
        throw new ApiError('STALE_REVISION','Exact action and current Workspace revision required.',409);
      const key=request.headers.get('Idempotency-Key');
      if(!key||!/^[A-Za-z0-9_-]{1,128}$/.test(key))
        throw new ApiError('INVALID_INPUT','Idempotency-Key required.');
      body={action:body.action,idempotencyKey:key};
    }
    return json(await rpc(workspace(env,migrationMatch[1]!),'/internal/migration',{
      ...body,workspaceId:migrationMatch[1],
    }));
  }
  const recoveryMatch = /^\/api\/v1\/admin\/workspaces\/([a-zA-Z0-9_-]+)\/recovery$/.exec(path);
  if (recoveryMatch) {
    if (request.method !== "GET")
      throw new ApiError("INVALID_INPUT", "Recovery status is read-only.", 405);
    // Reuse the existing admin authorization and Workspace visibility check;
    // never expose the internal Durable Object endpoint unauthenticated.
    const authenticated = (await registry(env).fetch(
      new Request(new URL("/api/v1/admin/workspaces/" + recoveryMatch[1], request.url),
        {method:"GET",headers:request.headers}) as never,
    )) as unknown as Response;
    if (!authenticated.ok) return authenticated;
    return json(await rpc(workspace(env,recoveryMatch[1]!),
      "/internal/recovery",{workspaceId:recoveryMatch[1]}));
  }
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
  if (path === '/api/v1/tab/rebind-proof')
    return await registry(env).fetch(request as never) as unknown as Response;
  if (path.startsWith("/api/v1/tab/")) {
    if(path==='/api/v1/tab/socket') {
      if(env.PUSH_NOTIFICATIONS_ENABLED!=='true')
        throw new ApiError('NOT_FOUND','Notifications are disabled.',404);
      validatePushUpgrade(request);
      const values=u.searchParams.getAll('workspaceId');
      if(values.length!==1||[...u.searchParams.keys()].some(key=>key!=='workspaceId')||
          !/^[A-Za-z0-9_-]{1,128}$/.test(values[0]!))
        throw new ApiError('INVALID_INPUT','Exact Workspace ID required.');
      return await workspace(env,values[0]!).fetch(request as never) as unknown as Response;
    }
    const clone = request.clone(),
      body = await parseBody(clone);
    if (
      typeof body.workspaceId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(body.workspaceId)
    )
      throw new ApiError("INVALID_INPUT", "Workspace ID required.");
    const waitMs = path === "/api/v1/tab/poll" ? pollWaitMs(body.waitMs) : 0;
    const response = await workspace(env, body.workspaceId).fetch(
      request as never,
    ) as unknown as Response;
    return path === "/api/v1/tab/poll" ? paceIdlePoll(response, waitMs) : response;
  }
  const match =
    /^\/(?:\.well-known\/oauth-protected-resource\/)?mcp\/([a-zA-Z0-9_-]+)$/.exec(
      path,
    );
  const config = await rpc<Configuration>(
    registry(env), "/internal/config", match ? {agentId:match[1]} : undefined,
  );
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
      workspaceLabel: string | null;
      contractVersion: 1 | 2;
      permissionCeiling?: string[];
      clientId: string;
      redirectUri: string;
      scope: string[];
    }>(registry(env), "/internal/oauth/pending", { request: auth });
    const connectorConsent = pending.contractVersion === 2;
    return html(
      "<h1>Approve in Perch MCP</h1><p>Open Perch MCP → " + (connectorConsent ? "Connectors" : "Agents") +
        " in the Perchance editor and match code <code>" + escape(pending.code) +
        "</code>.</p><dl><dt>" + (connectorConsent ? "Connector" : "Agent") +
        "</dt><dd>" + escape(pending.agentLabel) + "</dd>" +
        (connectorConsent
          ? "<dt>Resource</dt><dd>" + escape(auth.resource ?? "") + "</dd><dt>Permission ceiling</dt><dd>" +
            escape((pending.permissionCeiling ?? []).join(", ")) + "</dd>"
          : "<dt>Workspace</dt><dd>" + escape(pending.workspaceLabel ?? "") + "</dd>") +
        "<dt>Client</dt><dd>" +
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
      true,
    );
  }
  if (path === "/authorize/complete") {
    if (request.method !== "POST")
      throw new ApiError("INVALID_INPUT", "POST required.", 405);
    const o = request.headers.get("origin");
    // The one-time handle, exact Registry approval and PKCE S256 are the
    // authorization proof. Do not rely on Origin in form navigation, because
    // privacy policies can legitimately make it "null".
    // Explicit foreign origins and explicit cross-site Fetch Metadata remain
    // rejected; a null origin never receives CORS read permission.
    if (
      (o && o !== "null" && o !== config.issuer && o !== u.origin) ||
      (request.headers.get("sec-fetch-site") === "cross-site" &&
        o !== config.issuer && o !== u.origin)
    )
      throw new ApiError(
        "SCOPE_DENIED",
        "Authorization completion must originate from the gateway form.",
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
      redirectTo?: string;
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
    if (result.state === "completed" && result.redirectTo)
      return manualCallback(result.redirectTo);
    if (result.state === "processing")
      return retryCompletionForm(
        form.get("id") ?? "", form.get("handle") ?? "",
        "Authorization is completing",
      );
    if (result.state === "failed")
      return html(
        "<h1>Authorization could not complete</h1><p>The provisional Grant was revoked. Restart authorization from ChatGPT.</p>",
      );
    if (result.state === "revoked")
      return html(
        "<h1>Authorization revoked</h1><p>The Workspace Grant is no longer active. Restart authorization from ChatGPT after checking the Workspace binding.</p>",
      );
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
        true,
      );
    if (result.state === "denied" && result.request)
      return Response.redirect(
        authorizationErrorRedirect(result.request, "access_denied"),
        302,
      );
    if (result.state !== "approved" || !result.request || !result.props)
      return html(
        "<h1>Authorization no longer recoverable</h1><p>This code was issued by an older release, denied or expired. Start a fresh connector authorization in ChatGPT. No duplicate Grant will be issued.</p>",
      );
    const approval = {
      id: form.get("id"),
      handle: form.get("handle"),
      grantId: result.props.grantId,
    };
    let completed: { redirectTo: string };
    try {
      completed = await authorizationServer
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
    } catch (error) {
      // Do not leave a privileged orphan Grant if the OAuth SDK fails.
      await rpc(registry(env), "/internal/oauth/abort-completion", approval)
        .catch(() => undefined);
      throw error;
    }
    try {
      await rpc(registry(env), "/internal/oauth/redirect-commit", {
        ...approval, redirectTo: completed.redirectTo,
      });
    } catch (error) {
      // A lost commit response is ambiguous. Read back the sealed redirect
      // before revoking anything; never issue a second OAuth code.
      try {
        const current = await rpc<{ state: string; redirectTo?: string }>(
          registry(env), "/internal/oauth/consume", {
            id: approval.id, handle: approval.handle,
          },
        );
        if (current.state === "completed" &&
            current.redirectTo === completed.redirectTo)
          return callbackRedirect(current.redirectTo);
      } catch { /* Underlying storage may be unavailable. */ }
      await rpc(registry(env), "/internal/oauth/abort-completion", approval)
        .catch(() => undefined);
      throw error;
    }
    return callbackRedirect(completed.redirectTo);
  }
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
type AuditRoute = "authorize" | "authorize_complete" | "token" | "register";
const ingressAdmission=new IngressAdmission();
const oauthAuditAdmission=new OAuthAuditAdmission();
function auditRoute(path: string): AuditRoute | null {
  if (path === "/authorize") return "authorize";
  if (path === "/authorize/complete") return "authorize_complete";
  if (path === "/token") return "token";
  if (path === "/register") return "register";
  return null;
}
function originClass(request: Request): string {
  const value = request.headers.get("origin");
  if (!value) return "missing";
  if (value === "null") return "null";
  if (value === new URL(request.url).origin) return "same";
  if (value === "https://perchance.org") return "perchance";
  if (value === "https://chatgpt.com" || value === "https://chat.openai.com") return "chatgpt";
  return "other";
}
function auditOAuth(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  status: number,
  code: string,
  traceId: string,
): void {
  const routeName = auditRoute(new URL(request.url).pathname);
  if (!routeName || !["GET", "POST"].includes(request.method)) return;
  if(!oauthAuditAdmission.allow(routeName,request.method,originClass(request),status,code))return;
  // Audit is best effort; a logging outage must never prevent authorization.
  // Do not persist raw URL, Origin, query, OAuth credentials, handles or bodies.
  ctx.waitUntil(
    rpc(registry(env), "/internal/diagnostic-event", {
      route: routeName,
      method: request.method,
      originClass: originClass(request),
      status,
      code,
      traceId,
    }).then(() => undefined).catch(() => undefined),
  );
}
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const issuer: string | null = env.ISSUER_URL ?? null;
    let auditEligible=false;
    try {
      if(request.method!=='OPTIONS') {validateIngress(request,env);auditEligible=true;}
      if (!allowedOrigin(request, env, issuer))
        throw new ApiError("SCOPE_DENIED", "Origin is not allowed.", 403);
      if (request.method === "OPTIONS")
        return cors(new Response(null, { status: 204 }), request, env, issuer);
      auditEligible=false;
      ingressAdmission.check(request);
      auditEligible=true;
      const response = await route(request, env, ctx);
      if (response.status >= 500) {
        const body = await response.clone().json().catch(() => null) as
          { traceId?: unknown } | null;
        const traceId = typeof body?.traceId === "string" ? body.traceId : crypto.randomUUID();
        reportIncident(env, ctx, incident("worker", new URL(request.url).pathname,
          response.status, undefined, traceId));
      }
      if(auditEligible)auditOAuth(
        request, env, ctx, response.status,
        response.headers.get("X-Perch-OAuth-Outcome") ??
          (new URL(request.url).pathname === "/token" && response.ok
            ? "TOKEN_EXCHANGE_SUCCEEDED"
            : response.status === 302 ? "REDIRECT_ISSUED" :
              response.status >= 400 ? "HTTP_ERROR" : "PENDING_OR_INFO"),
        crypto.randomUUID(),
      );
      return cors(response, request, env, issuer);
    } catch (error) {
      const traceId = crypto.randomUUID();
      const response = errorResponse(error, traceId);
      if (response.status >= 500)
        reportIncident(env, ctx, incident("worker", new URL(request.url).pathname,
          response.status, error, traceId));
      if(auditEligible)auditOAuth(
        request, env, ctx, response.status,
        error instanceof ApiError ? error.code : "INTERNAL_ERROR",
        traceId,
      );
      return cors(response, request, env, issuer);
    }
  },
  scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): void {
    // Independent five-minute health probe; does not claim leases or run tools.
    ctx.waitUntil((async () => {
      const probe = await probeRegistryHealth(() => registry(env).fetch(
        new Request("https://internal/internal/health") as never,
      ) as unknown as Promise<Response>);
      if (!probe.failure) return;
      reportIncident(env, ctx, incident("scheduled", "/health", probe.response.status,
        probe.failure.error, probe.failure.traceId));
    })());
  },
};
