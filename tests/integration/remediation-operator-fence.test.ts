import assert from 'node:assert/strict';
import test from 'node:test';
import { issueSyntheticToken, syntheticMcp } from '../fixtures/optimization-client.js';
import { createCapacityHarness } from './gateway-capacity-harness.js';

test('operator restore reserves an exact Writer and releases it only on a settled result', { timeout: 30_000 }, async () => {
  const harness = await createCapacityHarness(1, {
    DEVELOPMENT_CONTRACT_V2_ENABLED: 'true',
    DEVELOPMENT_CONTRACT_V2_EXECUTION_ENABLED: 'true',
  });
  try {
    const fixture = harness.fixtures[0]!;
    const admin = '/api/v1/admin';
    const workspacePath = admin + '/workspaces/' + fixture.workspaceId;
    const workspace = await harness.get(workspacePath);
    const connector = await harness.get(admin + '/agents/' + fixture.agentId);
    const upgrade = await harness.request(admin + '/connectors/' + fixture.agentId + '/upgrade', {
      expectedRevision: connector.revision,
      expectedWorkspaceRevision: workspace.revision,
      acknowledgeReauthorization: true,
    });
    const upgraded = upgrade.workspace as Record<string, unknown>;
    fixture.lease = await harness.executionRequest('/api/v1/tab/claim', {
      workspaceId: fixture.workspaceId,
      binding: fixture.binding,
      tabInstanceId: 'operator-restore-fixture',
      adapterVersion: '2',
    });
    const token = await issueSyntheticToken(harness, fixture);
    const target = `w2.${upgraded.id}.${upgraded.assignmentGeneration}.${upgraded.bindingGeneration}`;
    const read = () => syntheticMcp(harness, fixture, token, 'read', { target, files: [{ path: 'main.pjs' }] });
    const reserve = (operationId: string, archiveSha256 = 'a'.repeat(64)) =>
      harness.browser(fixture, 'operator-restore', { action: 'acquire', operationId, archiveSha256 });
    const check = (operationId: string) => harness.browser(fixture, 'operator-restore', { action: 'check', operationId });
    const finish = (operationId: string, phase: 'SUCCEEDED' | 'UNKNOWN') =>
      harness.browser(fixture, 'reply', { operationId, phase, result: {
        operationId, status: phase, effectState: phase === 'SUCCEEDED' ? 'VERIFIED' : 'POSSIBLE',
        ...(phase === 'UNKNOWN' ? {error: {code:'EFFECT_UNKNOWN', message:'Synthetic restore receipt.',
          retryable:false, recovery:'Inspect the exact Workspace.'}} : {}),
      } });

    const settled = crypto.randomUUID();
    assert.equal((await reserve(settled)).operationId, settled);
    assert.equal((await reserve(settled)).operationId, settled);
    await assert.rejects(reserve(settled, 'b'.repeat(64)), /CONFLICT/);
    await assert.rejects(check(crypto.randomUUID()), /STALE_EPOCH/);
    assert.equal((await check(settled)).operationId, settled);
    await assert.rejects(read(), /"phase":"REJECTED","effectState":"NONE".*TRANSITION_BLOCKED/);
    await finish(settled, 'SUCCEEDED');

    const uncertain = crypto.randomUUID();
    assert.equal((await reserve(uncertain)).operationId, uncertain);
    await finish(uncertain, 'UNKNOWN');
    await assert.rejects(read(), /TRANSITION_BLOCKED/);
    await assert.rejects(reserve(crypto.randomUUID()), /TAB_BUSY/);
    const recovery = await harness.get(workspacePath + '/recovery');
    const held = (recovery.blockingOperations as Record<string, unknown>[]).find(item => item.operationId === uncertain);
    assert.equal(held?.phase, 'UNKNOWN');
    assert.equal(held?.tool, 'operator_source_restore');
  } finally {
    await harness.close();
  }
});
