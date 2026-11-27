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
    await assert.rejects(discover(a, pa), /REVOKED/);
    await h.internal(h.registry, '/internal/authorize', { props: legacy.props, agentId: legacy.agentId });
  } finally {
    await h.close();
  }
});
