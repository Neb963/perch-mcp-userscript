import { BrowserError, base64ToBytes, bytesToBase64, digest, type KeyValueStore } from './native-types.js';
export type { KeyValueStore } from './native-types.js';
export class MemoryStore implements KeyValueStore {
  private values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> { return structuredClone(this.values.get(key)) as T | undefined; }
  async set<T>(key: string, value: T): Promise<void> { this.values.set(key, structuredClone(value)); }
  async delete(key: string): Promise<void> { this.values.delete(key); }
  async list(): Promise<string[]> { return [...this.values.keys()]; }
}
/** Pass only isolated GM functions. Never pass page localStorage. */
export class GMStore implements KeyValueStore {
  constructor(private api: { getValue(key: string): unknown | Promise<unknown>; setValue(key: string, value: unknown): void | Promise<void>; deleteValue(key: string): void | Promise<void>; listValues(): string[] | Promise<string[]> }) {}
  async get<T>(key: string): Promise<T | undefined> { return await this.api.getValue(key) as T | undefined; }
  async set<T>(key: string, value: T): Promise<void> { await this.api.setValue(key, value); }
  async delete(key: string): Promise<void> { await this.api.deleteValue(key); }
  async list(): Promise<string[]> { return this.api.listValues(); }
}
interface BlobManifest { version: 1; length: number; hash: string; chunks: number; generation: string }
interface PendingGeneration { prefix: string; previousPrefix?: string; phase: 'STAGING'|'PUBLISHING'; startedAt: number }
/** Immutable generations, then one manifest pointer. Uncertain publication retains both generations. */
export class ChunkStore {
  constructor(readonly store: KeyValueStore, readonly namespace: string, readonly maxBytes = 64 * 1024 * 1024) {}
  async put(key: string, input: Uint8Array): Promise<void> {
    if (input.length > this.maxBytes) throw new BrowserError('QUOTA_EXCEEDED', 'Local object exceeds configured storage budget.');
    const bytes=input.slice(); const manifestKey=`${this.namespace}:manifest:${key}`;
    const previous=await this.store.get<BlobManifest>(manifestKey);
    const generation=crypto.randomUUID(), chunks=Math.ceil(bytes.length/196608);
    const prefix=`${this.namespace}:blob:${key}:${generation}:`, pendingKey=`${this.namespace}:pending:${key}:${generation}`;
    const manifest:BlobManifest={version:1,length:bytes.length,hash:await digest(bytes),chunks,generation};
    const pending:PendingGeneration={prefix,phase:'STAGING',startedAt:Date.now()};
    if (previous && typeof previous.generation==='string' && /^[a-f0-9-]{36}$/.test(previous.generation)) pending.previousPrefix=`${this.namespace}:blob:${key}:${previous.generation}:`;
    let retain=false;
    try {
      try {
        await this.store.set(pendingKey,pending);
        for(let i=0;i<chunks;i++) await this.store.set(prefix+i,bytesToBase64(bytes.subarray(i*196608,(i+1)*196608)));
        pending.phase='PUBLISHING'; await this.store.set(pendingKey,pending);
      } catch { throw new BrowserError('QUOTA_EXCEEDED','Local staging failed before manifest publication; no new manifest was dispatched.'); }
      try { await this.store.set(manifestKey,manifest); }
      catch {
        retain=true; // Publication may have committed. Never rewrite the pointer to compensate.
        let observed:BlobManifest|undefined;
        try { observed=await this.store.get<BlobManifest>(manifestKey); }
        catch { throw new BrowserError('EFFECT_UNKNOWN','Local manifest publication failed and its authoritative pointer could not be read.','Retain both generations; inspect the local journal and reconcile before writing.'); }
        if(this.sameManifest(observed,manifest)) {
          try { await this.readGeneration(key,manifest); }
          catch { throw new BrowserError('EFFECT_UNKNOWN','The new local manifest exists but its exact chunks could not be verified.','Retain both generations; reconcile storage without replay or rollback.'); }
          retain=false; return; // Lost acknowledgement, but exact committed bytes are independently verified.
        }
        if(this.sameManifest(observed,previous)) {
          retain=false;
          throw new BrowserError('QUOTA_EXCEEDED','Manifest publication failed; exact pointer readback confirms that the previous manifest is unchanged.');
        }
        throw new BrowserError('EFFECT_UNKNOWN','Local manifest changed during a failed publication; this operation cannot determine its effect.','Preserve current pointer and both staged generations; reconcile without retrying publication.');
      }
    } finally { if(!retain) try { await this.store.delete(pendingKey); } catch { /* Retaining a marker delays collection; it never rolls back content. */ } }
  }
  private sameManifest(a:BlobManifest|undefined,b:BlobManifest|undefined):boolean {
    if(a===undefined||b===undefined)return a===b;
    if(!this.validManifest(a)||!this.validManifest(b))return false;
    return a.version===b.version&&a.length===b.length&&a.hash===b.hash&&a.chunks===b.chunks&&a.generation===b.generation;
  }
  async get(key:string):Promise<Uint8Array|undefined> { const manifest=await this.store.get<BlobManifest>(`${this.namespace}:manifest:${key}`); return manifest===undefined?undefined:this.readGeneration(key,manifest); }
  private validManifest(manifest:BlobManifest):boolean { return !!manifest&&typeof manifest==='object'&&manifest.version===1&&Number.isSafeInteger(manifest.length)&&manifest.length>=0&&manifest.length<=this.maxBytes&&manifest.chunks===Math.ceil(manifest.length/196608)&&typeof manifest.generation==='string'&&/^[a-f0-9-]{36}$/.test(manifest.generation)&&typeof manifest.hash==='string'&&/^[a-f0-9]{64}$/.test(manifest.hash); }
  private async readGeneration(key:string,manifest:BlobManifest):Promise<Uint8Array> {
    if(!this.validManifest(manifest))throw new BrowserError('STORAGE_CORRUPT','Invalid local manifest.');
    const bytes=new Uint8Array(manifest.length);let offset=0;
    for(let i=0;i<manifest.chunks;i++){const chunk=await this.store.get<string>(`${this.namespace}:blob:${key}:${manifest.generation}:${i}`);if(typeof chunk!=='string')throw new BrowserError('STORAGE_CORRUPT','Missing local chunk.');const decoded=base64ToBytes(chunk);if(offset+decoded.length>bytes.length)throw new BrowserError('STORAGE_CORRUPT','Oversized local chunk.');bytes.set(decoded,offset);offset+=decoded.length;}
    if(offset!==manifest.length||await digest(bytes)!==manifest.hash)throw new BrowserError('STORAGE_CORRUPT','Local content digest mismatch.');return bytes;
  }
  async delete(key:string):Promise<void>{await this.store.delete(`${this.namespace}:manifest:${key}`);}
  async collectOrphans():Promise<number>{
    const keys=await this.store.list(),live=new Set<string>();
    for(const key of keys.filter(k=>k.startsWith(`${this.namespace}:pending:`))){const pending=await this.store.get<PendingGeneration>(key);if(!pending||typeof pending.prefix!=='string'||!pending.prefix.startsWith(`${this.namespace}:blob:`))throw new BrowserError('STORAGE_CORRUPT','Unrecognized pending generation; orphan collection stopped.');live.add(pending.prefix);if(typeof pending.previousPrefix==='string'&&pending.previousPrefix.startsWith(`${this.namespace}:blob:`))live.add(pending.previousPrefix);}
    // Pending generations have no time-based eviction: a timeout cannot prove non-publication.
    for(const key of keys.filter(k=>k.startsWith(`${this.namespace}:manifest:`))){const manifest=await this.store.get<BlobManifest>(key);if(manifest!==undefined){if(!this.validManifest(manifest))throw new BrowserError('STORAGE_CORRUPT','Invalid live manifest; orphan collection stopped.');live.add(`${this.namespace}:blob:${key.slice(`${this.namespace}:manifest:`.length)}:${manifest.generation}:`);}}
    let removed=0;for(const key of keys.filter(k=>k.startsWith(`${this.namespace}:blob:`))){if(![...live].some(prefix=>key.startsWith(prefix))){await this.store.delete(key);removed++;}}return removed;
  }
}
