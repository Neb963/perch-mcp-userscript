import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeAdapter } from '../../apps/userscript/src/adapter.js';
import { FilesystemV2, type FilesystemCallScope } from '../../apps/userscript/src/filesystem-v2.js';
import { BrowserError, bytesToBase64, digest } from '../../apps/userscript/src/native-types.js';
import { MemoryStore } from '../../apps/userscript/src/storage.js';
import { VirtualFileSystem } from '../../apps/userscript/src/vfs.js';

async function fixture(n = 4) {
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
  const store = new MemoryStore();
  const tuple = {workspaceId: 'fixture', installationId: 'inst', assignmentGeneration: 1, bindingGeneration: 1,
    epoch: 1, generatorId: '123', draftId: ''};
  const vfs = await VirtualFileSystem.openBound(adapter, store, tuple, {assertCurrent: () => undefined});
  const filesystem = new FilesystemV2(vfs);
  const scope: FilesystemCallScope = {
    operationId: 'synthetic', target: 'w2.fixture.1.1', grantId: 'grant',
    assertCurrent: () => undefined, authorizePublication: async () => { permits++; },
  };
  return {files, page, filesystem, scope, vfs, reads: () => reads, permits: () => permits,
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
