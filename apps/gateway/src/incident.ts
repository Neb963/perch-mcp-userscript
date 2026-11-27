import type { ExecutionContext } from '@cloudflare/workers-types';
import { ApiError, VERSION, type Env } from './common.js';

/** Durable, secret-free incident evidence outside the Registry failure domain. */
export type IncidentArea = 'worker' | 'registry' | 'scheduled';
export type IncidentRoute = 'health' | 'registry-admin' | 'oauth' | 'mcp' | 'tab' | 'other';
export interface Incident {
  schemaVersion: 1;
  at: number;
  version: string;
  traceId: string;
  area: IncidentArea;
  route: IncidentRoute;
  status: number;
  errorClass: string;
  causeClass: string;
  site: string | null;
}
const lastPersistentIncident = new Map<string, number>();
const TRACE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function routeClass(path: string): IncidentRoute {
  if (path === '/health' || path === '/live') return 'health';
  if (path.startsWith('/api/v1/admin/') || path.startsWith('/internal/')) return 'registry-admin';
  if (path.startsWith('/api/v1/tab/')) return 'tab';
  if (path.startsWith('/mcp/')) return 'mcp';
  if (/^\/(?:authorize|token|revoke|register|\.well-known)(?:\/|$)/.test(path)) return 'oauth';
  return 'other';
}
function safeClass(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(value)
    ? value : 'Unknown';
}
function cause(error: unknown): { errorClass: string; causeClass: string; site: string | null } {
  if (!(error instanceof Error)) return { errorClass: 'Unknown', causeClass: 'Unknown', site: null };
  // Never log the raw error message or stack: either can contain provider data or credentials.
  const message = String(error.message).toLowerCase();
  const causeClass = /sqlite|database|storage/i.test(message)
    ? (/full|quota|capacity|too large/.test(message) ? 'STORAGE_FULL'
      : /locked|busy/.test(message) ? 'STORAGE_BUSY'
      : /corrupt|malformed/.test(message) ? 'STORAGE_CORRUPT' : 'STORAGE_ERROR')
    : /json|parse|unexpected token/.test(message) ? 'SERIALIZATION_ERROR'
    : /timeout|timed out|aborted/.test(message) ? 'TIMEOUT'
    : /memory|allocation/.test(message) ? 'MEMORY'
    : 'UNCLASSIFIED';
  const loc = String(error.stack ?? '').match(/(registry|sql|index|common|workspace)\.(?:ts|js):(\d{1,6}):(\d{1,4})/);
  return { errorClass: safeClass(error.name), causeClass,
    site: loc ? `${loc[1]}:${loc[2]}:${loc[3]}` : null };
}
export function incident(
  area: IncidentArea, path: string, status: number, error?: unknown,
  traceId: string = crypto.randomUUID(), now = Date.now(),
): Incident {
  return { schemaVersion: 1, at: now, version: VERSION,
    traceId: TRACE.test(traceId) ? traceId : crypto.randomUUID(),
    area, route: routeClass(path), status,
    ...cause(error) };
}

/** Console first, independent KV second. No dependency on Registry, no recursive failures. */
export async function persistIncident(env: Env, value: Incident): Promise<void> {
  const key = `${value.area}/${value.route}/${value.status}/${value.causeClass}`;
  const now = Date.now();
  // Bound KV writes during prolonged outages. Console retains every emitted incident.
  if ((lastPersistentIncident.get(key) ?? 0) + 60_000 > now) return;
  lastPersistentIncident.set(key, now);
  if (lastPersistentIncident.size > 96) lastPersistentIncident.clear();
  try {
    await env.OAUTH_KV.put(
      `infra-incident/v1/${value.at}/${value.traceId}`,
      JSON.stringify(value),
      { expirationTtl: 7 * 86400 },
    );
  } catch {
    console.error(JSON.stringify({ kind: 'infra-incident-storage-unavailable', traceId: value.traceId }));
  }
}
export function reportIncident(env: Env, ctx: ExecutionContext, value: Incident): void {
  console.error(JSON.stringify({ kind: 'perch-mcp-incident', ...value }));
  ctx.waitUntil(persistIncident(env, value));
}

/** Fixed public diagnostic vocabulary. Never expose exception text, stack, IDs or storage data. */
const REGISTRY_REASONS = [
  'REGISTRY_QUOTA', 'REGISTRY_OVERLOADED', 'REGISTRY_STORAGE_FULL',
  'REGISTRY_STORAGE_CORRUPT', 'REGISTRY_STORAGE_UNAVAILABLE',
  'REGISTRY_SCHEMA_INCOMPATIBLE', 'REGISTRY_CONFIGURATION_INVALID',
  'REGISTRY_TIMEOUT', 'REGISTRY_HTTP_ERROR', 'REGISTRY_UNCLASSIFIED',
] as const;
export type RegistryFailureReason = typeof REGISTRY_REASONS[number];
function knownReason(value: unknown): value is RegistryFailureReason {
  return typeof value === 'string' && (REGISTRY_REASONS as readonly string[]).includes(value);
}
export function registryFailureReason(error: unknown): RegistryFailureReason {
  if (error instanceof ApiError) {
    if (error.code === 'INCOMPATIBLE_VERSION') return 'REGISTRY_SCHEMA_INCOMPATIBLE';
    if (error.code === 'INVALID_INPUT') return 'REGISTRY_CONFIGURATION_INVALID';
  }
  if (!(error instanceof Error)) return 'REGISTRY_UNCLASSIFIED';
  const message = error.message.toLowerCase();
  if (/quota|free tier|free-tier|daily (?:row|request|storage)|spending limit|exceeded.*limit|limit.*exceeded/.test(message)) return 'REGISTRY_QUOTA';
  if (/overload|too many (?:requests|queued)|queue.*full/.test(message)) return 'REGISTRY_OVERLOADED';
  if (/sqlite_full|database or disk is full|storage.*full/.test(message)) return 'REGISTRY_STORAGE_FULL';
  if (/sqlite_record_corrupt|sqlite_corrupt|database.*(?:corrupt|malformed)/.test(message)) return 'REGISTRY_STORAGE_CORRUPT';
  if (/invalid url|canonical https gateway origin/.test(message)) return 'REGISTRY_CONFIGURATION_INVALID';
  if (/timeout|timed out|aborted/.test(message)) return 'REGISTRY_TIMEOUT';
  if (/sqlite|database|storage|durable object namespace|durable object binding/.test(message)) return 'REGISTRY_STORAGE_UNAVAILABLE';
  return 'REGISTRY_UNCLASSIFIED';
}
function degraded(traceId: string, reason: RegistryFailureReason): Response {
  return Response.json({ ok: false, code: 'GATEWAY_DEGRADED',
    dependency: 'registry', retryable: ![
      'REGISTRY_SCHEMA_INCOMPATIBLE', 'REGISTRY_CONFIGURATION_INVALID',
      'REGISTRY_STORAGE_CORRUPT',
    ].includes(reason), traceId, version: VERSION, reason },
    {status: 503, headers: {'Cache-Control':'no-store'}});
}

/** Registry-independent readiness computation used by both HTTP and scheduled checks. */
export async function probeRegistryHealth(read: () => Promise<Response>): Promise<{
  response: Response; failure?: { traceId: string; error?: unknown };
}> {
  try {
    const upstream = await read();
    if (upstream.ok) return { response: upstream };
    const record = await upstream.clone().json().catch(() => null) as
      { traceId?: unknown } | null;
    const traceId = typeof record?.traceId === 'string' && TRACE.test(record.traceId)
      ? record.traceId : crypto.randomUUID();
    const classified = upstream.headers.get('X-Perch-Registry-Failure');
    const reason = knownReason(classified) ? classified : 'REGISTRY_HTTP_ERROR';
    return { response: degraded(traceId, reason), failure: { traceId } };
  } catch (error) {
    const traceId = crypto.randomUUID();
    return { response: degraded(traceId, registryFailureReason(error)),
      failure: { traceId, error } };
  }
}
