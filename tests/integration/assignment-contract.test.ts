import assert from 'node:assert/strict';
import test from 'node:test';
import { createCapacityHarness } from './gateway-capacity-harness.js';
import { issueSyntheticToken } from '../fixtures/optimization-client.js';
import { encodeTarget, nextGeneration, parseTarget } from '../../packages/contracts/src/target.js';

const admin = '/api/v1/admin';
const ceiling = ['READ_SOURCE', 'WRITE_SOURCE', 'PREVIEW_CONTROL'];

test('Target encoding rejects alternate representations and generation overflow', () => {
  const target = { workspaceId: 'abc_DEF-0', assignmentGeneration: 0, bindingGeneration: Number.MAX_SAFE_INTEGER };
  assert.deepEqual(parseTarget(encodeTarget(target)), target);
  for (const value of ['w2.example.01.1', 'w2.example.1.-1', 'w2.example.1.9007199254740992',
    'w2.example.1.2\n', 'w2.a%2Eb.1.2', 'w2.a.1.2.extra', null]) {
    assert.throws(() => parseTarget(value), /Invalid Workspace Target|canonical Workspace Target/);
  }
  assert.throws(() => nextGeneration(Number.MAX_SAFE_INTEGER), /cannot advance/);
});

test('v2 Connector consent, legacy scope and indexed discovery in local workerd', async () => {
  const h = await createCapacityHarness(1, { DEVELOPMENT_CONTRACT_V2_ENABLED: 'true' });
  try {
    const legacy = h.fixtures[0]!;
    async function connector(label: string) {
      const state = await h.get(admin + '/state');
      return h.request(admin + '/connectors', { expectedRevision: state.revision, label, permissionCeiling: ceiling });
    }
    async function assignee(connector: Record<string, unknown>, label: string) {
      return h.request(admin + '/workspaces', { label, contractVersion: 2,
        connectorId: connector.id, expectedConnectorRevision: connector.revision });
    }
    async function grant(connector: Record<string, unknown>) {
      const pending = await h.internal(h.registry, '/internal/oauth/pending', {
        request: { resource: connector.endpoint, clientId: 'shared-client', redirectUri: 'https://client.test/callback', scope: ['mcp'] },
      });
      const list = await h.get(admin + '/approvals');
      const approval = (list.items as Record<string, unknown>[]).find((row) => row.id === pending.id)!;
      const decision = await h.request(admin + '/approvals/' + pending.id + '/decision', {
        expectedRevision: approval.revision, digest: approval.digest, decision: 'approve',
      });
      assert.equal(decision.contractVersion, 2);
      const consumed = await h.internal(h.registry, '/internal/oauth/consume', { id: pending.id, handle: pending.handle });
      return consumed.props as Record<string, unknown>;
    }
    const a = await connector('A'), b = await connector('B'), c = await connector('C');
    const a1 = await assignee(a, 'A1'), a2 = await assignee(a, 'A2'), b1 = await assignee(b, 'B1');
    const [pa, pb, pc] = await Promise.all([grant(a), grant(b), grant(c)]);
    async function discover(connector: Record<string, unknown>, props: Record<string, unknown>, args: Record<string, unknown> = {}) {
      return h.internal(h.registry, '/internal/v2/discover', { agentId: connector.id, props, args });
    }
    const rows = (r: Record<string, unknown>) => r.workspaces as Record<string, unknown>[];
    const ap = await discover(a, pa);
    assert.deepEqual(rows(ap).map((w) => w.label).sort(), ['A1', 'A2']);
    assert.ok(rows(ap).every((w) => w.target === null && w.identity === null));
    assert.deepEqual(rows(await discover(b, pb)).map((w) => w.label), ['B1']);
    assert.deepEqual(rows(await discover(c, pc)), []);
    const first = await discover(a, pa, { limit: 1 });
    const cursor = first.nextCursor;
    assert.equal(typeof cursor, 'string');
    const second = await discover(a, pa, { limit: 1, cursor });
    assert.notEqual(rows(first)[0]!.label, rows(second)[0]!.label);
    assert.equal(second.nextCursor, null);
    await assert.rejects(discover(b, pb, { limit: 1, cursor }), /STALE_CURSOR/);
    await assert.rejects(discover(b, pa), /REVOKED/);
    await assert.rejects(discover(a, { ...pa, clientId: 'wrong' }), /REVOKED/);
    await assert.rejects(discover(a, { ...pa, audience: b.endpoint }), /REVOKED/);
    await assert.rejects(discover(a, legacy.props), /AUTH_REQUIRED/);
    const asTarget = (w: Record<string, unknown>) => encodeTarget({
      workspaceId: String(w.id), assignmentGeneration: Number(w.assignmentGeneration), bindingGeneration: Number(w.bindingGeneration),
    });
    await assert.rejects(discover(a, pa, { target: asTarget(b1) }), /TARGET_NOT_FOUND/);
    await assert.rejects(discover(a, pa, { target: asTarget(a2) }), /STALE_TARGET/);
    await assert.rejects(h.internal(h.registry, '/internal/authorize', {
      props: legacy.props, agentId: legacy.agentId, target: asTarget(a1),
    }), /AUTH_REQUIRED/);
    const token = await issueSyntheticToken(h, { ...legacy, agentId: String(c.id) });
    const catalog = await h.mf.dispatchFetch(String(c.endpoint), {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(catalog.status, 409);
    assert.match(await catalog.text(), /UPGRADE_REQUIRED/);
    const swapped = await h.mf.dispatchFetch(String(a.endpoint), {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(swapped.status, 401);
    const approvals = await h.get(admin + '/approvals');
    assert.ok((approvals.items as Record<string, unknown>[]).every((row) => !Object.hasOwn(row, 'completionRedirect')));
    await h.update(admin + '/connectors/' + a.id, { expectedRevision: a.revision, suspended: true });
    await assert.rejects(discover(a, pa), /PAUSED/);
    await h.internal(h.registry, '/internal/authorize', { props: legacy.props, agentId: legacy.agentId });
  } finally {
    await h.close();
  }
});

test('Binding transition holds dispatched effects, preserves original Grant access and publishes once', async () => {
  const h = await createCapacityHarness(0, { DEVELOPMENT_CONTRACT_V2_ENABLED: 'true',
    DEVELOPMENT_CONTRACT_V2_EXECUTION_ENABLED: 'true' });
  try {
    const state = await h.get(admin + '/state');
    const a = await h.request(admin + '/connectors', { expectedRevision: state.revision, label: 'First Connector' });
    const b = await h.request(admin + '/connectors', { expectedRevision: (await h.get(admin + '/state')).revision, label: 'Second Connector' });
    const token = await issueSyntheticToken(h, {workspaceId:'',agentId:String(b.id),binding:{},lease:{},props:{},permissions:[]});
    const list = await h.mf.dispatchFetch(String(b.endpoint), {method:'POST',
      headers:{Authorization:'Bearer ' + token,'Content-Type':'application/json',Accept:'application/json, text/event-stream',
        'MCP-Protocol-Version':'2025-11-25'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});
    assert.equal(list.status,200);
    const catalog = await list.json() as {result?: {tools: unknown[]}};
    assert.equal(catalog.result?.tools.length,19,JSON.stringify(catalog));
    const w = await h.request(admin + '/workspaces', { label: 'Workspace', contractVersion: 2,
      connectorId: a.id, expectedConnectorRevision: a.revision });
    const workspaceId = String(w.id);
    const wPath = admin + '/workspaces/' + workspaceId;
    const stub = h.wns.get(h.wns.idFromName(workspaceId));
    const internals = (path: string, body: Record<string, unknown>) => h.internal(stub, '/internal/' + path, body);
    const registry = (path: string, body: Record<string, unknown>) => h.internal(h.registry, '/internal/' + path, body);
    const binding = (generatorId: string) => ({ generatorId, slug: generatorId, draftId: '', browserInstallationId: 'capacity-browser' });
    const proof = async (current: Record<string, unknown>, target: Record<string, unknown>) =>
      h.executionRequest('/api/v1/tab/rebind-proof', {workspaceId, expectedRevision: current.revision,
        binding: target, tabInstanceId: 'approved-document', adapterVersion: '2'});
    const claim = (target: Record<string, unknown>, version: string, tabInstanceId: string) =>
      h.executionRequest('/api/v1/tab/claim', {workspaceId, binding: target, tabInstanceId, adapterVersion: version});
    const original = binding('original');
    const originalProof = await proof(w, original);
    const bound = await h.request(wPath + '/rebind', { expectedRevision: w.revision,
      expectedConnectorRevision: a.revision, binding: original, bindingProof: originalProof.proof });
    await assert.rejects(claim(original, '1', 'old-build'), /UPGRADE_REQUIRED/);
    const lease = await claim(original, '2', 'first-document');
    assert.equal(lease.contractVersion, 2);
    await assert.rejects(claim(original, '2', 'duplicate-document'), /TAB_BUSY/);
    const browser = (path: string, args: Record<string, unknown>) =>
      h.request('/api/v1/tab/' + path, {workspaceId, epoch: lease.epoch, tabInstanceId: lease.tabInstanceId, ...args}, String(lease.leaseCredential));
    const issue = async () => {
      const authorization = await registry('oauth/pending', {request: {
        resource: a.endpoint, clientId: 'shared-client', redirectUri: 'https://client.test/callback', scope: ['mcp'],
      }});
      const approvals = await h.get(admin + '/approvals');
      const pending = (approvals.items as Record<string, unknown>[]).find((row) => row.id === authorization.id)!;
      await h.request(admin + '/approvals/' + authorization.id + '/decision', {
        expectedRevision: pending.revision, digest: pending.digest, decision: 'approve',
      });
      return (await registry('oauth/consume', { id: authorization.id, handle: authorization.handle })).props as Record<string, unknown>;
    };
    const props = await issue();
    const replacementGrant = await issue();
    const target = encodeTarget({workspaceId, assignmentGeneration: Number(bound.assignmentGeneration),
      bindingGeneration: Number(bound.bindingGeneration)});
    await browser('heartbeat', {dirty: true});
    const destination = binding('replacement');
    const destinationProof = await proof(bound, destination);
    const args = { expectedRevision: bound.revision, expectedConnectorRevision: a.revision,
      binding: destination, bindingProof: destinationProof.proof };
    await assert.rejects(h.request(wPath + '/rebind', args), /APPROVAL_REQUIRED/);
    const auth = await registry('authorize', { props, agentId: a.id, target, permissions: ['READ_SOURCE'] });
    const operationKey = 'k2.' + Date.now() + '.' + crypto.randomUUID();
    const admission = { workspace: auth.workspace, props, agentId: a.id,
      target, tool: 'read', args: { path: 'main.pjs' }, permissions: ['READ_SOURCE'],
      requiredPermissions: ['READ_SOURCE'], mutating: false, operationKey, policyRevision: auth.policyRevision };
    const operation = await internals('admit', admission);
    assert.equal((await internals('admit', admission)).operationId, operation.operationId);
    await assert.rejects(internals('admit', {...admission, args: {path: 'index.html'}}), /IDEMPOTENCY_CONFLICT/);
    await assert.rejects(internals('admit', {...admission,
      operationKey: 'k2.' + (Date.now() - 901_000) + '.' + crypto.randomUUID()}), /OPERATION_KEY_EXPIRED/);
    const polled = await browser('poll', {});
    assert.equal((polled.operations as Record<string, unknown>[])[0]!.operationId, operation.operationId);
    await browser('reply', { operationId: operation.operationId, phase: 'RUNNING' });
    const segment = {sequence: 0, kind: 'read-view', digest: 'a'.repeat(64)};
    assert.equal((await browser('segment', {operationId: operation.operationId, segment})).digest, segment.digest);
    await assert.rejects(browser('segment', {operationId: operation.operationId, segment}), /CONFLICT/);
    const key = crypto.randomUUID();
    const transition = { ...args, acknowledgeDirty: true };
    await assert.rejects(h.request(wPath + '/rebind', transition, undefined, 'POST', key), /TRANSITION_BLOCKED/);
    await assert.rejects(registry('authorize', { props, agentId: a.id, target }), /TRANSITION_BLOCKED/);
    await assert.rejects(internals('admit', {...admission, operationKey: 'k2.' + Date.now() + '.' + crypto.randomUUID()}), /TRANSITION_BLOCKED/);
    await browser('reply', { operationId: operation.operationId, phase: 'SUCCEEDED',
      result: { operationId: operation.operationId, status: 'SUCCEEDED', effectState: 'VERIFIED', data: { ok: true } } });
    const resultScope = { props, agentId: a.id, target, workspaceId, operationId: operation.operationId, bindingRevision: bound.bindingRevision };
    assert.equal((await internals('status', resultScope)).status, 'SUCCEEDED');
    assert.equal((await internals('status', {...resultScope, operationId: undefined, operationKey})).operationId,
      operation.operationId);
    await assert.rejects(internals('status', { ...resultScope, props: replacementGrant }), /NOT_FOUND/);
    const changed = await h.request(wPath + '/rebind', transition, undefined, 'POST', key);
    assert.deepEqual(await h.request(wPath + '/rebind', transition, undefined, 'POST', key), changed);
    assert.deepEqual((await h.get(admin + '/receipts/' + key)).result, changed);
    await assert.rejects(h.request(wPath + '/rebind', { ...transition, acknowledgeDirty: false }, undefined, 'POST', key), /IDEMPOTENCY_CONFLICT/);
    assert.equal(changed.assignmentGeneration, bound.assignmentGeneration);
    assert.equal(changed.bindingGeneration, Number(bound.bindingGeneration) + 1);
    await assert.rejects(internals('status', resultScope), /STALE_TARGET/);
    const next = await claim(destination, '2', 'replacement-document');
    assert.ok(Number(next.epoch) > Number(lease.epoch));
    await assert.rejects(browser('heartbeat', { dirty: false }), /STALE_EPOCH/);
    const transfer = await h.request(wPath + '/transfer', {expectedRevision: changed.revision,
      expectedConnectorRevision: a.revision, expectedDestinationConnectorRevision: b.revision,
      connectorId: b.id, acknowledgeDirty: true});
    assert.equal(transfer.connectorId, b.id);
    assert.equal(transfer.binding, null);
    const discovery = await registry('v2/discover', {props, agentId: a.id, args: {}});
    assert.deepEqual(discovery.workspaces, []);
  } finally {
    await h.close();
  }
});

test('v1 Connector upgrade preserves the endpoint and native Binding while requiring fresh consent',async()=>{
  const h=await createCapacityHarness(1,{DEVELOPMENT_CONTRACT_V2_ENABLED:'true'});
  try {
    const old=h.fixtures[0]!;
    const w=await h.get(admin+'/workspaces/'+old.workspaceId);
    const a=await h.get(admin+'/agents/'+old.agentId);
    const oldToken=await issueSyntheticToken(h,old);
    const key=crypto.randomUUID();
    const route=admin+'/connectors/'+old.agentId+'/upgrade';
    const body={expectedRevision:a.revision,expectedWorkspaceRevision:w.revision,acknowledgeReauthorization:true};
    const next=await h.request(route,body,undefined,'POST',key);
    assert.deepEqual(await h.request(route,body,undefined,'POST',key),next);
    assert.equal((next.connector as Record<string,unknown>).endpoint,a.endpoint);
    assert.deepEqual((next.workspace as Record<string,unknown>).binding,old.binding);
    assert.equal(next.reauthorizationRequired,true);
    await assert.rejects(h.internal(h.registry,'/internal/authorize',{props:old.props,agentId:old.agentId}),/REVOKED/);
    const denied=await h.mf.dispatchFetch(String(a.endpoint),{method:'POST',headers:{Authorization:'Bearer '+oldToken,
      'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});
    assert.equal(denied.status,403);
    await issueSyntheticToken(h,old);
  } finally {await h.close();}
});
