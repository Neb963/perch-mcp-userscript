import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeAdapter } from '../../apps/userscript/src/adapter.js';
import { FilesystemV2, type FilesystemCallScope } from '../../apps/userscript/src/filesystem-v2.js';
import { BrowserError, bytesToBase64, digest } from '../../apps/userscript/src/native-types.js';
import { MemoryStore } from '../../apps/userscript/src/storage.js';
import { VirtualFileSystem } from '../../apps/userscript/src/vfs.js';

async function fixture(n = 4, store = new MemoryStore()) {
  let pjs = 'output\n  line\n';
  let reads = 0, permits = 0;
  const files: Map<string, Uint8Array> = new Map(Array.from({length: n}, (_a, i) =>
    ['f' + i + '.bin', Uint8Array.of(i, 0, 255)]));
  const page = {
    app: {data: {generator: {id: 123, name: 'fixture'}}},
    modelTextEditor: {state: {readOnly: false}, getValue: () => pjs, setValue: (value: string) => { pjs = value; }},
    outputTemplateEditor: {state: {readOnly: false}, getValue: () => '<p>Fixture</p>', setValue: () => undefined},
    srcState: {
      ready: async () => undefined, idle: async () => undefined, getDraftId: () => '',
      list: () => [...files.keys()], readFile: (name: string) => { reads++; return files.get(name)!; },
      writeFile: (name: string, bytes: Uint8Array) => { files.set(name, bytes.slice()); },
      deleteFile: (name: string) => { files.delete(name); },
    },
    aiAgentActivityState: () => ({active: false, unknown: false, reason: ''}),
    __aiGeneratorGuard: {blocked: () => false},
    __editorReady: true, __draftChoiceSettled: true, currentInterfaceMode: 'edit', perchanceSaveState: 'unsaved',
  };
  const adapter = new NativeAdapter(page);
  const tuple = {workspaceId: 'fixture', installationId: 'inst', assignmentGeneration: 1, bindingGeneration: 1,
    epoch: 1, generatorId: '123', draftId: ''};
  const vfs = await VirtualFileSystem.openBound(adapter, store, tuple, {assertCurrent: () => undefined});
  const filesystem = new FilesystemV2(vfs);
  const scope: FilesystemCallScope = {
    operationId: 'synthetic', target: 'w2.fixture.1.1', grantId: 'grant',
    assertCurrent: () => undefined, authorizePublication: async () => { permits++; },
  };
  return {files, page, filesystem, scope, vfs, adapter, tuple, store, reads: () => reads, permits: () => permits,
    edit: (value: string) => { pjs = value; }};
}
const expectCode = (code: string) => (error: unknown) => error instanceof BrowserError && error.code === code;

test('panel reads and metadata list use zero unrelated native content reads', async () => {
  const f = await fixture(100);
  const pjs = await f.filesystem.read({files: [{path: 'main.pjs'}]}, f.scope);
  assert.ok(pjs.files[0] && 'content' in pjs.files[0]);
  assert.equal(pjs.files[0].content, 'output\n  line\n');
  assert.deepEqual(pjs.sourceRevision, {value: null, verified: false});
  const metadata = await f.filesystem.list({directories: ['src'], limit: 10}, f.scope);
  assert.equal(metadata.files.length, 10);
  assert.ok(metadata.files.every(row => row.bytes === null && row.sha256 === null));
  const next = await f.filesystem.list({directories: ['src'], limit: 10, cursor: metadata.nextCursor!}, f.scope);
  assert.ok(next.files[0]!.path > metadata.files.at(-1)!.path);
  assert.equal(f.reads(), 0);
  const result = await f.filesystem.read({files: [{path: 'src/f0.bin', encoding: 'base64'}, {path: 'src/f2.bin'}]}, f.scope);
  assert.ok(result.files[0] && 'content' in result.files[0]);
  assert.equal(result.files[0].content, 'AAD/');
  assert.ok(result.files[1] && 'error' in result.files[1]);
  assert.equal(result.files[1].error?.code, 'BINARY_FILE');
  assert.equal(f.reads(), 4);
  f.files.set('new.bin', Uint8Array.of(42));
  await assert.rejects(f.filesystem.list({directories: ['src'], limit: 10, cursor: metadata.nextCursor!}, f.scope), expectCode('STALE_REVISION'));
});

test('long minified lines continue with digest and same-size edits invalidate the requested range', async () => {
  const f = await fixture();
  f.edit('λ'.repeat(90_000));
  const output = await f.filesystem.read({files: [{path: 'main.pjs', range: {unit: 'lines', start: 1, count: 1}}]}, f.scope);
  const page = output.files[0]!;
  assert.ok('content' in page && page.next && page.content && page.content.length < 90_000);
  f.edit('μ'.repeat(90_000));
  const stale = await f.filesystem.read({files: [{path: 'main.pjs', range: page.next, ifSha256: page.sha256}]}, f.scope);
  assert.ok(stale.files[0] && 'error' in stale.files[0]);
  assert.equal(stale.files[0].error?.code, 'STALE_REVISION');
});

test('exact multi-file preflight, zero-byte scratch and protected native rename', async () => {
  const f = await fixture();
  await f.filesystem.run('write', {files: [{path: 'scratch/empty', encoding: 'base64', content: '', ifAbsent: true}]}, f.scope);
  assert.equal(f.reads(), 0);
  const revision = (await f.vfs.localView()).revision.value;
  assert.equal((await (await f.vfs.localView()).read('scratch/empty')).length, 0);
  await assert.rejects(f.filesystem.run('write', {files: [
    {path: 'scratch/new', encoding: 'utf8', content: 'first', ifAbsent: true},
    {path: 'scratch/empty/subfile', encoding: 'utf8', content: 'second', ifAbsent: true},
  ]}, f.scope), expectCode('PATH_DENIED'));
  assert.equal((await f.vfs.localView()).revision.value, revision);
  const source = f.files.get('f0.bin')!;
  await f.filesystem.run('rename', {moves: [{from: 'src/f0.bin', to: 'src/replacement.bin',
    ifSha256: await digest(source), destination: 'absent'}]}, f.scope);
  assert.equal(f.files.has('f0.bin'), false);
  assert.deepEqual(f.files.get('replacement.bin'), source);
  assert.equal(f.permits(), 2);
});

test('binary transfer retry is scoped, exact and cannot commit twice', async () => {
  const f = await fixture();
  const bytes = Uint8Array.of(0, 1, 128, 255);
  const start = await f.filesystem.run('write', {mode: 'start', path: 'scratch/asset',
    totalBytes: bytes.length, sha256: await digest(bytes), encoding: 'base64', ifAbsent: true}, f.scope) as {transferId: string};
  const chunk = {mode: 'chunk', transferId: start.transferId, offset: 0, data: bytesToBase64(bytes)};
  await assert.rejects(f.filesystem.run('write', chunk, {...f.scope, grantId: 'replacement'}), expectCode('NOT_FOUND'));
  await assert.rejects(f.filesystem.run('write', {...chunk, offset: 1}, f.scope), expectCode('INVALID_INPUT'));
  assert.deepEqual(await f.filesystem.run('write', chunk, f.scope), {offset: 4});
  assert.deepEqual(await f.filesystem.run('write', chunk, f.scope), {offset: 4});
  assert.deepEqual((await f.vfs.localView()).files, []);
  const commit = {mode: 'commit', transferId: start.transferId};
  assert.deepEqual(await f.filesystem.run('write', commit, f.scope), await f.filesystem.run('write', commit, f.scope));
  assert.deepEqual(await (await f.vfs.localView()).read('scratch/asset'), bytes);
  assert.equal(f.permits(), 1);
});

class TransferFaultStore extends MemoryStore {
  fault?: (key: string, value: unknown) => 'before' | 'after' | undefined;
  override async set<T>(key: string, value: T): Promise<void> {
    const timing = this.fault?.(key, value);
    if (timing === 'before') throw new Error('Synthetic storage write failed');
    await super.set(key, value);
    if (timing === 'after') throw new Error('Synthetic storage acknowledgement was lost');
  }
}

const operation = (base: FilesystemCallScope, operationId: string): FilesystemCallScope => ({...base,
  operationId, operationKey: `k2.${Date.now()}.${crypto.randomUUID()}`});
const emptyStart = async (path: string) => ({mode: 'start', path, totalBytes: 0,
  sha256: await digest(new Uint8Array()), encoding: 'base64', ifAbsent: true});

test('F02 start metadata acknowledgement loss returns the exact stable transfer handle', async () => {
  const store = new TransferFaultStore();
  const f = await fixture(0, store);
  let losses = 0;
  store.fault = (key, value) => {
    if (/transfer:.*:meta$/.test(key) && (value as {state?: string}).state === 'OPEN' && losses++ === 0) return 'after';
  };
  const start = operation(f.scope, 'start');
  const input = await emptyStart('scratch/file');
  const first = await f.filesystem.run('write', input, start);
  const retry = await f.filesystem.run('write', input, start);
  assert.deepEqual(retry, first);
  assert.equal(losses, 1);
  await assert.rejects(f.filesystem.run('write', {...input, path: 'scratch/other'}, start), expectCode('IDEMPOTENCY_CONFLICT'));
});

test('F02 permit and quota rejection release both transfer reservations and retained abort stays idempotent', async () => {
  const f = await fixture(0);
  const start = (path: string, id: string) => emptyStart(path).then(input =>
    f.filesystem.run('write', input, operation(f.scope, id)) as Promise<{transferId: string}>);
  const one = await start('src/one', 'start-one');
  const two = await start('src/two', 'start-two');
  await assert.rejects(start('src/full', 'start-full'), expectCode('QUOTA_EXCEEDED'));
  for (const [index, [stage, code]] of [[one, 'REVOKED'], [two, 'QUOTA_EXCEEDED']].entries()) {
    const commit = {mode: 'commit', transferId: (stage as {transferId: string}).transferId};
    const scoped = {...operation(f.scope, 'commit-' + index), authorizePublication: async () => {
      throw new BrowserError(String(code), 'Synthetic pre-effect publication refusal');
    }};
    await assert.rejects(f.filesystem.run('write', commit, scoped), expectCode(String(code)));
    await assert.rejects(f.filesystem.run('write', commit, operation(f.scope, 'replay-' + index)), expectCode(String(code)));
  }
  assert.ok((await start('src/released', 'start-released')).transferId);
  assert.ok((await start('src/released-two', 'start-released-two')).transferId);
  const abort = {mode: 'abort', transferId: one.transferId};
  assert.deepEqual(await f.filesystem.run('write', abort, operation(f.scope, 'abort')), {aborted: true});
  assert.deepEqual(await f.filesystem.run('write', abort, operation(f.scope, 'abort-retry')), {aborted: true});
  assert.equal(f.files.size, 0);
});

test('F02 terminal transfer acknowledgement loss reads durable success and preserves original commit identity', async () => {
  const store = new TransferFaultStore();
  const f = await fixture(0, store);
  const start = await f.filesystem.run('write', await emptyStart('src/file'), operation(f.scope, 'start')) as {transferId: string};
  const first = operation(f.scope, 'first-commit');
  let drops = 0;
  store.fault = (key, value) => {
    if (/transfer:.*:meta$/.test(key) && (value as {state?: string}).state === 'COMMITTED' && drops++ === 0) return 'after';
  };
  const commit = {mode: 'commit', transferId: start.transferId};
  const receipt = await f.filesystem.run('write', commit, first) as Record<string, unknown>;
  assert.equal(drops, 1);
  assert.equal(receipt.status, 'SUCCEEDED');
  assert.equal(receipt.commitOperationId, first.operationId);
  assert.equal(receipt.commitOperationKey, first.operationKey);
  assert.equal(f.permits(), 1);
  const fresh = new FilesystemV2(await VirtualFileSystem.openBound(f.adapter, store, f.tuple, {assertCurrent: () => {}}));
  assert.deepEqual(await fresh.run('write', commit, operation(f.scope, 'second-commit')), receipt);
  assert.deepEqual(await fresh.run('write', {...commit, mode: 'abort'}, operation(f.scope, 'abort')),
    {...receipt, aborted: false, transferState: 'COMMITTED'});
  assert.equal(f.permits(), 1);
});

test('F02 a missing terminal transfer metadata write is reconciled from the exact successful VFS journal', async () => {
  for (const path of ['scratch/file', 'src/file']) {
    const store = new TransferFaultStore();
    const f = await fixture(0, store);
    const start = await f.filesystem.run('write', await emptyStart(path), operation(f.scope, 'start')) as {transferId: string};
    const commit = {mode: 'commit', transferId: start.transferId};
    const first = operation(f.scope, 'first-commit');
    let fault = true;
    store.fault = (key, value) => {
      if (/transfer:.*:meta$/.test(key) && (value as {state?: string}).state === 'COMMITTED' && fault) {
        fault = false;
        return 'before';
      }
    };
    const lost = await f.filesystem.run('write', commit, first) as Record<string, unknown>;
    assert.equal(lost.status, 'UNKNOWN');
    assert.equal(lost.commitOperationId, first.operationId);
    assert.equal(lost.commitOperationKey, first.operationKey);
    const fresh = new FilesystemV2(await VirtualFileSystem.openBound(f.adapter, store, f.tuple, {assertCurrent: () => {}}));
    const recovered = await fresh.run('write', commit, operation(f.scope, 'later-commit')) as Record<string, unknown>;
    assert.equal(recovered.status, 'SUCCEEDED');
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.commitOperationId, first.operationId);
    assert.equal(f.permits(), 1, 'read-only recovery must not consume a publication permit');
  }
});

test('F02 a mismatching native setter preserves unknown effects through repeat commit and abort', async () => {
  const f = await fixture(0);
  let setters = 0;
  f.page.srcState.writeFile = name => { setters++; f.files.set(name, Uint8Array.of(42)); };
  const start = await f.filesystem.run('write', await emptyStart('src/file'), operation(f.scope, 'start')) as {transferId: string};
  const first = operation(f.scope, 'first-commit');
  const commit = {mode: 'commit', transferId: start.transferId};
  const held = await f.filesystem.run('write', commit, first) as Record<string, unknown>;
  assert.equal(held.status, 'UNKNOWN');
  assert.equal(held.transferState, 'HOLD');
  assert.deepEqual(held.uncertainPaths, ['src/file']);
  assert.equal(held.commitOperationKey, first.operationKey);
  assert.deepEqual((await f.vfs.unresolved()).map(row => row.gatewayOperationId), [first.operationId]);
  const fresh = new FilesystemV2(await VirtualFileSystem.openBound(f.adapter, f.store, f.tuple, {assertCurrent: () => {}}));
  assert.deepEqual(await fresh.run('write', commit, operation(f.scope, 'retry')), held);
  assert.deepEqual(await fresh.run('write', {...commit, mode: 'abort'}, operation(f.scope, 'abort')), held);
  assert.equal(setters, 1);
  assert.equal(f.permits(), 1);
  await assert.rejects(fresh.run('write', commit, {...operation(f.scope, 'foreign'), grantId: 'elsewhere'}), expectCode('NOT_FOUND'));
});

test('F02 a verified native write followed by a manual edit keeps partial publication evidence', async () => {
  const f = await fixture(0);
  const apply = f.adapter.applyFiles.bind(f.adapter);
  f.adapter.applyFiles = async (...args) => {
    const result = await apply(...args);
    f.files.set('manual-edit', Uint8Array.of(42));
    return result;
  };
  const start = await f.filesystem.run('write', await emptyStart('src/file'), operation(f.scope, 'start')) as {transferId: string};
  const first = operation(f.scope, 'first-commit');
  const commit = {mode: 'commit', transferId: start.transferId};
  const held = await f.filesystem.run('write', commit, first) as Record<string, unknown>;
  assert.equal(held.status, 'PARTIAL');
  assert.equal(held.transferState, 'HOLD');
  assert.deepEqual(held.committed, ['src/file']);
  assert.deepEqual((await f.vfs.unresolved()).map(row => row.committed), [['src/file']]);
  assert.deepEqual(await f.filesystem.run('write', {...commit, mode: 'abort'}, operation(f.scope, 'abort')), held);
  assert.equal(f.permits(), 1);
  assert.deepEqual(f.files.get('manual-edit'), Uint8Array.of(42));
});

test('F02 expired OPEN transfers are reclaimed while an uncorrelated legacy commit stays held', async () => {
  const f = await fixture(0);
  const start = (path: string, id: string) => emptyStart(path).then(input =>
    f.filesystem.run('write', input, operation(f.scope, id)) as Promise<{transferId: string}>);
  const legacy = await start('scratch/legacy', 'start-legacy');
  const expired = await start('scratch/expired', 'start-expired');
  for (const [id, state] of [[legacy.transferId, 'COMMITTING'], [expired.transferId, 'OPEN']]) {
    const key = `${f.vfs.prefix}:transfer:${id}:meta`;
    const row = await f.store.get<Record<string, unknown>>(key);
    const {version: _version, transitionId: _transition, start: _start, ...old} = row!;
    await f.store.set(key, {...old, state, expiresAt: 0});
  }
  assert.ok(await start('scratch/new', 'start-new'));
  assert.equal(await f.store.get(`${f.vfs.prefix}:transfer:${expired.transferId}:meta`), undefined);
  assert.ok(await f.store.get(`${f.vfs.prefix}:transfer:${legacy.transferId}:meta`));
  const held = await f.filesystem.run('write', {mode: 'abort', transferId: legacy.transferId}, operation(f.scope, 'abort'));
  assert.deepEqual(held, {status: 'UNKNOWN', transferState: 'HOLD', transferId: legacy.transferId,
    commitOperationId: null, commitOperationKey: null});
});

test('F02 restart during VERIFYING releases reservations without a native setter', async () => {
  const f = await fixture(0);
  const start = await f.filesystem.run('write', await emptyStart('src/file'), operation(f.scope, 'start')) as {transferId: string};
  const key = `${f.vfs.prefix}:transfer:${start.transferId}:meta`;
  const previous = await f.store.get<Record<string, unknown>>(key);
  const first = operation(f.scope, 'first-commit');
  await f.store.set(key, {...previous, state: 'VERIFYING', commit: {operationId: first.operationId, operationKey: first.operationKey}});
  const fresh = new FilesystemV2(await VirtualFileSystem.openBound(f.adapter, f.store, f.tuple, {assertCurrent: () => {}}));
  await assert.rejects(fresh.run('write', {mode: 'commit', transferId: start.transferId}, operation(f.scope, 'later')),
    expectCode('CONFLICT'));
  assert.equal((await f.store.get<{state: string}>(key))?.state, 'REJECTED');
  assert.deepEqual(await fresh.run('write', {mode: 'abort', transferId: start.transferId}, operation(f.scope, 'abort')), {aborted: true});
  assert.equal(f.permits(), 0);
  assert.equal(f.files.size, 0);
});

test('F02 chunk retry adopts exact durable bytes after lost metadata and rejects conflicting overlap', async () => {
  const store = new TransferFaultStore();
  const f = await fixture(0, store);
  const bytes = Uint8Array.of(123);
  const start = await f.filesystem.run('write', {mode: 'start', path: 'scratch/file', totalBytes: bytes.length,
    sha256: await digest(bytes), encoding: 'base64', ifAbsent: true}, operation(f.scope, 'start')) as {transferId: string};
  const chunk = {mode: 'chunk', transferId: start.transferId, offset: 0, data: bytesToBase64(bytes)};
  let missing = true;
  store.fault = (key, value) => {
    if (/transfer:.*:meta$/.test(key) && (value as {cursor?: number}).cursor === bytes.length && missing) {
      missing = false;
      return 'before';
    }
  };
  await assert.rejects(f.filesystem.run('write', chunk, operation(f.scope, 'first-chunk')), expectCode('EFFECT_UNKNOWN'));
  await assert.rejects(f.filesystem.run('write', {...chunk, data: bytesToBase64(Uint8Array.of(234))},
    operation(f.scope, 'conflict')), expectCode('INVALID_INPUT'));
  assert.deepEqual(await f.filesystem.run('write', chunk, operation(f.scope, 'retry')), {offset: 1});
  assert.ok((await f.vfs.localView()).files.length === 0);
  await f.filesystem.run('write', {mode: 'commit', transferId: start.transferId}, operation(f.scope, 'commit'));
  assert.deepEqual(await (await f.vfs.localView()).read('scratch/file'), bytes);
  assert.equal(f.permits(), 1);
});
