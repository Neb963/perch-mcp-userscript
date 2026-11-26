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
/** Immutable chunks, then a single manifest pointer. Interrupted writes retain the previous value. */
export class ChunkStore {
  constructor(readonly store: KeyValueStore, readonly namespace: string, readonly maxBytes = 64 * 1024 * 1024) {}
  async put(key: string, bytes: Uint8Array): Promise<void> {
    if (bytes.length > this.maxBytes) throw new BrowserError('QUOTA_EXCEEDED', 'Local object exceeds configured storage budget.');
    const generation = crypto.randomUUID(); const chunks = Math.ceil(bytes.length / 196608); const prefix = `${this.namespace}:blob:${key}:${generation}:`;
    try { for (let i = 0; i < chunks; i++) await this.store.set(prefix + i, bytesToBase64(bytes.subarray(i * 196608, (i + 1) * 196608)));
      await this.store.set<BlobManifest>(`${this.namespace}:manifest:${key}`, { version: 1, length: bytes.length, hash: await digest(bytes), chunks, generation });
    } catch { throw new BrowserError('QUOTA_EXCEEDED', 'Local storage write failed; previous manifest remains authoritative.'); }
  }
  async get(key: string): Promise<Uint8Array | undefined> {
    const manifest = await this.store.get<BlobManifest>(`${this.namespace}:manifest:${key}`); if (!manifest) return undefined;
    if (manifest.version !== 1 || !Number.isSafeInteger(manifest.length) || manifest.length < 0 || manifest.length > this.maxBytes || manifest.chunks !== Math.ceil(manifest.length / 196608) || !/^[a-f0-9-]{36}$/.test(manifest.generation)) throw new BrowserError('STORAGE_CORRUPT', 'Invalid local manifest.');
    const bytes = new Uint8Array(manifest.length); let offset = 0;
    for (let i = 0; i < manifest.chunks; i++) { const chunk = await this.store.get<string>(`${this.namespace}:blob:${key}:${manifest.generation}:${i}`); if (typeof chunk !== 'string') throw new BrowserError('STORAGE_CORRUPT', 'Missing local chunk.'); const decoded = base64ToBytes(chunk); if (offset + decoded.length > bytes.length) throw new BrowserError('STORAGE_CORRUPT', 'Oversized local chunk.'); bytes.set(decoded, offset); offset += decoded.length; }
    if (offset !== manifest.length || await digest(bytes) !== manifest.hash) throw new BrowserError('STORAGE_CORRUPT', 'Local content digest mismatch.'); return bytes;
  }
  async delete(key: string): Promise<void> { await this.store.delete(`${this.namespace}:manifest:${key}`); }
  async collectOrphans(): Promise<number> { const keys = await this.store.list(); const live = new Set<string>(); for (const key of keys.filter(k => k.startsWith(`${this.namespace}:manifest:`))) { const m = await this.store.get<BlobManifest>(key); if (m) live.add(`${this.namespace}:blob:${key.slice(`${this.namespace}:manifest:`.length)}:${m.generation}:`); } let removed = 0; for (const key of keys.filter(k => k.startsWith(`${this.namespace}:blob:`))) { if (![...live].some(prefix => key.startsWith(prefix))) { await this.store.delete(key); removed++; } } return removed; }
}
