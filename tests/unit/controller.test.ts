import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserController, type AdditionalTools, type RuntimeContext } from '../../apps/userscript/src/controller.js';
import { NativeAdapter } from '../../apps/userscript/src/adapter.js';
import { GatewayTransport } from '../../apps/userscript/src/transport.js';
import { MemoryStore } from '../../apps/userscript/src/storage.js';
import type { KeyValueStore, NativeIdentity } from '../../apps/userscript/src/native-types.js';
import type { SourceTools } from '../../apps/userscript/src/source-tools.js';
import type { Envelope, Permission } from '../../packages/contracts/src/index.js';

type Lease = { workspaceId: string; epoch: number; bindingRevision: number; tabInstanceId: string; leaseCredential: string; expiresAt: number; permissions: string[] };
type Internals = { lease: Lease; identity: NativeIdentity; stopped: boolean; source: SourceTools; execute(raw: unknown, lease: Lease): Promise<void> };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function harness(options: { store?: KeyValueStore; tool?: AdditionalTools['call']; failAck?: boolean; permissions?: Permission[] } = {}) {
  const store = options.store ?? new MemoryStore();
  let identity: NativeIdentity = { generatorId: 'native-id', slug: 'fixture', draftId: '' };
  const adapter = { identity: async () => identity, probe: async () => ({ ready: true, identity, dirty: true }), bind: () => {} } as unknown as NativeAdapter;
  const replies: Record<string, unknown>[] = [];
  const transport = {
    configuration: () => ({ paired: true, origin: 'https://fixture.workers.dev' }),
    installationId: async () => 'installation',
    tab: async (_path: string, body: Record<string, unknown>) => {
      if (options.failAck && body.phase === 'RUNNING') throw new Error('ACK transport lost');
      replies.push(body); return { ok: true };
    },
  } as unknown as GatewayTransport;
  let effects = 0;
  const tools: AdditionalTools = { supports: name => ['execute_js', 'page_eval'].includes(name), call: async (name, args, context) => { effects++; return options.tool ? options.tool(name, args, context) : { value: 1 }; } };
  const controller = new BrowserController(adapter, store, transport, tools);
  const lease: Lease = { workspaceId: 'workspace', epoch: 2, bindingRevision: 1, tabInstanceId: controller.tabInstanceId, leaseCredential: 'secret', expiresAt: Date.now() + 180000, permissions: options.permissions ?? ['COMPUTE', 'PREVIEW_EXECUTE', 'WRITE_SOURCE', 'READ_SOURCE'] };
  const internal = controller as unknown as Internals;
  Object.assign(internal, { lease, identity, stopped: false, source: { supports: () => false } as unknown as SourceTools });
  const envelope = (changes: Partial<Envelope> = {}): Envelope => ({ version: 1, operationId: 'operation', workspaceId: lease.workspaceId, epoch: lease.epoch, bindingRevision: lease.bindingRevision, tabInstanceId: controller.tabInstanceId, deadlineMs: Date.now() + 30000, tool: 'execute_js', args: { js: 'return 1' }, permissions: ['COMPUTE'], traceId: 'trace', ...changes });
  return { controller, internal, lease, store, replies, envelope, effects: () => effects, changeIdentity: (value: NativeIdentity) => { identity = value; } };
}

test('controller persists intent before ACK/effect and replays only a retained result', async () => {
  const h = harness(); const envelope = h.envelope();
  await h.internal.execute(envelope, h.lease);
  assert.equal(h.effects(), 1);
  assert.equal(h.replies[0]?.phase, 'RUNNING');
  assert.equal(h.replies[1]?.phase, 'SUCCEEDED');
  const operation = await h.store.get<Record<string, unknown>>('perch:operation:workspace:operation');
  assert.equal(operation?.status, 'SUCCEEDED');
  await h.internal.execute(envelope, h.lease);
  assert.equal(h.effects(), 1);
  assert.equal(h.replies.at(-1)?.phase, 'SUCCEEDED');
});

test('controller rejects changed arguments under an existing Operation ID', async () => {
  const h = harness(); const envelope = h.envelope();
  await h.internal.execute(envelope, h.lease);
  await assert.rejects(h.internal.execute({ ...envelope, args: { js: 'return 2' } }, h.lease));
  assert.equal(h.effects(), 1);
});

test('controller rejects permission-ceiling changes under an existing Operation ID', async () => {
  const h = harness(); const envelope = h.envelope();
  await h.internal.execute(envelope, h.lease);
  await assert.rejects(h.internal.execute({ ...envelope, permissions: ['COMPUTE', 'PREVIEW_EXECUTE'] }, h.lease));
  assert.equal(h.effects(), 1);
});

test('controller never retries a durable RUNNING intent after an ACK transport failure', async () => {
  const h = harness({ failAck: true }); const envelope = h.envelope();
  await assert.rejects(h.internal.execute(envelope, h.lease));
  assert.equal(h.effects(), 0);
  await h.internal.execute(envelope, h.lease);
  assert.equal(h.effects(), 0);
  assert.equal(h.replies.at(-1)?.phase, 'UNKNOWN');
});

test('controller refuses effects if durable intent storage fails', async () => {
  class FailedStore extends MemoryStore { override async set<T>(): Promise<void> { throw new Error('Storage unavailable'); } }
  const h = harness({ store: new FailedStore() });
  await assert.rejects(h.internal.execute(h.envelope(), h.lease));
  assert.equal(h.effects(), 0);
  assert.equal(h.replies.length, 0);
});

test('controller does not repeat an effect if terminal storage fails after execution', async () => {
  class FailedTerminalStore extends MemoryStore {
    override async set<T>(key: string, value: T): Promise<void> {
      if (value && typeof value === 'object' && 'status' in value && value.status !== 'RUNNING') throw new Error('Terminal write failed');
      return super.set(key, value);
    }
  }
  const h = harness({ store: new FailedTerminalStore() }); const envelope = h.envelope();
  await assert.rejects(h.internal.execute(envelope, h.lease));
  assert.equal(h.effects(), 1);
  await h.internal.execute(envelope, h.lease);
  assert.equal(h.effects(), 1);
  assert.equal(h.replies.at(-1)?.phase, 'UNKNOWN');
});

test('controller rejects wrong binding, Epoch and document before ACK or native effects', async () => {
  for (const change of [{ workspaceId: 'other-workspace' }, { epoch: 1 }, { tabInstanceId: 'other-tab' }, { bindingRevision: 2 }]) {
    const h = harness(); await assert.rejects(h.internal.execute(h.envelope(change), h.lease));
    assert.equal(h.effects(), 0); assert.equal(h.replies.length, 0);
  }
  const h = harness(); h.changeIdentity({ generatorId: 'native-id', slug: 'fixture', draftId: 'different-draft' });
  await assert.rejects(h.internal.execute(h.envelope(), h.lease));
  assert.equal(h.effects(), 0); assert.equal(h.replies.length, 0);
});

test('controller bounds child tool permissions by the Grant ceiling despite a broader lease', async () => {
  const h = harness({ tool: async (name, _args, context) => {
    if (name === 'execute_js') return context.call('page_eval', { js: 'return document.title' });
    assert.fail('Preview execution exceeded the parent Grant.');
  } });
  await h.internal.execute(h.envelope({ permissions: ['COMPUTE'] }), h.lease);
  assert.equal(h.effects(), 1); // parent only; child denied before adapter dispatch
  const result = h.replies.at(-1)?.result as { status: string; error: { code: string } };
  assert.equal(result.status, 'REJECTED'); assert.equal(result.error.code, 'SCOPE_DENIED');
});

test('controller denies concurrent execution and Workspace switch while an effect runs', async () => {
  const started = deferred<void>(), finish = deferred<void>();
  const h = harness({ tool: async () => { started.resolve(); await finish.promise; return { value: 1 }; } });
  const running = h.internal.execute(h.envelope(), h.lease); await started.promise;
  await assert.rejects(h.internal.execute(h.envelope({ operationId: 'second-operation' }), h.lease), (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === 'TAB_BUSY');
  await assert.rejects(h.controller.attach({ id: 'other-workspace' }), (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === 'TAB_BUSY');
  finish.resolve(); await running;
  assert.equal(h.effects(), 1);
});

test('controller pause aborts subsequent child calls without asserting retroactive cancellation', async () => {
  const started = deferred<void>(), resume = deferred<void>(); let context!: RuntimeContext;
  const h = harness({ tool: async (_name, _args, captured) => { context = captured; started.resolve(); await resume.promise; await assert.rejects(captured.call('page_eval', { js: 'return 1' })); return { value: 1 }; } });
  const running = h.internal.execute(h.envelope({ permissions: ['COMPUTE', 'PREVIEW_EXECUTE'] }), h.lease); await started.promise;
  await h.controller.pause(); assert.equal(context.signal.aborted, true);
  resume.resolve(); await running;
  assert.equal(h.effects(), 1);
  assert.notEqual(h.replies.at(-1)?.phase, 'CANCELLED');
});

test('controller preserves a trusted explicit no-effect timeout without an UNKNOWN hold', async () => {
  const h = harness({ tool: async () => { throw Object.assign(new Error('Isolated loop terminated'), { code: 'TIMEOUT', effectState: 'NONE' }); } });
  await h.internal.execute(h.envelope(), h.lease);
  const result = h.replies.at(-1)?.result as { status: string; effectState: string };
  assert.equal(result.status, 'REJECTED'); assert.equal(result.effectState, 'NONE');
  assert.equal(h.internal.stopped, false);
});

test('controller preserves partial and unknown effect states even for otherwise safe error codes', async () => {
  for (const state of ['PARTIAL', 'UNKNOWN']) {
    const h = harness({ tool: async () => { throw Object.assign(new Error('Interrupted broker effect'), { code: 'LIMIT_EXCEEDED', effectState: state }); } });
    await h.internal.execute(h.envelope(), h.lease);
    const result = h.replies.at(-1)?.result as { status: string; effectState: string };
    assert.equal(result.status, state); assert.equal(result.effectState, state === 'UNKNOWN' ? 'POSSIBLE' : 'PARTIAL');
    assert.equal(h.internal.stopped, true);
  }
});
