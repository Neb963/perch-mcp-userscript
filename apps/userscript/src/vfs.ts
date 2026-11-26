import { NativeAdapter } from './adapter.js';
import { ChunkStore } from './storage.js';
import { BrowserError, base64ToBytes, bytesToBase64, canonicalPath, digest, equalIdentity, snapshotRevision, utf8, type FileWrite, type KeyValueStore, type MutationResult, type NativeIdentity, type NativeSnapshot } from './native-types.js';
export interface WorkspaceSnapshot extends NativeSnapshot { nativeRevision: string; generation: number }
interface StoredSource { version: 1; identity: NativeIdentity; files: Record<string, string>; revision: string; createdAt: number; label: string; pinned: boolean }
interface LocalState { version: 1; files: Record<string, string>; lastHash: string; generation: number }
interface Journal { id: string; state: 'INTENT' | 'SUCCEEDED' | 'PARTIAL' | 'UNKNOWN' | 'REJECTED'; paths: string[]; baseRevision: string; checkpointId: string; createdAt: number }
/** Serialized per active lease. Durable generation pointer stores scratch without page-origin storage. */
export class VirtualFileSystem {
  private chunks: ChunkStore; private tail: Promise<unknown> = Promise.resolve(); readonly prefix: string;
  constructor(readonly adapter: NativeAdapter, readonly store: KeyValueStore, readonly workspaceId: string, readonly maxBytes = 64 * 1024 * 1024) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(workspaceId)) throw new BrowserError('INVALID_INPUT', 'Invalid local Workspace ID.'); this.prefix = `perch:workspace:${workspaceId}`; this.chunks = new ChunkStore(store, this.prefix, maxBytes);
  }
  private async local(): Promise<LocalState> { const raw = await this.chunks.get('local'); if (!raw) return { version: 1, files: {}, lastHash: '', generation: 0 }; try { const data = JSON.parse(new TextDecoder().decode(raw)) as LocalState; if (data.version !== 1 || !data.files || !Number.isSafeInteger(data.generation) || data.generation < 0) throw new Error(); for (const path of Object.keys(data.files)) if (!canonicalPath(path).startsWith('scratch/') && !path.startsWith('imports/')) throw new Error(); return data; } catch { throw new BrowserError('STORAGE_CORRUPT', 'Local filesystem manifest is invalid; export and recover it before writing.'); } }
  async snapshot(): Promise<WorkspaceSnapshot> {
    const native = await this.adapter.snapshot(); const local = await this.local(); const files = { ...native.files }; for (const [path, value] of Object.entries(local.files)) files[path] = base64ToBytes(value);
    const hash = await snapshotRevision(native.identity, files); if (hash !== local.lastHash) { local.generation++; local.lastHash = hash; await this.chunks.put('local', utf8.encode(JSON.stringify(local))); }
    return { ...native, files, nativeRevision: native.revision, revision: `${local.generation}:${hash}`, generation: local.generation };
  }
  getSnapshot(): Promise<WorkspaceSnapshot> { return this.snapshot(); }
  async list(path = ''): Promise<string[]> { if (path && !['src', 'scratch', 'imports'].includes(path)) canonicalPath(path); const files = Object.keys((await this.snapshot()).files).sort(); return path ? files.filter(name => name === path || name.startsWith(`${path.replace(/\/$/, '')}/`)) : files; }
  async read(path: string): Promise<Uint8Array> { canonicalPath(path); const bytes = (await this.snapshot()).files[path]; if (!bytes) throw new BrowserError('FILE_NOT_FOUND', 'File does not exist in assigned Workspace.'); return bytes.slice(); }
  async writeBatch(writes: FileWrite[], expectedRevision?: string): Promise<MutationResult> { return this.serial(async () => this.commit(writes, expectedRevision)); }
  private serial<T>(fn: () => Promise<T>): Promise<T> { const next = this.tail.then(fn, fn); this.tail = next.catch(() => undefined); return next; }
  private async commit(writes: FileWrite[], expectedRevision?: string): Promise<MutationResult> {
    const unresolved = await this.unresolved(); if (unresolved.length) throw new BrowserError('EFFECT_UNKNOWN', 'Workspace has unresolved native intent.', 'Inspect local journal and current source; explicit operator reconciliation is required.');
    const before = await this.snapshot(); if (expectedRevision && before.revision !== expectedRevision) throw new BrowserError('STALE_REVISION', 'Workspace revision changed.');
    if (!writes.length || writes.length > 1000) throw new BrowserError('LIMIT_EXCEEDED', 'Batch requires 1–1000 files.');
    const planned = { ...before.files }; const seen = new Set<string>();
    for (const write of writes) {
      canonicalPath(write.path); if (write.path.startsWith('imports/')) throw new BrowserError('PATH_DENIED', 'Imported source snapshots are read-only.');
      const lower = write.path.toLowerCase(); if (seen.has(lower)) throw new BrowserError('PATH_DENIED', 'Duplicate path in batch.'); seen.add(lower);
      if (Object.keys(planned).some(path => path !== write.path && path.toLowerCase() === lower)) throw new BrowserError('PATH_DENIED', 'Case-colliding path.');
      if (write.bytes === null) { if (write.path === 'main.pjs' || write.path === 'index.html') throw new BrowserError('PATH_DENIED', 'Native panels cannot be deleted.'); if (!(write.path in planned)) throw new BrowserError('FILE_NOT_FOUND', 'Delete target missing.'); delete planned[write.path]; }
      else { if (write.bytes.length > 16 * 1024 * 1024) throw new BrowserError('QUOTA_EXCEEDED', 'File exceeds configured 16 MiB inline local file budget.'); if (write.path === 'main.pjs' || write.path === 'index.html') new TextDecoder('utf-8', { fatal: true }).decode(write.bytes); planned[write.path] = write.bytes.slice(); }
    }
    if (Object.values(planned).reduce((n, b) => n + b.length, 0) > this.maxBytes) throw new BrowserError('QUOTA_EXCEEDED', 'Workspace exceeds configured total local budget.');
    const checkpoint = await this.createCheckpoint('Before source mutation', false, before); const journal: Journal = { id: crypto.randomUUID(), state: 'INTENT', paths: writes.map(w => w.path), baseRevision: before.revision, checkpointId: checkpoint.id, createdAt: Date.now() };
    await this.store.set(`${this.prefix}:journal:${journal.id}`, journal);
    const nativeWrites = writes.filter(w => !w.path.startsWith('scratch/')); let nativeResult: MutationResult = { status: 'SUCCEEDED', revision: before.nativeRevision, committed: [] };
    try { if (nativeWrites.length) nativeResult = await this.adapter.applyFiles(nativeWrites, before.nativeRevision); }
    catch (error) { journal.state = 'REJECTED'; await this.store.set(`${this.prefix}:journal:${journal.id}`, journal); throw error; }
    if (nativeResult.status !== 'SUCCEEDED') { journal.state = nativeResult.status; await this.store.set(`${this.prefix}:journal:${journal.id}`, journal); return { ...nativeResult, revision: (await this.snapshot()).revision }; }
    try {
      const afterNative = await this.adapter.snapshot(); const expectedNative = { ...before.files }; for (const path of Object.keys(expectedNative)) if (path.startsWith('scratch/') || path.startsWith('imports/')) delete expectedNative[path]; for (const w of nativeWrites) if (w.bytes === null) delete expectedNative[w.path]; else expectedNative[w.path] = w.bytes;
      if (afterNative.revision !== await snapshotRevision(before.identity, expectedNative)) throw new BrowserError('STALE_REVISION', 'Manual edit interrupted final commit.');
      const local = await this.local(); for (const w of writes.filter(w => w.path.startsWith('scratch/'))) if (w.bytes === null) delete local.files[w.path]; else local.files[w.path] = bytesToBase64(w.bytes);
      await this.chunks.put('local', utf8.encode(JSON.stringify(local))); const after = await this.snapshot();
      const expectedHash = await snapshotRevision(before.identity, planned); if (after.revision.split(':')[1] !== expectedHash) throw new BrowserError('STALE_REVISION', 'Workspace readback differs from planned complete source.');
      journal.state = 'SUCCEEDED'; await this.store.set(`${this.prefix}:journal:${journal.id}`, journal); await this.trim();
      return { status: 'SUCCEEDED', revision: after.revision, committed: writes.map(w => w.path) };
    } catch { journal.state = nativeWrites.length ? 'PARTIAL' : 'UNKNOWN'; await this.store.set(`${this.prefix}:journal:${journal.id}`, journal); return { status: journal.state, revision: before.revision, committed: nativeResult.committed, error: { code: 'PARTIAL_EFFECT', message: 'Commit or durable terminal record failed; preserve current state.', recovery: 'Inspect local journal and checkpoint. Do not replay uncertain writes.' } }; }
  }
  async checkpoint(label = 'Checkpoint', pinned = false): Promise<{ id: string; revision: string }> { return this.createCheckpoint(label, pinned); }
  private async createCheckpoint(label: string, pinned: boolean, snapshot?: WorkspaceSnapshot): Promise<{ id: string; revision: string }> { const source = snapshot ?? await this.snapshot(); const id = crypto.randomUUID(); const data: StoredSource = { version: 1, identity: source.identity, files: Object.fromEntries(Object.entries(source.files).map(([path, bytes]) => [path, bytesToBase64(bytes)])), revision: source.revision, createdAt: Date.now(), label: label.slice(0, 200), pinned }; const encoded = utf8.encode(JSON.stringify(data)); const checkpoints = await this.checkpointList(); const retainedBytes = checkpoints.reduce((total, c) => total + c.bytes, 0); if (retainedBytes + encoded.length > this.maxBytes) throw new BrowserError('QUOTA_EXCEEDED', 'Checkpoint budget exhausted. Export or delete unpinned checkpoints before mutation.'); await this.chunks.put(`checkpoint:${id}`, encoded); await this.store.set(`${this.prefix}:checkpoint:${id}`, { id, revision: data.revision, createdAt: data.createdAt, label: data.label, pinned, bytes: encoded.length }); return { id, revision: source.revision }; }
  async checkpointList(): Promise<{ id: string; revision: string; createdAt: number; label: string; pinned: boolean; bytes: number }[]> { const result = []; for (const key of (await this.store.list()).filter(k => k.startsWith(`${this.prefix}:checkpoint:`))) { const item = await this.store.get<{ id: string; revision: string; createdAt: number; label: string; pinned: boolean; bytes: number }>(key); if (item) result.push(item); } return result.sort((a, b) => b.createdAt - a.createdAt); }
  async restore(id: string, expectedRevision: string): Promise<MutationResult> { if (!/^[a-f0-9-]{36}$/.test(id)) throw new BrowserError('INVALID_INPUT', 'Invalid Checkpoint ID.'); const raw = await this.chunks.get(`checkpoint:${id}`); if (!raw) throw new BrowserError('FILE_NOT_FOUND', 'Checkpoint missing.'); const saved = JSON.parse(new TextDecoder().decode(raw)) as StoredSource; const before = await this.snapshot(); if (saved.version !== 1 || !equalIdentity(saved.identity, before.identity)) throw new BrowserError('BINDING_MISMATCH', 'Checkpoint belongs to another generator or draft.'); const paths = new Set([...Object.keys(before.files), ...Object.keys(saved.files)]); const writes = [...paths].filter(path => !path.startsWith('imports/')).map(path => ({ path, bytes: saved.files[path] === undefined ? null : base64ToBytes(saved.files[path]!) })); return this.writeBatch(writes, expectedRevision); }
  /** Trusted public-source adapter only. Agent write tools cannot mutate this revision-pinned cache. */
  async importSnapshot(id: string, files: Record<string, Uint8Array>, expectedRevision?: string): Promise<{ revision: string; paths: string[]; sha256: string }> {
    return this.serial(async () => {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) || id === '.' || id === '..') throw new BrowserError('PATH_DENIED', 'Invalid import snapshot ID.');
      const before = await this.snapshot(); if (expectedRevision && before.revision !== expectedRevision) throw new BrowserError('STALE_REVISION', 'Workspace changed before import publication.');
      const sourcePaths = Object.keys(files).sort(); if (sourcePaths.length > 1000 || !sourcePaths.length) throw new BrowserError('LIMIT_EXCEEDED', 'Import requires 1–1000 files.');
      const staged: Record<string,string> = {}; const seen = new Set<string>();
      for (const path of sourcePaths) { canonicalPath(path); if (path.startsWith('scratch/') || path.startsWith('imports/')) throw new BrowserError('PATH_DENIED', 'Imports accept public native source paths only.'); const target = canonicalPath(`imports/${id}/${path}`); if (seen.has(target.toLowerCase())) throw new BrowserError('PATH_DENIED', 'Import path case collision.'); seen.add(target.toLowerCase()); const bytes = files[path]!; if (!(bytes instanceof Uint8Array)) throw new BrowserError('INVALID_INPUT', 'Import requires exact byte arrays.'); staged[target] = bytesToBase64(bytes); }
      const local = await this.local(); for (const path of Object.keys(local.files)) if (path.startsWith(`imports/${id}/`)) delete local.files[path]; Object.assign(local.files, staged);
      const total = Object.values(local.files).reduce((n, b) => n + base64ToBytes(b).length, 0);
      const nativeBytes = Object.entries(before.files).filter(([path]) => !path.startsWith('scratch/') && !path.startsWith('imports/')).reduce((n, [, b]) => n + b.length, 0);
      if (total + nativeBytes > this.maxBytes) throw new BrowserError('QUOTA_EXCEEDED', 'Imported snapshot exceeds Workspace budget.');
      if ((await this.snapshot()).revision !== before.revision) throw new BrowserError('STALE_REVISION', 'Workspace changed during import preflight.');
      await this.chunks.put('local', utf8.encode(JSON.stringify(local))); const after = await this.snapshot(); return {revision:after.revision, paths:Object.keys(staged), sha256:await digest(JSON.stringify(staged))};
    });
  }
  async unresolved(): Promise<Journal[]> { const result: Journal[] = []; for (const key of (await this.store.list()).filter(k => k.startsWith(`${this.prefix}:journal:`))) { const row = await this.store.get<Journal>(key); if (row && ['INTENT', 'PARTIAL', 'UNKNOWN'].includes(row.state)) result.push(row); } return result; }
  /** Operator-only acknowledgement: never exposed as an agent tool or automatic retry. */
  async acknowledgeReconciliation(id: string, inspectedRevision: string): Promise<void> { if ((await this.snapshot()).revision !== inspectedRevision) throw new BrowserError('STALE_REVISION', 'Source changed during reconciliation.'); const key = `${this.prefix}:journal:${id}`; const row = await this.store.get<Journal>(key); if (!row) throw new BrowserError('FILE_NOT_FOUND', 'Journal entry missing.'); row.state = 'REJECTED'; await this.store.set(key, row); }
  async exportBackup(): Promise<{ version: 1; identity: NativeIdentity; files: Record<string, string>; revision: string; sha256: string }> { const source = await this.snapshot(); const files = Object.fromEntries(Object.entries(source.files).map(([path, bytes]) => [path, bytesToBase64(bytes)])); return { version: 1, identity: source.identity, files, revision: source.revision, sha256: await digest(JSON.stringify(files)) }; }
  private async trim(): Promise<void> { const list = await this.checkpointList(); for (const item of list.filter(c => !c.pinned).slice(5)) { await this.chunks.delete(`checkpoint:${item.id}`); await this.store.delete(`${this.prefix}:checkpoint:${item.id}`); } const journals: {key: string; row: Journal}[] = []; for (const key of (await this.store.list()).filter(k => k.startsWith(`${this.prefix}:journal:`))) { const row = await this.store.get<Journal>(key); if (row) journals.push({key,row}); } for (const {key} of journals.filter(x => ['SUCCEEDED','REJECTED'].includes(x.row.state)).sort((a,b) => b.row.createdAt-a.row.createdAt).slice(1000)) await this.store.delete(key); await this.chunks.collectOrphans(); }
}
