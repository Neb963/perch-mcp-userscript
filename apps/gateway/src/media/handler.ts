import { ApiError, canonical, digest, fields, id } from '../common.js';
import { validateToolCall } from '../../../../packages/contracts/src/index.js';
import { generateElevenLabsMusic, MusicProviderError, type MusicInput, type MusicOutput, type MusicProviderOptions } from './elevenlabs.js';

export const MUSIC_CHUNK_BYTES = 192 * 1024;
const MAX_BYTES = 8 * 1024 * 1024;
const RETENTION_MS = 10 * 60 * 1000;
export interface MusicRecordStore {
  get<T>(key: string, fallback?: T): T;
  put(key: string, value: unknown): void;
  delete(key: string): void;
  keys(prefix: string): string[];
  transaction<T>(fn: () => T): T;
}
export interface MusicLease { workspaceId: string; epoch: number; bindingRevision: number; tabInstanceId: string; expiresAt: number; permissions: string[] }
export interface MusicOperation {
  operationId: string; workspaceId: string; epoch: number; bindingRevision: number; tabInstanceId: string; deadlineMs: number;
  tool: string; args?: Record<string, unknown>; permissions: string[]; phase: string; terminalAt?: number;
  props: unknown; agentId: string; result?: unknown;
}
export interface MusicHandlerEnvironment { ELEVENLABS_API_KEY?: string; PAID_MEDIA_ENABLED?: string }
export interface MusicHandlerDependencies {
  getLease(): MusicLease | undefined;
  /** Must check current Registry Grant, assignment, binding, MEDIA and WRITE_SOURCE; use dispatch permit for start. */
  authorize(operation: MusicOperation, action: 'start' | 'read'): Promise<void>;
  generate?: (input: MusicInput, options: MusicProviderOptions) => Promise<MusicOutput>;
}
interface Journal {
  operationId: string; workspaceId: string; epoch: number; bindingRevision: number; tabInstanceId: string;
  requestDigest: string; phase: 'INTENT' | 'READY' | 'REJECTED' | 'UNKNOWN' | 'DELIVERED' | 'EXPIRED';
  createdAt: number; expiresAt?: number; bytes: number; sha256?: string; metadata?: Omit<MusicOutput, 'bytes'>;
  errorCode?: string;
}
/** One instance per Workspace DO. Persistent INTENT never authorizes regeneration after restart. */
export class MusicHandler {
  private readonly active = new Set<string>();
  constructor(private readonly db: MusicRecordStore, private readonly env: MusicHandlerEnvironment, private readonly deps: MusicHandlerDependencies) {}
  private key(operationId: string): string { return 'music/journal/' + operationId }
  private chunkKey(operationId: string, offset: number): string { return `music/chunk/${operationId}/${String(offset).padStart(10, '0')}` }
  private operation(operationId: string, lease: MusicLease): MusicOperation {
    const current = this.deps.getLease(), operation = this.db.get<MusicOperation>('operation/' + operationId);
    if (!current || current.workspaceId !== lease.workspaceId || current.epoch !== lease.epoch || current.bindingRevision !== lease.bindingRevision || current.tabInstanceId !== lease.tabInstanceId || current.expiresAt <= Date.now()) throw new ApiError('STALE_EPOCH', 'Music route requires the current live lease.', 409);
    if (!operation || operation.tool !== 'generate_music' || operation.phase !== 'RUNNING' || operation.workspaceId !== current.workspaceId || operation.epoch !== current.epoch || operation.bindingRevision !== current.bindingRevision || operation.tabInstanceId !== current.tabInstanceId || operation.deadlineMs <= Date.now()) throw new ApiError('STALE_EPOCH', 'Music route requires the exact running generate_music operation.', 409);
    if (!['MEDIA', 'WRITE_SOURCE'].every(permission => operation.permissions.includes(permission) && current.permissions.includes(permission))) throw new ApiError('SCOPE_DENIED', 'Music generation requires current MEDIA and WRITE_SOURCE permission.', 403);
    return operation;
  }
  private sameJournal(journal: Journal, operation: MusicOperation): void {
    if (journal.operationId !== operation.operationId || journal.workspaceId !== operation.workspaceId || journal.epoch !== operation.epoch || journal.bindingRevision !== operation.bindingRevision || journal.tabInstanceId !== operation.tabInstanceId) throw new ApiError('STALE_EPOCH', 'Music result belongs to another operation or lease.', 409);
  }
  private unknown(journal: Journal, code = 'EFFECT_UNKNOWN'): void {
    journal.phase = 'UNKNOWN'; journal.errorCode = code; this.db.put(this.key(journal.operationId), journal);
    const operation = this.db.get<MusicOperation>('operation/' + journal.operationId);
    if (operation && ['RUNNING', 'DISPATCHED'].includes(operation.phase)) {
      operation.phase = 'UNKNOWN'; operation.terminalAt = Date.now(); delete operation.args;
      operation.result = { operationId: operation.operationId, status: 'UNKNOWN', effectState: 'POSSIBLE', error: { code: 'EFFECT_UNKNOWN', message: 'Paid media was dispatched; reconcile provider usage and retained media evidence before another generation.', retryable: false, recovery: 'Inspect operation_status and provider usage. Do not regenerate.' } };
      this.db.put('operation/' + operation.operationId, operation);
    }
  }
  private prune(keys?:string[]): void {
    this.db.transaction(() => {
      const now = Date.now();
      for (const key of keys??this.db.keys('music/journal/')) {
        const journal = this.db.get<Journal>(key);
        if(!journal)continue;
        if (journal.expiresAt && journal.expiresAt <= now && journal.bytes) {
          for (const chunk of this.db.keys('music/chunk/' + journal.operationId + '/')) this.db.delete(chunk);
          journal.bytes = 0; if (journal.phase === 'READY') journal.phase = 'EXPIRED'; this.db.put(key, journal);
        }
        if (['DELIVERED', 'EXPIRED', 'REJECTED'].includes(journal.phase) && journal.createdAt + 7 * 86400000 <= now) this.db.delete(key);
      }
    });
  }
  expire(keys?:string[]): void { this.prune(keys) }
  nextExpiry(): number | undefined {
    const expiries = this.db.keys('music/journal/').map(key => this.db.get<Journal>(key))
      .filter(row => row.bytes > 0 && row.expiresAt !== undefined).map(row => row.expiresAt!);
    return expiries.length ? Math.min(...expiries) : undefined;
  }
  private manifest(journal: Journal): Record<string, unknown> {
    return { status: journal.phase, operationId: journal.operationId, bytes: journal.bytes, sha256: journal.sha256, chunkBytes: MUSIC_CHUNK_BYTES, expiresAt: journal.expiresAt, contentType: 'audio/mpeg', metadata: journal.metadata };
  }
  async handle(path: '/api/v1/tab/music' | '/api/v1/tab/music-result', body: Record<string, unknown>, lease: MusicLease): Promise<Record<string, unknown>> {
    fields(body, ['workspaceId', 'epoch', 'tabInstanceId', 'operationId', ...(path === '/api/v1/tab/music-result' ? ['offset', 'ackSha256'] : [])]);
    if (body.workspaceId !== lease.workspaceId || body.epoch !== lease.epoch || body.tabInstanceId !== lease.tabInstanceId) throw new ApiError('STALE_EPOCH', 'Music request identity differs from lease.', 409);
    const operationId = id(body.operationId), initial = this.operation(operationId, lease);
    await this.deps.authorize(initial, path === '/api/v1/tab/music' ? 'start' : 'read');
    const operation = this.operation(operationId, lease); // Synchronous revalidation after the Registry await.
    this.prune();
    if (path === '/api/v1/tab/music-result') return this.readChunk(operation, body);
    const args = validateToolCall('generate_music', operation.args), requestDigest = await digest(canonical(args));
    const fresh = this.operation(operationId, lease);
    if (canonical(fresh.args) !== canonical(args)) throw new ApiError('CONFLICT', 'Music operation arguments changed.', 409);
    let existing: Journal | undefined;
    this.db.transaction(() => {
      existing = this.db.get<Journal>(this.key(operationId));
      if (existing) {
        this.sameJournal(existing, fresh);
        if (existing.requestDigest !== requestDigest) throw new ApiError('CONFLICT', 'Operation ID cannot be reused with different music arguments.', 409);
      }
    });
    if (existing) {
      if (existing.phase === 'READY') return this.manifest(existing);
      if (existing.phase === 'INTENT' && this.active.has(operationId)) return { status: 'RUNNING', operationId };
      if (existing.phase === 'INTENT') { this.db.transaction(() => this.unknown(existing!)); throw new ApiError('EFFECT_UNKNOWN', 'Provider intent survived without an active execution; no automatic regeneration.', 409) }
      throw new ApiError(existing.phase === 'DELIVERED' || existing.phase === 'EXPIRED' ? 'RESULT_EXPIRED' : existing.errorCode ?? 'EFFECT_UNKNOWN', 'Music operation is retained and cannot be regenerated.', 409);
    }
    if (this.env.PAID_MEDIA_ENABLED !== 'true' || !this.env.ELEVENLABS_API_KEY) throw new ApiError('APPROVAL_REQUIRED', 'Operator must configure the scoped music secret and explicitly enable paid media.', 403);
    const timeoutMs = Math.min(300000, fresh.deadlineMs - Date.now());
    if (timeoutMs < 1000) throw new ApiError('TIMEOUT', 'Insufficient remaining operation deadline before provider dispatch.', 409);
    const journal: Journal = { operationId, workspaceId: fresh.workspaceId, epoch: fresh.epoch, bindingRevision: fresh.bindingRevision, tabInstanceId: fresh.tabInstanceId, requestDigest, phase: 'INTENT', createdAt: Date.now(), bytes: 0 };
    this.db.transaction(() => {
      // Concurrent requests may have raced through argument hashing; serialize admission and budget reservation.
      this.operation(operationId, lease);
      if (this.db.get<Journal>(this.key(operationId))) throw new ApiError('CONFLICT', 'Music operation already admitted; inspect its handle.', 409);
      const journals = this.db.keys('music/journal/').map(key => this.db.get<Journal>(key));
      if (journals.length >= 1000) throw new ApiError('QUOTA_EXCEEDED', 'Paid media journal budget exhausted; resolve retained effects.', 429);
      if (journals.some(row => row.phase === 'INTENT' || row.bytes > 0)) throw new ApiError('QUOTA_EXCEEDED', 'Consume or expire the previous media artifact before another generation.', 429);
      this.db.put(this.key(operationId), journal); // Durable external intent precedes any paid request.
    });
    this.active.add(operationId);
    try {
      const input: MusicInput = { style: String(args.style), isInstrumental: args.isInstrumental as boolean, ...(args.lyrics === undefined ? {} : { lyrics: args.lyrics as string }), ...(args.seed === undefined ? {} : { seed: args.seed as number }), ...(args.userRequestedSeconds === undefined ? {} : { userRequestedSeconds: args.userRequestedSeconds as number }) };
      const generated = await (this.deps.generate ?? generateElevenLabsMusic)(input, { apiKey: this.env.ELEVENLABS_API_KEY, paidEnabled: true, maxBytes: MAX_BYTES, timeoutMs });
      if (generated.bytes.length > MAX_BYTES || !generated.bytes.length) throw new MusicProviderError('LIMIT_EXCEEDED', 'Generated music exceeds the Workspace artifact budget.', 'UNKNOWN');
      const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', generated.bytes.slice().buffer as ArrayBuffer)), byte => byte.toString(16).padStart(2, '0')).join('');
      const { bytes: audio, ...metadata } = generated;
      this.db.transaction(() => {
        for (let offset = 0; offset < audio.length; offset += MUSIC_CHUNK_BYTES) this.db.put(this.chunkKey(operationId, offset), toBase64(audio.subarray(offset, offset + MUSIC_CHUNK_BYTES)));
        journal.phase = 'READY'; journal.bytes = audio.length; journal.sha256 = sha256; journal.metadata = metadata; journal.expiresAt = Date.now() + RETENTION_MS;
        this.db.put(this.key(operationId), journal);
      });
      // A revoked/expired binding cannot receive the output even when paid generation has already completed.
      try { this.operation(operationId, lease); await this.deps.authorize(fresh, 'read'); this.operation(operationId, lease) }
      catch { this.db.transaction(() => this.unknown(journal)); throw new ApiError('EFFECT_UNKNOWN', 'Paid generation completed after authorization or lease changed; result held for reconciliation.', 409) }
      return this.manifest(journal);
    } catch (error) {
      if (error instanceof MusicProviderError && error.effectState === 'NONE') {
        journal.phase = 'REJECTED'; journal.errorCode = error.code; this.db.put(this.key(operationId), journal);
        throw new ApiError(error.code, 'Music provider rejected the request without a verified generation; no automatic retry.', 409);
      }
      this.db.transaction(() => this.unknown(journal));
      throw new ApiError('EFFECT_UNKNOWN', 'Paid media outcome requires reconciliation; another request cannot regenerate it.', 409);
    } finally { this.active.delete(operationId) }
  }
  private readChunk(operation: MusicOperation, body: Record<string, unknown>): Record<string, unknown> {
    const journal = this.db.get<Journal>(this.key(operation.operationId));
    if (!journal) throw new ApiError('NOT_FOUND', 'Music operation has no retained provider result.', 404);
    this.sameJournal(journal, operation);
    if (journal.phase !== 'READY' || !journal.sha256 || !journal.expiresAt || journal.expiresAt <= Date.now()) throw new ApiError(journal.phase === 'INTENT' ? 'TAB_BUSY' : 'RESULT_EXPIRED', 'Music result is not available; no provider operation was replayed.', 409);
    const offset = body.offset;
    if (!Number.isSafeInteger(offset) || (offset as number) < 0 || (offset as number) > journal.bytes) throw new ApiError('INVALID_INPUT', 'Music result offset is outside the artifact.', 400);
    if (body.ackSha256 !== undefined) {
      if (offset !== journal.bytes || body.ackSha256 !== journal.sha256) throw new ApiError('INVALID_INPUT', 'Consumption acknowledgement requires the complete verified artifact digest.', 400);
      this.db.transaction(() => {
        for (const key of this.db.keys('music/chunk/' + operation.operationId + '/')) this.db.delete(key);
        journal.bytes = 0; journal.phase = 'DELIVERED'; this.db.put(this.key(operation.operationId), journal);
      });
      return { operationId: operation.operationId, status: 'DELIVERED', sha256: journal.sha256 };
    }
    if ((offset as number) % MUSIC_CHUNK_BYTES !== 0 || offset === journal.bytes) throw new ApiError('INVALID_INPUT', 'Music chunk offset must be aligned and below total bytes.', 400);
    const base64 = this.db.get<string>(this.chunkKey(operation.operationId, offset as number));
    if (typeof base64 !== 'string') throw new ApiError('RESULT_EXPIRED', 'Music artifact chunk is missing; generation will not be replayed.', 409);
    const nextOffset = Math.min(journal.bytes, (offset as number) + MUSIC_CHUNK_BYTES);
    return { operationId: operation.operationId, offset, totalBytes: journal.bytes, sha256: journal.sha256, base64, nextOffset, done: nextOffset === journal.bytes };
  }
}
function toBase64(bytes: Uint8Array): string {
  let binary = ''; for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192)); return btoa(binary);
}
