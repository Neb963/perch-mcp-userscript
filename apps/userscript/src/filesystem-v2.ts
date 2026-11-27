import { filesystemV2Schemas, type FilesystemArgs, type FilesystemToolV2 } from '../../../packages/contracts/src/filesystem-v2.js';
import { BrowserError, base64ToBytes, bytesToBase64, canonicalPath, digest, equalBytes, utf8,
  type FileWrite } from './native-types.js';
import type { VirtualFileSystem } from './vfs.js';

type Preconditions = { expectedSourceRevision?: string; expectedLocalRevision?: string };
interface FileCondition { ifSha256?: string; ifAbsent?: true }
interface Metadata {path: string; bytes: number | null; sha256: string | null}
export interface FilesystemCallScope {
  target: string;
  grantId: string;
  operationId: string;
  assertCurrent: () => void | Promise<void>;
  authorizePublication: (value: {digest: string; paths: string[]; expectedSourceRevision?: string;
    expectedLocalRevision?: string}) => Promise<void>;
}
interface Transfer extends Preconditions, FileCondition {
  target: string;
  grantId: string;
  path: string;
  encoding: 'utf8' | 'base64';
  totalBytes: number;
  sha256: string;
  expiresAt: number;
  cursor: number;
  state: 'OPEN' | 'COMMITTING' | 'COMMITTED' | 'ABORTED';
  chunks: {offset: number; bytes: number; sha256: string}[];
  result?: unknown;
}
const maxFileBytes = 16 * 1024 * 1024;
const chunkBytes = 192 * 1024;
const inlineBudget = 131_072;
const nativePath = (path: string) => !path.startsWith('scratch/') && !path.startsWith('imports/');
const lexical = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const stringByteLength = (value: unknown) => utf8.encode(JSON.stringify(value)).length;

function requireDistinctPaths(paths: readonly string[]) {
  const seen = new Set<string>();
  for (const path of paths) {
    const key = canonicalPath(path).toLowerCase();
    if (seen.has(key)) throw new BrowserError('PATH_DENIED', 'Duplicate or case-colliding path.');
    seen.add(key);
  }
}
function requireNoPrefixConflicts(paths: readonly string[]) {
  requireDistinctPaths(paths);
  const keys = new Set(paths.map(path => path.toLowerCase()));
  for (const key of keys) {
    const parts = key.split('/');
    for (let i = 2; i < parts.length; i++) {
      if (keys.has(parts.slice(0, i).join('/')))
        throw new BrowserError('PATH_DENIED', 'File and directory paths overlap.');
    }
  }
}
function text(bytes: Uint8Array) {
  try { return new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes); }
  catch { throw new BrowserError('BINARY_FILE', 'Selected bytes are not complete UTF-8 text. Use base64.'); }
}
function contentBytes(input: string, encoding: 'utf8' | 'base64'): Uint8Array {
  if (encoding === 'utf8') {
    if (/[\uD800-\uDFFF]/u.test(input)) throw new BrowserError('INVALID_INPUT', 'Text contains unpaired Unicode surrogates.');
    return utf8.encode(input);
  }
  const decoded = base64ToBytes(input);
  if (bytesToBase64(decoded) !== input) throw new BrowserError('INVALID_INPUT', 'Noncanonical base64.');
  return decoded;
}
function lineOffsets(input: Uint8Array, start: number, count: number): [number, number] {
  let line = 1;
  let from = start === 1 ? 0 : -1;
  for (let i = 0; i < input.length; i++) {
    if (input[i] !== 10) continue;
    line++;
    if (line === start) from = i + 1;
    if (line === start + count && from >= 0) return [from, i + 1];
  }
  if (from < 0) throw new BrowserError('INVALID_INPUT', 'Line range starts beyond the file.');
  return [from, input.length];
}
type ReadItem = FilesystemArgs<'read'>['files'][number];
async function fileResult(item: ReadItem, bytes: Uint8Array, available: number) {
  const sha256 = await digest(bytes);
  if (item.ifSha256 && item.ifSha256 !== sha256) throw new BrowserError('STALE_REVISION', 'Selected file digest changed.');
  const encoding = item.encoding ?? 'utf8';
  let offset = 0, end = bytes.length;
  if (item.range?.unit === 'bytes') {
    offset = item.range.offset;
    end = Math.min(bytes.length, offset + item.range.length);
    if (offset > bytes.length) throw new BrowserError('INVALID_INPUT', 'Byte range starts beyond the file.');
  } else if (item.range) [offset, end] = lineOffsets(bytes, item.range.start, item.range.count);
  if (encoding === 'utf8') text(bytes); // An invalid file cannot be projected as text by slicing around corruption.
  let returnedEnd = Math.min(end, offset + Math.max(1, Math.floor(available / (encoding === 'base64' ? 2 : 6))));
  if (encoding === 'utf8' && returnedEnd < end)
    while (returnedEnd > offset && (bytes[returnedEnd]! & 0xc0) === 0x80) returnedEnd--;
  if (returnedEnd === offset && end > offset) throw new BrowserError('LIMIT_EXCEEDED', 'Text character does not fit in this page.');
  const selected = bytes.subarray(offset, returnedEnd);
  return {path: item.path, encoding, sha256, totalBytes: bytes.length, returnedBytes: selected.length,
    offset, content: encoding === 'base64' ? bytesToBase64(selected) : text(selected),
    next: returnedEnd < bytes.length ? {unit: 'bytes' as const, offset: returnedEnd,
      length: Math.min(chunkBytes, bytes.length - returnedEnd), ifSha256: sha256} : null};
}

export class FilesystemV2 {
  constructor(readonly vfs: VirtualFileSystem) {}
  async run(name: FilesystemToolV2, raw: unknown, scope: FilesystemCallScope): Promise<unknown> {
    await scope.assertCurrent();
    const parsed = filesystemV2Schemas[name].safeParse(raw);
    if (!parsed.success) throw new BrowserError('INVALID_INPUT', 'Invalid filesystem arguments.');
    switch (name) {
      case 'read': return this.read(parsed.data as FilesystemArgs<'read'>, scope);
      case 'list_files': return this.list(parsed.data as FilesystemArgs<'list_files'>, scope);
      case 'write': {
        const args = parsed.data as FilesystemArgs<'write'>;
        if (!('files' in args)) return this.transfer(args, scope);
        return this.mutate('write', args, scope);
      }
      case 'delete': return this.mutate('delete', parsed.data as FilesystemArgs<'delete'>, scope);
      case 'rename': return this.mutate('rename', parsed.data as FilesystemArgs<'rename'>, scope);
    }
  }
  async read(args: FilesystemArgs<'read'>, scope: FilesystemCallScope) {
    requireDistinctPaths(args.files.map(file => file.path));
    const nativePaths = args.files.filter(file => nativePath(file.path)).map(file => file.path);
    const local = await this.vfs.localView();
    if (args.expectedLocalRevision && local.revision.value !== args.expectedLocalRevision)
      throw new BrowserError('STALE_REVISION', 'Private file revision changed.');
    const full = args.expectedSourceRevision ? await this.vfs.adapter.snapshot() : null;
    if (full && args.expectedSourceRevision !== full.revision)
      throw new BrowserError('STALE_REVISION', 'Native source revision changed.');
    const native = full ? new Map(Object.entries(full.files)) :
      nativePaths.length ? await this.vfs.adapter.readSelectedSource(nativePaths) : new Map();
    const files = [];
    for (const item of args.files) {
      try {
        const bytes = nativePath(item.path) ? native.get(item.path) : await local.read(item.path);
        if (!bytes) throw new BrowserError('FILE_NOT_FOUND', 'Selected file does not exist.');
        files.push(await fileResult(item, bytes, Math.floor(inlineBudget / args.files.length)));
      } catch (error) {
        if (!(error instanceof BrowserError) || error.code === 'STALE_EPOCH' || error.code === 'BINDING_MISMATCH') throw error;
        files.push({path: item.path, error: {code: error.code, message: error.message}});
      }
    }
    await scope.assertCurrent();
    return {files, sourceRevision: {value: full?.revision ?? null, verified: !!full},
      localRevision: local.revision};
  }
  async list(args: FilesystemArgs<'list_files'>, scope: FilesystemCallScope) {
    const local = await this.vfs.localView();
    const dirs = args.directories?.length ? args.directories : [''];
    const filter = args.filter ? new RegExp('^' + args.filter.replace(/[.]/g, '\\.').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '$') : null;
    const rows: Metadata[] = [...await this.vfs.adapter.listSourceMetadata(), ...local.files];
    rows.sort((a, b) => lexical(a.path, b.path));
    const {cursor, ...query} = args;
    const fingerprint = await digest(JSON.stringify([scope.target, query, rows, local.revision.value]));
    let last = '';
    if (cursor) {
      const separator = cursor.indexOf('|');
      if (separator < 1 || cursor.slice(0, separator) !== fingerprint)
        throw new BrowserError('STALE_REVISION', 'File manifest or listing query changed. Restart the listing.');
      last = canonicalPath(cursor.slice(separator + 1));
      if (!rows.some(row => row.path === last))
        throw new BrowserError('STALE_REVISION', 'Listing cursor no longer identifies a file.');
    }
    const selected = rows.filter(row => {
      if (row.path <= last || args.prefix && !row.path.startsWith(args.prefix) || filter && !filter.test(row.path)) return false;
      if (args.extensions?.length && !args.extensions.includes(row.path.split('.').at(-1) ?? '')) return false;
      return dirs.some(dir => {
        if (dir === row.path) return true;
        const prefix = dir ? dir + '/' : '';
        if (!row.path.startsWith(prefix)) return false;
        return args.recursive === true || !row.path.slice(prefix.length).includes('/');
      });
    });
    const limit = args.limit ?? 100;
    const files = selected.slice(0, limit);
    await scope.assertCurrent();
    return {files, namespaces: ['src', 'scratch', 'imports'], sourceRevision: {value: null, verified: false},
      localRevision: local.revision, nextCursor: selected.length > limit ? fingerprint + '|' + files.at(-1)!.path : null};
  }
  async publishWrites(args: Parameters<FilesystemV2['mutate']>[1], scope: FilesystemCallScope) {
    return this.mutate('write', args, scope);
  }
  private async mutate(name: 'write' | 'delete' | 'rename',
    args: (Preconditions & {files: Array<FileCondition & {path: string; encoding: 'utf8' | 'base64'; content: string}>}) |
      FilesystemArgs<'delete'> | FilesystemArgs<'rename'>, scope: FilesystemCallScope) {
    const paths = 'files' in args ? args.files.map(file => file.path) :
      'paths' in args ? args.paths.map(item => item.path) : args.moves.flatMap(move => [move.from, move.to]);
    requireDistinctPaths(paths);
    const native = paths.some(nativePath);
    const local = await this.vfs.localView();
    const before = native || args.expectedSourceRevision ? await this.vfs.snapshot() : null;
    if (args.expectedSourceRevision && args.expectedSourceRevision !== before?.nativeRevision)
      throw new BrowserError('STALE_REVISION', 'Native source revision changed.');
    if (args.expectedLocalRevision && args.expectedLocalRevision !== local.revision.value)
      throw new BrowserError('STALE_REVISION', 'Private file revision changed.');
    const current = async (path: string) => {
      if (nativePath(path)) return before?.files[path];
      if (!local.files.some(file => file.path === path)) return undefined;
      return local.read(path);
    };
    const expect = async (path: string, condition: FileCondition, allowCreate: boolean) => {
      const bytes = await current(path);
      const revisionSupplied = nativePath(path) ? args.expectedSourceRevision : args.expectedLocalRevision;
      if (condition.ifAbsent && condition.ifSha256)
        throw new BrowserError('INVALID_INPUT', 'A file cannot require both absence and an existing digest.');
      if (condition.ifAbsent) {
        if (!allowCreate || bytes) throw new BrowserError('STALE_REVISION', 'Expected an absent file.');
      } else if (condition.ifSha256) {
        if (!bytes || await digest(bytes) !== condition.ifSha256)
          throw new BrowserError('STALE_REVISION', 'Current file digest does not match.');
      } else if (!revisionSupplied || !bytes) {
        throw new BrowserError('INVALID_INPUT', 'A matching file digest, verified revision or explicit absence is required.');
      }
      return bytes;
    };
    const writes: FileWrite[] = [];
    if ('files' in args) {
      for (const file of args.files) {
        await expect(file.path, file, true);
        const bytes = contentBytes(file.content, file.encoding);
        if (bytes.length > maxFileBytes) throw new BrowserError('LIMIT_EXCEEDED', 'File exceeds 16 MiB.');
        if (file.path === 'main.pjs' || file.path === 'index.html') text(bytes);
        writes.push({path: file.path, bytes});
      }
    } else if ('paths' in args) {
      for (const item of args.paths) {
        await expect(item.path, item, false);
        writes.push({path: item.path, bytes: null});
      }
    } else {
      for (const move of args.moves) {
        if (move.from.split('/')[0] !== move.to.split('/')[0] ||
            move.to.toLowerCase().startsWith(move.from.toLowerCase() + '/') ||
            move.from.toLowerCase().startsWith(move.to.toLowerCase() + '/'))
          throw new BrowserError('PATH_DENIED', 'Rename must stay within one writable namespace.');
        const bytes = await expect(move.from, move, false);
        if (await current(move.to)) throw new BrowserError('STALE_REVISION', 'Rename destination already exists.');
        writes.push({path: move.to, bytes: bytes!}, {path: move.from, bytes: null});
      }
    }
    const complete = new Set([...Object.keys(before?.files ?? {}), ...local.files.map(file => file.path)]);
    for (const write of writes) {
      if (write.bytes === null) complete.delete(write.path);
      else complete.add(write.path);
    }
    requireNoPrefixConflicts([...complete]);
    const writeDigests = await Promise.all(writes.map(async write => [write.path, write.bytes === null ? null : await digest(write.bytes)]));
    const writeSetDigest = await digest(JSON.stringify([name, before?.nativeRevision ?? null, local.revision.value, writeDigests]));
    await scope.authorizePublication({digest: writeSetDigest, paths: writes.map(write => write.path),
      expectedSourceRevision: before?.nativeRevision, expectedLocalRevision: local.revision.value});
    await scope.assertCurrent();
    if (!native) {
      const localRevision = await this.vfs.writeLocalBatch(writes, local.revision.value, scope.operationId);
      return {status: 'SUCCEEDED', committed: writes.map(write => write.path), localRevision};
    }
    return this.vfs.writeBatch(writes, before!.revision, scope.operationId);
  }
  private async transfer(args: Exclude<FilesystemArgs<'write'>, {mode?: 'inline'}>, scope: FilesystemCallScope) {
    const namespace = this.vfs.scope;
    if (!namespace) throw new BrowserError('INCOMPATIBLE_VERSION', 'Transfer requires versioned Binding storage.');
    const prefix = namespace.epochPrefix + ':transfer:';
    const store = this.vfs.store;
    if (args.mode === 'start') {
      const keys = (await store.list()).filter(key => key.startsWith(prefix) && key.endsWith(':meta'));
      if (keys.length > 128) throw new BrowserError('QUOTA_EXCEEDED', 'Retained transfer records require cleanup.');
      const stages = [];
      let cleanupBudget = 32;
      for (const key of keys) {
        const stage = await store.get<Transfer>(key);
        if (!stage || !Array.isArray(stage.chunks) || stage.chunks.length > Math.ceil(maxFileBytes / chunkBytes))
          throw new BrowserError('STORAGE_CORRUPT', 'Transfer staging metadata is malformed.');
        if (stage.state !== 'COMMITTING' && stage.expiresAt <= Date.now() && cleanupBudget > 0) {
          const stem = key.slice(0, -5);
          const removeCount = Math.min(cleanupBudget, stage.chunks.length);
          for (const chunk of stage.chunks.slice(0, removeCount)) {
            await scope.assertCurrent();
            await store.delete(stem + ':chunk:' + chunk.offset);
            cleanupBudget--;
          }
          const remaining = stage.chunks.slice(removeCount);
          if (remaining.length) await store.set(key, {...stage, chunks: remaining});
          else await store.delete(key);
        } else {
          stages.push(stage);
        }
      }
      const open = stages.filter(stage => stage.state === 'COMMITTING' || stage.state === 'OPEN' && stage.expiresAt > Date.now());
      if (open.length >= 2 || open.reduce((sum, stage) => sum + stage.totalBytes, 0) + args.totalBytes > 32 * 1024 * 1024)
        throw new BrowserError('QUOTA_EXCEEDED', 'Binding transfer capacity is exhausted.');
      if (args.ifAbsent && args.ifSha256 || !args.ifAbsent && !args.ifSha256 &&
          (nativePath(args.path) ? !args.expectedSourceRevision : !args.expectedLocalRevision))
        throw new BrowserError('INVALID_INPUT', 'Supply the destination precondition at transfer start.');
      const id = crypto.randomUUID();
      const stage: Transfer = {...args, target: scope.target, grantId: scope.grantId,
        cursor: 0, state: 'OPEN', expiresAt: Date.now() + 600_000, chunks: []};
      await scope.assertCurrent();
      await store.set(prefix + id + ':meta', stage);
      return {transferId: id, offset: 0, expiresAt: stage.expiresAt};
    }
    const key = prefix + args.transferId + ':meta';
    const stage = await store.get<Transfer>(key);
    if (!stage || stage.target !== scope.target || stage.grantId !== scope.grantId)
      throw new BrowserError('NOT_FOUND', 'Transfer is unavailable in this operation scope.');
    if (stage.state === 'COMMITTING') throw new BrowserError('EFFECT_UNKNOWN', 'Transfer commit requires reconciliation.');
    if (stage.state === 'COMMITTED' && args.mode === 'commit') return stage.result;
    if (stage.state === 'ABORTED' && args.mode === 'abort') return {aborted: true};
    if (stage.state !== 'OPEN' || stage.expiresAt <= Date.now())
      throw new BrowserError('RESULT_EXPIRED', 'Transfer is closed or expired.');
    if (args.mode === 'abort') {
      await scope.assertCurrent();
      await store.set(key, {...stage, state: 'ABORTED'});
      return {aborted: true};
    }
    if (args.mode === 'chunk') {
      const bytes = contentBytes(args.data, 'base64');
      const sha256 = await digest(bytes);
      const current = stage.chunks.find(chunk => chunk.offset === args.offset);
      if (current && current.bytes === bytes.length && current.sha256 === sha256 &&
          await store.get(prefix + args.transferId + ':chunk:' + args.offset) === args.data) return {offset: stage.cursor};
      if (args.offset !== stage.cursor || bytes.length > chunkBytes || stage.cursor + bytes.length > stage.totalBytes ||
          (stage.cursor + bytes.length !== stage.totalBytes && bytes.length !== chunkBytes))
        throw new BrowserError('INVALID_INPUT', 'Unexpected transfer offset or chunk length.');
      await scope.assertCurrent();
      const chunkKey = prefix + args.transferId + ':chunk:' + args.offset;
      await this.vfs.assertLocalRoom(args.data.length + chunkKey.length + 256);
      await scope.assertCurrent();
      await store.set(chunkKey, args.data);
      if (await store.get(chunkKey) !== args.data) throw new BrowserError('STORAGE_CORRUPT', 'Transfer chunk readback differs.');
      stage.cursor += bytes.length;
      stage.chunks.push({offset: args.offset, bytes: bytes.length, sha256});
      await store.set(key, stage);
      return {offset: stage.cursor};
    }
    if (stage.cursor !== stage.totalBytes || stage.chunks.length > Math.ceil(maxFileBytes / chunkBytes))
      throw new BrowserError('INVALID_INPUT', 'Transfer is incomplete.');
    const bytes = new Uint8Array(stage.totalBytes);
    let offset = 0;
    for (const chunk of stage.chunks) {
      const raw = await store.get<string>(prefix + args.transferId + ':chunk:' + chunk.offset);
      if (!raw || offset !== chunk.offset) throw new BrowserError('STORAGE_CORRUPT', 'Transfer chunk is missing.');
      const data = contentBytes(raw, 'base64');
      if (data.length !== chunk.bytes || await digest(data) !== chunk.sha256)
        throw new BrowserError('STORAGE_CORRUPT', 'Transfer chunk content differs.');
      bytes.set(data, offset);
      offset += data.length;
    }
    if (offset !== bytes.length || await digest(bytes) !== stage.sha256)
      throw new BrowserError('STORAGE_CORRUPT', 'Transfer file content differs from the declared digest.');
    const content = stage.encoding === 'base64' ? bytesToBase64(bytes) : text(bytes);
    await scope.assertCurrent();
    await store.set(key, {...stage, state: 'COMMITTING'});
    const result = await this.mutate('write', {expectedSourceRevision: stage.expectedSourceRevision,
      expectedLocalRevision: stage.expectedLocalRevision, files: [{path: stage.path, encoding: stage.encoding,
        content, ifAbsent: stage.ifAbsent, ifSha256: stage.ifSha256}]}, scope);
    await store.set(key, {...stage, state: 'COMMITTED', result});
    return result;
  }
}
