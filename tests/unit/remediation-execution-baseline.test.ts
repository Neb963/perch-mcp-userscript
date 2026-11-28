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

const offline = {timeout: 30_000};
const tuple = {workspaceId: 'fixture', installationId: 'inst', assignmentGeneration: 1,
  bindingGeneration: 1, epoch: 1, generatorId: '123', draftId: ''};
const target = 'w2.fixture.1.1';
const operationKey = () => `k2.${Date.now()}.${crypto.randomUUID()}`;
const errorCode = (code: string) => (error: unknown) => error instanceof BrowserError && error.code === code;

class CheckpointFixtureStore extends MemoryStore {
  onCheckpoint: () => void = () => {};
  onDispatch: () => void = () => {};
  onStage: () => void = () => {};
  override async set<T>(key: string, value: T): Promise<void> {
    await super.set(key, value);
    if (key.includes(':root:checkpoint:')) this.onCheckpoint();
    if (key.includes(':stage:')) this.onStage();
    if (key.includes(':journal:') && (value as {state?: unknown})?.state === 'DISPATCHED') this.onDispatch();
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

test('F01 malformed later actions are rejected at ingress and browser preflight before effects', async context => {
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

test('F04 deadline crossing during durable checkpoint stops the first native setter', async () => {
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

test('F04 operation cancellation preserves the first verified setter and stops the next', async () => {
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

test('F04 cancellation after dispatch journal but before native invocation is known no-effect', async () => {
  const f = await nativeFixture();
  const controller = new AbortController();
  f.scope.assertCurrent = () => {
    if (controller.signal.aborted) throw new BrowserError('CANCELLED', 'Synthetic operation cancellation');
  };
  f.store.onDispatch = () => { controller.abort(); };
  await assert.rejects(f.fs.run('write', {files: [newFile('src/asset')]}, f.scope), errorCode('CANCELLED'));
  assert.equal(controller.signal.aborted, true);
  assert.deepEqual(f.nativeWrites, []);
  assert.deepEqual(await f.vfs.unresolved(), []);
});

test('F04 cancellation after private staging stops publication and leaves prior bytes intact', async () => {
  const f = await nativeFixture();
  await f.fs.run('write', {files: [newFile('scratch/original')]}, f.scope);
  const before = await f.vfs.localView();
  const controller = new AbortController();
  f.scope.assertCurrent = () => {
    if (controller.signal.aborted) throw new BrowserError('CANCELLED', 'Synthetic operation cancellation');
  };
  f.store.onStage = () => { controller.abort(); };
  await assert.rejects(f.fs.run('write', {files: [newFile('scratch/new')]}, f.scope), errorCode('CANCELLED'));
  assert.equal(controller.signal.aborted, true);
  const after = await f.vfs.localView();
  assert.deepEqual(after.revision, before.revision);
  assert.deepEqual(after.files, before.files);
  assert.deepEqual(await f.vfs.unresolved(), []);
});

test('F04 the running browser controller ignores a mismatched cancellation and aborts its exact operation',
  {timeout: 5000}, async () => {
  const f = await nativeFixture();
  const phases: string[] = [];
  let cancelRequestedOperationId = 'another-operation';
  const lease = {contractVersion: 2 as const, workspaceId: tuple.workspaceId,
    epoch: tuple.epoch, bindingRevision: 1, assignmentGeneration: 1, bindingGeneration: 1, connectorId: 'connector',
    expiresAt: Date.now() + 30_000, permissions: ['READ_SOURCE', 'WRITE_SOURCE'], leaseCredential: 'synthetic-lease'};
  const transport = {tab: async (path: string, body: Record<string, unknown>) => {
    if (path === '/api/v1/tab/heartbeat') {
      assert.equal(body.activeOperationId, 'operation');
      return {expiresAt: lease.expiresAt, permissions: lease.permissions, cancelRequestedOperationId};
    }
    assert.equal(path, '/api/v1/tab/reply');
    phases.push(String(body.phase));
    if (body.phase === 'CANCELLED') assert.equal((body.result as {effectState: unknown}).effectState, 'NONE');
    return {ok: true};
  }} as unknown as GatewayTransport;
  let acceptStart!: (signal: AbortSignal) => void;
  const started = new Promise<AbortSignal>(resolve => { acceptStart = resolve; });
  const controller = new BrowserController(f.adapter, f.store, transport, {supports: () => false,
    call: async () => { throw new Error('Unexpected legacy call'); },
    callDevelopment: async ({signal, assertCurrent}) => {
      acceptStart(signal);
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), {once: true}));
      await assertCurrent();
      throw new Error('Expected operation assertion to stop');
    }});
  const bound = {...lease, tabInstanceId: controller.tabInstanceId};
  const instance = controller as unknown as {
    execute(operation: unknown, current: typeof bound): Promise<void>;
    renew(current: typeof bound, controlOnly: boolean): Promise<void>;
    vfs: VirtualFileSystem; lease: typeof bound; stopped: boolean;
  };
  instance.vfs = f.vfs;
  instance.lease = bound;
  instance.stopped = false;
  const running = instance.execute({version: 2, target, workspaceId: tuple.workspaceId, tabInstanceId: bound.tabInstanceId,
    operationId: 'operation', operationKey: operationKey(), grantId: 'grant', connectorId: 'connector',
    bindingRevision: 1, assignmentGeneration: 1, bindingGeneration: 1, epoch: tuple.epoch,
    policyRevision: 1, permissionRevision: 1, deadlineMs: Date.now() + 3000,
    traceId: 'trace', tool: 'write', args: {files: [newFile('scratch/asset')]}, permissions: lease.permissions}, bound);
  const signal = await started;
  await instance.renew(bound, true);
  assert.equal(signal.aborted, false);
  cancelRequestedOperationId = 'operation';
  await instance.renew(bound, true);
  await running;
  assert.deepEqual(phases, ['RUNNING', 'CANCELLED']);
});

test('F02 stale destination before transfer publication leaves a safely abortable transfer', async () => {
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
  const transport = {request: async () => { throw new Error('Gateway unavailable'); }} as unknown as GatewayTransport;
  await f.store.set('perch:installation-id', tuple.installationId);
  const controller = new BrowserController(f.adapter, f.store, transport);
  const scopes = await controller.localRecoveryScopes();
  const scope = scopes.find(row => row.workspaceId === tuple.workspaceId && row.epoch === 1);
  assert.ok(scope);
  const recovery = await controller.inspectLocalRecovery(scope.id);
  assert.deepEqual(recovery.records.map(hold => hold.id), ['journal-held']);
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

test('F04 actual workerd delivers cancellation only for the requested active Operation', {timeout: 30_000}, async () => {
  const {h, f, token, target} = await gatewayFixture();
  try {
    const admitted = await callMcp(h, f, token, 'write', {target, operationKey: operationKey(),
      files: [newFile('scratch/asset')]});
    const operationId = String(admitted.operationId);
    await h.browser(f, 'poll', {waitMs: 0});
    await h.browser(f, 'reply', {operationId, phase: 'RUNNING'});
    assert.equal((await h.browser(f, 'heartbeat', {activeOperationId: operationId})).cancelRequestedOperationId, undefined);
    const cancellation = await callMcp(h, f, token, 'cancel_operation', {target, operationId});
    assert.equal(cancellation.phase, 'RUNNING');
    assert.equal(cancellation.cancelRequested, true);
    assert.equal((await h.browser(f, 'heartbeat', {activeOperationId: crypto.randomUUID()})).cancelRequestedOperationId, undefined);
    assert.equal((await h.browser(f, 'heartbeat', {activeOperationId: operationId})).cancelRequestedOperationId, operationId);
    await assert.rejects(h.browser(f, 'segment', {operationId,
      segment: {kind: 'source-publication', sequence: 0, digest: await digest('fixture')}}), /CANCELLED/);
    await h.browser(f, 'reply', {operationId, phase: 'CANCELLED', result: {
      operationId, status: 'CANCELLED', effectState: 'NONE', error: {code: 'CANCELLED',
        message: 'Synthetic pre-dispatch cancellation', recovery: 'No publication occurred.', retryable: false},
    }});
    const terminal = await callMcp(h, f, token, 'operation_status', {target, operationId});
    assert.equal(terminal.phase, 'CANCELLED');
    assert.equal(terminal.effectState, 'NONE');
    assert.equal((await h.browser(f, 'heartbeat', {activeOperationId: operationId})).cancelRequestedOperationId, undefined);
  } finally { await h.close(); }
});

test('F01 invalid batch final action is rejected before durable admission through local SDK', {timeout: 30_000}, async () => {
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

test('F02 real SDK and workerd inspect a held transfer without a new permit or native setter', {timeout: 30_000}, async () => {
  const {h, f, token, target} = await gatewayFixture();
  const local = await nativeFixture();
  let segmentCalls = 0;
  try {
    const execute = async (args: Record<string, unknown>, caller = token) => {
      const operationKey = `k2.${Date.now()}.${crypto.randomUUID()}`;
      const admitted = await callMcp(h, f, caller, 'write', {target, operationKey, ...args});
      assert.equal(admitted.phase, 'ADMITTED', JSON.stringify(admitted));
      const payload = await h.browser(f, 'poll', {waitMs: 0});
      const envelope = (payload.operations as DevelopmentContext['envelope'][])[0]!;
      assert.equal(envelope.operationId, admitted.operationId);
      await h.browser(f, 'reply', {operationId: envelope.operationId, phase: 'RUNNING'});
      if (envelope.transferRecoveryOnly) {
        await assert.rejects(h.browser(f, 'segment', {operationId: envelope.operationId,
          segment: {kind: 'source-publication', digest: await digest('fixture'), sequence: 0}}), /SCOPE_DENIED/);
      }
      const context: DevelopmentContext = {envelope, vfs: local.vfs, signal: new AbortController().signal,
        assertCurrent: async () => {}, recordStep: async () => {}, additional: async () => { throw new Error('Unexpected native tool'); },
        permit: async (kind, digestValue) => { await h.browser(f, 'segment', {operationId: envelope.operationId,
          segment: {kind, digest: digestValue, sequence: 0}}); segmentCalls++; }};
      let data: Record<string, unknown>;
      try { data = await executeDevelopment(context) as Record<string, unknown>; }
      catch (error) { const fault = error as BrowserError;
        data = {status: 'REJECTED', effectState: 'NONE', errorCode: fault.code}; }
      const phase = ['PARTIAL', 'UNKNOWN', 'REJECTED'].includes(String(data.status)) ? String(data.status) : 'SUCCEEDED';
      const browserEffect = phase === 'UNKNOWN' ? 'POSSIBLE' : phase === 'PARTIAL' ? 'PARTIAL' :
        data.effectState === 'NONE' ? 'NONE' : 'VERIFIED';
      const result = {operationId: envelope.operationId, status: phase, effectState: browserEffect, data,
        ...(phase === 'SUCCEEDED' ? {} : {error: {code: phase === 'UNKNOWN' ? 'EFFECT_UNKNOWN' : 'SCOPE_DENIED',
          message: 'Synthetic transfer verification', recovery: 'Inspect the original transfer proof.', retryable: false}})};
      await h.browser(f, 'reply', {operationId: envelope.operationId, phase, result});
      return {envelope, data, terminal: await callMcp(h, f, caller, 'operation_status', {target, operationKey})};
    };
    const initial = async (path: string) => execute({mode: 'start', path, encoding: 'base64', ifAbsent: true,
      totalBytes: 0, sha256: await digest(new Uint8Array())});
    const first = await initial('src/asset');
    const second = await initial('src/other');
    const transferId = first.data.transferId;
    local.signals.onWrite = () => { local.source.set('asset', Uint8Array.of(7)); };
    const commit = await execute({mode: 'commit', transferId});
    assert.equal(commit.terminal.phase, 'UNKNOWN');
    assert.equal(commit.terminal.effectState, 'UNKNOWN');
    assert.equal(commit.envelope.transferRecoveryOnly, undefined);
    assert.deepEqual(local.nativeWrites, ['asset']);
    assert.equal(segmentCalls, 1);
    const forged = await callMcp(h, f, token, 'write', {target, operationKey: operationKey(), mode: 'abort',
      transferId, transferRecoveryOnly: true});
    assert.equal(forged.phase, 'REJECTED');
    assert.equal(forged.operationId, null);
    const readback = await execute({mode: 'abort', transferId});
    assert.equal(readback.envelope.transferRecoveryOnly, true);
    assert.equal(readback.terminal.phase, 'SUCCEEDED');
    assert.equal(readback.terminal.effectState, 'NONE');
    const retained = readback.data.transferOutcome as Record<string, unknown>;
    assert.equal(retained.status, 'UNKNOWN');
    assert.equal(retained.commitOperationId, commit.envelope.operationId);
    assert.equal(retained.commitOperationKey, commit.envelope.operationKey);
    const noNew = await execute({mode: 'commit', transferId: second.data.transferId});
    assert.equal(noNew.envelope.transferRecoveryOnly, true);
    assert.equal(noNew.terminal.phase, 'REJECTED');
    assert.equal(noNew.data.errorCode, 'SCOPE_DENIED');
    const other = await issueSyntheticToken(h, f);
    const hidden = await execute({mode: 'abort', transferId}, other);
    assert.equal(hidden.envelope.transferRecoveryOnly, true);
    assert.equal(hidden.data.errorCode, 'NOT_FOUND');
    assert.deepEqual(local.nativeWrites, ['asset']);
    assert.equal(segmentCalls, 1);
  } finally { await h.close(); }
});
