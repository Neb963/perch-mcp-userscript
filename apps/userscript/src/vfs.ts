import { nextGeneration } from '../../../packages/contracts/src/target.js';
import { NativeAdapter } from './adapter.js';
import { BoundObjectStore, resolveBindingStorage, type BindingStorageIdentity, type BindingStorageScope } from './binding-storage.js';
import { ChunkStore } from './storage.js';
import { BrowserError, base64ToBytes, bytesToBase64, canonicalPath, digest, equalIdentity, isUint8Array, snapshotRevision, utf8, type FileWrite, type KeyValueStore, type MutationResult, type NativeIdentity, type NativeSnapshot } from './native-types.js';
export interface WorkspaceSnapshot extends NativeSnapshot { nativeRevision: string; generation: number }
interface StoredSource { version: 1; identity: NativeIdentity; files: Record<string, string>; revision: string; createdAt: number; label: string; pinned: boolean }
interface LocalState { version: 1; files: Record<string, string>; lastHash: string; generation: number }
interface Journal { id: string; state: 'INTENT' | 'DISPATCHED' | 'SUCCEEDED' | 'PARTIAL' | 'UNKNOWN' | 'REJECTED'; paths: string[]; baseRevision: string; checkpointId?: string; kind?: 'SOURCE'|'IMPORT'|'SAVE'; createdAt: number; resolvedByOperator?: boolean; inspectedRevision?: string; resolvedAt?: number; operatorEvidence?: string;
  gatewayOperationId?: string; plannedHash?: string; plannedPaths?: Record<string,string|null>; identity?: NativeIdentity;
  resolvedByReadback?: boolean; resolutionMode?: 'VERIFIED_INTENDED_BYTES'|'ADOPTED_CURRENT_SAVED_SOURCE'|'ADOPTED_CURRENT_DRAFT'|'ADOPTED_CURRENT_IMPORT_CACHE'|'SUPERSEDED_BINDING';
}
/** Serialized per active lease. Durable generation pointer stores scratch without page-origin storage. */
export class VirtualFileSystem {
  private chunks: ChunkStore | BoundObjectStore;
  private tail: Promise<unknown> = Promise.resolve();
  private observationTail: Promise<unknown> = Promise.resolve();
  readonly prefix: string;
  constructor(readonly adapter: NativeAdapter, readonly store: KeyValueStore, readonly workspaceId: string,
      readonly maxBytes = 64 * 1024 * 1024, readonly scope?: BindingStorageScope) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(workspaceId) || (scope && scope.workspaceId !== workspaceId))
      throw new BrowserError('INVALID_INPUT', 'Invalid local Workspace ID.');
    this.prefix = scope?.epochPrefix ?? `perch:workspace:${workspaceId}`;
    this.chunks = scope ? new BoundObjectStore(store, scope, maxBytes) : new ChunkStore(store, this.prefix, maxBytes);
  }
  static async openBound(adapter: NativeAdapter, store: KeyValueStore, identity: BindingStorageIdentity,
      options: {assertCurrent: BindingStorageScope['assertCurrent']; maxBytes?: number; readOnly?: boolean}): Promise<VirtualFileSystem> {
    const scope = await resolveBindingStorage(identity, options.assertCurrent, options.readOnly);
    const current = new VirtualFileSystem(adapter, store, scope.workspaceId, options.maxBytes, scope);
    if (scope.readOnly) return current;
    await current.assertPublication();
    const keys = (await store.list()).filter(key => key.startsWith(scope.bindingPrefix + ':epoch:'));
    if (keys.length > 4096) throw new BrowserError('QUOTA_EXCEEDED', 'Binding retention has reached its record limit.');
    const epochs = new Set<number>();
    for (const key of keys) {
      const epoch = Number(key.slice(scope.bindingPrefix.length + 7).split(':', 1)[0]);
      if (!Number.isSafeInteger(epoch) || epoch < 1 || epoch > scope.epoch)
        throw new BrowserError('STALE_EPOCH', 'A newer Binding storage writer already exists.');
      if (epoch < scope.epoch) epochs.add(epoch);
    }
    const priorEpochs = [...epochs].sort((a, b) => b - a);
    for (const epoch of priorEpochs) {
      const priorScope = await resolveBindingStorage({...identity, epoch}, options.assertCurrent, true);
      const prior = new VirtualFileSystem(adapter, store, scope.workspaceId, options.maxBytes, priorScope);
      if (keys.some(key => key.startsWith(prior.prefix + ':stage:')) || (await prior.unresolved()).length)
        throw new BrowserError('EFFECT_UNKNOWN', 'Earlier Epoch has unresolved local evidence. Reconcile that exact Epoch before adoption.');
    }
    if (await current.chunks.get('local') === undefined) {
      for (const epoch of priorEpochs) {
        const priorScope = await resolveBindingStorage({...identity, epoch}, options.assertCurrent, true);
        const prior = new BoundObjectStore(store, priorScope, current.maxBytes);
        const data = await prior.get('local');
        if (data) {
          await current.assertPublication();
          await current.chunks.put('local', data);
          break;
        }
      }
    }
    return current;
  }
  private async assertPublication() {
    if (this.scope?.readOnly) throw new BrowserError('SCOPE_DENIED', 'Binding storage is read-only.');
    await this.scope?.assertCurrent();
  }
  async assertLocalRoom(additionalBytes: number) {
    if (!(this.chunks instanceof BoundObjectStore))
      throw new BrowserError('INCOMPATIBLE_VERSION', 'A scoped Binding lease is required.');
    await this.chunks.assertStorageRoom(additionalBytes);
  }
  async localView() {
    if (!(this.chunks instanceof BoundObjectStore))
      throw new BrowserError('INCOMPATIBLE_VERSION', 'A scoped Binding lease is required for targeted local reads.');
    return this.chunks.localView();
  }
  private async local(): Promise<LocalState> { const raw = await this.chunks.get('local'); if (!raw) return { version: 1, files: {}, lastHash: '', generation: 0 }; try { const data = JSON.parse(new TextDecoder().decode(raw)) as LocalState; if (data.version !== 1 || !data.files || !Number.isSafeInteger(data.generation) || data.generation < 0) throw new Error(); for (const path of Object.keys(data.files)) if (!canonicalPath(path).startsWith('scratch/') && !path.startsWith('imports/')) throw new Error(); return data; } catch { throw new BrowserError('STORAGE_CORRUPT', 'Local filesystem manifest is invalid; export and recover it before writing.'); } }
  async snapshot(): Promise<WorkspaceSnapshot> {
    const observe = async (): Promise<WorkspaceSnapshot> => {
      const native = await this.adapter.snapshot(); const local = await this.local(); const files = { ...native.files }; for (const [path, value] of Object.entries(local.files)) files[path] = base64ToBytes(value);
      const hash = await snapshotRevision(native.identity, files);
      const key = `${this.prefix}:observation`; const persisted = await this.store.get<{generation:number;hash:string}>(key);
      const observed = persisted ?? {generation:local.generation,hash:local.lastHash};
      if (!Number.isSafeInteger(observed.generation) || observed.generation < 0 || typeof observed.hash !== 'string') throw new BrowserError('STORAGE_CORRUPT','Invalid local revision observation.');
      if (hash !== observed.hash) {
        observed.generation++; observed.hash=hash;
        if (!this.scope?.readOnly) await this.store.set(key,observed);
      }
      return { ...native, files, nativeRevision: native.revision, revision: `${observed.generation}:${hash}`, generation: observed.generation };
    };
    const next = this.observationTail.then(observe,observe); this.observationTail=next.catch(()=>undefined); return next;
  }
  getSnapshot(): Promise<WorkspaceSnapshot> { return this.snapshot(); }
  async list(path = ''): Promise<string[]> { if (path && !['src', 'scratch', 'imports'].includes(path)) canonicalPath(path); const files = Object.keys((await this.snapshot()).files).sort(); return path ? files.filter(name => name === path || name.startsWith(`${path.replace(/\/$/, '')}/`)) : files; }
  async read(path: string): Promise<Uint8Array> { canonicalPath(path); const bytes = (await this.snapshot()).files[path]; if (!bytes) throw new BrowserError('FILE_NOT_FOUND', 'File does not exist in assigned Workspace.'); return bytes.slice(); }
  async writeLocalBatch(writes: FileWrite[], expectedLocalRevision: string, gatewayOperationId?: string) {
    return this.writePrivateFiles(writes, expectedLocalRevision, gatewayOperationId, 'SOURCE');
  }
  async publishImportedFiles(slugs: readonly string[], files: Record<string,Uint8Array>, expectedLocalRevision: string,
      gatewayOperationId: string) {
    const prefixes = slugs.map(slug => {
      if (!/^[a-z0-9][a-z0-9-]{0,119}$/.test(slug)) throw new BrowserError('INVALID_INPUT', 'Invalid import Slug.');
      return 'imports/' + slug + '/';
    });
    const old = await this.localView();
    if (old.revision.value !== expectedLocalRevision)
      throw new BrowserError('STALE_REVISION', 'Local import manifest changed before publication.');
    const writes: FileWrite[] = old.files.filter(file => prefixes.some(prefix => file.path.startsWith(prefix)) &&
      !Object.hasOwn(files,file.path)).map(file=>({path:file.path,bytes:null}));
    for (const [path,bytes] of Object.entries(files)) {
      if (!prefixes.some(prefix=>path.startsWith(prefix))) throw new BrowserError('PATH_DENIED', 'Import outside the requested public namespace.');
      writes.push({path,bytes});
    }
    return this.writePrivateFiles(writes, expectedLocalRevision, gatewayOperationId, 'IMPORT');
  }
  private writePrivateFiles(writes: FileWrite[], expectedLocalRevision: string, gatewayOperationId: string | undefined,
      kind: 'SOURCE' | 'IMPORT') {
    return this.serial(async () => {
      await this.assertPublication();
      const scope = this.scope;
      if (!scope) throw new BrowserError('INCOMPATIBLE_VERSION', 'Binding-local write requires a scoped store.');
      const old = await this.localView();
      if (old.revision.value !== expectedLocalRevision)
        throw new BrowserError('STALE_REVISION', 'Private files changed before publication.');
      const pending = await this.unresolved();
      if (pending.some(row => row.paths.some(path => writes.some(write => write.path === path))))
        throw new BrowserError('NATIVE_CONFLICT', 'An unresolved local publication overlaps these files.');
      const local = await this.local();
      const prefix = kind === 'SOURCE' ? 'scratch/' : 'imports/';
      for (const write of writes) {
        if (!canonicalPath(write.path).startsWith(prefix))
          throw new BrowserError('PATH_DENIED', 'Private publication does not match its authorized namespace.');
        if (write.bytes === null) delete local.files[write.path];
        else local.files[write.path] = bytesToBase64(write.bytes);
      }
      local.generation = nextGeneration(local.generation);
      const paths = Object.keys(local.files).map(path=>path.toLowerCase());
      const manifest = new Set(paths);
      if (manifest.size !== paths.length || paths.some(path=>{
        const parts = path.split('/');
        return parts.some((_part,index)=>index >= 2 && manifest.has(parts.slice(0,index).join('/')));
      })) throw new BrowserError('PATH_DENIED', 'Private publication had a case or file/directory collision.');
      const journal: Journal = {id: crypto.randomUUID(), kind, state: 'INTENT',
        paths: writes.map(write => write.path), baseRevision: expectedLocalRevision, createdAt: Date.now(),
        gatewayOperationId};
      const key = scope.epochPrefix + ':journal:' + journal.id;
      await this.store.set(key, journal);
      let started = false;
      try {
        await this.assertPublication();
        started = true;
        await this.chunks.put('local', utf8.encode(JSON.stringify(local)));
        const updated = await this.localView();
        for (const write of writes) {
          const file = updated.files.find(file => file.path === write.path);
          if (write.bytes === null ? file !== undefined : file?.sha256 !== await digest(write.bytes))
            throw new BrowserError('EFFECT_UNKNOWN', 'Binding local readback differs from planned bytes.');
        }
        await this.store.set(key, {...journal, state: 'SUCCEEDED'});
        void this.serial(() => this.trim()).catch(() => undefined);
        return updated.revision;
      } catch (error) {
        const known = !started || error instanceof BrowserError && error.code === 'QUOTA_EXCEEDED';
        await this.store.set(key, {...journal, state: known ? 'REJECTED' : 'UNKNOWN'}).catch(() => undefined);
        if (known) throw error;
        throw new BrowserError('EFFECT_UNKNOWN', 'Private file publication requires reconciliation.');
      }
    });
  }
  async writeBatch(writes: FileWrite[], expectedRevision?: string, gatewayOperationId?: string): Promise<MutationResult> { return this.serial(async () => this.commit(writes, expectedRevision, gatewayOperationId)); }
  private serial<T>(fn: () => Promise<T>): Promise<T> { const next = this.tail.then(fn, fn); this.tail = next.catch(() => undefined); return next; }
  private async commit(writes: FileWrite[], expectedRevision?: string, gatewayOperationId?: string): Promise<MutationResult> {
    await this.assertPublication();
    await this.reconcileRetainedUnlocked();
    // An old uncertain operation is *not* a Workspace-wide lock. The current
    // native source and the requested optimistic revision are authoritative.
    // Only a recent overlapping write, which may still be executing, is held.
    const unresolved = await this.unresolved();
    const nativePaths = new Set(writes.map(w=>w.path));
    const conflicting = unresolved.filter(j=>j.kind!=='IMPORT' &&
      ((j.kind==='SAVE' && writes.some(w=>!w.path.startsWith('scratch/'))) ||
       j.paths.some(path=>nativePaths.has(path))));
    if (conflicting.length) throw new BrowserError('NATIVE_CONFLICT',
      `A recent source operation may still be settling (${conflicting.map(j=>j.paths.join(', ')).join('; ')}). `+
      'Refresh Workspace status and retry after the native editor has settled.',
      'The agent can continue reading, previewing, and modifying unaffected paths. Do not repeat the uncertain operation.');
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
    // Precompute the *complete intended result* before dispatch. No native or
    // scratch bytes are embedded in the journal; only immutable SHA-256 proofs.
    const plannedHash = await snapshotRevision(before.identity, planned);
    const plannedPaths: Record<string,string|null> = {};
    for (const write of writes) plannedPaths[write.path] = write.bytes===null ? null : await digest(write.bytes);
    const checkpoint = await this.createCheckpoint('Before source mutation', false, before);
    const journal: Journal = { id: crypto.randomUUID(), state: 'INTENT', kind:'SOURCE',
      paths: writes.map(w => w.path), baseRevision: before.revision,
      checkpointId: checkpoint.id, createdAt: Date.now(), plannedHash, plannedPaths, identity:before.identity,
      ...(gatewayOperationId && /^[A-Za-z0-9_-]{1,128}$/.test(gatewayOperationId) ? {gatewayOperationId} : {}),
    };
    const key = `${this.prefix}:journal:${journal.id}`;
    await this.store.set(key, journal);
    const nativeWrites = writes.filter(w => !w.path.startsWith('scratch/'));
    let nativeResult: MutationResult = { status: 'SUCCEEDED', revision: before.nativeRevision, committed: [] };
    let dispatched = false;
    try {
      if (nativeWrites.length) nativeResult = await this.adapter.applyFiles(nativeWrites, before.nativeRevision, async () => {
        // A failed durable dispatch marker prevents *all* native effects.
        await this.store.set(key,{...journal,state:'DISPATCHED'});
        journal.state='DISPATCHED'; dispatched = true;
      }, this.scope ? () => this.assertPublication() : undefined);
    } catch (error) {
      journal.state = dispatched ? 'UNKNOWN' : 'REJECTED';
      await this.store.set(key,journal);
      if (!dispatched) throw error;
      nativeResult = {status:'UNKNOWN',revision:before.nativeRevision,committed:[],
        error:{code:'EFFECT_UNKNOWN',message:'Native effect was dispatched; inspect current bytes before retrying.',
          recovery:'No automatic repeat. Readback will reconcile exact intended bytes.'}};
    }
    if (nativeResult.status !== 'SUCCEEDED') {
      // The native method can throw *after* committing all of its bytes.
      // Complete current-state proof is sufficient; the reply is not.
      if (nativeWrites.length === writes.length) {
        try {
          const actual = await this.snapshot();
          if (actual.revision.split(':')[1] === plannedHash && await this.matchesPlannedPaths(actual,journal)) {
            journal.state='SUCCEEDED'; journal.resolvedByReadback=true;
            journal.resolutionMode='VERIFIED_INTENDED_BYTES'; journal.resolvedAt=Date.now();
            journal.inspectedRevision=actual.revision;
            await this.store.set(key,journal);
            void this.serial(() => this.trim()).catch(()=>undefined); // Cleanup must not falsify success.
            return {status:'SUCCEEDED',revision:actual.revision,committed:writes.map(w=>w.path),
              ...(this.scope?{nativeRevision:actual.nativeRevision}:{})};
          }
        } catch { /* Retain the original UNKNOWN/PARTIAL without losing the journal. */ }
      }
      journal.state=nativeResult.status;
      await this.store.set(key,journal);
      let currentRevision=before.revision;
      try { currentRevision=(await this.snapshot()).revision; } catch { /* Readback unavailable. */ }
      return {...nativeResult,revision:currentRevision};
    }
    try {
      const afterNative = await this.adapter.snapshot();
      const expectedNative = { ...before.files };
      for (const path of Object.keys(expectedNative)) if (path.startsWith('scratch/') || path.startsWith('imports/')) delete expectedNative[path];
      for (const w of nativeWrites) if (w.bytes === null) delete expectedNative[w.path]; else expectedNative[w.path] = w.bytes;
      if (afterNative.revision !== await snapshotRevision(before.identity, expectedNative))
        throw new BrowserError('STALE_REVISION', 'Manual edit interrupted final commit.');
      if (writes.some(w=>w.path.startsWith('scratch/'))) {
        const local = await this.local();
        for (const w of writes.filter(w => w.path.startsWith('scratch/')))
          if (w.bytes === null) delete local.files[w.path]; else local.files[w.path] = bytesToBase64(w.bytes);
        if (this.scope) local.generation = nextGeneration(local.generation);
        await this.chunks.put('local', utf8.encode(JSON.stringify(local)));
      }
      const after = await this.snapshot();
      if (after.revision.split(':')[1] !== plannedHash || !(await this.matchesPlannedPaths(after,journal)))
        throw new BrowserError('STALE_REVISION', 'Workspace readback differs from planned complete source.');
      journal.state = 'SUCCEEDED'; journal.resolvedByReadback=true;
      journal.resolutionMode='VERIFIED_INTENDED_BYTES'; journal.inspectedRevision=after.revision;
      journal.resolvedAt=Date.now();
      await this.store.set(key, journal);
      void this.serial(() => this.trim()).catch(()=>undefined); // Housekeeping never turns a verified write UNKNOWN.
      return { status: 'SUCCEEDED', revision: after.revision, committed: writes.map(w => w.path),
        ...(this.scope?{nativeRevision:after.nativeRevision}:{}) };
    } catch (error) {
      journal.state = nativeWrites.length ? 'PARTIAL' : 'UNKNOWN';
      await this.store.set(key,journal);
      return { status: journal.state, revision: before.revision, committed: nativeResult.committed,
        error: { code: 'PARTIAL_EFFECT', message: 'Native bytes or durable terminal record could not be verified.',
          recovery: 'The journal retains planned byte hashes. Read-only reconciliation can settle an exact match.' } };
    }
  }

  async checkpoint(label = 'Checkpoint', pinned = false): Promise<{
    id: string; revision: string; sha256: string; bytes: number;
    identity: NativeIdentity; pinned: boolean; fileCount: number; sourceBytes: number;
  }> { return this.serial(() => this.createCheckpoint(label, pinned)); }

  private async createCheckpoint(label: string, pinned: boolean, snapshot?: WorkspaceSnapshot): Promise<{
    id: string; revision: string; sha256: string; bytes: number;
    identity: NativeIdentity; pinned: boolean; fileCount: number; sourceBytes: number;
  }> {
    await this.assertPublication();
    const source = snapshot ?? await this.snapshot();
    const id = crypto.randomUUID();
    const entries = Object.entries(source.files);
    const sourceBytes = entries.reduce((sum,[,bytes]) => sum + bytes.length, 0);
    const data: StoredSource = {
      version: 1, identity: source.identity,
      files: Object.fromEntries(entries.map(([path,bytes]) => [path,bytesToBase64(bytes)])),
      revision: source.revision, createdAt: Date.now(), label: label.slice(0,200), pinned,
    };
    const encoded = utf8.encode(JSON.stringify(data));
    const sha256 = await digest(encoded);
    const checkpoints = await this.checkpointList();
    const retainedBytes = checkpoints.reduce((sum,row) => sum + row.bytes, 0);
    if (!this.scope && retainedBytes + encoded.length > this.maxBytes)
      throw new BrowserError('QUOTA_EXCEEDED',
        'Checkpoint budget exhausted. Export or delete unpinned checkpoints before mutation.');
    await this.chunks.put(`checkpoint:${id}`, encoded);
    const observed = await this.chunks.get(`checkpoint:${id}`);
    if (!observed || await digest(observed) !== sha256)
      throw new BrowserError('STORAGE_CORRUPT',
        'Checkpoint bytes did not survive readback. Source unchanged; do not rely on this checkpoint.');
    await this.assertPublication();
    await this.store.set(`${this.prefix}:checkpoint:${id}`,{
      id,revision:data.revision,createdAt:data.createdAt,label:data.label,
      pinned,bytes:encoded.length,sha256,fileCount:entries.length,sourceBytes,
    });
    return {id,revision:source.revision,sha256,bytes:encoded.length,
      identity:structuredClone(source.identity),pinned,fileCount:entries.length,sourceBytes};
  }

  async checkpointList(): Promise<{
    id: string; revision: string; createdAt: number; label: string; pinned: boolean;
    bytes: number; sha256?: string; fileCount?: number; sourceBytes?: number;
  }[]> {
    const result=[];
    for(const key of (await this.store.list()).filter(k => k.startsWith(`${this.prefix}:checkpoint:`))){
      const row=await this.store.get<{
        id:string;revision:string;createdAt:number;label:string;
        pinned:boolean;bytes:number;sha256?:string;fileCount?:number;sourceBytes?:number;
      }>(key);
      if(row)result.push(row);
    }
    return result.sort((a,b) => b.createdAt-a.createdAt);
  }

  async restore(id: string, expectedRevision: string, gatewayOperationId?: string): Promise<MutationResult> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new BrowserError('INVALID_INPUT','Invalid Checkpoint ID.');
    const raw=await this.chunks.get(`checkpoint:${id}`);
    if (!raw) throw new BrowserError('FILE_NOT_FOUND','Checkpoint missing.');
    const metadata=await this.store.get<{sha256?:string;bytes?:number}>(`${this.prefix}:checkpoint:${id}`);
    if (metadata?.sha256 && await digest(raw)!==metadata.sha256)
      throw new BrowserError('STORAGE_CORRUPT',
        'Checkpoint checksum differs from the persisted receipt; source unchanged.');
    if (metadata?.bytes!==undefined && raw.length!==metadata.bytes)
      throw new BrowserError('STORAGE_CORRUPT',
        'Checkpoint byte count differs from the persisted receipt; source unchanged.');
    let saved:StoredSource;
    try {
      saved=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)) as StoredSource;
      if (!saved || saved.version!==1 || !saved.identity ||
          !saved.files || typeof saved.files!=='object' || Array.isArray(saved.files) ||
          typeof saved.revision!=='string' || !/^\d+:[a-f0-9]{64}$/.test(saved.revision))
        throw new Error('invalid-checkpoint');
    } catch {
      throw new BrowserError('STORAGE_CORRUPT',
        'Checkpoint metadata is malformed; source unchanged.');
    }
    const before=await this.snapshot();
    if (!equalIdentity(saved.identity,before.identity))
      throw new BrowserError('BINDING_MISMATCH','Checkpoint belongs to another generator or draft.');
    if (before.revision!==expectedRevision)
      throw new BrowserError('STALE_REVISION','Workspace changed before checkpoint restore preflight.');
    const restored:Record<string,Uint8Array>={};
    const entries=Object.entries(saved.files);
    if (entries.length>1000)
      throw new BrowserError('LIMIT_EXCEEDED','Checkpoint exceeds the 1000-file restoration budget.');
    let bytes=0;
    try {
      for(const [path,base64] of entries){
        canonicalPath(path);
        if(typeof base64!=='string')throw new Error('invalid-byte-string');
        const content=base64ToBytes(base64);
        if(content.length>16*1024*1024)throw new Error('file-limit');
        bytes+=content.length;
        if(bytes>this.maxBytes)throw new Error('storage-limit');
        restored[path]=content;
      }
    }catch{
      throw new BrowserError('STORAGE_CORRUPT',
        'Checkpoint contains invalid paths or oversized/corrupt bytes; source unchanged.');
    }
    if (await snapshotRevision(saved.identity,restored)!==saved.revision.split(':')[1])
      throw new BrowserError('STORAGE_CORRUPT',
        'Checkpoint full-source digest differs from its declared revision; source unchanged.');
    const paths=new Set([...Object.keys(before.files),...Object.keys(restored)]);
    const writes=[...paths].filter(path=>!path.startsWith('imports/'))
      .map(path=>({path,bytes:restored[path]??null}));
    // writeBatch atomically preflights the complete write set and preserves
    // the current draft as a separate checkpoint before mutation.
    return this.writeBatch(writes,expectedRevision,gatewayOperationId);
  }
  /** Trusted public-source adapter only. Agent write tools cannot mutate this revision-pinned cache. */
  async importSnapshot(id: string, files: Record<string, Uint8Array>, expectedRevision?: string): Promise<{ revision: string; paths: string[]; sha256: string }> {
    return this.serial(async () => {
      await this.assertPublication();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) || id === '.' || id === '..') throw new BrowserError('PATH_DENIED', 'Invalid import snapshot ID.');
      // Imports are local read-only cache entries. They must not be fenced by
      // unrelated native source journals or imports with another prefix.
      await this.reconcileRetainedUnlocked();
      const importPrefix=`imports/${id}/`;
      if ((await this.unresolved()).some(j=>j.kind==='IMPORT' &&
          j.paths.some(path=>path.startsWith(importPrefix))))
        throw new BrowserError('NATIVE_CONFLICT','This import is still settling. Recheck its cache before replacing it.');
      const before = await this.snapshot(); if (expectedRevision && before.revision !== expectedRevision) throw new BrowserError('STALE_REVISION', 'Workspace changed before import publication.');
      const sourcePaths = Object.keys(files).sort(); if (sourcePaths.length > 1000 || !sourcePaths.length) throw new BrowserError('LIMIT_EXCEEDED', 'Import requires 1–1000 files.');
      const prefix = `imports/${id}/`;
      const retained = Object.entries(before.files).filter(([path]) => !path.startsWith(prefix));
      let total = retained.reduce((n, [, bytes]) => n + bytes.length, 0);
      const seen = new Set(retained.map(([path]) => path.toLowerCase()));
      const planned: [string, Uint8Array][] = [];
      for (const [index, path] of sourcePaths.entries()) {
        canonicalPath(path);
        if (path.startsWith('scratch/') || path.startsWith('imports/'))
          throw new BrowserError('PATH_DENIED', 'Import preflight: only public native source paths are allowed.');
        const target = canonicalPath(`${prefix}${path}`);
        if (seen.has(target.toLowerCase()))
          throw new BrowserError('PATH_DENIED', `Import preflight: file #${index + 1} collides with another path.`);
        seen.add(target.toLowerCase());
        const bytes = files[path];
        if (!isUint8Array(bytes))
          throw new BrowserError('INVALID_INPUT', `Import preflight: file #${index + 1} is not a Uint8Array.`);
        if (bytes.byteLength > 16 * 1024 * 1024)
          throw new BrowserError('QUOTA_EXCEEDED', `Import preflight: file #${index + 1} exceeds the 16 MiB file limit.`);
        total += bytes.byteLength;
        if (total > this.maxBytes)
          throw new BrowserError('QUOTA_EXCEEDED', 'Import preflight: snapshot exceeds Workspace byte budget.');
        planned.push([target, new Uint8Array(bytes)]);
      }
      const staged = Object.fromEntries(planned.map(([path, bytes]) => [path, bytesToBase64(bytes)]));
      const local = await this.local();
      for (const path of Object.keys(local.files)) if (path.startsWith(prefix)) delete local.files[path];
      Object.assign(local.files, staged);
      if ((await this.snapshot()).revision !== before.revision) throw new BrowserError('STALE_REVISION', 'Workspace changed during import preflight.');
      const journal:Journal={id:crypto.randomUUID(),state:'INTENT',kind:'IMPORT',paths:Object.keys(staged),baseRevision:before.revision,createdAt:Date.now(),identity:before.identity}; const journalKey=`${this.prefix}:journal:${journal.id}`;
      await this.store.set(journalKey,journal); // Durable intent precedes the cache manifest pointer.
      try { await this.chunks.put('local',utf8.encode(JSON.stringify(local))); }
      catch(error) {
        journal.state=error instanceof BrowserError&&error.code==='QUOTA_EXCEEDED'?'REJECTED':'UNKNOWN';
        try { await this.store.set(journalKey,journal); } catch { throw new BrowserError('EFFECT_UNKNOWN','Import publication failed and its terminal journal could not be persisted.','Inspect the retained intent and current imports without replaying publication.'); }
        if (journal.state === 'REJECTED') throw error;
        throw new BrowserError('EFFECT_UNKNOWN', 'Import manifest publication is uncertain; retained journal requires reconciliation.');
      }
      try {
        const after=await this.snapshot(); const expectedFiles={...before.files}; for(const path of Object.keys(expectedFiles))if(path.startsWith(`imports/${id}/`))delete expectedFiles[path]; for(const [path,value]of Object.entries(staged))expectedFiles[path]=base64ToBytes(value);
        if(after.revision.split(':')[1]!==await snapshotRevision(before.identity,expectedFiles))throw new BrowserError('EFFECT_UNKNOWN','Imported cache publication completed but complete Workspace readback differs.');
        journal.state='SUCCEEDED';await this.store.set(journalKey,journal);return{revision:after.revision,paths:Object.keys(staged),sha256:await digest(JSON.stringify(staged))};
      }catch{journal.state='UNKNOWN';try{await this.store.set(journalKey,journal);}catch{/* The durable INTENT remains held. */}throw new BrowserError('EFFECT_UNKNOWN','Imported cache may be published; its complete readback or terminal record is unavailable.','Inspect the retained import intent and current cache; do not replay publication.');}
    });
  }
  /**
   * Read-only native evidence may close a local write hold, without replaying
   * any effect. This mutates *only* local journal metadata, under VFS serial.
   */
  async reconcileRetained(): Promise<{id:string;mode:string;revision:string}[]> {
    return this.serial(() => this.reconcileRetainedUnlocked());
  }
  private async matchesPlannedPaths(snapshot: WorkspaceSnapshot, journal: Journal): Promise<boolean> {
    if (!journal.plannedPaths || !journal.plannedHash) return false;
    for (const [path,hash] of Object.entries(journal.plannedPaths)) {
      const bytes=snapshot.files[path];
      if (hash===null ? bytes!==undefined : !bytes || await digest(bytes)!==hash) return false;
    }
    return true;
  }
  /**
   * The current native draft is canonical once two independent snapshots
   * agree and the native editor has no active mutation. A local write journal
   * records uncertainty about an *old command*, not ownership of future
   * source revisions. Rebase old uncertain commands without claiming that the
   * old command succeeded. Preserve both its original state and checkpoint.
   *
   * A short grace period guards against delayed native effects. New requests
   * may still edit unrelated paths while a recent conflicting intent settles.
   */
  private async reconcileRetainedUnlocked(): Promise<{id:string;mode:string;revision:string}[]> {
    if (this.scope) return []; // Explicit exact-epoch recovery owns v2 acknowledgement.
    const held=await this.unresolved();
    if (!held.length) return [];
    let probe:Awaited<ReturnType<NativeAdapter['probe']>>;
    try { probe=await this.adapter.probe(); }
    catch{return [];}
    if (!probe.ready || probe.sourceRead!==true ||
        (probe.sourceWriteBlocked??[]).length) return [];
    let first:WorkspaceSnapshot, second:WorkspaceSnapshot;
    try {
      first=await this.snapshot();
      second=await this.snapshot();
      if (first.revision!==second.revision || first.nativeRevision!==second.nativeRevision ||
          !equalIdentity(first.identity,second.identity) ||
          (probe.identity && !equalIdentity(second.identity,probe.identity))) return [];
    } catch { return []; }
    const currentHash=second.revision.split(':')[1];
    const now=Date.now();
    const result:{id:string;mode:string;revision:string}[]=[];
    for (const journal of held) {
      if (journal.resolvedByOperator || journal.resolvedByReadback ||
          !Number.isSafeInteger(journal.createdAt)) continue;
      const intended = journal.kind!=='IMPORT' &&
        !!journal.plannedHash && /^[a-f0-9]{64}$/.test(journal.plannedHash) &&
        currentHash===journal.plannedHash && await this.matchesPlannedPaths(second,journal);
      // Exact intended bytes prove the old write outcome immediately. Other
      // outcomes only become a new baseline after any delayed effect window.
      if (!intended && now-journal.createdAt < 15000) continue;
      const mode:NonNullable<Journal['resolutionMode']> = intended
        ? 'VERIFIED_INTENDED_BYTES'
        : journal.identity && !equalIdentity(journal.identity,second.identity) ? 'SUPERSEDED_BINDING'
        : journal.kind==='IMPORT' ? 'ADOPTED_CURRENT_IMPORT_CACHE'
        : second.saveState==='saved' && !second.dirty
          ? 'ADOPTED_CURRENT_SAVED_SOURCE' : 'ADOPTED_CURRENT_DRAFT';
      const key=`${this.prefix}:journal:${journal.id}`;
      const latest=await this.store.get<Journal>(key);
      if (!latest || latest.id!==journal.id || latest.state!==journal.state ||
          latest.resolvedByOperator || latest.resolvedByReadback) continue;
      const terminal:Journal={...latest,resolvedByReadback:true,
        resolutionMode:mode,inspectedRevision:second.revision,resolvedAt:Date.now()};
      // Historical UNKNOWN is deliberately retained when current source is
      // adopted, because the original command's result remains unknowable.
      if (intended) terminal.state='SUCCEEDED';
      await this.store.set(key,terminal);
      result.push({id:journal.id,mode,revision:second.revision});
    }
    return result;
  }
  async recentReconciliations():Promise<Array<{id:string;mode:string;revision:string;at:number;paths:string[];originalState:string}>> {
    const items:Array<{id:string;mode:string;revision:string;at:number;paths:string[];originalState:string}>=[];
    for(const key of (await this.store.list()).filter(k=>k.startsWith(`${this.prefix}:journal:`))) {
      const r=await this.store.get<Journal>(key);
      if(r?.resolvedByReadback && r.resolutionMode && r.inspectedRevision && r.resolvedAt)
        items.push({id:r.id,mode:r.resolutionMode,revision:r.inspectedRevision,at:r.resolvedAt,
          paths:r.paths.slice(0,30),originalState:r.resolutionMode==='VERIFIED_INTENDED_BYTES'?'SUCCEEDED':r.state});
    }
    return items.sort((a,b)=>b.at-a.at).slice(0,8);
  }
  async unresolved(): Promise<Journal[]> {
    const result: Journal[] = [];
    for (const key of (await this.store.list()).filter(k => k.startsWith(`${this.prefix}:journal:`))) {
      const row = await this.store.get<Journal>(key);
      if (!row || typeof row !== 'object' || Array.isArray(row) ||
          typeof row.id !== 'string' || key !== `${this.prefix}:journal:${row.id}` ||
          !['INTENT','DISPATCHED','PARTIAL','UNKNOWN','SUCCEEDED','REJECTED'].includes(row.state) ||
          !Array.isArray(row.paths) || row.paths.some(path=>typeof path!=='string') ||
          typeof row.baseRevision !== 'string')
        throw new BrowserError('STORAGE_CORRUPT','A local operation journal is malformed. It has not been removed or acknowledged.');
      if (['INTENT','DISPATCHED','PARTIAL','UNKNOWN'].includes(row.state) &&
          row.resolvedByOperator !== true && row.resolvedByReadback !== true) result.push(row);
    }
    return result;
  }
  /** Operator-only acknowledgement: never exposed as an agent tool or automatic retry. */
  async acknowledgeReconciliation(id: string, inspectedRevision: string, operatorEvidence?: string): Promise<void> { if ((await this.snapshot()).revision !== inspectedRevision) throw new BrowserError('STALE_REVISION', 'Source changed during reconciliation.'); const key = `${this.prefix}:journal:${id}`; const row = await this.store.get<Journal>(key); if (!row) throw new BrowserError('FILE_NOT_FOUND', 'Journal entry missing.'); if(operatorEvidence!==undefined){if(!operatorEvidence.trim()||operatorEvidence.length>512)throw new BrowserError('INVALID_INPUT','Bounded operator evidence is required.'); row.operatorEvidence=operatorEvidence.trim();} row.resolvedByOperator = true; row.inspectedRevision = inspectedRevision; row.resolvedAt = Date.now(); await this.store.set(key, row); }
  async exportBackup(): Promise<{ version: 1; identity: NativeIdentity; files: Record<string, string>; revision: string; sha256: string }> { const source = await this.snapshot(); const files = Object.fromEntries(Object.entries(source.files).map(([path, bytes]) => [path, bytesToBase64(bytes)])); return { version: 1, identity: source.identity, files, revision: source.revision, sha256: await digest(JSON.stringify(files)) }; }
  private async trim(): Promise<void> {
    await this.assertPublication();
    const pinnedByHold = new Set((await this.unresolved()).map(journal => journal.checkpointId));
    const list = await this.checkpointList();
    for (const item of list.filter(c => !c.pinned && !pinnedByHold.has(c.id)).slice(5, this.scope ? 13 : undefined)) { await this.chunks.delete(`checkpoint:${item.id}`); await this.store.delete(`${this.prefix}:checkpoint:${item.id}`); } const journals: {key: string; row: Journal}[] = []; for (const key of (await this.store.list()).filter(k => k.startsWith(`${this.prefix}:journal:`))) { const row = await this.store.get<Journal>(key); if (row) journals.push({key,row}); } for (const {key} of journals.filter(x => (['SUCCEEDED','REJECTED'].includes(x.row.state) || x.row.resolvedByOperator === true)).sort((a,b) => b.row.createdAt-a.row.createdAt).slice(1000)) await this.store.delete(key); await this.chunks.collectOrphans(); }
}
