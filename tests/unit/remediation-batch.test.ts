import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeAdapter } from '../../apps/userscript/src/adapter.js';
import { ExecutionError } from '../../apps/userscript/src/compute.js';
import { executeDevelopment, type DevelopmentContext } from '../../apps/userscript/src/development-v2.js';
import { digest, BrowserError } from '../../apps/userscript/src/native-types.js';
import { MemoryStore } from '../../apps/userscript/src/storage.js';
import { VirtualFileSystem } from '../../apps/userscript/src/vfs.js';
import { batchResultBudget, parseDevelopmentCall } from '../../packages/contracts/src/development-v2.js';

const fixtureTarget = 'w2.fixture.1.1';
const write = (path: string, content = 'fixture') => ({tool: 'write', args: {
  files: [{path, encoding: 'utf8', content, ifAbsent: true}],
}});
const evaluate = {tool: 'page_eval', args: {js: 'return 1;'}};

async function fixture(actions: object[]) {
  const storage = new MemoryStore();
  const native = new Map<string, Uint8Array>([
    ['original', Uint8Array.of(1)], ['removed', Uint8Array.of(2)],
  ]);
  const attempts: string[] = [];
  const effects = {failAt: -1};
  const publish = (path: string, bytes?: Uint8Array) => {
    attempts.push(path);
    if (attempts.length - 1 === effects.failAt) throw new Error('Synthetic setter acknowledgement loss.');
    if (bytes) native.set(path, bytes.slice());
    else native.delete(path);
  };
  const adapter = new NativeAdapter({
    app: {data: {generator: {id: 123, name: 'fixture'}}},
    modelTextEditor: {state: {readOnly: false}, getValue: () => '', setValue: () => undefined},
    outputTemplateEditor: {state: {readOnly: false}, getValue: () => '', setValue: () => undefined},
    srcState: {ready: async () => undefined, idle: async () => undefined, getDraftId: () => '',
      list: () => [...native.keys()], readFile: (path: string) => native.get(path)!,
      writeFile: (path: string, bytes: Uint8Array) => publish(path, bytes), deleteFile: (path: string) => publish(path)},
    __editorReady: true, __draftChoiceSettled: true, currentInterfaceMode: 'edit', perchanceSaveState: 'unsaved',
    aiAgentActivityState: () => ({active: false, unknown: false, reason: ''}), __aiGeneratorGuard: {blocked: () => false},
  });
  const vfs = await VirtualFileSystem.openBound(adapter, storage, {
    workspaceId: 'fixture', installationId: 'installation', assignmentGeneration: 1, bindingGeneration: 1,
    epoch: 1, generatorId: '123', draftId: '',
  }, {assertCurrent: () => undefined});
  const ledger: Parameters<DevelopmentContext['recordStep']>[0][] = [];
  const permits: string[] = [];
  const context: DevelopmentContext = {
    envelope: {version: 2, target: fixtureTarget, operationId: 'operation', operationKey: `k2.${Date.now()}.${crypto.randomUUID()}`,
      workspaceId: 'fixture', bindingRevision: 1, assignmentGeneration: 1, bindingGeneration: 1,
      connectorId: 'connector', grantId: 'grant', epoch: 1, tabInstanceId: 'tab', policyRevision: 1,
      permissionRevision: 1, deadlineMs: Date.now() + 60_000, traceId: 'trace', tool: 'batch', args: {actions},
      permissions: ['READ_SOURCE', 'WRITE_SOURCE', 'PREVIEW_EXECUTE', 'FETCH_PUBLIC']},
    vfs, signal: AbortSignal.timeout(60_000), assertCurrent: async () => undefined,
    permit: async kind => { permits.push(kind); }, recordStep: async step => { ledger.push(step); },
    additional: async () => { throw new BrowserError('UNSUPPORTED_INTERFACE', 'Fixture browser action unavailable.'); },
  };
  return {context, storage, vfs, ledger, permits, attempts, effects, native};
}

const invalidPathCode = (code: string) => (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === code;
type BatchResult = {status: string; effectState: string; steps: (Parameters<DevelopmentContext['recordStep']>[0] &
  {result?: {files: {content?: string; resultAvailability?: string; next?: {offset: number; length: number; ifSha256: string}}[]}})[]};

test('F01 browser host approval is checked before earlier actions in an otherwise valid batch', async () => {
  const f = await fixture([evaluate, {tool: 'fetch_url', args: {
    requests: [{url: 'https://fixture-perch.com/data', path: 'scratch/reply', ifAbsent: true}],
  }}]);
  let effects = 0;
  f.context.additional = async () => { effects++; };
  const {operationKey, args} = f.context.envelope;
  assert.doesNotThrow(() => parseDevelopmentCall('batch', {target: fixtureTarget, operationKey, ...args}));
  await assert.rejects(executeDevelopment(f.context), invalidPathCode('SCOPE_DENIED'));
  assert.deepEqual([effects, f.ledger.length, f.permits.length], [0, 0, 0]);
});

test('F01 canonical pad bits, coherent prefix collision and serialized aggregate budget reject before effects', async () => {
  const invalid = [
    [[evaluate, {tool: 'write', args: {files: [{path: 'scratch/bytes', content: 'YR==', encoding: 'base64', ifAbsent: true}]}}], 'INVALID_INPUT'],
    [[evaluate, write('scratch/first'), write('scratch/first/child')], 'PATH_DENIED'],
    [[evaluate, write('scratch/first'), write('scratch/first')], 'INVALID_INPUT'],
    [[evaluate, write('scratch/first', 'λ'.repeat(131_000)), write('scratch/second', 'λ'.repeat(131_000))], 'LIMIT_EXCEEDED'],
  ] as const;
  for (const [actions, code] of invalid) {
    const f = await fixture([...actions]);
    const {args, operationKey} = f.context.envelope;
    assert.throws(() => parseDevelopmentCall('batch', {target: fixtureTarget, operationKey, ...args}), invalidPathCode(code));
    await assert.rejects(executeDevelopment(f.context), invalidPathCode(code));
    assert.deepEqual(f.permits, []);
    assert.deepEqual(f.ledger, []);
  }
});

test('F08 reports exact dynamic staging failure and discards unpublished earlier steps', async () => {
  const f = await fixture([write('scratch/new'),
    {tool: 'delete', args: {paths: [{path: 'src/removed', ifSha256: 'a'.repeat(64)}]}},
    write('scratch/last'), {tool: 'read', args: {files: [{path: 'src/removed'}]}}]);
  const result = await executeDevelopment(f.context) as BatchResult;
  assert.deepEqual([result.status, result.effectState], ['REJECTED', 'NONE']);
  assert.deepEqual(result.steps.map(step => [step.stepId, step.status]), [
    ['operation:0', 'DISCARDED'], ['operation:1', 'REJECTED'], ['operation:2', 'SKIPPED'], ['operation:3', 'SKIPPED'],
  ]);
  assert.equal(result.steps[1]?.code, 'STALE_REVISION');
  assert.deepEqual(f.permits, []);
  assert.deepEqual(f.attempts, []);
  assert.deepEqual((await f.vfs.localView()).files, []);
  assert.equal(f.ledger[0]?.status, 'STAGED');
});

test('F08 records only actual per-path effects when each grouped write, rename or delete setter fails', async t => {
  const setters = ['written', 'renamed', 'original', 'removed'];
  for (const [index, failedPath] of setters.entries()) await t.test(failedPath, async () => {
    const f = await fixture([write('src/written'),
      {tool: 'rename', args: {moves: [{from: 'src/original', to: 'src/renamed', destination: 'absent', ifSha256: await digest(Uint8Array.of(1))}]}},
      {tool: 'delete', args: {paths: [{path: 'src/removed', ifSha256: await digest(Uint8Array.of(2))}]}},
      {tool: 'read', args: {files: [{path: 'src/written'}]}}]);
    f.effects.failAt = index;
    const result = await executeDevelopment(f.context) as BatchResult;
    assert.equal(result.status, index === 0 ? 'UNKNOWN' : 'PARTIAL');
    assert.deepEqual(f.attempts, setters.slice(0, index + 1));
    const pathOutcomes = new Map(result.steps.flatMap(step => step.paths ?? []).map(path => [path.path, path.outcome]));
    for (const [position, path] of setters.entries()) assert.equal(pathOutcomes.get('src/' + path),
      position < index ? 'COMMITTED' : position === index ? 'UNCERTAIN' : 'SKIPPED');
    assert.equal(result.steps[3]?.status, 'SKIPPED');
    assert.ok(f.ledger.slice(0, 3).every(step => step.status === 'STAGED'));
    assert.deepEqual(f.permits, ['source-publication']);
  });
});

test('F08 retains a child UNKNOWN after a known effect and explicit skip for later actions', async () => {
  const f = await fixture([evaluate, evaluate, write('scratch/skipped')]);
  let ran = 0;
  f.context.additional = async () => {
    if (ran++) throw new ExecutionError('EFFECT_UNKNOWN', 'Synthetic timeout after dispatch.', 'UNKNOWN');
    return {output: 'complete'};
  };
  const result = await executeDevelopment(f.context) as BatchResult;
  assert.deepEqual([result.status, result.effectState], ['PARTIAL', 'PARTIAL']);
  assert.deepEqual(result.steps.map(step => [step.status, step.effectState]), [
    ['SUCCEEDED', 'KNOWN'], ['UNKNOWN', 'UNKNOWN'], ['SKIPPED', 'NONE'],
  ]);
});

test('F08 retains ordinary read bytes and digest-pinned continuation after aggregate exhaustion', async () => {
  const text = 'a'.repeat(19_000);
  const f = await fixture(Array.from({length: 12}, () => ({
    tool: 'read', args: {files: [{path: 'scratch/source'}]},
  })));
  const revision = (await f.vfs.localView()).revision.value;
  await f.vfs.writeLocalBatch([{path: 'scratch/source', bytes: new TextEncoder().encode(text)}], revision);
  const result = await executeDevelopment(f.context) as BatchResult;
  assert.deepEqual([result.status, result.effectState], ['SUCCEEDED', 'NONE']);
  assert.equal(result.steps[0]?.result?.files[0]?.content, text);
  const tail = result.steps.at(-1)?.result?.files[0];
  assert.equal(tail?.resultAvailability, 'CONTINUATION_REQUIRED');
  assert.deepEqual(tail?.next, {unit: 'bytes', offset: 0, length: text.length, ifSha256: await digest(text)});
  assert.ok(new TextEncoder().encode(JSON.stringify(result)).byteLength <= batchResultBudget);
  assert.ok(f.ledger.every(step => !('result' in step)));
});

test('F08 net-zero coalesced publication retains proof of no effects', async () => {
  const f = await fixture([write('scratch/temporary'),
    {tool: 'delete', args: {base: 'previous', paths: [{path: 'scratch/temporary'}]}}]);
  const result = await executeDevelopment(f.context) as BatchResult;
  assert.deepEqual([result.status, result.effectState], ['SUCCEEDED', 'NONE']);
  assert.deepEqual(result.steps.map(step => step.paths?.[0]?.outcome), ['DISCARDED', 'DISCARDED']);
  assert.deepEqual(f.permits, []);
  assert.deepEqual((await f.vfs.localView()).files, []);
});
