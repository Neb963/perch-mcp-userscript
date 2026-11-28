import { ToolError } from "../../../packages/contracts/src/errors.js";
import type {
  DurableObjectNamespace,
  DurableObjectStub,
  KVNamespace,
} from "@cloudflare/workers-types";
export const VERSION = "0.3.0";
export const HAR_NATIVE_ACTIONS: Readonly<Record<string,string>> = Object.freeze({
  save_generator:"SAVE",rename_generator:"RENAME",set_listing:"LISTING",
});
/** Exact tool+permission admission; never treat a generic native-write toggle
 * as permission for unrelated media, upload, deletion or production restore. */
export function permitsHarNativeAction(env: Pick<Env,'NATIVE_ACTIONS_ENABLED'>,
  tool:unknown, requiredPermissions:readonly unknown[]):boolean {
  if(env.NATIVE_ACTIONS_ENABLED!=="true"||typeof tool!=="string")return false;
  const permission=Object.prototype.hasOwnProperty.call(HAR_NATIVE_ACTIONS,tool)
    ? HAR_NATIVE_ACTIONS[tool] : undefined;
  if(!permission||!requiredPermissions.includes(permission))return false;
  return !requiredPermissions.some(p=>typeof p!=="string" ||
    (["SAVE","CREATE","RENAME","DUPLICATE","LISTING","DELETE",
      "UPLOAD_PUBLIC","MEDIA","PRODUCTION_RESTORE"].includes(p) && p!==permission));
}
export const DEFAULT_PERMISSIONS = [
  "READ_SOURCE",
  "WRITE_SOURCE",
  "PREVIEW_CONTROL",
  "READ_RESOURCES",
];
export const PERMISSIONS = [
  ...DEFAULT_PERMISSIONS,
  "PREVIEW_EXECUTE",
  "COMPUTE",
  "FETCH_PUBLIC",
  "FETCH_POST",
  "SAVE",
  "CREATE",
  "RENAME",
  "DUPLICATE",
  "LISTING",
  "DELETE",
  "MEDIA",
  "UPLOAD_PUBLIC",
  "PRODUCTION_READ",
  "PRODUCTION_RESTORE",
  "EXPORT_ARTIFACT",
];
export const MAX_BODY = 512 * 1024;
export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public recovery = "Review the request and retry only after correcting it.",
    public connectivityRetryAfterSeconds?: number,
  ) {
    super(message);
  }
}
export function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
/** Only the observed provider quota signature may slow connectivity retries.
 * This is not permission to retry an operation or an uncertain mutation. */
export function dailySqlQuotaRetry(error: unknown): number | undefined {
  return error instanceof Error &&
    /exceeded allowed rows (?:read|written) in durable objects free tier/i.test(error.message)
    ? 300 : undefined;
}
export function errorResponse(error: unknown, traceId = crypto.randomUUID()): Response {
  const e =
    error instanceof ApiError
      ? error
      : error instanceof ToolError
        ? new ApiError(error.code, error.message, 400, error.recovery)
        : dailySqlQuotaRetry(error) !== undefined
          ? new ApiError("GATEWAY_DEGRADED","Daily Durable Object SQL allowance exhausted.",503,
              "Wait for quota recovery; reconcile uncertain effects before any new operation.",300)
          : new ApiError(
            "INTERNAL_ERROR",
            "Internal operation failed; no secret details are returned.",
            500,
            "Inspect redacted Activity and the operation handle.",
          );
  return json(
    {
      code: e.code,
      message: e.message,
      retryable: false,
      recovery: e.recovery,
      ...(e.code==="GATEWAY_DEGRADED" && e.connectivityRetryAfterSeconds===300
        ? {connectivityRetryAfterSeconds:300} : {}),
      traceId,
    },
    e.status,
  );
}

/** Result delivery can fail independently of the operation's durable outcome. */
export function omitDevelopmentResult(
  receipt: Record<string, unknown>,
  availability: "TOO_LARGE" | "EXPIRED" | "UNAVAILABLE",
): Record<string, unknown> {
  const {data: _data, result: _result, resolution: _resolution,
    lateObservation: _observation, ...metadata} = receipt;
  return {
    ...metadata,
    result: null,
    resultAvailability: availability,
    error: {
      code: "RESULT_" + availability,
      message: "The requested result bytes cannot be delivered.",
      retryable: false,
      recovery: "Inspect the retained operation receipt. Do not replay this intent to recover its result.",
    },
  };
}

export async function parseBody(
  request: Request,
  max = MAX_BODY,
): Promise<Record<string, unknown>> {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    throw new ApiError("INVALID_INPUT", "JSON Content-Type required.", 415);
  const reader = request.body?.getReader();
  let count = 0;
  const chunks: Uint8Array[] = [];
  if (reader)
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      count += value.byteLength;
      if (count > max) {
        await reader.cancel();
        throw new ApiError(
          "LIMIT_EXCEEDED",
          "Request body exceeds transport limit.",
          413,
        );
      }
      chunks.push(value);
    }
  const bytes = new Uint8Array(count);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ApiError("INVALID_INPUT", "Invalid UTF-8 JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ApiError("INVALID_INPUT", "Object required.");
  return value as Record<string, unknown>;
}
export function fields(
  value: Record<string, unknown>,
  allowed: string[],
): void {
  if (Object.keys(value).some((k) => !allowed.includes(k)))
    throw new ApiError("INVALID_INPUT", "Unknown request field.");
}
export function str(value: unknown, name: string, max = 200): string {
  if (typeof value !== "string" || !value.length || value.length > max)
    throw new ApiError(
      "INVALID_INPUT",
      `${name} must be a nonempty string up to ${max} characters.`,
    );
  return value;
}
export function id(value: unknown, name = "id"): string {
  const s = str(value, name, 128);
  if (!/^[a-zA-Z0-9_-]+$/.test(s))
    throw new ApiError("INVALID_INPUT", `Invalid ${name}.`);
  return s;
}
export function revision(value: unknown, current: number): void {
  if (value !== current)
    throw new ApiError(
      "STALE_REVISION",
      "Entity changed; reload before editing.",
      409,
    );
}
export function bearer(request: Request): string {
  const m = /^Bearer ([A-Za-z0-9._~-]{32,1024})$/.exec(
    request.headers.get("authorization") ?? "",
  );
  if (!m)
    throw new ApiError("AUTH_REQUIRED", "Bearer credential required.", 401);
  return m[1]!;
}
export function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
export async function digest(value: string): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
}
export function origin(value: string): string {
  const u = new URL(value);
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== "/" ||
    (u.protocol !== "https:" &&
      !(
        u.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)
      ))
  )
    throw new ApiError(
      "INVALID_INPUT",
      "Canonical HTTPS gateway origin required.",
    );
  return u.origin;
}
export function permissions(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > PERMISSIONS.length ||
    value.some((v) => typeof v !== "string" || !PERMISSIONS.includes(v))
  )
    throw new ApiError("INVALID_INPUT", "Invalid permission set.");
  return [...new Set(value)] as string[];
}
export function equalBinding(a: Binding, b: Binding): boolean {
  return canonical(a) === canonical(b);
}
export interface Binding {
  generatorId: string;
  slug: string;
  publicId?: string;
  draftId: string;
  browserInstallationId: string;
}
export function binding(value: unknown): Binding {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ApiError("INVALID_INPUT", "Binding required.");
  const b = value as Record<string, unknown>;
  fields(b, [
    "generatorId",
    "slug",
    "publicId",
    "draftId",
    "browserInstallationId",
  ]);
  if (typeof b.draftId !== "string" || b.draftId.length > 200)
    throw new ApiError(
      "INVALID_INPUT",
      "Draft ID must be a string, including empty default.",
    );
  return {
    generatorId: str(b.generatorId, "generatorId"),
    slug: str(b.slug, "slug"),
    ...(b.publicId === undefined
      ? {}
      : { publicId: str(b.publicId, "publicId") }),
    draftId: b.draftId,
    browserInstallationId: id(b.browserInstallationId, "browserInstallationId"),
  };
}
export interface Env {
  CANONICAL_STORAGE_MODE?: "legacy" | "prepare" | "native";
  PUSH_NOTIFICATIONS_ENABLED?: string;
  BINARY_PAYLOADS_ENABLED?: string;
  ADMISSION_BUDGET_ENABLED?: string;
  ADMISSION_BUDGET_CAPS_JSON?: string;
  ADMISSION_BUDGET_BASELINE_JSON?: string;
  SQL_TELEMETRY_ENABLED?: string;
  /** Opt-in fingerprint-only query-cost profiling; never record SQL arguments. */
  SQL_TELEMETRY_DETAIL_ENABLED?: string;
  REGISTRY: DurableObjectNamespace;
  WORKSPACES: DurableObjectNamespace;
  OAUTH_KV: KVNamespace;
  BOOTSTRAP_SECRET: string;
  RECOVERY_SECRET?: string;
  ISSUER_URL?: string;
  ALLOWED_ORIGINS?: string;
  PROVIDER_WRITES_ENABLED?: string;
  /** Restricts external mutations to HAR-confirmed native Save/Rename/Listing. */
  NATIVE_ACTIONS_ENABLED?: string;
  ELEVENLABS_API_KEY?: string;
  PAID_MEDIA_ENABLED?: string;
  REGISTRY_WORKSPACE_BUDGET?: string;
  DEVELOPMENT_CONTRACT_V2_ENABLED?: string;
  DEVELOPMENT_CONTRACT_V2_EXECUTION_ENABLED?: string;
  REGISTRY_GRANT_BUDGET?: string;
  /** Explicit bounded v2 access-token TTL override; consent itself never expires. */
  OAUTH_ACCESS_TOKEN_TTL_SECONDS?: string;
  OAUTH_REGISTRATIONS_PER_HOUR?: string;
}
export async function rpc<T = Record<string, unknown>>(
  stub: DurableObjectStub,
  path: string,
  body?: unknown,
  headers: HeadersInit = {},
): Promise<T> {
  const r = await stub.fetch(
    new Request("https://internal" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        ...Object.fromEntries(new Headers(headers)),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }) as never,
  );
  const data = (await r.json()) as Record<string, unknown>;
  if (!r.ok)
    throw new ApiError(
      String(data.code ?? "INTERNAL_ERROR"),
      String(data.message ?? "Internal request failed."),
      r.status,
      "Review the request and retry only after correcting it.",
      data.code==="GATEWAY_DEGRADED" && data.connectivityRetryAfterSeconds===300 ? 300 : undefined,
    );
  return data as T;
}
export function registry(env: Env): DurableObjectStub {
  return env.REGISTRY.get(env.REGISTRY.idFromName("installation"));
}
export function workspace(env: Env, workspaceId: string): DurableObjectStub {
  return env.WORKSPACES.get(env.WORKSPACES.idFromName(workspaceId));
}

export function configuredBudget(
  value: string | undefined,
  fallback: number,
  maximum = 100000,
): number {
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(value))
    throw new ApiError(
      "INVALID_INPUT",
      "Operational budget must be a positive integer.",
    );
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n > maximum)
    throw new ApiError(
      "INVALID_INPUT",
      "Operational budget exceeds supported safety range.",
    );
  return n;
}

/** Operation-handle lifetime preserves tool execution defaults instead of imposing an HTTP deadline. */
export function operationTimeoutMs(
  tool: string,
  args: Record<string, unknown>,
): number {
  const fallback =
    tool === "generate_music"
      ? 600000
      : [
            "page_eval",
            "execute_js",
            "fetch_url",
            "generate_image",
            "upload_file",
          ].includes(tool)
        ? 120000
        : 30000;
  if (args.timeoutMs === undefined) return fallback;
  const value = args.timeoutMs,
    maximum = tool === "page_eval" ? 500000 : 3600000;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximum
  )
    throw new ApiError(
      "INVALID_INPUT",
      "Tool timeout exceeds its supported execution bound.",
    );
  return value;
}
