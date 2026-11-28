import { validGeneration } from '../../../packages/contracts/src/target.js';
import {
  BrowserError, base64ToBytes, bytesToBase64, canonicalPath, digest, snapshotRevision, utf8,
  type KeyValueStore, type NativeIdentity,
} from './native-types.js';
import type { BindingStorageIdentity } from './binding-storage.js';

export type RestoreMode = 'exact-binding' | 'source-only';
export interface RestoreIntent { mode: RestoreMode; archiveSha256: string; expectedRevision: string }
export interface RestorePreview extends RestoreIntent { fileCount: number }

interface ArchiveData {
  version: 2;
  identity: NativeIdentity;
  scope: BindingStorageIdentity | null;
  revision: string;
  files: Record<string, string>;
}
export interface SourceArchive extends ArchiveData { sha256: string; proof?: string }
const sha256 = /^[a-f0-9]{64}$/;
const opaque = /^[A-Za-z0-9_-]{1,128}$/;
const maxBytes = 64 * 1024 * 1024;
const maxFileBytes = 16 * 1024 * 1024;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BrowserError('INVALID_INPUT', 'Expected a source backup object.');
  return value as Record<string, unknown>;
}

function readIdentity(input: unknown): NativeIdentity {
  const value = record(input);
  const { generatorId, slug, draftId, publicId } = value;
  if (typeof generatorId !== 'string' || !generatorId || generatorId.length > 512 ||
      typeof slug !== 'string' || !slug || slug.length > 512 ||
      typeof draftId !== 'string' || draftId.length > 512 ||
      (publicId !== undefined && (typeof publicId !== 'string' || publicId.length > 512)))
    throw new BrowserError('INVALID_INPUT', 'Backup native identity is malformed.');
  // Preserve the identity field order used by the canonical SourceRevision.
  return input as NativeIdentity;
}

function readScope(input: unknown, identity: NativeIdentity): BindingStorageIdentity | null {
  if (input === null) return null;
  const { installationId, workspaceId, assignmentGeneration, bindingGeneration, epoch, generatorId, draftId } = record(input);
  if (typeof installationId !== 'string' || !opaque.test(installationId) ||
      typeof workspaceId !== 'string' || !opaque.test(workspaceId) ||
      !validGeneration(assignmentGeneration) || !validGeneration(bindingGeneration) ||
      !validGeneration(epoch) || epoch < 1 || generatorId !== identity.generatorId || draftId !== identity.draftId)
    throw new BrowserError('BINDING_MISMATCH', 'Backup Assignment, Binding or Epoch is malformed.');
  return { installationId, workspaceId, assignmentGeneration, bindingGeneration, epoch,
    generatorId: identity.generatorId, draftId: identity.draftId };
}

export function sameBackupBinding(a: BindingStorageIdentity, b: BindingStorageIdentity): boolean {
  return a.installationId === b.installationId && a.workspaceId === b.workspaceId &&
    a.assignmentGeneration === b.assignmentGeneration && a.bindingGeneration === b.bindingGeneration &&
    a.generatorId === b.generatorId && a.draftId === b.draftId;
}

async function signingKey(store: KeyValueStore, installationId: string, create: boolean): Promise<CryptoKey | undefined> {
  const name = 'perch:backup-signing-key:' + installationId;
  let encoded = await store.get<string>(name);
  if (encoded === undefined && create) {
    try {
      await store.set(name, bytesToBase64(crypto.getRandomValues(new Uint8Array(32))));
    } catch {
      // A lost acknowledgement may leave the key durably stored.
    }
    encoded = await store.get<string>(name);
  }
  if (encoded === undefined) return undefined;
  if (typeof encoded !== 'string' || encoded.length !== 44)
    throw new BrowserError('STORAGE_CORRUPT', 'Local backup signing key is malformed.');
  const bytes = base64ToBytes(encoded);
  if (bytes.length !== 32 || bytesToBase64(bytes) !== encoded)
    throw new BrowserError('STORAGE_CORRUPT', 'Local backup signing key is malformed.');
  return crypto.subtle.importKey('raw', new Uint8Array(bytes), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

function archiveDigest(archive: ArchiveData): Promise<string> {
  return digest(JSON.stringify([archive.version, archive.scope, archive.identity, archive.revision,
    Object.entries(archive.files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)]));
}

export async function createSourceArchive(store: KeyValueStore, identity: NativeIdentity, revision: string,
  files: Record<string, string>, scope: BindingStorageIdentity | null): Promise<SourceArchive> {
  const archive = { version: 2 as const, identity, revision, files, scope: readScope(scope, identity) };
  const sha256 = await archiveDigest(archive);
  if (!scope) return { ...archive, sha256 };
  const key = await signingKey(store, scope.installationId, true);
  if (!key) throw new BrowserError('STORAGE_CORRUPT', 'The local backup signing key could not be verified.');
  const signature = await crypto.subtle.sign('HMAC', key, utf8.encode(sha256));
  return { ...archive, sha256, proof: bytesToBase64(new Uint8Array(signature)) };
}

export async function inspectSourceArchive(store: KeyValueStore, input: unknown, mode: RestoreMode,
  currentScope?: BindingStorageIdentity): Promise<{ archiveSha256: string; files: Record<string, Uint8Array> }> {
  if (mode !== 'exact-binding' && mode !== 'source-only')
    throw new BrowserError('INVALID_INPUT', 'Choose an explicit source restore mode.');
  const value = record(input);
  const identity = readIdentity(value.identity);
  const files = record(value.files);
  const entries = Object.entries(files);
  if (entries.length > 1000 || typeof value.sha256 !== 'string' || !sha256.test(value.sha256))
    throw new BrowserError('LIMIT_EXCEEDED', 'Backup exceeds the accepted manifest shape.');
  const restored: Record<string, Uint8Array> = Object.create(null);
  let bytes = 0;
  for (const [path, encoded] of entries) {
    canonicalPath(path);
    if (typeof encoded !== 'string' || encoded.length > 4 * Math.ceil(maxFileBytes / 3))
      throw new BrowserError('LIMIT_EXCEEDED', 'Backup file exceeds the 16 MiB encoded-byte limit.');
    const content = base64ToBytes(encoded);
    bytes += content.length;
    if (content.length > maxFileBytes || bytes > maxBytes || bytesToBase64(content) !== encoded)
      throw new BrowserError('INVALID_INPUT', 'Backup contains malformed or oversized file data.');
    restored[path] = content;
  }
  if (!restored['main.pjs'] || !restored['index.html'])
    throw new BrowserError('INVALID_INPUT', 'A source backup requires both native panels.');
  const revision = value.revision;
  if (typeof revision !== 'string' || !/^(?:\d+:)?[a-f0-9]{64}$/.test(revision) ||
      await snapshotRevision(identity, restored) !== revision.split(':').at(-1))
    throw new BrowserError('INVALID_INPUT', 'Backup file contents differ from its recorded revision.');

  if (value.version === 1) {
    if (mode !== 'source-only')
      throw new BrowserError('BINDING_MISMATCH', 'Legacy backups lack private Binding provenance. Select source-only import.');
    if (await digest(JSON.stringify(files)) !== value.sha256)
      throw new BrowserError('INVALID_INPUT', 'Backup manifest digest differs.');
  } else if (value.version === 2) {
    const archiveScope = readScope(value.scope, identity);
    const fields = { version: 2 as const, identity, scope: archiveScope, revision, files: files as Record<string, string> };
    if (await archiveDigest(fields) !== value.sha256)
      throw new BrowserError('INVALID_INPUT', 'Backup manifest digest differs.');
    if (mode === 'exact-binding') {
      if (!archiveScope || !currentScope || !sameBackupBinding(archiveScope, currentScope) ||
          typeof value.proof !== 'string' || value.proof.length !== 44)
        throw new BrowserError('BINDING_MISMATCH', 'The backup was not exported from this exact Assignment and Binding.');
      const key = await signingKey(store, currentScope.installationId, false);
      const signature = base64ToBytes(value.proof);
      if (!key || signature.length !== 32 || bytesToBase64(signature) !== value.proof ||
          !await crypto.subtle.verify('HMAC', key, new Uint8Array(signature), utf8.encode(value.sha256)))
        throw new BrowserError('BINDING_MISMATCH', 'Local backup provenance could not be authenticated.');
    }
  } else {
    throw new BrowserError('INCOMPATIBLE_VERSION', 'Unknown source backup version.');
  }

  // Import caches only accept their internal verified public fetch publisher.
  for (const path of Object.keys(restored)) {
    if (path.startsWith('imports/') || (mode === 'source-only' && path.startsWith('scratch/')))
      delete restored[path];
  }
  return { archiveSha256: value.sha256, files: restored };
}
