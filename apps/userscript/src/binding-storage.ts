import { validGeneration } from '../../../packages/contracts/src/target.js';
import { BrowserError, base64ToBytes, bytesToBase64, canonicalPath, digest, utf8, type KeyValueStore } from './native-types.js';

const hexDigest = /^[a-f0-9]{64}$/;
const opaqueId = /^[A-Za-z0-9_-]{1,128}$/;
const chunkSize = 192 * 1024;
const maxKeys = 4096;
const maxFiles = 1000;

export interface BindingStorageIdentity {
  workspaceId: string;
  installationId: string;
  assignmentGeneration: number;
  bindingGeneration: number;
  epoch: number;
  generatorId: string;
  draftId: string;
}
export interface BindingStorageScope extends BindingStorageIdentity {
  bindingPrefix: string;
  epochPrefix: string;
  assertCurrent: () => void | Promise<void>;
  readOnly: boolean;
}

export async function resolveBindingStorage(identity: BindingStorageIdentity,
  assertCurrent: BindingStorageScope['assertCurrent'], readOnly = false): Promise<BindingStorageScope> {
  const { workspaceId, installationId, assignmentGeneration, bindingGeneration, epoch, generatorId, draftId } = identity;
  if (!opaqueId.test(workspaceId) || !opaqueId.test(installationId) ||
      !validGeneration(assignmentGeneration) || !validGeneration(bindingGeneration) ||
      !validGeneration(epoch) || epoch < 1 || typeof generatorId !== 'string' ||
      !generatorId || generatorId.length > 256 || typeof draftId !== 'string' || draftId.length > 256)
    throw new BrowserError('BINDING_MISMATCH', 'Exact Binding and Epoch are required for local storage.');
  const nativeHash = await digest(JSON.stringify([generatorId, draftId]));
  const bindingPrefix = ['perch', 'binding-v2', installationId, workspaceId, assignmentGeneration, bindingGeneration, nativeHash].join(':');
  return { ...identity, bindingPrefix, epochPrefix: bindingPrefix + ':epoch:' + epoch, assertCurrent, readOnly };
}

interface ChunkRef { sha256: string; bytes: number; epoch?: number }
interface FileRef { sha256: string; bytes: number; chunks: ChunkRef[] }
interface ObjectRoot { version: 2 | 3; sourceHash: string; sourceBytes: number; fields: Record<string, unknown>; files: Record<string, FileRef> }
interface StagingRoot { objectName?: string; root: ObjectRoot; previous?: ObjectRoot; previousEpoch?: number }
interface RootLocation { root: ObjectRoot; epoch: number }
type ObjectScope = Pick<BindingStorageScope, 'bindingPrefix' | 'epochPrefix' | 'epoch' | 'assertCurrent' | 'readOnly'>;
const objectNamePattern = /^(?:local|checkpoint:[a-f0-9-]{36})$/;
const stageIdPattern = /^[a-f0-9-]{36}$/;
const failCorrupt = (message: string): never => { throw new BrowserError('STORAGE_CORRUPT', message); };
function serializedBytes(key: string, value: unknown): number {
  return utf8.encode(key).length + utf8.encode(JSON.stringify(value)).length;
}

function parseRoot(root: unknown, epoch: number): ObjectRoot {
  if (!root || typeof root !== 'object' || Array.isArray(root)) return failCorrupt('Invalid Binding manifest.');
  const row = root as ObjectRoot;
  if ((row.version !== 2 && row.version !== 3) || !hexDigest.test(row.sourceHash) ||
      !validGeneration(row.sourceBytes) || !row.fields || typeof row.fields !== 'object' ||
      Array.isArray(row.fields) || !row.files || typeof row.files !== 'object' || Array.isArray(row.files) ||
      Object.keys(row.files).length > maxFiles)
    return failCorrupt('Invalid Binding manifest.');
  for (const [path, file] of Object.entries(row.files)) {
    if (canonicalPath(path) !== path || !file || !hexDigest.test(file.sha256) || !validGeneration(file.bytes) ||
        file.bytes > 16 * 1024 * 1024 || !Array.isArray(file.chunks) || file.chunks.length !== Math.ceil(file.bytes / chunkSize))
      return failCorrupt('Invalid file reference in Binding manifest.');
    for (const [i, chunk] of file.chunks.entries()) {
      const length = Math.min(chunkSize, file.bytes - i * chunkSize);
      if (!chunk || !hexDigest.test(chunk.sha256) || chunk.bytes !== length ||
          (row.version === 2 ? chunk.epoch !== undefined :
            !validGeneration(chunk.epoch) || chunk.epoch < 1 || chunk.epoch > epoch))
        return failCorrupt('Invalid chunk reference in Binding manifest.');
    }
  }
  return row;
}

function parseStage(raw: unknown, epoch: number): StagingRoot {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return failCorrupt('Invalid staged Binding manifest.');
  const stage = raw as StagingRoot;
  if (stage.objectName !== undefined && !objectNamePattern.test(stage.objectName))
    return failCorrupt('Invalid staged Binding object name.');
  const prior = stage.previousEpoch ?? epoch;
  if (!validGeneration(prior) || prior < 1 || prior > epoch || (stage.previousEpoch !== undefined && !stage.previous))
    return failCorrupt('Invalid staged Binding previous Epoch.');
  return {...stage, root: parseRoot(stage.root, epoch),
    ...(stage.previous ? {previous: parseRoot(stage.previous, prior)} : {})};
}

function blobKey(bindingPrefix: string, ref: ChunkRef, epoch: number) {
  return `${bindingPrefix}:epoch:${ref.epoch ?? epoch}:chunk:${ref.sha256}:${ref.bytes}`;
}

function readOnlyScope(epochPrefix: string): ObjectScope {
  const parts = /^(perch:binding-v2:[A-Za-z0-9_-]{1,128}:[A-Za-z0-9_-]{1,128}:(0|[1-9]\d{0,15}):(0|[1-9]\d{0,15}):[a-f0-9]{64}):epoch:([1-9]\d{0,15})$/.exec(epochPrefix);
  const epoch = Number(parts?.[4]);
  if (!parts || !validGeneration(epoch) || !validGeneration(Number(parts[2])) || !validGeneration(Number(parts[3])))
    throw new BrowserError('BINDING_MISMATCH', 'Exact Binding Epoch prefix is required.');
  return {bindingPrefix: parts[1]!, epochPrefix, epoch, assertCurrent: () => undefined, readOnly: true};
}

function chunkReferences({root, epoch}: RootLocation): ChunkRef[] {
  return Object.values(root.files).flatMap(file => file.chunks.map(ref => ({...ref, epoch: ref.epoch ?? epoch})));
}

function stageLocations(stage: StagingRoot, epoch: number): RootLocation[] {
  return [{root: stage.root, epoch}, ...(stage.previous ? [{root: stage.previous, epoch: stage.previousEpoch ?? epoch}] : [])];
}

/** Return only physical chunks referenced by exact Epoch roots or staged evidence. */
export async function boundEpochChunkKeys(store: KeyValueStore, epochPrefix: string, keys: readonly string[]): Promise<string[]> {
  const {bindingPrefix, epoch} = readOnlyScope(epochPrefix);
  const roots = epochPrefix + ':root:';
  const stages = epochPrefix + ':stage:';
  const output = new Set<string>();
  for (const key of keys) {
    const locations = key.startsWith(roots) ? [{root: parseRoot(await store.get(key), epoch), epoch}] :
      key.startsWith(stages) ? stageLocations(parseStage(await store.get(key), epoch), epoch) : [];
    for (const location of locations)
      for (const ref of chunkReferences(location)) output.add(blobKey(bindingPrefix, ref, epoch));
  }
  return [...output].sort();
}

export interface BoundStageInspection {
  id: string;
  objectName: string | null;
  stageDigest: string;
  observedRootDigest: string | null;
  observedSourceHash: string | null;
  observedState: 'STAGED_ROOT' | 'PREVIOUS_ROOT' | 'MISSING_ROOT' | 'DIVERGED' | 'UNATTRIBUTED';
  stagedSourceHash: string;
  previousSourceHash: string | null;
}

export async function inspectBoundStage(store: KeyValueStore, epochPrefix: string, stageId: string,
    maxBytes = 64 * 1024 * 1024): Promise<BoundStageInspection> {
  return new BoundObjectStore(store, readOnlyScope(epochPrefix), maxBytes).inspectStage(stageId);
}

export async function readBoundCheckpoint(store: KeyValueStore, epochPrefix: string, checkpointId: string,
    maxBytes = 64 * 1024 * 1024): Promise<Uint8Array | undefined> {
  return new BoundObjectStore(store, readOnlyScope(epochPrefix), maxBytes).get('checkpoint:' + checkpointId);
}

/** Each writer owns its Epoch's mutable roots and immutable chunks. New roots
 * can refer to verified, protected bytes inherited from an older exact Binding. */
export class BoundObjectStore {
  private inheritedLocal?: RootLocation;
  constructor(readonly store: KeyValueStore, readonly scope: ObjectScope, readonly maxBytes: number) {}
  private get prefix() { return this.scope.epochPrefix + ':'; }
  private rootKey(name: string) {
    if (!objectNamePattern.test(name))
      throw new BrowserError('INVALID_INPUT', 'Unknown Binding object name.');
    return this.prefix + 'root:' + name;
  }
  private async readChunk(ref: ChunkRef, epoch: number): Promise<Uint8Array> {
    const raw = await this.store.get<string>(blobKey(this.scope.bindingPrefix, ref, epoch));
    if (typeof raw !== 'string' || raw.length !== 4 * Math.ceil(ref.bytes / 3))
      return failCorrupt('Binding chunk is missing or has the wrong length.');
    const bytes = base64ToBytes(raw);
    if (bytes.length !== ref.bytes || await digest(bytes) !== ref.sha256 || bytesToBase64(bytes) !== raw)
      return failCorrupt('Binding chunk digest or encoding differs.');
    return bytes;
  }
  private async readRoot({root, epoch}: RootLocation): Promise<Uint8Array> {
    const files: Record<string, string> = Object.create(null);
    let total = 0;
    for (const [path, file] of Object.entries(root.files)) {
      total += file.bytes;
      if (total > this.maxBytes) return failCorrupt('Binding manifest exceeds its byte limit.');
      const bytes = new Uint8Array(file.bytes);
      let offset = 0;
      for (const ref of file.chunks) {
        bytes.set(await this.readChunk(ref, epoch), offset);
        offset += ref.bytes;
      }
      if (await digest(bytes) !== file.sha256) return failCorrupt('Binding file digest differs.');
      files[path] = bytesToBase64(bytes);
    }
    const result = utf8.encode(JSON.stringify({...root.fields, files}));
    if (result.length !== root.sourceBytes || await digest(result) !== root.sourceHash)
      return failCorrupt('Binding manifest bytes differ from their receipt.');
    return result;
  }
  private async rootLocation(name: string): Promise<RootLocation | undefined> {
    const raw = await this.store.get(this.rootKey(name));
    if (raw !== undefined) return {root: parseRoot(raw, this.scope.epoch), epoch: this.scope.epoch};
    return name === 'local' ? this.inheritedLocal : undefined;
  }
  async adoptLocal(prior: BoundObjectStore): Promise<boolean> {
    if (prior.store !== this.store || prior.scope.bindingPrefix !== this.scope.bindingPrefix || prior.scope.epoch >= this.scope.epoch)
      throw new BrowserError('BINDING_MISMATCH', 'Local adoption requires an earlier Epoch of the exact Binding.');
    await this.writable();
    const location = await prior.rootLocation('local');
    if (!location) return false;
    await prior.readRoot(location);
    await this.writable();
    this.inheritedLocal = location;
    return true;
  }
  async get(name: string): Promise<Uint8Array | undefined> {
    const location = await this.rootLocation(name);
    return location === undefined ? undefined : this.readRoot(location);
  }
  async localView() {
    const location = await this.rootLocation('local');
    const root = location?.root;
    const files = Object.entries(root?.files ?? {}).map(([path, file]) => ({path, sha256: file.sha256, bytes: file.bytes}));
    const value = await digest(JSON.stringify(files.map((file) => [file.path, file.sha256, file.bytes])
      .sort(([a], [b]) => String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0)));
    const generation = root?.fields.generation ?? 0;
    if (!validGeneration(generation)) return failCorrupt('Invalid Binding local revision.');
    return {
      revision: {value: generation + ':' + value, verified: true as const},
      files,
      read: async (path: string) => {
        const reference = root?.files[canonicalPath(path)];
        if (!reference) throw new BrowserError('FILE_NOT_FOUND', 'Binding-local file does not exist.');
        const bytes = new Uint8Array(reference.bytes);
        let offset = 0;
        for (const chunk of reference.chunks) {
          bytes.set(await this.readChunk(chunk, location!.epoch), offset);
          offset += chunk.bytes;
        }
        if (await digest(bytes) !== reference.sha256) return failCorrupt('Binding file digest differs.');
        return bytes;
      },
    };
  }
  private async writable(): Promise<void> {
    if (this.scope.readOnly) throw new BrowserError('SCOPE_DENIED', 'Binding object storage is read-only.');
    await this.scope.assertCurrent();
  }
  private async keys(): Promise<string[]> {
    const keys = (await this.store.list()).filter((key) => key.startsWith(this.scope.bindingPrefix + ':epoch:'));
    if (keys.length > maxKeys) throw new BrowserError('QUOTA_EXCEEDED', 'Binding retention has reached its record limit.');
    return keys;
  }
  private async physicalBytes(keys: string[]) {
    let total = 0;
    for (const key of keys) {
      const chunk = /:chunk:[a-f0-9]{64}:([1-9][0-9]{0,5})$/.exec(key);
      if (chunk) {
        const length = Number(chunk[1]);
        if (length > chunkSize) return failCorrupt('Invalid Binding chunk length.');
        const encoded = await this.store.get<string>(key);
        if (typeof encoded !== 'string' || encoded.length !== 4 * Math.ceil(length / 3) || /[^A-Za-z0-9+/=]/.test(encoded))
          return failCorrupt('Invalid Binding chunk storage size or encoding.');
        total += utf8.encode(key).length + 2 + encoded.length;
      } else {
        const value = await this.store.get(key);
        if (value !== undefined) total += serializedBytes(key, value);
      }
      if (total > this.maxBytes) break;
    }
    return total;
  }
  async assertStorageRoom(additionalBytes: number): Promise<void> {
    const keys = await this.keys();
    if (await this.physicalBytes(keys) + additionalBytes > this.maxBytes)
      throw new BrowserError('QUOTA_EXCEEDED', 'Binding physical storage is full.');
  }
  private get adoptableKey() { return this.prefix + 'adoptable'; }
  private async retainedAdoptable(): Promise<Set<string>> {
    const record = await this.store.get<unknown>(this.adoptableKey);
    if (record === undefined) return new Set();
    if (!Array.isArray(record) || record.length > maxKeys ||
        record.some(key => typeof key !== 'string' || !/^[a-f0-9]{64}:[1-9][0-9]{0,5}$/.test(key)))
      return failCorrupt('Invalid adoptable Binding chunk inventory.');
    return new Set(record as string[]);
  }
  async put(name: string, input: Uint8Array, beforePublish?: () => void | Promise<void>): Promise<void> {
    await this.writable();
    const key = this.rootKey(name);
    if (input.length > this.maxBytes) throw new BrowserError('QUOTA_EXCEEDED', 'Binding object exceeds capacity.');
    const previous = await this.rootLocation(name);
    const sourceHash = await digest(input);
    if (previous?.root.sourceHash === sourceHash) {
      await this.readRoot(previous);
      return;
    }
    const raw = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(input)) as Record<string, unknown>;
    const entries = Object.entries(raw.files as Record<string, unknown>);
    const files: Record<string, FileRef> = Object.create(null);
    const additions = new Map<string, string>();
    const keys = await this.keys();
    const existing = new Set(keys);
    const inheritedBytes = new Map<string, ChunkRef>();
    for (const location of [this.inheritedLocal, previous]) {
      if (!location) continue;
      for (const ref of chunkReferences(location))
        inheritedBytes.set(`${ref.sha256}:${ref.bytes}`, ref);
    }
    if (entries.length > maxFiles) throw new BrowserError('LIMIT_EXCEEDED', 'Binding object exceeds its file limit.');
    for (const [path, value] of entries) {
      canonicalPath(path);
      if (typeof value !== 'string') return failCorrupt('Binding file must contain base64.');
      const bytes = base64ToBytes(value);
      if (bytes.length > 16 * 1024 * 1024 || bytesToBase64(bytes) !== value) return failCorrupt('Invalid Binding file encoding.');
      const chunks: ChunkRef[] = [];
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        const chunk = bytes.subarray(offset, offset + chunkSize);
        const sha256 = await digest(chunk);
        const ref = inheritedBytes.get(`${sha256}:${chunk.length}`) ??
          {sha256, bytes: chunk.length, epoch: this.scope.epoch};
        chunks.push(ref);
        const chunkKey = blobKey(this.scope.bindingPrefix, ref, this.scope.epoch);
        if (ref.epoch !== this.scope.epoch || existing.has(chunkKey)) await this.readChunk(ref, this.scope.epoch);
        else if (!additions.has(chunkKey)) additions.set(chunkKey, bytesToBase64(chunk));
      }
      files[path] = { sha256: await digest(bytes), bytes: bytes.length, chunks };
    }
    const root: ObjectRoot = { version: 3, sourceHash, sourceBytes: input.length,
      fields: { ...raw, files: null }, files };
    const pendingKey = this.prefix + 'stage:' + crypto.randomUUID();
    const stage: StagingRoot = {objectName:name, root,
      ...(previous ? {previous: previous.root, previousEpoch: previous.epoch} : {})};
    const adoptable = name === 'local' ? await this.retainedAdoptable() : undefined;
    const beforeAdoptable = adoptable?.size;
    if (adoptable) {
      // A successor may have a previously verified view of any published local
      // root. This Epoch may not collect its bytes on behalf of that reader.
      for (const location of stageLocations(stage, this.scope.epoch))
        for (const ref of chunkReferences(location))
          if (ref.epoch === this.scope.epoch) adoptable.add(`${ref.sha256}:${ref.bytes}`);
    }
    const newAdoptable = adoptable && adoptable.size !== beforeAdoptable ? [...adoptable].sort() : undefined;
    let projected = await this.physicalBytes(keys) + serializedBytes(key, root) + serializedBytes(pendingKey, stage);
    if (newAdoptable) projected += serializedBytes(this.adoptableKey, newAdoptable);
    for (const [chunkKey, encoded] of additions) projected += serializedBytes(chunkKey, encoded);
    const pendingCount = additions.size + 1 + Number(!existing.has(key)) + Number(!!newAdoptable && !existing.has(this.adoptableKey));
    if (projected > this.maxBytes || keys.length + pendingCount > maxKeys)
      throw new BrowserError('QUOTA_EXCEEDED', 'Binding physical storage is full. Export retained evidence before clearing unpinned data.');
    await this.writable();
    await this.store.set(pendingKey, stage);
    let rootAttempted = false;
    try {
      for (const [chunkKey, encoded] of additions) await this.store.set(chunkKey, encoded);
      await this.readRoot({root, epoch:this.scope.epoch});
      if (newAdoptable) await this.store.set(this.adoptableKey, newAdoptable);
      await this.writable();
      if (beforePublish) await beforePublish();
      rootAttempted = true;
      try { await this.store.set(key, root); }
      catch { /* Exact readback distinguishes a lost acknowledgement. */ }
      const observed = await this.store.get(key);
      if (observed === undefined || parseRoot(observed, this.scope.epoch).sourceHash !== root.sourceHash)
        throw new BrowserError('EFFECT_UNKNOWN', 'Binding manifest publication could not be verified. Preserve its staged evidence.');
      await this.readRoot({root:parseRoot(observed, this.scope.epoch), epoch:this.scope.epoch});
      rootAttempted = false;
    } catch (error) {
      if (rootAttempted)
        throw new BrowserError('EFFECT_UNKNOWN', 'Binding manifest publication requires exact readback reconciliation.');
      throw error;
    } finally {
      if (!rootAttempted) await this.store.delete(pendingKey).catch(() => undefined);
    }
  }
  async delete(name: string): Promise<void> {
    await this.writable();
    await this.store.delete(this.rootKey(name));
  }
  async retireCheckpoint(id: string, ownerEpoch: number): Promise<void> {
    if (!stageIdPattern.test(id) || !validGeneration(ownerEpoch) || ownerEpoch < 1 || ownerEpoch > this.scope.epoch)
      throw new BrowserError('BINDING_MISMATCH', 'Checkpoint retirement requires its exact retained Epoch.');
    await this.writable();
    await this.store.delete(`${this.scope.bindingPrefix}:epoch:${ownerEpoch}:root:checkpoint:${id}`);
  }
  async inspectStage(id: string): Promise<BoundStageInspection> {
    if (!stageIdPattern.test(id)) throw new BrowserError('INVALID_INPUT', 'Invalid staged Binding object identifier.');
    const epoch = this.scope.epoch;
    const raw = await this.store.get(this.prefix + 'stage:' + id);
    if (raw === undefined) throw new BrowserError('FILE_NOT_FOUND', 'Staged Binding object is missing.');
    const stage = parseStage(raw, epoch);
    const stageDigest = await digest(JSON.stringify(raw));
    const stagedSourceHash = stage.root.sourceHash;
    const previousSourceHash = stage.previous?.sourceHash ?? null;
    let objectName = stage.objectName ?? null;
    if (!objectName) {
      const prefix = this.prefix + 'root:';
      const matches: string[] = [];
      for (const key of (await this.keys()).filter(key => key.startsWith(prefix))) {
        const hash = parseRoot(await this.store.get(key), epoch).sourceHash;
        if (hash === stagedSourceHash || hash === previousSourceHash) matches.push(key.slice(prefix.length));
      }
      if (matches.length === 1) objectName = matches[0]!;
      else if (!matches.length && stage.root.fields.version === 1 &&
          typeof stage.root.fields.lastHash === 'string' && validGeneration(stage.root.fields.generation) &&
          Object.keys(stage.root.fields).every(key => ['version', 'generation', 'lastHash', 'files'].includes(key)))
        objectName = 'local';
    }
    const base = {id, objectName, stageDigest, stagedSourceHash, previousSourceHash};
    if (!objectName) return {...base, observedRootDigest:null, observedSourceHash:null, observedState:'UNATTRIBUTED'};
    let observedEpoch = epoch;
    let observed = await this.store.get(this.rootKey(objectName));
    if (observed === undefined && objectName === 'local' && stage.previousEpoch && stage.previousEpoch < epoch) {
      observedEpoch = stage.previousEpoch;
      observed = await this.store.get(`${this.scope.bindingPrefix}:epoch:${observedEpoch}:root:local`);
    }
    if (observed === undefined) return {...base, observedRootDigest:null, observedSourceHash:null, observedState:'MISSING_ROOT'};
    const root = parseRoot(observed, observedEpoch);
    await this.readRoot({root, epoch:observedEpoch});
    const observedRootDigest = await digest(JSON.stringify(observed));
    const observedState = root.sourceHash === stagedSourceHash ? 'STAGED_ROOT' :
      root.sourceHash === previousSourceHash ? 'PREVIOUS_ROOT' : 'DIVERGED';
    return {...base, observedRootDigest, observedSourceHash:root.sourceHash, observedState};
  }
  async collectOrphans(): Promise<number> {
    await this.writable();
    const keys = (await this.keys()).filter(key => key.startsWith(this.prefix));
    const reachable = new Set(await boundEpochChunkKeys(this.store, this.scope.epochPrefix, keys));
    for (const suffix of await this.retainedAdoptable()) reachable.add(this.prefix + 'chunk:' + suffix);
    const orphaned = keys.filter((key) => key.startsWith(this.prefix + 'chunk:') && !reachable.has(key)).slice(0, 32);
    for (const key of orphaned) {
      await this.writable();
      await this.store.delete(key);
    }
    return orphaned.length;
  }
}

/** Older storage is intentionally retained. Its key prefix is never used by a
 * v2 execution path because v0.2 lacks exact assignment provenance. */
export async function hasQuarantinedWorkspaceData(store: KeyValueStore, workspaceId: string): Promise<boolean> {
  if (!opaqueId.test(workspaceId)) throw new BrowserError('INVALID_INPUT', 'Invalid Workspace ID.');
  return (await store.list()).some((key) => key.startsWith('perch:workspace:' + workspaceId + ':') ||
    key.startsWith('perch:operation:' + workspaceId + ':'));
}

/** Operator-only private export. Read exact Workspace namespaces and retain
 * every record on failure. Pairing, credential and Resource keys are excluded. */
export async function exportWorkspaceEvidence(store: KeyValueStore, workspaceId: string): Promise<string> {
  if (!opaqueId.test(workspaceId)) throw new BrowserError('INVALID_INPUT','Invalid Workspace ID.');
  const keys=(await store.list()).filter(key=>key.startsWith('perch:workspace:'+workspaceId+':') ||
    key.startsWith('perch:operation:'+workspaceId+':') ||
    (key.startsWith('perch:binding-v2:') && key.split(':',5)[3]===workspaceId)).sort();
  if(keys.length>4096) throw new BrowserError('LIMIT_EXCEEDED','Exact Workspace archive is too large.');
  const entries: string[]=[];
  let bytes=0;
  for(const key of keys){
    const row=await store.get(key);
    if(row===undefined)throw new BrowserError('STORAGE_CORRUPT','The Workspace archive changed during export.');
    const encoded=JSON.stringify({key,row});
    bytes+=utf8.encode(encoded).length;
    if(bytes>64*1024*1024)throw new BrowserError('LIMIT_EXCEEDED','Exact Workspace archive exceeds 64 MiB.');
    entries.push(encoded);
  }
  return '{"format":"perch-workspace-evidence-v1","workspaceId":'+JSON.stringify(workspaceId)+
    ',"records":['+entries.join(',')+']}\n';
}
