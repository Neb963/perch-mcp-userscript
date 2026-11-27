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
  'REGISTRY_RUNTIME_LIMIT', 'REGISTRY_LIMIT_UNSPECIFIED',
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
  if (/overload|too many (?:requests|queued|concurrent)|queue.*full/.test(message) ||
      (error as Error & { overloaded?: boolean }).overloaded === true) return 'REGISTRY_OVERLOADED';
  if (/timeout|timed out|aborted/.test(message)) return 'REGISTRY_TIMEOUT';
  if (/\b(?:cpu|memory|subrequests?|invocation|execution time|stack)\b.*\b(?:limit|exceed|exhaust)|\b(?:limit|exceed|exhaust).*\b(?:cpu|memory|subrequests?|invocation|execution time|stack)\b/.test(message)) return 'REGISTRY_RUNTIME_LIMIT';
  if (/free[- ]tier|daily (?:row|request|storage|duration)|monthly quota|account(?:'s)? spending (?:cap|limit)|account(?:'s)? quota|account has exceeded.*(?:quota|daily|monthly)|quota.*(?:daily|monthly)/.test(message)) return 'REGISTRY_QUOTA';
  if (/sqlite_full|database or disk is full|storage.*full/.test(message)) return 'REGISTRY_STORAGE_FULL';
  if (/sqlite_record_corrupt|sqlite_corrupt|database.*(?:corrupt|malformed)/.test(message)) return 'REGISTRY_STORAGE_CORRUPT';
  if (/invalid url|canonical https gateway origin/.test(message)) return 'REGISTRY_CONFIGURATION_INVALID';
  if (/quota|exceed.*limit|limit.*exceed|limit reached/.test(message)) return 'REGISTRY_LIMIT_UNSPECIFIED';
  if (/sqlite|database|storage|durable object namespace|durable object binding/.test(message)) return 'REGISTRY_STORAGE_UNAVAILABLE';
  return 'REGISTRY_UNCLASSIFIED';
}
const QUOTA_DIMENSIONS = ['DURATION', 'ROWS_READ', 'ROWS_WRITTEN', 'REQUESTS', 'SPENDING', 'STORAGE', 'UNKNOWN'] as const;
type QuotaDimension = typeof QUOTA_DIMENSIONS[number];
function knownQuota(value: unknown): value is QuotaDimension {
  return typeof value === 'string' && (QUOTA_DIMENSIONS as readonly string[]).includes(value);
}
export function registryQuotaDimension(error: unknown): QuotaDimension {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (/spending|billing|budget/.test(message)) return 'SPENDING';
  if (/rows? (?:read|reads)|read(?:s|ing)? rows?/.test(message)) return 'ROWS_READ';
  if (/rows? (?:written|write|writes)|writ(?:e|es|ing) rows?/.test(message)) return 'ROWS_WRITTEN';
  if (/duration|gb.s|gigabyte.second/.test(message)) return 'DURATION';
  if (/requests?/.test(message)) return 'REQUESTS';
  if (/storage|disk/.test(message)) return 'STORAGE';
  return 'UNKNOWN';
}
const STAGES = ['DO_STUB', 'SQL_INIT', 'CORE_READ', 'CORE_VALIDATE', 'REGISTRY_RESPONSE'] as const;
type FailureStage = typeof STAGES[number];
function knownStage(value: unknown): value is FailureStage {
  return typeof value === 'string' && (STAGES as readonly string[]).includes(value);
}
// Only fixed infrastructure words may be emitted, never arbitrary message substrings,
// identifiers, URLs, numbers, SQL values, source, stack traces, or credential material.
const SIGNAL_WORDS = new Set(('account accounts exceeded exceed exceeds exceeding limit limits quota quotas daily monthly free tier plan paid spending cap billing budget blocked reached durable object objects worker workers script scripts class namespace namespaces binding bindings registered configured deployment version invocation execution cpu memory stack subrequest subrequests request requests row rows read reads reading write writes written writing storage sqlite sqlite_full sqlite_corrupt database disk full timeout timed out reset overloaded overload concurrent operations operation too many connection closed internal error runtime resource resources exhausted unavailable unavailable temporarily retry retryable invalid not supported allowed maximum minimum number count time duration second seconds milliseconds wall clock exceeded unexpected failed failure failed to from for by on in of and or a an the its is was has have with as at per must cannot could no found due because before after during this your it that be done more than less than calls call called sql query queries transaction transactions initialization constructor init creation create created read-only readonly table statement statements code updated service services environment permission permissions access denied forbidden disconnected terminated exceeded sized size exceeded exceeded database quota enforcement capacity capacity daily monthly').split(' '));
export function registryFailureSignal(error: unknown): string {
  if (!(error instanceof Error)) return 'unavailable';
  const words = error.message.toLowerCase().slice(0, 1024).match(/[a-z_]+/g) ?? [];
  return words.slice(0, 48).map(word => SIGNAL_WORDS.has(word) ? word : '_').join(' ').slice(0, 320) || 'unavailable';
}
function knownSignal(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 320 &&
    value.split(' ').every(word => word === '_' || SIGNAL_WORDS.has(word));
}
function degraded(traceId: string, reason: RegistryFailureReason, dimension: QuotaDimension = 'UNKNOWN',
  stage: FailureStage = 'DO_STUB', signal = 'unavailable'): Response {
  return Response.json({ ok: false, code: 'GATEWAY_DEGRADED',
    dependency: 'registry', retryable: ![
      'REGISTRY_SCHEMA_INCOMPATIBLE', 'REGISTRY_CONFIGURATION_INVALID',
      'REGISTRY_STORAGE_CORRUPT',
    ].includes(reason), traceId, version: VERSION, reason, stage, signal,
    ...(reason === "REGISTRY_QUOTA" ? { quotaDimension: dimension } : {}) },
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
    const quota = upstream.headers.get('X-Perch-Registry-Quota');
    const stage = upstream.headers.get('X-Perch-Registry-Stage');
    const signal = upstream.headers.get('X-Perch-Registry-Signal');
    return { response: degraded(traceId, reason, knownQuota(quota) ? quota : 'UNKNOWN',
      knownStage(stage) ? stage : 'REGISTRY_RESPONSE', knownSignal(signal) ? signal : 'unavailable'), failure: { traceId } };
  } catch (error) {
    const traceId = crypto.randomUUID();
    return { response: degraded(traceId, registryFailureReason(error), registryQuotaDimension(error), 'DO_STUB', registryFailureSignal(error)),
      failure: { traceId, error } };
  }
}
