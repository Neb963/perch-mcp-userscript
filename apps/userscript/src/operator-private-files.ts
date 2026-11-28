import { sameBackupBinding } from './operator-backup.js';
import type { BindingStorageIdentity } from './binding-storage.js';
import { BrowserError, base64ToBytes, bytesToBase64, canonicalPath, digest, isUint8Array, utf8,
  type KeyValueStore } from './native-types.js';

type StagePhase = 'OPEN' | 'COMMITTING' | 'IMPORTED';
export interface PrivateFileStageSummary {
  id: string; path: string; bytes: number; sha256: string; state: StagePhase;
}
interface StageRecord extends PrivateFileStageSummary {
  version: 1;
  scope: BindingStorageIdentity | null;
  at: number;
  content?: string;
  expectedLocalRevision?: string;
  resultRevision?: string;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const sha256 = /^[a-f0-9]{64}$/;
const maxBytes = 64 * 1024 * 1024;
const maxFileBytes = 16 * 1024 * 1024;
const maxOpen = 32;
const maxTerminal = 64;

function scratchPath(path: string): string {
  if (!canonicalPath(path).startsWith('scratch/'))
    throw new BrowserError('PATH_DENIED', 'Private staged files require a canonical scratch/ path.');
  return path;
}

export class OperatorPrivateFiles {
  private readonly prefix: string;
  constructor(private readonly store: KeyValueStore, installationId: string) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(installationId))
      throw new BrowserError('BINDING_MISMATCH', 'Private file staging requires the browser installation.');
    this.prefix = 'perch:operator-private-stage:' + installationId + ':';
  }

  private key(id: string): string {
    if (!uuid.test(id)) throw new BrowserError('INVALID_INPUT', 'Choose an exact staged private file.');
    return this.prefix + id;
  }

  async read(id: string): Promise<StageRecord> {
    const row = await this.store.get<StageRecord>(this.key(id));
    if (!row) throw new BrowserError('FILE_NOT_FOUND', 'Staged private file is missing.');
    if (row.version !== 1 || row.id !== id || !['OPEN','COMMITTING','IMPORTED'].includes(row.state) ||
        typeof row.path !== 'string' || !sha256.test(row.sha256) || !Number.isSafeInteger(row.bytes) ||
        row.bytes < 0 || row.bytes > maxFileBytes || !Number.isSafeInteger(row.at) ||
        (row.state !== 'IMPORTED' && (typeof row.content !== 'string' || row.content.length !== 4 * Math.ceil(row.bytes / 3))))
      throw new BrowserError('STORAGE_CORRUPT', 'Staged private file metadata is malformed.');
    scratchPath(row.path);
    return row;
  }

  private async records(): Promise<StageRecord[]> {
    const keys = (await this.store.list()).filter(key => key.startsWith(this.prefix));
    if (keys.length > 2 * (maxOpen + maxTerminal))
      throw new BrowserError('QUOTA_EXCEEDED', 'Private staging exceeds its retained record budget.');
    return (await Promise.all(keys.map(key => this.read(key.slice(this.prefix.length))))).sort((a,b) => b.at - a.at);
  }

  async list(): Promise<PrivateFileStageSummary[]> {
    return (await this.records()).map(({id, path, bytes, sha256, state}) => ({id, path, bytes, sha256, state}));
  }

  async stage(path: string, bytes: Uint8Array, scope: BindingStorageIdentity | null): Promise<PrivateFileStageSummary> {
    scratchPath(path);
    if (!isUint8Array(bytes) || bytes.length > maxFileBytes)
      throw new BrowserError('LIMIT_EXCEEDED', 'A private staged file may contain up to 16 MiB.');
    const content = bytes.slice();
    const existing = await this.records();
    const active = existing.filter(row => row.state !== 'IMPORTED');
    if (active.length >= maxOpen)
      throw new BrowserError('QUOTA_EXCEEDED', 'Private staging is full. Import or resolve existing files first.');
    const row: StageRecord = {version: 1, id: crypto.randomUUID(), path, bytes: content.length,
      sha256: await digest(content), content: bytesToBase64(content), scope, at: Date.now(), state: 'OPEN'};
    const occupied = active.reduce((total, item) => total + utf8.encode(JSON.stringify(item)).length, 0);
    if (occupied + utf8.encode(JSON.stringify(row)).length > maxBytes)
      throw new BrowserError('QUOTA_EXCEEDED', 'Private staged file byte budget would be exceeded.');
    await this.persist(row);
    const {id, sha256, state} = row;
    return {id, path, bytes: row.bytes, sha256, state};
  }

  async verifiedContent(row: StageRecord, scope: BindingStorageIdentity): Promise<Uint8Array> {
    if (row.scope && !sameBackupBinding(row.scope, scope))
      throw new BrowserError('BINDING_MISMATCH', 'This private stage belongs to a different Assignment or Binding.');
    if (row.state !== 'OPEN')
      throw new BrowserError('EFFECT_UNKNOWN', 'The original private stage is awaiting reconciliation or already imported.');
    const bytes = base64ToBytes(row.content!);
    if (bytes.length !== row.bytes || bytesToBase64(bytes) !== row.content || await digest(bytes) !== row.sha256)
      throw new BrowserError('STORAGE_CORRUPT', 'Staged private bytes differ from the recorded fingerprint.');
    return bytes;
  }

  async begin(row: StageRecord, scope: BindingStorageIdentity, expectedLocalRevision: string): Promise<StageRecord> {
    const current = await this.read(row.id);
    if (JSON.stringify(current) !== JSON.stringify(row) || current.state !== 'OPEN')
      throw new BrowserError('STALE_REVISION', 'The staged file changed before import.');
    const intent: StageRecord = {...row, scope, expectedLocalRevision, state: 'COMMITTING'};
    await this.persist(intent);
    return intent;
  }

  async finish(intent: StageRecord, localRevision: string): Promise<void> {
    const current = await this.read(intent.id);
    if (JSON.stringify(current) !== JSON.stringify(intent))
      throw new BrowserError('EFFECT_UNKNOWN', 'The private import intent could not be verified.');
    const {content: _content, ...metadata} = intent;
    await this.persist({...metadata, resultRevision: localRevision, state: 'IMPORTED'});
    const receipts = (await this.records()).filter(row => row.state === 'IMPORTED');
    for (const old of receipts.slice(maxTerminal)) await this.store.delete(this.key(old.id));
  }

  async reopen(intent: StageRecord): Promise<void> {
    const current = await this.read(intent.id);
    if (JSON.stringify(current) !== JSON.stringify(intent) || intent.state !== 'COMMITTING')
      throw new BrowserError('EFFECT_UNKNOWN', 'The private stage changed during reconciliation.');
    const {expectedLocalRevision: _expected, ...retained} = intent;
    await this.persist({...retained, state: 'OPEN'});
  }

  private async persist(row: StageRecord): Promise<void> {
    const key = this.key(row.id);
    try { await this.store.set(key, row); }
    catch { /* Read back an acknowledgement loss by exact record. */ }
    if (JSON.stringify(await this.store.get(key)) !== JSON.stringify(row))
      throw new BrowserError('EFFECT_UNKNOWN', 'The private stage receipt could not be verified.');
  }
}
