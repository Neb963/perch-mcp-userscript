import { ChunkStore } from './storage.js';
import { base64ToBytes, bytesToBase64, digest, type KeyValueStore } from './native-types.js';
export interface Artifact { id: string; workspaceId: string; bindingRevision: number; name: string; bytes: number; sha256: string; createdAt: number; expiresAt: number }
export class ArtifactStore {
  constructor(private store: KeyValueStore, private budget = 8 * 1024 * 1024) {}
  private chunks() { return new ChunkStore(this.store,'perch:artifacts',this.budget); }
  async create(workspaceId: string, bindingRevision: number, name: string, bytes: Uint8Array): Promise<Artifact> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(workspaceId) || !Number.isInteger(bindingRevision) || bindingRevision < 1) throw new Error('Invalid artifact scope.');
    if (bytes.length > this.budget) throw new Error('Artifact snapshot exceeds the 8 MiB local budget.');
    const existing = await this.list();
    if (existing.reduce((n, a) => n + a.bytes, 0) + bytes.length > this.budget) throw new Error('Artifact storage budget exhausted.');
    const artifact: Artifact = { id: crypto.randomUUID(), workspaceId, bindingRevision, name: name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'artifact.bin', bytes: bytes.length, sha256: await digest(bytes), createdAt: Date.now(), expiresAt: Date.now() + 600000 };
    await this.chunks().put(artifact.id,bytes);
    await this.store.set(`perch:artifact:${artifact.id}`,artifact);
    return artifact;
  }
  async list(): Promise<Artifact[]> {
    const result: Artifact[] = [];
    for (const key of (await this.store.list()).filter(k => k.startsWith('perch:artifact:'))) {
      const value = await this.store.get<Artifact & {data:string}>(key); if (!value) continue;
      if (value.expiresAt <= Date.now()) { await this.store.delete(key); await this.chunks().delete(value.id); continue; }
      const { data: _data, ...metadata } = value; result.push(metadata);
    }
    return result.sort((a,b) => b.createdAt-a.createdAt);
  }
  async read(id: string, workspaceId?: string, bindingRevision?: number): Promise<{ metadata: Artifact; bytes: Uint8Array }> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid artifact ID.');
    const value = await this.store.get<Artifact & {data:string}>(`perch:artifact:${id}`);
    if (!value || value.expiresAt <= Date.now()) throw new Error('RESULT_EXPIRED: artifact is no longer retained.');
    if ((workspaceId !== undefined && value.workspaceId !== workspaceId) || (bindingRevision !== undefined && value.bindingRevision !== bindingRevision)) throw new Error('Artifact scope mismatch.');
    const bytes = await this.chunks().get(id); if(!bytes)throw new Error('Artifact bytes missing.'); if (bytes.length !== value.bytes || await digest(bytes) !== value.sha256) throw new Error('Artifact digest mismatch.');
    const {data:_data,...metadata} = value; return {metadata,bytes};
  }
}
