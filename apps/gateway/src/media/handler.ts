import { ApiError, canonical, digest, fields, id } from '../common.js';
import { BinaryPayloads, readMediaMetadata, type MediaRecordStore, type PayloadFormat } from '../binary-payloads.js';
import { mediaCatalog, type MediaCatalog } from '../media-catalog.js';
import { validateToolCall } from '../../../../packages/contracts/src/index.js';
import { generateElevenLabsMusic, MusicProviderError, type MusicInput, type MusicOutput, type MusicProviderOptions } from './elevenlabs.js';

export const MUSIC_CHUNK_BYTES = 192 * 1024;
const MAX_BYTES = 8 * 1024 * 1024;
const RETENTION_MS = 10 * 60 * 1000;
export interface MusicRecordStore extends MediaRecordStore {}
export interface MusicLease { workspaceId: string; epoch: number; bindingRevision: number; tabInstanceId: string; expiresAt: number; permissions: string[] }
export interface MusicOperation {
  operationId: string; workspaceId: string; epoch: number; bindingRevision: number; tabInstanceId: string; deadlineMs: number;
  tool: string; args?: Record<string, unknown>; permissions: string[]; phase: string; terminalAt?: number;
  props: unknown; agentId: string; result?: unknown;
}
export interface MusicHandlerEnvironment { ELEVENLABS_API_KEY?: string; PAID_MEDIA_ENABLED?: string; BINARY_PAYLOADS_ENABLED?: string }
export interface MusicHandlerDependencies<T extends MusicOperation = MusicOperation> {
  getLease(): MusicLease | undefined;
  getOperation?(operationId: string): T | undefined;
  putOperation?(operation: T): void;
  now?(): number;
  /** Production callers also require the Workspace canonical reader/schema fence before native writes. */
  binaryPayloadsEnabled?(): boolean;
  onStoragePreparationPending?(): void;
  /** Must check current Registry Grant, assignment, binding, MEDIA and WRITE_SOURCE; use dispatch permit for start. */
  authorize(operation: T, action: 'start' | 'read'): Promise<void>;
  generate?: (input: MusicInput, options: MusicProviderOptions) => Promise<MusicOutput>;
}
interface Journal {
  operationId: string; workspaceId: string; epoch: number; bindingRevision: number; tabInstanceId: string;
  requestDigest: string; phase: 'INTENT' | 'READY' | 'REJECTED' | 'UNKNOWN' | 'DELIVERED' | 'EXPIRED';
  createdAt: number; expiresAt?: number; bytes: number; sha256?: string; metadata?: Omit<MusicOutput, 'bytes'>;
  errorCode?: string; payloadFormat?: PayloadFormat; deliveredBytes?: number;
}
/** One instance per Workspace DO. Persistent INTENT never authorizes regeneration after restart. */
export class MusicHandler<T extends MusicOperation = MusicOperation> {
  private readonly active = new Set<string>();
  private readonly payloads: BinaryPayloads;
  private readonly catalog: MediaCatalog;
  constructor(private readonly db: MusicRecordStore, private readonly env: MusicHandlerEnvironment, private readonly deps: MusicHandlerDependencies<T>) { this.payloads = new BinaryPayloads(db); this.catalog = mediaCatalog(db); }
  private now(): number { return this.deps.now?.() ?? Date.now(); }
  private binaryEnabled(): boolean { return this.deps.binaryPayloadsEnabled?.() ?? this.env.BINARY_PAYLOADS_ENABLED === "true"; }
  storageStatus(): Record<string, unknown> { return { binaryWritesEnabled: this.binaryEnabled(), metadata: this.catalog.status("music") }; }
  prepareStorage(): boolean { return this.catalog.prepare("music"); }
  private getOperation(operationId: string): T | undefined { return this.deps.getOperation ? this.deps.getOperation(operationId) : this.db.get<T>('operation/' + operationId); }
  private putOperation(operation: T): void { if (this.deps.putOperation) this.deps.putOperation(operation); else this.db.put('operation/' + operation.operationId, operation); }
  private load(key: string): Journal | undefined {
    const value = readMediaMetadata<Journal>(this.db,key);
    if (value===undefined) return undefined;
    const text = (v: unknown) => typeof v === 'string' && v.length>0;
    const whole = (v: unknown, min: number, max=Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && (v as number)>=min && (v as number)<=max;
    if (!value || typeof value!=='object' || Array.isArray(value) || !text(value.operationId) || this.key(value.operationId)!==key || !text(value.workspaceId) ||
        !text(value.tabInstanceId) || !text(value.requestDigest) || !whole(value.epoch,1) || !whole(value.bindingRevision,1) || !whole(value.createdAt,0) || !whole(value.bytes,0,MAX_BYTES) ||
        !['INTENT','READY','REJECTED','UNKNOWN','DELIVERED','EXPIRED'].includes(value.phase) || (value.expiresAt!==undefined && !whole(value.expiresAt,0)) ||
        (value.sha256!==undefined && (typeof value.sha256!=='string' || !/^[a-f0-9]{64}$/.test(value.sha256))) ||
        (value.bytes>0 && (value.expiresAt===undefined || value.sha256===undefined)) || (value.phase==='READY' && value.bytes===0) ||
        (value.deliveredBytes!==undefined && !whole(value.deliveredBytes,1,MAX_BYTES))) throw new Error('SQLITE_RECORD_CORRUPT');
    if (value.payloadFormat!==undefined && value.payloadFormat!=='BLOB_V1') throw new ApiError('INCOMPATIBLE_VERSION','Unsupported music payload format.',409);
    return value;
  }
  private save(journal: Journal): void { const key = this.key(journal.operationId); this.db.put(key, journal); this.catalog.changed(key); }
  private removeChunks(journal: Journal): void {
    if (journal.payloadFormat !== undefined && journal.payloadFormat !== "BLOB_V1") throw new ApiError('INCOMPATIBLE_VERSION', 'Unsupported music payload format.', 409);
    for (let offset = 0; offset < journal.bytes; offset += MUSIC_CHUNK_BYTES) {
      const key = this.chunkKey(journal.operationId, offset);
      if (journal.payloadFormat === "BLOB_V1") this.payloads.delete(key); else this.db.delete(key);
    }
  }
  private key(operationId: string): string { return 'music/journal/' + operationId }
  private chunkKey(operationId: string, offset: number): string { return `music/chunk/${operationId}/${String(offset).padStart(10, '0')}` }
  private operation(operationId: string, lease: MusicLease): T {
    const current = this.deps.getLease(), operation = this.getOperation(operationId);
    if (!current || current.workspaceId !== lease.workspaceId || current.epoch !== lease.epoch || current.bindingRevision !== lease.bindingRevision || current.tabInstanceId !== lease.tabInstanceId || current.expiresAt <= this.now()) throw new ApiError('STALE_EPOCH', 'Music route requires the current live lease.', 409);
    if (!operation || operation.tool !== 'generate_music' || operation.phase !== 'RUNNING' || operation.workspaceId !== current.workspaceId || operation.epoch !== current.epoch || operation.bindingRevision !== current.bindingRevision || operation.tabInstanceId !== current.tabInstanceId || operation.deadlineMs <= this.now()) throw new ApiError('STALE_EPOCH', 'Music route requires the exact running generate_music operation.', 409);
    if (!['MEDIA', 'WRITE_SOURCE'].every(permission => operation.permissions.includes(permission) && current.permissions.includes(permission))) throw new ApiError('SCOPE_DENIED', 'Music generation requires current MEDIA and WRITE_SOURCE permission.', 403);
    return operation;
  }
  private sameJournal(journal: Journal, operation: MusicOperation): void {
    if (journal.operationId !== operation.operationId || journal.workspaceId !== operation.workspaceId || journal.epoch !== operation.epoch || journal.bindingRevision !== operation.bindingRevision || journal.tabInstanceId !== operation.tabInstanceId) throw new ApiError('STALE_EPOCH', 'Music result belongs to another operation or lease.', 409);
  }
  private unknown(journal: Journal, code = 'EFFECT_UNKNOWN'): void {
    const current = this.load(this.key(journal.operationId));
    if (!current || current.requestDigest !== journal.requestDigest) throw new Error('SQLITE_RECORD_CORRUPT');
    if (['INTENT','READY','UNKNOWN'].includes(current.phase)) { current.phase = 'UNKNOWN'; current.errorCode = code; this.save(current); }
    Object.assign(journal, current);
    const operation = this.getOperation(journal.operationId);
    if (operation && ['RUNNING', 'DISPATCHED'].includes(operation.phase)) {
      operation.phase = 'UNKNOWN'; operation.terminalAt = this.now(); delete operation.args;
      operation.result = { operationId: operation.operationId, status: 'UNKNOWN', effectState: 'POSSIBLE', error: { code: 'EFFECT_UNKNOWN', message: 'Paid media was dispatched; reconcile provider usage and retained media evidence before another generation.', retryable: false, recovery: 'Inspect operation_status and provider usage. Do not regenerate.' } };
      this.putOperation(operation);
    }
  }
  private prune(keys?: string[]): void {
    this.db.transaction(() => {
      const now = this.now();
      const selected = keys ?? (this.catalog.available ? [...new Set([...this.catalog.due("music", now, true), ...this.catalog.due("music", now)])] : this.db.keys('music/journal/'));
      for (const key of selected) {
        const journal = this.load(key);
        if (!journal) continue;
        if (journal.expiresAt && journal.expiresAt <= now && journal.bytes) {
          this.removeChunks(journal); journal.bytes = 0;
          if (journal.phase === 'READY') journal.phase = 'EXPIRED';
          this.save(journal);
        }
        if (['DELIVERED','EXPIRED','REJECTED'].includes(journal.phase) && journal.createdAt + 7 * 86400000 <= now) { this.db.delete(key); this.catalog.changed(key); }
      }
    });
  }
  expire(keys?: string[]): void { this.prune(keys); this.payloads.expire(this.now()); }
  nextExpiry(): number | undefined {
    if (this.catalog.available) return this.catalog.nextDue("music", true);
    const expiries = this.db.keys('music/journal/').map(key => this.load(key)).filter((row): row is Journal => !!row && row.bytes > 0 && row.expiresAt !== undefined).map(row => row.expiresAt!);
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
    if (path === '/api/v1/tab/music-result' && (!Number.isSafeInteger(body.offset) || (body.offset as number) < 0 || (body.offset as number) > MAX_BYTES || (body.ackSha256 !== undefined && (typeof body.ackSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(body.ackSha256))))) throw new ApiError('INVALID_INPUT', 'Music result range or acknowledgement digest is invalid.');
    this.prune([this.key(operationId)]);
    if (path === '/api/v1/tab/music-result') return this.readChunk(operation, body);
    const args = validateToolCall('generate_music', operation.args), requestDigest = await digest(canonical(args));
    const fresh = this.operation(operationId, lease);
    if (canonical(fresh.args) !== canonical(args)) throw new ApiError('CONFLICT', 'Music operation arguments changed.', 409);
    let existing: Journal | undefined;
    this.db.transaction(() => {
      existing = this.load(this.key(operationId));
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
    const timeoutMs = Math.min(300000, fresh.deadlineMs - this.now());
    if (timeoutMs < 1000) throw new ApiError('TIMEOUT', 'Insufficient remaining operation deadline before provider dispatch.', 409);
    if (this.catalog.available) {
      this.catalog.initialize();
      // Commit bounded progress before the admission transaction can reject.
      if (!this.catalog.prepare("music")) {
        try { this.deps.onStoragePreparationPending?.(); } catch { /* Pending progress remains durable. */ }
        throw new ApiError("TAB_BUSY", "Media storage preparation is incomplete; no provider intent was created.", 503, "Wait for bounded storage maintenance. Existing results and uncertain effects remain available.");
      }
    }
    if (this.binaryEnabled()) this.payloads.prepare();
    const journal: Journal = { operationId, workspaceId: fresh.workspaceId, epoch: fresh.epoch, bindingRevision: fresh.bindingRevision, tabInstanceId: fresh.tabInstanceId, requestDigest, phase: 'INTENT', createdAt: this.now(), bytes: 0 };
    this.db.transaction(() => {
      // Concurrent requests may have raced through argument hashing; serialize admission and budget reservation.
      this.operation(operationId, lease);
      if (this.load(this.key(operationId))) throw new ApiError('CONFLICT', 'Music operation already admitted; inspect its handle.', 409);
      this.prune();
      const journals = this.catalog.available ? undefined : this.db.keys('music/journal/').map(key => this.load(key)).filter((row): row is Journal => !!row);
      const totals = this.catalog.available ? this.catalog.counters('music') : { count: journals!.length, busy: journals!.filter(row => row.phase === 'INTENT' || row.bytes > 0).length };
      if (totals.count >= 1000) throw new ApiError('QUOTA_EXCEEDED', 'Paid media journal budget exhausted; resolve retained effects.', 429);
      if (totals.busy > 0) throw new ApiError('QUOTA_EXCEEDED', 'Consume or expire the previous media artifact before another generation.', 429);
      if (this.binaryEnabled()) {
        if (!this.payloads.available()) throw new ApiError("INCOMPATIBLE_VERSION", "Native binary payload storage is unavailable.", 409);
        journal.payloadFormat = "BLOB_V1";
      }
      this.save(journal); // Durable external intent precedes any paid request.
    });
    this.active.add(operationId);
    try {
      const input: MusicInput = { style: String(args.style), isInstrumental: args.isInstrumental as boolean, ...(args.lyrics === undefined ? {} : { lyrics: args.lyrics as string }), ...(args.seed === undefined ? {} : { seed: args.seed as number }), ...(args.userRequestedSeconds === undefined ? {} : { userRequestedSeconds: args.userRequestedSeconds as number }) };
      const generated = await (this.deps.generate ?? generateElevenLabsMusic)(input, { apiKey: this.env.ELEVENLABS_API_KEY, paidEnabled: true, maxBytes: MAX_BYTES, timeoutMs });
      if (generated.bytes.length > MAX_BYTES || !generated.bytes.length) throw new MusicProviderError('LIMIT_EXCEEDED', 'Generated music exceeds the Workspace artifact budget.', 'UNKNOWN');
      const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', generated.bytes.slice().buffer as ArrayBuffer)), byte => byte.toString(16).padStart(2, '0')).join('');
      const { bytes: audio, ...metadata } = generated;
      this.db.transaction(() => {
        const current = this.load(this.key(operationId));
        if (!current || current.requestDigest !== journal.requestDigest) throw new Error('SQLITE_RECORD_CORRUPT');
        this.sameJournal(current, fresh);
        if (!['INTENT','UNKNOWN'].includes(current.phase)) throw new ApiError('CONFLICT', 'Paid media intent already has a retained outcome; no outcome was overwritten.', 409);
        const expiresAt = this.now() + RETENTION_MS;
        for (let offset = 0; offset < audio.length; offset += MUSIC_CHUNK_BYTES) {
          const key = this.chunkKey(operationId, offset), chunk = audio.subarray(offset, offset + MUSIC_CHUNK_BYTES);
          if (current.payloadFormat === "BLOB_V1") this.payloads.put(key, chunk, expiresAt);
          else if (current.payloadFormat === undefined) this.db.put(key, toBase64(chunk));
          else throw new ApiError('INCOMPATIBLE_VERSION', 'Unsupported music payload format.', 409);
        }
        if (current.phase === 'INTENT') current.phase = 'READY';
        current.bytes = audio.length; current.sha256 = sha256; current.metadata = metadata; current.expiresAt = expiresAt;
        this.save(current); Object.assign(journal, current);
      });
      // A revoked/expired binding cannot receive the output even when paid generation has already completed.
      try { this.operation(operationId, lease); await this.deps.authorize(fresh, 'read'); this.operation(operationId, lease) }
      catch { this.db.transaction(() => this.unknown(journal)); throw new ApiError('EFFECT_UNKNOWN', 'Paid generation completed after authorization or lease changed; result held for reconciliation.', 409) }
      return this.manifest(journal);
    } catch (error) {
      if (error instanceof MusicProviderError && error.effectState === 'NONE') {
        const current = this.load(this.key(operationId));
        if (current?.phase === 'INTENT') { current.phase = 'REJECTED'; current.errorCode = error.code; this.save(current); }
        throw new ApiError(error.code, 'Music provider rejected the request without a verified generation; no automatic retry.', 409);
      }
      this.db.transaction(() => this.unknown(journal));
      throw new ApiError('EFFECT_UNKNOWN', 'Paid media outcome requires reconciliation; another request cannot regenerate it.', 409);
    } finally { this.active.delete(operationId) }
  }
  private readChunk(operation: MusicOperation, body: Record<string, unknown>): Record<string, unknown> {
    const journal = this.load(this.key(operation.operationId));
    if (!journal) throw new ApiError('NOT_FOUND', 'Music operation has no retained provider result.', 404);
    this.sameJournal(journal, operation);
    if (journal.phase === 'DELIVERED' && body.ackSha256 === journal.sha256 && Number.isSafeInteger(journal.deliveredBytes) && body.offset === journal.deliveredBytes) return { operationId: operation.operationId, status: 'DELIVERED', sha256: journal.sha256 };
    if (journal.phase !== 'READY' || !journal.sha256 || !journal.expiresAt || journal.expiresAt <= this.now()) throw new ApiError(journal.phase === 'INTENT' ? 'TAB_BUSY' : 'RESULT_EXPIRED', 'Music result is not available; no provider operation was replayed.', 409);
    const offset = body.offset;
    if (!Number.isSafeInteger(offset) || (offset as number) < 0 || (offset as number) > journal.bytes) throw new ApiError('INVALID_INPUT', 'Music result offset is outside the artifact.', 400);
    if (body.ackSha256 !== undefined) {
      if (offset !== journal.bytes || body.ackSha256 !== journal.sha256) throw new ApiError('INVALID_INPUT', 'Consumption acknowledgement requires the complete verified artifact digest.', 400);
      this.db.transaction(() => {
        this.removeChunks(journal);
        journal.deliveredBytes = journal.bytes; journal.bytes = 0; journal.phase = 'DELIVERED'; this.save(journal);
      });
      return { operationId: operation.operationId, status: 'DELIVERED', sha256: journal.sha256 };
    }
    if ((offset as number) % MUSIC_CHUNK_BYTES !== 0 || offset === journal.bytes) throw new ApiError('INVALID_INPUT', 'Music chunk offset must be aligned and below total bytes.', 400);
    const key = this.chunkKey(operation.operationId, offset as number);
    if (journal.payloadFormat !== undefined && journal.payloadFormat !== 'BLOB_V1') throw new ApiError('INCOMPATIBLE_VERSION', 'Unsupported music payload format.', 409);
    const base64 = journal.payloadFormat === 'BLOB_V1' ? toBase64(this.payloads.get(key)) : readMediaMetadata<string>(this.db, key);
    if (typeof base64 !== 'string') throw new ApiError('RESULT_EXPIRED', 'Music artifact chunk is missing; generation will not be replayed.', 409);
    const nextOffset = Math.min(journal.bytes, (offset as number) + MUSIC_CHUNK_BYTES);
    if (base64.length !== Math.ceil((nextOffset - (offset as number)) / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error('SQLITE_RECORD_CORRUPT');
    let decoded: string;
    try { decoded = atob(base64); } catch { throw new Error('SQLITE_RECORD_CORRUPT'); }
    if (decoded.length !== nextOffset - (offset as number) || btoa(decoded) !== base64) throw new Error('SQLITE_RECORD_CORRUPT');
    return { operationId: operation.operationId, offset, totalBytes: journal.bytes, sha256: journal.sha256, base64, nextOffset, done: nextOffset === journal.bytes };
  }
}
function toBase64(bytes: Uint8Array): string {
  let binary = ''; for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192)); return btoa(binary);
}
