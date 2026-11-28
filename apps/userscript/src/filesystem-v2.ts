import { filesystemV2Schemas, type FilesystemArgs, type FilesystemToolV2 } from '../../../packages/contracts/src/filesystem-v2.js';
import { BrowserError, base64ToBytes, bytesToBase64, canonicalPath, digest, equalBytes, utf8,
  type FileWrite } from './native-types.js';
import type { VirtualFileSystem, WorkspaceSnapshot } from './vfs.js';

type Preconditions = { expectedSourceRevision?: string; expectedLocalRevision?: string };
interface FileCondition { ifSha256?: string; ifAbsent?: true }
type MutationName='write'|'delete'|'rename';
type MutationArgs=(Preconditions & {files: Array<FileCondition & {path:string;encoding:'utf8'|'base64';content:string}>}) |
  FilesystemArgs<'delete'> | FilesystemArgs<'rename'>;
type MutationAction={tool:MutationName;args:MutationArgs & {base?:'previous'}};
interface MutationStage {
  nativeBefore: WorkspaceSnapshot | null;
  local: Awaited<ReturnType<VirtualFileSystem['localView']>>;
  changes: Map<string,FileWrite>;
}
const actionPaths=(args:MutationArgs):string[]=>'files' in args ? args.files.map(file=>file.path) :
  'paths' in args ? args.paths.map(item=>item.path) : args.moves.flatMap(move=>[move.from,move.to]);
interface Metadata {path: string; bytes: number | null; sha256: string | null}
export interface FilesystemCallScope {
  target: string;
  grantId: string;
  operationId: string;
  operationKey?: string;
  transferRecoveryOnly?: true;
  assertCurrent: () => void | Promise<void>;
  beforePublication?: () => Promise<void>;
  authorizePublication: (value: {digest: string; paths: string[]; expectedSourceRevision?: string;
    expectedLocalRevision?: string}) => Promise<void>;
}
type TransferState = 'OPEN' | 'VERIFYING' | 'DISPATCHED' | 'COMMITTED' | 'REJECTED' | 'HOLD' | 'ABORTED';
interface TransferOperation {
  operationId: string;
  operationKey: string | null;
}
interface Transfer extends Preconditions, FileCondition {
  version?: 2;
  transitionId?: string;
  target: string;
  grantId: string;
  path: string;
  encoding: 'utf8' | 'base64';
  totalBytes: number;
  sha256: string;
  expiresAt: number;
  cursor: number;
  state: TransferState | 'COMMITTING';
  chunks: {offset: number; bytes: number; sha256: string}[];
  retainUntil?: number;
  retentionSettled?: boolean;
  start?: TransferOperation & {digest: string};
  commit?: TransferOperation;
  result?: Record<string, unknown>;
  rejection?: {code: string; message: string};
}
type TransferCall = Exclude<FilesystemArgs<'write'>, {mode?: 'inline'}>;
const transferTail = new WeakMap<VirtualFileSystem, Promise<unknown>>();
const transferLifetime = 600_000;
const transferStates: ReadonlySet<string> = new Set<TransferState | 'COMMITTING'>(
  ['OPEN', 'VERIFYING', 'DISPATCHED', 'COMMITTED', 'REJECTED', 'HOLD', 'ABORTED', 'COMMITTING']);
const maxFileBytes = 16 * 1024 * 1024;
const chunkBytes = 192 * 1024;
const inlineBudget = 131_072;
const nativePath = (path: string) => !path.startsWith('scratch/') && !path.startsWith('imports/');
const lexical = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const stringByteLength = (value: unknown) => utf8.encode(JSON.stringify(value)).length;

function transferState(stage: Transfer): TransferState {
  if (stage.state === 'COMMITTING' ||
      stage.state === 'COMMITTED' && stage.result?.status !== 'SUCCEEDED') return 'HOLD';
  return stage.state;
}

function transferOperation(scope: FilesystemCallScope): TransferOperation {
  return {operationId: scope.operationId, operationKey: scope.operationKey ?? null};
}

function checkTransfer(stage: Transfer | undefined): Transfer {
  if (!stage || (stage.version !== undefined && stage.version !== 2) || !transferStates.has(stage.state) ||
      typeof stage.target !== 'string' || typeof stage.grantId !== 'string' || typeof stage.path !== 'string' ||
      canonicalPath(stage.path) !== stage.path || stage.path.startsWith('imports/') ||
      !['utf8', 'base64'].includes(stage.encoding) || !/^[a-f0-9]{64}$/.test(stage.sha256) ||
      !Number.isSafeInteger(stage.totalBytes) || stage.totalBytes < 0 || stage.totalBytes > maxFileBytes ||
      !Number.isSafeInteger(stage.cursor) || stage.cursor < 0 || stage.cursor > stage.totalBytes ||
      !Number.isSafeInteger(stage.expiresAt) || stage.expiresAt < 0 || !Array.isArray(stage.chunks) ||
      stage.chunks.length > Math.ceil(maxFileBytes / chunkBytes))
    throw new BrowserError('STORAGE_CORRUPT', 'Transfer staging metadata is malformed.');
  if (stage.retainUntil !== undefined && (!Number.isSafeInteger(stage.retainUntil) || stage.retainUntil < stage.expiresAt))
    throw new BrowserError('STORAGE_CORRUPT', 'Transfer retention metadata is malformed.');
  if (stage.result !== undefined && (!stage.result || typeof stage.result !== 'object' || Array.isArray(stage.result) ||
      !['SUCCEEDED', 'PARTIAL', 'UNKNOWN'].includes(String(stage.result.status)) || stringByteLength(stage.result) > 16_384))
    throw new BrowserError('STORAGE_CORRUPT', 'Transfer receipt metadata is malformed.');
  for (const chunk of stage.chunks) {
    if (!chunk || !Number.isSafeInteger(chunk.offset) || chunk.offset < 0 || chunk.offset % chunkBytes !== 0 ||
        !Number.isSafeInteger(chunk.bytes) || chunk.bytes < 1 || chunk.bytes > chunkBytes ||
        chunk.offset + chunk.bytes > stage.totalBytes || !/^[a-f0-9]{64}$/.test(chunk.sha256))
      throw new BrowserError('STORAGE_CORRUPT', 'Transfer staging chunk reference is malformed.');
  }
  return stage;
}

function holdResult(stage: Transfer, transferId: string): Record<string, unknown> {
  return {...stage.result, status: stage.result?.status === 'PARTIAL' ? 'PARTIAL' : 'UNKNOWN',
    transferState: 'HOLD', transferId,
    commitOperationId: stage.commit?.operationId ?? null, commitOperationKey: stage.commit?.operationKey ?? null};
}

function commitReceipt(stage: Transfer, transferId: string, result: Record<string, unknown>) {
  return {...result, transferId, commitOperationId: stage.commit?.operationId ?? null,
    commitOperationKey: stage.commit?.operationKey ?? null};
}

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
  async publishWrites(args: MutationArgs, scope: FilesystemCallScope) {
    return this.mutate('write', args, scope);
  }
  async publishCoherent(actions: readonly MutationAction[], scope: FilesystemCallScope,
    recordStaged: (offset: number, paths: string[]) => Promise<void>) {
    const native = actions.some(({args}) => args.expectedSourceRevision || actionPaths(args).some(nativePath));
    const stagedPaths: string[][] = [];
    let offset = 0;
    let stage: MutationStage;
    try {
      await scope.assertCurrent();
      const local = await this.vfs.localView();
      stage = {nativeBefore: native ? await this.vfs.snapshot() : null, local, changes: new Map()};
      for (const step of actions) {
        await scope.assertCurrent();
        const {base, ...rest} = step.args;
        if (base && stage.changes.size === 0) throw new BrowserError('INVALID_INPUT', 'Previous mutation state is unavailable.');
        const args = base ? {...rest, expectedSourceRevision: stage.nativeBefore?.nativeRevision,
          expectedLocalRevision: local.revision.value} as MutationArgs : rest as MutationArgs;
        await this.mutate(step.tool, args, scope, stage);
        const paths = actionPaths(args);
        await recordStaged(offset, paths);
        stagedPaths.push(paths);
        offset++;
      }
    } catch (error) {
      return {kind: 'staging-failed' as const, stagedPaths, failedOffset: offset, error};
    }
    const finalWrites = [...stage.changes.values()].filter(write => write.bytes !== null ||
      (nativePath(write.path) ? Object.hasOwn(stage.nativeBefore?.files ?? {}, write.path)
        : stage.local.files.some(file => file.path === write.path)));
    const finalPaths = finalWrites.map(write => write.path);
    const written = finalWrites.filter(write => write.bytes !== null);
    const removed = finalWrites.filter(write => write.bytes === null);
    try {
      const result = written.length || removed.length
        ? await this.publishPlan('batch', [...written, ...removed], stage.nativeBefore, stage.local.revision.value, scope)
        : {status:'SUCCEEDED' as const, committed:[]};
      return {kind: 'published' as const, result, stagedPaths, finalPaths};
    } catch (error) {
      return {kind: 'publication-failed' as const, stagedPaths, finalPaths, error};
    }
  }
  private async mutate(name: MutationName, args: MutationArgs, scope: FilesystemCallScope, stage?: MutationStage) {
    const paths=actionPaths(args);
    requireDistinctPaths(paths);
    const native = paths.some(nativePath);
    const local = stage?.local ?? await this.vfs.localView();
    const before = stage ? stage.nativeBefore : native || args.expectedSourceRevision ? await this.vfs.snapshot() : null;
    if (args.expectedSourceRevision && args.expectedSourceRevision !== before?.nativeRevision)
      throw new BrowserError('STALE_REVISION', 'Native source revision changed.');
    if (args.expectedLocalRevision && args.expectedLocalRevision !== local.revision.value)
      throw new BrowserError('STALE_REVISION', 'Private file revision changed.');
    const current = async (path: string) => {
      const staged=stage?.changes.get(path);
      if (staged) return staged.bytes ?? undefined;
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
    for (const write of [...stage?.changes.values() ?? [],...writes]) {
      if (write.bytes === null) complete.delete(write.path);
      else complete.add(write.path);
    }
    requireNoPrefixConflicts([...complete]);
    if (stage) {
      for (const write of writes) stage.changes.set(write.path,write);
      return {status:'STAGED', paths:writes.map(write=>write.path)};
    }
    return this.publishPlan(name,writes,before,local.revision.value,scope);
  }
  private async publishPlan(name: string,writes:FileWrite[],before:WorkspaceSnapshot|null,localRevisionValue:string,scope:FilesystemCallScope) {
    const native = writes.some(write=>nativePath(write.path));
    const writeDigests = await Promise.all(writes.map(async write => [write.path, write.bytes === null ? null : await digest(write.bytes)]));
    const writeSetDigest = await digest(JSON.stringify([name, before?.nativeRevision ?? null, localRevisionValue, writeDigests]));
    await scope.authorizePublication({digest: writeSetDigest, paths: writes.map(write => write.path),
      expectedSourceRevision: before?.nativeRevision, expectedLocalRevision: localRevisionValue});
    await scope.assertCurrent();
    const publicationFence = scope.beforePublication ? async () => {
      await scope.assertCurrent();
      await scope.beforePublication!();
      await scope.assertCurrent();
    } : scope.assertCurrent;
    if (!native) {
      const localRevision = await this.vfs.writeLocalBatch(writes, localRevisionValue, scope.operationId, publicationFence);
      return {status: 'SUCCEEDED', committed: writes.map(write => write.path), localRevision};
    }
    const result = await this.vfs.writeBatch(writes,before!.revision,scope.operationId,publicationFence);
    const localRevision = result.status === 'SUCCEEDED'
      ? await this.vfs.localView().then(view => view.revision, () => ({value: null, verified: false, reason: 'READBACK_UNAVAILABLE'}))
      : undefined;
    return {...result, sourceRevision: {value: result.nativeRevision ?? null, verified: !!result.nativeRevision},
      ...(localRevision ? {localRevision} : {})};
  }
  private transfer(args: TransferCall, scope: FilesystemCallScope): Promise<unknown> {
    const before = transferTail.get(this.vfs) ?? Promise.resolve();
    const next = before.then(() => this.runTransfer(args, scope));
    const after = next.catch(() => undefined);
    transferTail.set(this.vfs, after);
    void after.then(() => { if (transferTail.get(this.vfs) === after) transferTail.delete(this.vfs); });
    return next;
  }

  private async persistTransfer(key: string, stage: Transfer): Promise<Transfer> {
    const next: Transfer = {...stage, version: 2, transitionId: crypto.randomUUID()};
    // A write can commit before its acknowledgement is lost. Exact readback
    // proves the transition. A different state never authorizes publication.
    try { await this.vfs.store.set(key, next); } catch { /* Read back the transition. */ }
    const observed = await this.vfs.store.get<Transfer>(key);
    if (observed?.transitionId !== next.transitionId || JSON.stringify(observed) !== JSON.stringify(next))
      throw new BrowserError('EFFECT_UNKNOWN', 'Transfer metadata acknowledgement could not be verified.');
    return next;
  }

  private async clearTransferChunks(key: string, stage: Transfer, scope: FilesystemCallScope, budget: number,
      allKeys?: readonly string[]) {
    const chunkPrefix = key.slice(0, -5) + ':chunk:';
    const keys = (allKeys ?? await this.vfs.store.list()).filter(key => key.startsWith(chunkPrefix));
    let remaining = stage.chunks;
    if (budget > 0 && keys.length > 0) {
      const remove = new Set(keys.slice(0, budget));
      for (const chunkKey of remove) {
        await scope.assertCurrent();
        await this.vfs.store.delete(chunkKey);
      }
      remaining = stage.chunks.filter(chunk => !remove.has(chunkPrefix + chunk.offset));
      await this.persistTransfer(key, {...stage, chunks: remaining});
      budget -= remove.size;
      keys.splice(0, remove.size);
    }
    if (budget > 0 && !keys.length && (stage.retainUntil ?? stage.expiresAt) <= Date.now()) {
      await scope.assertCurrent();
      await this.vfs.store.delete(key);
      budget--;
    }
    return budget;
  }

  private async recoverTransfer(key: string, stage: Transfer, transferId: string, scope: FilesystemCallScope): Promise<Transfer> {
    await scope.assertCurrent();
    if (stage.state === 'VERIFYING') {
      // The dispatch fence is a distinct durable state. An interrupted
      // preflight can never cross that fence without its exact readback.
      return this.persistTransfer(key, {...stage, state: 'REJECTED',
        rejection: {code: 'CONFLICT', message: 'Earlier commit stopped before publication.'},
        retainUntil: Math.max(stage.expiresAt, Date.now() + transferLifetime)});
    }
    if (!stage.commit || !['DISPATCHED', 'HOLD'].includes(transferState(stage))) return stage;
    const epochPrefix = key.slice(0, key.lastIndexOf(':transfer:'));
    const receipt = await this.vfs.transferPublicationReceipt(stage.commit.operationId, stage.path, epochPrefix);
    if (receipt?.state === 'REJECTED') {
      return this.persistTransfer(key, {...stage, state: 'REJECTED',
        rejection: {code: 'CONFLICT', message: 'Earlier publication stopped before any destination effect.'},
        retainUntil: Math.max(stage.expiresAt, Date.now() + transferLifetime)});
    }
    if (receipt?.state === 'SUCCEEDED') {
      const isNative = nativePath(stage.path);
      const revision = receipt.revision ?? null;
      const result = commitReceipt(stage, transferId, {status: 'SUCCEEDED', committed: [stage.path], recovered: true,
        ...(isNative ? {sourceRevision: {value: receipt.nativeRevision ?? null, verified: !!receipt.nativeRevision}}
          : {localRevision: {value: revision, verified: revision !== null}})});
      return this.persistTransfer(key, {...stage, state: 'COMMITTED', result,
        retainUntil: Math.max(stage.expiresAt, Date.now() + transferLifetime)});
    }
    if (stage.state === 'HOLD' && (!receipt?.settled || stage.retentionSettled)) return stage;
    const result = stage.result ?? (receipt?.state === 'PARTIAL'
      ? {status: 'PARTIAL', committed: receipt.committed, uncertainPaths: receipt.uncertainPaths}
      : undefined);
    return this.persistTransfer(key, {...stage, state: 'HOLD', result, retentionSettled: receipt?.settled === true,
      ...(receipt?.settled ? {retainUntil: Math.max(stage.expiresAt, Date.now() + transferLifetime)} : {})});
  }

  private async runTransfer(args: TransferCall, scope: FilesystemCallScope) {
    await scope.assertCurrent();
    const namespace = this.vfs.scope;
    if (!namespace) throw new BrowserError('INCOMPATIBLE_VERSION', 'Transfer requires versioned Binding storage.');
    const prefix = namespace.epochPrefix + ':transfer:';
    const store = this.vfs.store;
    if (args.mode === 'start') {
      if (args.ifAbsent && args.ifSha256 || !args.ifAbsent && !args.ifSha256 &&
          (nativePath(args.path) ? !args.expectedSourceRevision : !args.expectedLocalRevision))
        throw new BrowserError('INVALID_INPUT', 'Supply the destination precondition at transfer start.');
      const start = {...transferOperation(scope), digest: await digest(JSON.stringify(args))};
      const allKeys = await store.list();
      const keys = allKeys.filter(key => key.startsWith(namespace.bindingPrefix + ':epoch:') &&
        /:transfer:[a-f0-9-]{36}:meta$/.test(key));
      let retained = keys.length;
      let cleanupBudget = 32;
      const open = [];
      for (const key of keys.slice(0, 128)) {
        let stage = checkTransfer(await store.get<Transfer>(key));
        if (key.startsWith(prefix) && stage.target === scope.target && stage.grantId === scope.grantId && stage.start &&
            (start.operationKey !== null ? stage.start.operationKey === start.operationKey : stage.start.operationId === start.operationId)) {
          if (stage.start.digest !== start.digest)
            throw new BrowserError('IDEMPOTENCY_CONFLICT', 'Transfer start identity was used for another destination or payload.');
          return {transferId: key.slice(prefix.length, -5), offset: 0, expiresAt: stage.expiresAt};
        }
        if ((key.startsWith(prefix) || stage.expiresAt <= Date.now()) && !stage.retentionSettled &&
            ['VERIFYING', 'DISPATCHED', 'HOLD'].includes(stage.state)) {
          const transferId = key.slice(-41, -5);
          stage = await this.recoverTransfer(key, stage, transferId, scope);
        }
        const state = transferState(stage);
        const held = (state === 'VERIFYING' || state === 'DISPATCHED' || state === 'HOLD') && !stage.retentionSettled;
        if (held || state === 'OPEN' && stage.expiresAt > Date.now()) open.push(stage);
        else if (cleanupBudget > 0) {
          cleanupBudget = await this.clearTransferChunks(key, stage, scope, cleanupBudget, allKeys);
          if (await store.get(key) === undefined) retained--;
        }
      }
      if (keys.length > 128 || retained >= 128 || open.length >= 2 ||
          open.reduce((sum, stage) => sum + stage.totalBytes, 0) + args.totalBytes > 32 * 1024 * 1024)
        throw new BrowserError('QUOTA_EXCEEDED', 'Binding transfer capacity is exhausted. Resolve Holds or remove closed staged transfers.');
      const id = crypto.randomUUID();
      const key = prefix + id + ':meta';
      const stage: Transfer = {...args, target: scope.target, grantId: scope.grantId, start,
        cursor: 0, state: 'OPEN', expiresAt: Date.now() + transferLifetime, chunks: []};
      await this.vfs.assertLocalRoom(stringByteLength(stage) + key.length + 256);
      await scope.assertCurrent();
      await this.persistTransfer(key, stage);
      return {transferId: id, offset: 0, expiresAt: stage.expiresAt};
    }
    const key = prefix + args.transferId + ':meta';
    const raw = await store.get<Transfer>(key);
    if (!raw || raw.target !== scope.target || raw.grantId !== scope.grantId)
      throw new BrowserError('NOT_FOUND', 'Transfer is unavailable in this operation scope.');
    let stage = checkTransfer(raw);
    if (args.mode !== 'chunk') stage = await this.recoverTransfer(key, stage, args.transferId, scope);
    const state = transferState(stage);
    if (scope.transferRecoveryOnly) {
      if (state === 'OPEN')
        throw new BrowserError('SCOPE_DENIED', 'Transfer has no previous publication to inspect while a Workspace Hold is unresolved.');
      const outcome = state === 'COMMITTED'
        ? {...commitReceipt(stage, args.transferId, stage.result ?? {}), transferState: state, aborted: false}
        : state === 'ABORTED' || state === 'REJECTED'
          ? {transferId: args.transferId, transferState: state, aborted: state === 'ABORTED',
            originalError: stage.rejection ?? null}
          : holdResult(stage, args.transferId);
      return {status: 'SUCCEEDED', effectState: 'NONE', transferOutcome: outcome};
    }
    if (state === 'DISPATCHED' || state === 'HOLD' || state === 'VERIFYING')
      return holdResult(stage, args.transferId);
    if (state === 'COMMITTED' && args.mode !== 'chunk') {
      const receipt = commitReceipt(stage, args.transferId, stage.result ?? {});
      return args.mode === 'abort' ? {...receipt, aborted: false, transferState: 'COMMITTED'} : receipt;
    }
    if ((state === 'REJECTED' || state === 'ABORTED' && stage.rejection) && args.mode === 'commit') {
      const rejected = stage.rejection;
      throw new BrowserError(rejected?.code ?? 'CONFLICT', rejected?.message ?? 'Earlier transfer commit was rejected.');
    }
    if (args.mode === 'abort' && (state === 'ABORTED' || state === 'REJECTED' || state === 'OPEN')) {
      if (state !== 'ABORTED') {
        await scope.assertCurrent();
        stage = await this.persistTransfer(key, {...stage, state: 'ABORTED',
          retainUntil: Math.max(stage.expiresAt, Date.now() + transferLifetime)});
      }
      await this.clearTransferChunks(key, stage, scope, 32).catch(() => undefined);
      return {aborted: true};
    }
    if (state !== 'OPEN' || stage.expiresAt <= Date.now())
      throw new BrowserError('RESULT_EXPIRED', 'Transfer is closed or expired.');
    if (args.mode === 'chunk') {
      const bytes = contentBytes(args.data, 'base64');
      const sha256 = await digest(bytes);
      const chunkKey = prefix + args.transferId + ':chunk:' + args.offset;
      const durable = await store.get<string>(chunkKey);
      const current = stage.chunks.find(chunk => chunk.offset === args.offset);
      if (current && current.bytes === bytes.length && current.sha256 === sha256 && durable === args.data) return {offset: stage.cursor};
      if (args.offset !== stage.cursor || (durable !== undefined && durable !== args.data) ||
          bytes.length > chunkBytes || stage.cursor + bytes.length > stage.totalBytes ||
          (stage.cursor + bytes.length !== stage.totalBytes && bytes.length !== chunkBytes))
        throw new BrowserError('INVALID_INPUT', 'Unexpected transfer offset, data or chunk length.');
      if (durable === undefined) {
        await this.vfs.assertLocalRoom(args.data.length + chunkKey.length + 256);
        await scope.assertCurrent();
        try { await store.set(chunkKey, args.data); } catch { /* Read back the exact bytes. */ }
        if (await store.get(chunkKey) !== args.data)
          throw new BrowserError('EFFECT_UNKNOWN', 'Transfer chunk acknowledgement could not be verified.');
      }
      await scope.assertCurrent();
      const cursor = stage.cursor + bytes.length;
      await this.persistTransfer(key, {...stage, cursor, chunks: [...stage.chunks, {offset: args.offset, bytes: bytes.length, sha256}]});
      return {offset: cursor};
    }
    if (args.mode !== 'commit') throw new BrowserError('RESULT_EXPIRED', 'Transfer is closed.');
    return this.commitTransfer(key, stage, args.transferId, scope);
  }

  private async commitTransfer(key: string, stage: Transfer, transferId: string, scope: FilesystemCallScope) {
    const store = this.vfs.store;
    const stem = key.slice(0, -5);
    const bytes = new Uint8Array(stage.totalBytes);
    if (stage.cursor !== stage.totalBytes) throw new BrowserError('INVALID_INPUT', 'Transfer is incomplete.');
    let offset = 0;
    for (const chunk of stage.chunks) {
      const raw = await store.get<string>(stem + ':chunk:' + chunk.offset);
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
    let durable = await this.persistTransfer(key, {...stage, state: 'VERIFYING', commit: transferOperation(scope)});
    const publication = {...scope, beforePublication: async () => {
      if (durable.state === 'VERIFYING') durable = await this.persistTransfer(key, {...durable, state: 'DISPATCHED'});
    }};
    let result: Record<string, unknown>;
    try {
      const published = await this.mutate('write', {expectedSourceRevision: stage.expectedSourceRevision,
        expectedLocalRevision: stage.expectedLocalRevision, files: [{path: stage.path, encoding: stage.encoding,
          content, ifAbsent: stage.ifAbsent, ifSha256: stage.ifSha256}]}, publication);
      result = commitReceipt(durable, transferId, published);
    } catch (error) {
      const stillPreEffect = durable.state === 'VERIFYING';
      const receipt = stillPreEffect ? undefined : await this.vfs.transferPublicationReceipt(scope.operationId, stage.path);
      if (stillPreEffect || receipt?.state === 'REJECTED') {
        const code = error instanceof BrowserError ? error.code : 'PROVIDER_REJECTED';
        await this.persistTransfer(key, {...durable, state: 'REJECTED',
          rejection: {code, message: 'Transfer publication was rejected before any destination effect.'},
          retainUntil: Math.max(stage.expiresAt, Date.now() + transferLifetime)});
        throw error;
      }
      durable = await this.persistTransfer(key, {...durable, state: 'HOLD'});
      return holdResult(durable, transferId);
    }
    const commitKnown = result.status === 'SUCCEEDED';
    const final: Transfer = {...durable, state: commitKnown ? 'COMMITTED' : 'HOLD', result,
      ...(commitKnown ? {retainUntil: Math.max(stage.expiresAt, Date.now() + transferLifetime)} : {})};
    try { durable = await this.persistTransfer(key, final); }
    catch {
      // A durable VFS journal may settle this later without replay. While
      // its exact acknowledgement is missing, retain the stage and handle.
      return holdResult({...durable, result: {status: commitKnown ? 'UNKNOWN' : result.status}}, transferId);
    }
    if (!commitKnown) return holdResult(durable, transferId);
    await this.clearTransferChunks(key, durable, scope, 32).catch(() => undefined);
    return result;
  }
}
