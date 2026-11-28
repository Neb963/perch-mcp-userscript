import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeAdapter } from '../../apps/userscript/src/adapter.js';
import { BrowserController } from '../../apps/userscript/src/controller.js';
import { executeDevelopment, type DevelopmentContext } from '../../apps/userscript/src/development-v2.js';
import { FilesystemV2, type FilesystemCallScope } from '../../apps/userscript/src/filesystem-v2.js';
import { BrowserError, digest } from '../../apps/userscript/src/native-types.js';
import { MemoryStore } from '../../apps/userscript/src/storage.js';
import type { GatewayTransport } from '../../apps/userscript/src/transport.js';
import { VirtualFileSystem } from '../../apps/userscript/src/vfs.js';
import { parseDevelopmentCall } from '../../packages/contracts/src/development-v2.js';
import { issueSyntheticToken, type Harness } from '../fixtures/optimization-client.js';
import { createCapacityHarness, type CapacityFixture } from '../integration/gateway-capacity-harness.js';

// Remove the opt-in when the release-blocking baseline regressions pass.
const skip = process.env.PERCH_REMEDIATION_EXECUTION !== '1';
const offline = {skip, timeout: 30_000};
const tuple = {workspaceId: 'fixture', installationId: 'inst', assignmentGeneration: 1,
  bindingGeneration: 1, epoch: 1, generatorId: '123', draftId: ''};
const target = 'w2.fixture.1.1';
const operationKey = () => `k2.${Date.now()}.${crypto.randomUUID()}`;
const errorCode = (code: string) => (error: unknown) => error instanceof BrowserError && error.code === code;

class CheckpointFixtureStore extends MemoryStore {
  onCheckpoint: () => void = () => {};
  override async set<T>(key: string, value: T): Promise<void> {
    await super.set(key, value);
    if (key.includes(':root:checkpoint:')) this.onCheckpoint();
  }
}

async function nativeFixture() {
  const store = new CheckpointFixtureStore();
  const nativeWrites: string[] = [];
  const source = new Map<string, Uint8Array>();
  const signals = {onWrite: () => {}};
  const adapter = new NativeAdapter({
    app: {data: {generator: {id: 123, name: 'fixture'}}},
    modelTextEditor: {state: {readOnly: false}, getValue: () => 'output = fixture', setValue: () => {}},
    outputTemplateEditor: {state: {readOnly: false}, getValue: () => '', setValue: () => {}},
    srcState: {
      ready: async () => {}, idle: async () => {}, getDraftId: () => '', list: () => [...source.keys()],
      readFile: (name: string) => source.get(name)!,
      writeFile: (name: string, bytes: Uint8Array) => {
        nativeWrites.push(name);
        source.set(name, bytes.slice());
        signals.onWrite();
      },
      deleteFile: (name: string) => { source.delete(name); },
    },
    __editorReady: true, __draftChoiceSettled: true, currentInterfaceMode: 'edit',
    perchanceSaveState: 'unsaved', aiAgentActivityState: () => ({active: false, unknown: false, reason: ''}),
    __aiGeneratorGuard: {blocked: () => false},
  });
  const vfs = await VirtualFileSystem.openBound(adapter, store, tuple, {assertCurrent: () => {}});
  const scope: FilesystemCallScope = {
    operationId: 'operation', target, grantId: 'grant',
    assertCurrent: () => {}, authorizePublication: async () => {},
  };
  return {store, adapter, vfs, fs: new FilesystemV2(vfs), scope, nativeWrites, source, signals};
}

const preview = {tool: 'page_eval', args: {js: 'return 1;'}};
const inline = (files: Record<string, unknown>[]) => ({tool: 'write', args: {files}});
const newFile = (path: string) => ({path, encoding: 'utf8', content: 'fixture', ifAbsent: true});
const malformedBatches = [
  ['invalid base64', inline([{...newFile('scratch/asset'), encoding: 'base64', content: '!!!!'}])],
  ['invalid Unicode', inline([{...newFile('scratch/asset'), content: '\ud800'}])],
  ['mutually exclusive preconditions', inline([{...newFile('scratch/asset'), ifSha256: 'a'.repeat(64)}])],
  ['missing precondition', inline([{path: 'scratch/asset', encoding: 'utf8', content: 'fixture'}])],
  ['duplicate pathname', inline([newFile('scratch/asset'), newFile('scratch/asset')])],
  ['case collision', inline([newFile('scratch/asset'), newFile('scratch/Asset')])],
  ['prefix collision', inline([newFile('scratch/asset'), newFile('scratch/asset/child')])],
  ['cross-namespace rename', {tool: 'rename', args: {moves: [
    {from: 'scratch/asset', to: 'src/asset', ifSha256: 'a'.repeat(64), destination: 'absent'},
  ]}}],
  ['unsupported URL scheme', {tool: 'fetch_url', args: {requests: [
    {url: 'file:///synthetic-fixture', path: 'scratch/asset', ifAbsent: true},
  ]}}],
] as const;

test('F01 malformed later actions are rejected at ingress and browser preflight before effects', offline, async context => {
  for (const [label, invalid] of malformedBatches) await context.test(label, async () => {
    const f = await nativeFixture();
    const key = operationKey();
    const args = {actions: [preview, invalid]};
    const observed: string[] = [];
    const operation: DevelopmentContext = {
      envelope: {version: 2, target, operationId: 'operation', operationKey: key,
        workspaceId: tuple.workspaceId, bindingRevision: 1, assignmentGeneration: 1, bindingGeneration: 1,
        connectorId: 'connector', grantId: 'grant', epoch: 1, tabInstanceId: 'tab',
        policyRevision: 1, permissionRevision: 1, deadlineMs: Date.now() + 30_000, traceId: 'trace',
        tool: 'batch', args, permissions: ['READ_SOURCE', 'WRITE_SOURCE', 'PREVIEW_EXECUTE', 'FETCH_PUBLIC']},
      vfs: f.vfs, signal: new AbortController().signal,
      assertCurrent: async () => {}, recordStep: async () => {},
      permit: async kind => { observed.push(kind); },
      additional: async tool => { observed.push(tool); return {status: 'SUCCEEDED'}; },
    };
    const ingressAccepted = (() => {
      try { parseDevelopmentCall('batch', {target, operationKey: key, ...args}); return true; }
      catch { return false; }
    })();
    const browser = await executeDevelopment(operation, undefined, async () => {
      observed.push('fetch');
      throw new Error('Fixture must never use outbound network');
    }).catch(error => ({status: 'REJECTED', code: (error as BrowserError).code}));
    assert.deepEqual({ingressAccepted, observed, status: (browser as {status?: string}).status},
      {ingressAccepted: false, observed: [], status: 'REJECTED'});
  });
});

test('F04 deadline crossing during durable checkpoint stops the first native setter', offline, async () => {
  const f = await nativeFixture();
  let now = 0;
  f.scope.assertCurrent = () => { if (now >= 1) throw new BrowserError('TIMEOUT', 'Synthetic operation deadline'); };
  f.store.onCheckpoint = () => { now = 1; };
  const result = await f.fs.run('write', {files: [newFile('src/asset')]}, f.scope)
    .catch(error => ({status: 'REJECTED', code: (error as BrowserError).code}));
  assert.equal(now, 1, 'the checkpoint completed under the fault fixture');
  assert.deepEqual(f.nativeWrites, [], JSON.stringify(result));
  assert.equal((await f.vfs.unresolved()).length, 0, 'a proved pre-setter stop has no native uncertainty');
});

test('F04 operation cancellation preserves the first verified setter and stops the next', offline, async () => {
  const f = await nativeFixture();
  const controller = new AbortController();
  f.scope.assertCurrent = () => {
    if (controller.signal.aborted) throw new BrowserError('CANCELLED', 'Synthetic operation cancellation');
  };
  f.signals.onWrite = () => { controller.abort(); };
  const result = await f.fs.run('write', {files: [newFile('src/first'), newFile('src/second')]}, f.scope) as
    {status: string; committed: string[]};
  assert.deepEqual({nativeWrites: f.nativeWrites, status: result.status, committed: result.committed},
    {nativeWrites: ['first'], status: 'PARTIAL', committed: ['src/first']});
});

test('F02 stale destination before transfer publication leaves a safely abortable transfer', offline, async () => {
  const f = await nativeFixture();
  const start = await f.fs.run('write', {mode: 'start', path: 'src/asset', totalBytes: 0,
    sha256: await digest(new Uint8Array()), encoding: 'base64', ifAbsent: true}, f.scope) as {transferId: string};
  const existing = Uint8Array.of(42);
  f.source.set('asset', existing);
  await assert.rejects(f.fs.run('write', {mode: 'commit', transferId: start.transferId},
    {...f.scope, operationId: 'commit-attempt'}), errorCode('STALE_REVISION'));
  assert.deepEqual(f.source.get('asset'), existing);
  assert.deepEqual(f.nativeWrites, []);
  assert.deepEqual(await f.fs.run('write', {mode: 'abort', transferId: start.transferId},
    {...f.scope, operationId: 'abort-attempt'}), {aborted: true});
});

test('F03 an earlier local-only Epoch Hold is discoverable from ordinary recovery after failed adoption', offline, async () => {
  const f = await nativeFixture();
  const current = await f.vfs.snapshot();
  await f.store.set(`${f.vfs.prefix}:journal:held`, {id: 'held', state: 'UNKNOWN',
    kind: 'SOURCE', paths: ['src/asset'], baseRevision: current.revision, createdAt: Date.now()});
  await assert.rejects(VirtualFileSystem.openBound(f.adapter, f.store, {...tuple, epoch: 2},
    {assertCurrent: () => {}}), errorCode('EFFECT_UNKNOWN'));
  const transport = {request: async () => ({
    id: tuple.workspaceId, contractVersion: 2, assignmentGeneration: 1, bindingGeneration: 1, epoch: 2,
    binding: {generatorId: tuple.generatorId, draftId: '', slug: 'fixture', browserInstallationId: tuple.installationId},
  })} as unknown as GatewayTransport;
  const controller = new BrowserController(f.adapter, f.store, transport);
  const recovery = await controller.localRecovery(tuple.workspaceId);
  assert.deepEqual(recovery.holds.map(hold => hold.id), ['held']);
});

async function gatewayFixture() {
  const h = await createCapacityHarness(1, {DEVELOPMENT_CONTRACT_V2_ENABLED: 'true',
    DEVELOPMENT_CONTRACT_V2_EXECUTION_ENABLED: 'true'}, {entryPoint: 'tests/fixtures/optimization-fault-runtime.ts'});
  try {
    const f = h.fixtures[0]!;
    const workspace = await h.get('/api/v1/admin/workspaces/' + f.workspaceId);
    const connector = await h.get('/api/v1/admin/agents/' + f.agentId);
    const upgraded = await h.request('/api/v1/admin/connectors/' + f.agentId + '/upgrade', {
      expectedRevision: connector.revision, expectedWorkspaceRevision: workspace.revision,
      acknowledgeReauthorization: true,
    });
    const next = upgraded.workspace as Record<string, unknown>;
    f.lease = await h.executionRequest('/api/v1/tab/claim', {workspaceId: f.workspaceId,
      binding: f.binding, tabInstanceId: 'remediation-tab', adapterVersion: '2'});
    const token = await issueSyntheticToken(h, f);
    return {h, f, token, target: `w2.${next.id}.${next.assignmentGeneration}.${next.bindingGeneration}`};
  } catch (error) {
    await h.close();
    throw error;
  }
}

async function callMcp(h: Harness, f: CapacityFixture, token: string, name: string, args: Record<string, unknown>) {
  const response = await h.mf.dispatchFetch('https://capacity.test/mcp/' + f.agentId, {
    method: 'POST', headers: {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25'},
    body: JSON.stringify({jsonrpc: '2.0', id: 'remediation-fixture', method: 'tools/call', params: {name, arguments: args}}),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as {result: {structuredContent: Record<string, unknown>}};
  return body.result.structuredContent;
}

test('F01 invalid batch final action is rejected before durable admission through local SDK', offline, async () => {
  const {h, f, token, target} = await gatewayFixture();
  try {
    const result = await callMcp(h, f, token, 'batch', {target, operationKey: operationKey(), actions: [
      inline([newFile('scratch/first')]), malformedBatches[0][1],
    ]});
    assert.deepEqual({phase: result.phase, effectState: result.effectState, operationId: result.operationId},
      {phase: 'REJECTED', effectState: 'NONE', operationId: null});
    assert.deepEqual((await h.browser(f, 'poll')).operations, []);
  } finally { await h.close(); }
});

test('F05 an issued receipt survives lost admission and status responses through local SDK', offline, async () => {
  const {h, f, token, target} = await gatewayFixture();
  try {
    const workspace = h.wns.get(h.wns.idFromName(f.workspaceId));
    const drop = async (path: string) => {
      const response = await workspace.fetch('https://internal/__fixture_faults', {
        method: 'POST', body: JSON.stringify({dropAckPath: path, dropAcks: 1}),
      });
      assert.equal(response.status, 200);
    };
    const key = operationKey();
    await drop('/internal/admit');
    const admissionFailure = await callMcp(h, f, token, 'write', {target, operationKey: key,
      files: [newFile('scratch/asset')]});
    const receipt = await callMcp(h, f, token, 'operation_status', {target, operationKey: key});
    assert.equal(receipt.phase, 'ADMITTED');
    assert.equal(typeof receipt.operationId, 'string', 'admission persisted before the injected response loss');
    await drop('/internal/status');
    const statusFailure = await callMcp(h, f, token, 'operation_status', {target, operationId: receipt.operationId});
    const faults = await (await workspace.fetch('https://internal/__fixture_faults')).json() as {droppedAcks: number};
    assert.equal(faults.droppedAcks, 2, 'the fixture dropped two successful acknowledgements');
    assert.deepEqual({admission: [admissionFailure.phase, admissionFailure.effectState, admissionFailure.operationKey],
      status: [statusFailure.phase, statusFailure.effectState, statusFailure.operationId]},
    {admission: ['UNKNOWN', 'UNKNOWN', key], status: ['UNKNOWN', 'UNKNOWN', receipt.operationId]});
    const replay = await callMcp(h, f, token, 'write', {target, operationKey: key, files: [newFile('scratch/asset')]});
    assert.equal(replay.operationId, receipt.operationId);
  } finally { await h.close(); }
});
