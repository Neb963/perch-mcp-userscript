import { ApiError, operationTimeoutMs } from './common.js';

/** Local admission estimates. These are NOT provider counters or reserved account quota. */
export const BUDGET_DIMENSIONS = [
  'sqlReads', 'sqlWrites', 'workerRequests', 'durableObjectRequests',
  'durationMs', 'storageBytes', 'kvReads', 'kvWrites', 'logEvents',
] as const;
export type BudgetDimension = typeof BUDGET_DIMENSIONS[number];
export type BudgetVector = Record<BudgetDimension, number>;
export type BudgetMode = 'NORMAL' | 'VISIBILITY' | 'REDUCE_OPTIONAL' | 'RESTRICT_EXPENSIVE' | 'RECOVERY_ONLY';
export interface BudgetEnvironment {
  ADMISSION_BUDGET_ENABLED?: string;
  ADMISSION_BUDGET_CAPS_JSON?: string;
  ADMISSION_BUDGET_BASELINE_JSON?: string;
}
export interface BudgetPolicy { enabled: boolean; caps: BudgetVector; baseline: BudgetVector }
export interface BudgetStore {
  readonly inTransaction: boolean;
  get<T>(key: string, fallback?: T): T;
  put(key: string, value: unknown): void;
  transaction<T>(fn: () => T): T;
}
export interface RetainedCleanupSummary {
  nativeOperations:boolean;
  retainedOperations:number;
  retainedResultBytes:number;
  imageBytes:number;imageManifests:number;
  musicBytes:number;musicJournals:number;
  retiredLeases:number;
}
export interface BudgetState {
  schemaVersion: 1;
  utcDay: number;
  observedAt: number;
  reserved: BudgetVector;
  admissions: number;
  retainedCleanup:BudgetVector;
  cleanupSummary:RetainedCleanupSummary;
}
export interface BudgetOperation {
  tool: string;
  args?: Record<string, unknown>;
  budgetReservation?: BudgetVector;
}
export interface BudgetView {
  scope: 'workspace'; coverage: 'admission-estimates-only'; accountUsage: 'UNKNOWN';
  utcDay: number; mode: BudgetMode; limiting: BudgetDimension; ratio: number;
  reserved: BudgetVector; caps: BudgetVector; admissions: number;
  retainedCleanup:BudgetVector;cleanupSummary:RetainedCleanupSummary;
}
export const ADMISSION_BUDGET_KEY = 'admission-budget/v1';
const INITIALIZED_KEY = 'admission-budget-initialized/v1';
const UTC_DAY_MS = 86_400_000;
const MAX_OBLIGATIONS = 8 + 128 + 128;
const MAX_CLOCK_ROLLBACK_MS = 5 * 60_000;
const CHUNK_BYTES = 192 * 1024;
/** Per-Workspace envelopes; summing many envelopes is NOT an account-wide guarantee.
 * SQL/request caps use 20% of Free allowances; KV mutation cap differs because
 * a single 24h OAuth client already requires 192 refresh writes before issuance. */
const DEFAULT_CAPS: Readonly<BudgetVector> = Object.freeze({
  sqlReads: 1_000_000, sqlWrites: 20_000,
  workerRequests: 20_000, durableObjectRequests: 20_000,
  durationMs: 20_800_000, storageBytes: 256 * 1024 * 1024,
  kvReads: 20_000, kvWrites: 750, logEvents: 10_000,
});
export function zeroBudget(): BudgetVector {
  return Object.fromEntries(BUDGET_DIMENSIONS.map(key => [key, 0])) as BudgetVector;
}
function validNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function vector(value: unknown): BudgetVector {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).length !== BUDGET_DIMENSIONS.length ||
    !BUDGET_DIMENSIONS.every(key => validNumber((value as Record<string,unknown>)[key])))
    throw new ApiError('GATEWAY_DEGRADED', 'Admission accounting is unavailable or corrupt.', 503,
      'Preserve accounting and operation records; restore a compatible reader before admitting work.');
  return Object.fromEntries(BUDGET_DIMENSIONS.map(key => [key, (value as BudgetVector)[key]])) as BudgetVector;
}
function add(left: BudgetVector, right: BudgetVector): BudgetVector {
  const result = zeroBudget();
  for (const key of BUDGET_DIMENSIONS) {
    result[key] = left[key] + right[key];
    if (!validNumber(result[key])) throw new ApiError('GATEWAY_DEGRADED', 'Admission accounting overflow.', 503);
  }
  return result;
}
function configuredVector(raw: string | undefined, fallback: BudgetVector, allowZero: boolean): BudgetVector {
  if (raw === undefined) return {...fallback};
  let parsed: unknown;
  try {parsed = JSON.parse(raw);} catch {throw new ApiError('INVALID_INPUT', 'Admission budget configuration must be JSON.');}
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
    Object.keys(parsed).some(key => !(BUDGET_DIMENSIONS as readonly string[]).includes(key)) ||
    Object.values(parsed).some(value => !validNumber(value) || (!allowZero && value === 0)))
    throw new ApiError('INVALID_INPUT', 'Admission budget dimensions must be bounded nonnegative integers.');
  return {...fallback, ...parsed} as BudgetVector;
}
export function admissionBudgetPolicy(env: BudgetEnvironment): BudgetPolicy {
  if (env.ADMISSION_BUDGET_ENABLED !== undefined && !['true','false'].includes(env.ADMISSION_BUDGET_ENABLED))
    throw new ApiError('INVALID_INPUT', 'ADMISSION_BUDGET_ENABLED must be true or false.');
  // Disabling optional admission estimates must recover from both corrupt
  // durable counters and malformed inactive configuration.
  if(env.ADMISSION_BUDGET_ENABLED!=='true')return {enabled:false,caps:{...DEFAULT_CAPS},baseline:zeroBudget()};
  const caps = configuredVector(env.ADMISSION_BUDGET_CAPS_JSON, {...DEFAULT_CAPS}, false);
  // Unknown earlier-day traffic is not silently initialized to zero. This
  // configurable margin is a local allocation assumption, never account proof.
  const defaultBaseline=Object.fromEntries(BUDGET_DIMENSIONS.map(key => [key,Math.ceil(caps[key]*0.2)])) as BudgetVector;
  // One measured continuously active client rotates 96 times/day at 2 KV puts
  // per rotation. Reserve 256 to include issuance and retry margin. Additional
  // clients require an explicit Operator baseline; this is not a KV limiter.
  defaultBaseline.kvWrites=Math.max(defaultBaseline.kvWrites,256);
  const baseline=configuredVector(env.ADMISSION_BUDGET_BASELINE_JSON,defaultBaseline,true);
  if (BUDGET_DIMENSIONS.some(key => baseline[key] > caps[key]))
    throw new ApiError('INVALID_INPUT', 'Admission baseline exceeds a configured envelope.');
  return {enabled: env.ADMISSION_BUDGET_ENABLED === 'true', caps, baseline};
}

/**
 * Conservative coefficients, deliberately larger than the small-payload
 * lifecycle target. Includes bounded payload transfer, one retained late
 * observation as well as the original 512 KiB result, result retention/deletion,
 * auth, alarms and retry margin. A compute parent reserves its maximum 1000
 * child broker calls. Repeated arbitrary status traffic and other installations
 * are outside this model and must be measured separately.
 */
export function completionReservation(tool: string, args: Record<string,unknown> = {}): BudgetVector {
  const argBytes = new TextEncoder().encode(JSON.stringify(args)).byteLength;
  if (argBytes > 512 * 1024) throw new ApiError('LIMIT_EXCEEDED', 'Admission argument size exceeds transport bounds.', 413);
  const mediaBytes = tool === 'generate_music' ? 8 * 1024 * 1024
    : ['generate_image','read_image','capture_page_image'].includes(tool) ? 1024 * 1024 : 0;
  const payloadRows = Math.ceil(mediaBytes / CHUNK_BYTES) + Math.ceil((argBytes + 2 * 512 * 1024) / 32_000);
  const childCalls = tool === 'execute_js' ? 1000 : 0;
  return {
    sqlReads: 512 + payloadRows * 16 + childCalls * 512,
    sqlWrites: 96 + payloadRows * 12 + childCalls * 96,
    workerRequests: 12 + Math.ceil(mediaBytes / CHUNK_BYTES) * 2 + childCalls,
    durableObjectRequests: 24 + Math.ceil(mediaBytes / CHUNK_BYTES) * 4 + childCalls * 2,
    durationMs: operationTimeoutMs(tool,args) + 30_000,
    storageBytes: 4096 + argBytes + 2 * 512 * 1024 + mediaBytes,
    kvReads: 4, kvWrites: 0, logEvents: 8 + childCalls,
  };
}
export function emptyCleanupSummary():RetainedCleanupSummary {
  return {nativeOperations:true,retainedOperations:0,retainedResultBytes:0,
    imageBytes:0,imageManifests:0,musicBytes:0,musicJournals:0,retiredLeases:0};
}
function checkedCleanupSummary(value:unknown):RetainedCleanupSummary {
  if(!value||typeof value!=='object'||Array.isArray(value))
    throw new ApiError('GATEWAY_DEGRADED','Retained cleanup accounting is unavailable.',503);
  const row=value as Record<string,unknown>;
  const bounds={retainedOperations:1264,retainedResultBytes:32*1024*1024,
    imageBytes:8*1024*1024,imageManifests:64,musicBytes:8*1024*1024,musicJournals:1000,retiredLeases:4096};
  if(typeof row.nativeOperations!=='boolean'||Object.entries(bounds).some(([key,max])=>!validNumber(row[key])||Number(row[key])>max))
    throw new ApiError('GATEWAY_DEGRADED','Retained cleanup accounting is unknown, corrupt or exceeds its bounded summary.',503);
  return {nativeOperations:row.nativeOperations,retainedOperations:Number(row.retainedOperations),
    retainedResultBytes:Number(row.retainedResultBytes),imageBytes:Number(row.imageBytes),imageManifests:Number(row.imageManifests),
    musicBytes:Number(row.musicBytes),musicJournals:Number(row.musicJournals),retiredLeases:Number(row.retiredLeases)};
}
/** Counts-only reserve for retained state, deliberately charged again at UTC rollover.
 * Legacy metadata can occupy 133 parts; native metadata/args/result occupy 3 rows.
 * Storage conservatively permits 4 MiB of accepted canonical metadata per operation even
 * when hot native metadata is much smaller. Payload expiry and later retention
 * deletion are both included. These are estimates, not measured billing bounds.
 */
export function retainedCleanupReservation(input:RetainedCleanupSummary):BudgetVector {
  const summary=checkedCleanupSummary(input),payloadChunks=Math.ceil(summary.imageBytes/CHUNK_BYTES)+Math.ceil(summary.musicBytes/CHUNK_BYTES);
  const metadata=summary.imageManifests+summary.musicJournals;
  const alarms=Math.ceil(summary.retainedOperations/128)*2+Math.ceil(metadata/128)*2+Math.ceil(summary.retiredLeases/128)+Math.ceil(payloadChunks/128);
  return {sqlReads:64+summary.retainedOperations*(summary.nativeOperations?64:512)+payloadChunks*64+metadata*64+summary.retiredLeases*16,
    sqlWrites:summary.retainedOperations*(summary.nativeOperations?32:600)+payloadChunks*64+metadata*64+summary.retiredLeases*16,
    workerRequests:0,durableObjectRequests:alarms,durationMs:summary.retainedOperations*100+payloadChunks*10+metadata*20+summary.retiredLeases*20,
    storageBytes:summary.retainedOperations*4*1024*1024+summary.retainedResultBytes+2*(summary.imageBytes+summary.musicBytes)+(metadata+summary.retiredLeases)*8192,
    kvReads:0,kvWrites:0,logEvents:alarms};
}
function maximumCleanupSummary():RetainedCleanupSummary {
  return {nativeOperations:false,retainedOperations:1264,retainedResultBytes:32*1024*1024,
    imageBytes:8*1024*1024,imageManifests:64,musicBytes:8*1024*1024,musicJournals:1000,retiredLeases:4096};
}
function checkedState(value: unknown): BudgetState {
  const row = value as Partial<BudgetState> | null;
  if (!row || row.schemaVersion !== 1 || !validNumber(row.utcDay) ||
    !validNumber(row.observedAt) || !validNumber(row.admissions) ||
    Math.floor(row.observedAt / UTC_DAY_MS) !== row.utcDay)
    throw new ApiError('GATEWAY_DEGRADED', 'Admission accounting schema is invalid.', 503);
  return {schemaVersion: 1, utcDay: row.utcDay, observedAt: row.observedAt,
    reserved: vector(row.reserved), admissions: row.admissions,
    retainedCleanup:vector(row.retainedCleanup),cleanupSummary:checkedCleanupSummary(row.cleanupSummary)};
}
function view(state: BudgetState, policy: BudgetPolicy): BudgetView {
  let limiting: BudgetDimension = 'sqlReads', ratio = 0;
  for (const key of BUDGET_DIMENSIONS) if (state.reserved[key] / policy.caps[key] > ratio) {
    ratio = state.reserved[key] / policy.caps[key]; limiting = key;
  }
  const mode: BudgetMode = ratio >= 0.95 ? 'RECOVERY_ONLY' : ratio >= 0.85 ? 'RESTRICT_EXPENSIVE'
    : ratio >= 0.7 ? 'REDUCE_OPTIONAL' : ratio >= 0.5 ? 'VISIBILITY' : 'NORMAL';
  return {scope:'workspace',coverage:'admission-estimates-only',accountUsage:'UNKNOWN',
    utcDay:state.utcDay,mode,limiting,ratio,reserved:{...state.reserved},caps:{...policy.caps},admissions:state.admissions,retainedCleanup:{...state.retainedCleanup},cleanupSummary:{...state.cleanupSummary}};
}
function costly(tool: string): boolean {
  return ['execute_js','generate_music','generate_image','read_image','capture_page_image',
    'upload_file','download_server_plugin_state','upload_server_plugin_state'].includes(tool);
}

/**
 * Invoke ONLY in admission's canonical transaction. The operation and reservation
 * must commit together. Terminal/result/recovery routes never call this function.
 * No persistent write occurs on ordinary reads, heartbeats or denied admission.
 * `outstanding` is evaluated only on first activation or UTC rollover and MUST
 * contain the indexed active/pending/held operations, deduplicated by caller.
 * The cleanup callback supplies bounded counts/bytes for already retained state;
 * omitted callback uses conservative accepted maxima, never assumed zero.
 */
export function reserveAdmission(
  db: BudgetStore, policy: BudgetPolicy, operation: BudgetOperation,
  outstanding: () => readonly BudgetOperation[], now = Date.now(),
  cleanupSummary?:()=>RetainedCleanupSummary,
): {reservation: BudgetVector; status: BudgetView} | undefined {
  if (!policy.enabled) return undefined;
  if (!db.inTransaction) throw new ApiError('GATEWAY_DEGRADED', 'Admission reservation requires the canonical transaction.', 503);
  if (!validNumber(now)) throw new ApiError('GATEWAY_DEGRADED', 'Admission accounting clock is invalid.', 503);
  return db.transaction(() => {
    const stored = db.get<unknown>(ADMISSION_BUDGET_KEY);
    if (stored === undefined && db.get<unknown>(INITIALIZED_KEY) !== undefined)
      throw new ApiError('GATEWAY_DEGRADED', 'Admission accounting record is missing.', 503);
    const old = stored === undefined ? undefined : checkedState(stored);
    if (old && now + MAX_CLOCK_ROLLBACK_MS < old.observedAt)
      throw new ApiError('GATEWAY_DEGRADED', 'Admission accounting clock moved backwards.', 503);
    const effectiveNow = Math.max(now, old?.observedAt ?? now);
    const utcDay = Math.floor(effectiveNow / UTC_DAY_MS);
    let state: BudgetState;
    if (!old || old.utcDay !== utcDay) {
      const obligations = outstanding();
      if (obligations.length > MAX_OBLIGATIONS)
        throw new ApiError('GATEWAY_DEGRADED', 'Outstanding accounting exceeds bounded journal capacity.', 503);
      const cleanup=checkedCleanupSummary(cleanupSummary?cleanupSummary():maximumCleanupSummary());
      const retainedCleanup=retainedCleanupReservation(cleanup);
      let carried = add(policy.baseline,retainedCleanup);
      for (const item of obligations)
        carried = add(carried, item.budgetReservation === undefined
          ? completionReservation(item.tool,item.args) : vector(item.budgetReservation));
      state = {schemaVersion:1,utcDay,observedAt:effectiveNow,reserved:carried,admissions:0,retainedCleanup,cleanupSummary:cleanup};
    } else state = {...old,observedAt:effectiveNow};
    const before = view(state,policy), reservation = completionReservation(operation.tool,operation.args);
    const after = view({...state,reserved:add(state.reserved,reservation)},policy);
    if (after.ratio >= 0.95 || (before.ratio >= 0.85 && costly(operation.tool)))
      throw new ApiError('QUOTA_EXCEEDED', `Local Workspace ${after.limiting} estimate would reach ${Math.ceil(after.ratio*100)}%; new admission is restricted to preserve recovery headroom.`, 429,
        'Inspect the local allocation and account metrics. Existing operation results and recovery remain available.');
    state.reserved = after.reserved;
    state.admissions++;
    if (!validNumber(state.admissions)) throw new ApiError('GATEWAY_DEGRADED', 'Admission accounting overflow.', 503);
    if (!old) db.put(INITIALIZED_KEY,{schemaVersion:1});
    db.put(ADMISSION_BUDGET_KEY,state);
    return {reservation,status:view(state,policy)};
  });
}

/** Operator-facing snapshot only. A failed budget diagnostic cannot block recovery. */
export function admissionBudgetSnapshot(
  db: Pick<BudgetStore,'get'>, policy: BudgetPolicy, now=Date.now(),
): ({enabled:true;known:true;staleDay:boolean;observedAt:number}&BudgetView) |
  {enabled:boolean;known:false;scope:'workspace';reason:'DISABLED'|'NOT_INITIALIZED'|'ACCOUNTING_UNAVAILABLE'} {
  if(!policy.enabled)return {enabled:false,known:false,scope:'workspace',reason:'DISABLED'};
  try {
    const stored=db.get<unknown>(ADMISSION_BUDGET_KEY);
    if(stored===undefined)return {enabled:true,known:false,scope:'workspace',reason:
      db.get<unknown>(INITIALIZED_KEY)===undefined?'NOT_INITIALIZED':'ACCOUNTING_UNAVAILABLE'};
    const state=checkedState(stored);
    return {...view(state,policy),enabled:true,known:true,observedAt:state.observedAt,
      staleDay:!validNumber(now)||Math.floor(now/UTC_DAY_MS)!==state.utcDay};
  } catch {
    return {enabled:true,known:false,scope:'workspace',reason:'ACCOUNTING_UNAVAILABLE'};
  }
}
