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

interface ChunkRef { sha256: string; bytes: number }
interface FileRef { sha256: string; bytes: number; chunks: ChunkRef[] }
interface ObjectRoot { version: 2; sourceHash: string; sourceBytes: number; fields: Record<string, unknown>; files: Record<string, FileRef> }
interface StagingRoot { root: ObjectRoot; previous?: ObjectRoot }
const failCorrupt = (message: string): never => { throw new BrowserError('STORAGE_CORRUPT', message); };
function serializedBytes(key: string, value: unknown): number {
  return utf8.encode(key).length + utf8.encode(JSON.stringify(value)).length;
}

function parseRoot(root: unknown): ObjectRoot {
  if (!root || typeof root !== 'object' || Array.isArray(root)) return failCorrupt('Invalid Binding manifest.');
  const row = root as ObjectRoot;
  if (row.version !== 2 || !hexDigest.test(row.sourceHash) ||
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
      if (!chunk || !hexDigest.test(chunk.sha256) || chunk.bytes !== length)
        return failCorrupt('Invalid chunk reference in Binding manifest.');
    }
  }
  return row;
}

/** Each Epoch has independent mutable roots and chunks. A suspended writer can
 * leave evidence in its own namespace without changing a newer Epoch's roots. */
export class BoundObjectStore {
  constructor(readonly store: KeyValueStore, readonly scope: BindingStorageScope, readonly maxBytes: number) {}
  private get prefix() { return this.scope.epochPrefix + ':'; }
  private rootKey(name: string) {
    if (!/^(?:local|checkpoint:[a-f0-9-]{36})$/.test(name))
      throw new BrowserError('INVALID_INPUT', 'Unknown Binding object name.');
    return this.prefix + 'root:' + name;
  }
  private blobKey(ref: ChunkRef) { return this.prefix + 'chunk:' + ref.sha256 + ':' + ref.bytes; }
  private async readChunk(ref: ChunkRef): Promise<Uint8Array> {
    const raw = await this.store.get<string>(this.blobKey(ref));
    if (typeof raw !== 'string' || raw.length !== 4 * Math.ceil(ref.bytes / 3))
      return failCorrupt('Binding chunk is missing or has the wrong length.');
    const bytes = base64ToBytes(raw);
    if (bytes.length !== ref.bytes || await digest(bytes) !== ref.sha256 || bytesToBase64(bytes) !== raw)
      return failCorrupt('Binding chunk digest or encoding differs.');
    return bytes;
  }
  private async readRoot(root: ObjectRoot): Promise<Uint8Array> {
    const files: Record<string, string> = Object.create(null);
    let total = 0;
    for (const [path, file] of Object.entries(root.files)) {
      total += file.bytes;
      if (total > this.maxBytes) return failCorrupt('Binding manifest exceeds its byte limit.');
      const bytes = new Uint8Array(file.bytes);
      let offset = 0;
      for (const ref of file.chunks) {
        bytes.set(await this.readChunk(ref), offset);
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
  async get(name: string): Promise<Uint8Array | undefined> {
    const root = await this.store.get(this.rootKey(name));
    return root === undefined ? undefined : this.readRoot(parseRoot(root));
  }
  async localView() {
    const raw = await this.store.get(this.rootKey('local'));
    const root = raw === undefined ? undefined : parseRoot(raw);
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
          bytes.set(await this.readChunk(chunk), offset);
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
        total += utf8.encode(key).length + 2 + 4 * Math.ceil(length / 3);
      } else {
        const value = await this.store.get(key);
        if (value !== undefined) total += serializedBytes(key, value);
      }
    }
    return total;
  }
  async assertStorageRoom(additionalBytes: number): Promise<void> {
    const keys = await this.keys();
    if (await this.physicalBytes(keys) + additionalBytes > this.maxBytes)
      throw new BrowserError('QUOTA_EXCEEDED', 'Binding physical storage is full.');
  }
  async put(name: string, input: Uint8Array, beforePublish?: () => void | Promise<void>): Promise<void> {
    await this.writable();
    const key = this.rootKey(name);
    if (input.length > this.maxBytes) throw new BrowserError('QUOTA_EXCEEDED', 'Binding object exceeds capacity.');
    const raw = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(input)) as Record<string, unknown>;
    const entries = Object.entries(raw.files as Record<string, unknown>);
    const files: Record<string, FileRef> = Object.create(null);
    const additions = new Map<string, string>();
    const keys = await this.keys();
    const existing = new Set(keys);
    if (entries.length > maxFiles) throw new BrowserError('LIMIT_EXCEEDED', 'Binding object exceeds its file limit.');
    for (const [path, value] of entries) {
      canonicalPath(path);
      if (typeof value !== 'string') return failCorrupt('Binding file must contain base64.');
      const bytes = base64ToBytes(value);
      if (bytes.length > 16 * 1024 * 1024 || bytesToBase64(bytes) !== value) return failCorrupt('Invalid Binding file encoding.');
      const chunks: ChunkRef[] = [];
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        const chunk = bytes.subarray(offset, offset + chunkSize);
        const ref = { sha256: await digest(chunk), bytes: chunk.length };
        chunks.push(ref);
        const chunkKey = this.blobKey(ref);
        if (existing.has(chunkKey)) await this.readChunk(ref);
        else if (!additions.has(chunkKey)) additions.set(chunkKey, bytesToBase64(chunk));
      }
      files[path] = { sha256: await digest(bytes), bytes: bytes.length, chunks };
    }
    const root: ObjectRoot = { version: 2, sourceHash: await digest(input), sourceBytes: input.length,
      fields: { ...raw, files: null }, files };
    const previousRaw = await this.store.get(key);
    const previous = previousRaw === undefined ? undefined : parseRoot(previousRaw);
    if (previous?.sourceHash === root.sourceHash) {
      await this.readRoot(previous);
      return;
    }
    const pendingKey = this.prefix + 'stage:' + crypto.randomUUID();
    const stage: StagingRoot = { root, ...(previous ? { previous } : {}) };
    let projected = await this.physicalBytes(keys) + serializedBytes(key, root) + serializedBytes(pendingKey, stage);
    for (const [chunkKey, encoded] of additions) projected += serializedBytes(chunkKey, encoded);
    if (projected > this.maxBytes || keys.length + additions.size + 2 > maxKeys)
      throw new BrowserError('QUOTA_EXCEEDED', 'Binding physical storage is full. Export retained evidence before clearing unpinned data.');
    await this.writable();
    await this.store.set(pendingKey, stage);
    let rootAttempted = false;
    try {
      for (const [chunkKey, encoded] of additions) await this.store.set(chunkKey, encoded);
      await this.readRoot(root);
      await this.writable();
      if (beforePublish) await beforePublish();
      rootAttempted = true;
      try { await this.store.set(key, root); }
      catch { /* Exact readback distinguishes a lost acknowledgement. */ }
      const observed = await this.store.get(key);
      if (observed === undefined || parseRoot(observed).sourceHash !== root.sourceHash)
        throw new BrowserError('EFFECT_UNKNOWN', 'Binding manifest publication could not be verified. Preserve its staged evidence.');
      await this.readRoot(parseRoot(observed));
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
  async collectOrphans(): Promise<number> {
    await this.writable();
    const keys = (await this.keys()).filter((key) => key.startsWith(this.prefix));
    const reachable = new Set<string>();
    const retain = (root: unknown) => {
      for (const file of Object.values(parseRoot(root).files))
        for (const ref of file.chunks) reachable.add(this.blobKey(ref));
    };
    for (const key of keys) {
      if (key.startsWith(this.prefix + 'root:')) retain(await this.store.get(key));
      else if (key.startsWith(this.prefix + 'stage:')) {
        const stage = await this.store.get<StagingRoot>(key);
        if (!stage) return failCorrupt('Missing staged Binding manifest.');
        retain(stage.root);
        if (stage.previous) retain(stage.previous);
      }
    }
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
