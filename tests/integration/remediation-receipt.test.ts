import assert from 'node:assert/strict';
import test from 'node:test';
import { uploadImageResult } from '../../apps/userscript/src/image-transfer.js';
import { activateSyntheticNative, issueSyntheticToken, type Harness } from '../fixtures/optimization-client.js';
import { createCapacityHarness, type CapacityFixture } from './gateway-capacity-harness.js';

const admin = '/api/v1/admin';
const writeArgs = {
  files: [{ path: 'scratch/asset', encoding: 'utf8', content: 'synthetic', ifAbsent: true }],
};
const operationKey = () => `k2.${Date.now()}.${crypto.randomUUID()}`;
const redacted = 'synthetic-result-bytes';

async function scopedFixture(capture = false, native = false) {
  const h = await createCapacityHarness(1, {
    DEVELOPMENT_CONTRACT_V2_ENABLED: 'true',
    DEVELOPMENT_CONTRACT_V2_EXECUTION_ENABLED: 'true',
    ...(native ? {CANONICAL_STORAGE_MODE: 'native', BINARY_PAYLOADS_ENABLED: 'true'} : {}),
  }, { entryPoint: 'tests/fixtures/optimization-fault-runtime.ts' });
  try {
    const f = h.fixtures[0]!;
    if (native) await activateSyntheticNative(h, f);
    const workspacePath = admin + '/workspaces/' + f.workspaceId;
    const connectorPath = admin + '/connectors/' + f.agentId;
    const connector = await h.get(admin + '/agents/' + f.agentId);
    const upgrade = await h.request(connectorPath + '/upgrade', {
      expectedRevision: connector.revision,
      expectedWorkspaceRevision: (await h.get(workspacePath)).revision,
      acknowledgeReauthorization: true,
    });
    const workspace = upgrade.workspace as Record<string, unknown>;
    if (capture) {
      const permissions = [...workspace.permissions as string[], 'CAPTURE_PREVIEW'];
      await h.update(connectorPath, {
        expectedRevision: (upgrade.connector as Record<string, unknown>).revision,
        permissionCeiling: permissions,
      });
      await h.update(workspacePath, { expectedRevision: workspace.revision, permissions });
    }
    f.lease = await h.executionRequest('/api/v1/tab/claim', {
      workspaceId: f.workspaceId, binding: f.binding, tabInstanceId: 'receipt-tab', adapterVersion: '2',
    });
    const token = await issueSyntheticToken(h, f);
    const target = `w2.${f.workspaceId}.${workspace.assignmentGeneration}.${workspace.bindingGeneration}`;
    const stub = h.wns.get(h.wns.idFromName(f.workspaceId));
    return {
      h, f, target,
      call: (name: string, args: Record<string, unknown>) => call(h, f, token, name, {target, ...args}),
      fault: (args: Record<string, unknown>) => h.internal(stub, '/__fixture_faults', args),
    };
  } catch (error) {
    await h.close();
    throw error;
  }
}

async function call(h: Harness, f: CapacityFixture, token: string, name: string, args: Record<string, unknown>) {
  const response = await h.mf.dispatchFetch('https://capacity.test/mcp/' + f.agentId, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token, 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25',
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 'receipt-fixture', method: 'tools/call', params: {name, arguments: args},
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as {
    result: { content: {type: string; text?: string}[]; structuredContent: Record<string, unknown>; isError: boolean };
  };
  return body.result;
}

async function finish(fixture: Awaited<ReturnType<typeof scopedFixture>>, id: string, data: unknown,
  phase: 'SUCCEEDED' | 'PARTIAL' = 'SUCCEEDED', effectState = phase === 'SUCCEEDED' ? 'VERIFIED' : 'PARTIAL') {
  const {h, f} = fixture;
  const poll = await h.browser(f, 'poll', {waitMs: 0});
  assert.equal((poll.operations as Record<string, unknown>[])[0]?.operationId, id);
  await h.browser(f, 'reply', {operationId: id, phase: 'RUNNING'});
  await h.browser(f, 'reply', {operationId: id, phase, result: {
    operationId: id, status: phase, data, effectState,
    ...(phase === 'PARTIAL' ? {
      error: {code: 'PARTIAL_EFFECT', message: 'Synthetic partial outcome.', retryable: false, recovery: 'Inspect the receipt.'},
    } : {}),
  }});
}

function receipt(result: Awaited<ReturnType<typeof call>>) {
  const {phase, effectState, operationId, operationKey, resultAvailability, target} = result.structuredContent;
  return {phase, effectState, operationId, operationKey, resultAvailability, target};
}

test('F05 A27-lost-admission-ack A27-retry-same A27-retry-changed retain exact correlation through the pinned SDK',
  {timeout: 30_000}, async () => {
    const fixture = await scopedFixture();
    const {h, target, call, fault} = fixture;
    try {
      const key = operationKey();
      await fault({dropAckPath: '/internal/admit', dropAcks: 1});
      const lost = await call('write', {operationKey: key, ...writeArgs});
      assert.deepEqual(receipt(lost), {
        phase: 'UNKNOWN', effectState: 'UNKNOWN', operationId: null, operationKey: key,
        resultAvailability: 'UNAVAILABLE', target,
      });
      assert.equal(lost.isError, true);
      assert.equal((lost.structuredContent.error as {retryable: boolean}).retryable, false);

      const found = await call('operation_status', {operationKey: key});
      const originalId = found.structuredContent.operationId;
      assert.equal(typeof originalId, 'string');
      assert.equal(found.structuredContent.phase, 'ADMITTED');
      const replay = await call('write', {operationKey: key, ...writeArgs});
      assert.equal(replay.structuredContent.operationId, originalId);
      const conflict = await call('write', {
        operationKey: key, files: [{...writeArgs.files[0], content: 'different'}],
      });
      assert.equal(conflict.structuredContent.phase, 'REJECTED');
      assert.equal(conflict.structuredContent.effectState, 'NONE');
      assert.equal((conflict.structuredContent.error as {code: string}).code, 'IDEMPOTENCY_CONFLICT');

      await fault({dropAckPath: '/internal/status', dropAcks: 1});
      const lostStatus = await call('operation_status', {operationId: originalId});
      assert.deepEqual(receipt(lostStatus), {
        phase: 'UNKNOWN', effectState: 'UNKNOWN', operationId: originalId, operationKey: null,
        resultAvailability: 'UNAVAILABLE', target,
      });
      await fault({dropAckPath: '/internal/cancel', dropAcks: 1});
      const lostCancel = await call('cancel_operation', {operationKey: key});
      assert.equal(lostCancel.structuredContent.phase, 'UNKNOWN');
      assert.equal(lostCancel.structuredContent.operationKey, key);
      const cancelled = await call('operation_status', {operationId: originalId});
      assert.equal(cancelled.structuredContent.phase, 'CANCELLED');
      assert.equal(cancelled.structuredContent.effectState, 'NONE');
      assert.deepEqual((await h.browser(fixture.f, 'poll', {waitMs: 0})).operations, []);
    } finally { await h.close(); }
  });

test('F05 A24-successful-large-result A24-partial-large-result A24-expiry retain terminal phase without result bytes',
  {timeout: 30_000}, async (context) => {
    const fixture = await scopedFixture();
    const {h, target, call, fault} = fixture;
    try {
      let verified: {id: string; key: string} | undefined;
      for (const phase of ['SUCCEEDED', 'PARTIAL'] as const) {
        await context.test(phase, async () => {
          const key = operationKey();
          const admitted = await call('write', {operationKey: key, ...writeArgs});
          const id = String(admitted.structuredContent.operationId);
          await finish(fixture, id, { marker: redacted, bytes: 'z'.repeat(250_000) }, phase);
          const result = await call('operation_status', {operationId: id});
          assert.deepEqual(receipt(result), {
            phase, effectState: phase === 'SUCCEEDED' ? 'KNOWN' : 'PARTIAL', operationId: id, operationKey: key,
            resultAvailability: 'TOO_LARGE', target,
          });
          assert.equal(JSON.stringify(result).includes(redacted), false);
          if (phase === 'SUCCEEDED') verified = {id, key};
        });
      }
      assert.ok(verified);
      await fault({now: Date.now() + 601_000});
      const expired = await call('operation_status', {operationId: verified.id});
      assert.deepEqual(receipt(expired), {
        phase: 'SUCCEEDED', effectState: 'KNOWN', operationId: verified.id, operationKey: verified.key,
        resultAvailability: 'EXPIRED', target,
      });
      assert.equal(JSON.stringify(expired).includes(redacted), false);
    } finally { await h.close(); }
  });

test('F05 A24-projection-failure preserves exact phase across image projection and hydration failures',
  {timeout: 30_000}, async (context) => {
    const fixture = await scopedFixture(true);
    const {h, target, call} = fixture;
    try {
      for (const availability of ['UNAVAILABLE', 'EXPIRED'] as const) {
        await context.test(availability, async () => {
          const key = operationKey();
          const admitted = await call('capture_page_image', {operationKey: key});
          const id = String(admitted.structuredContent.operationId);
          assert.equal(admitted.structuredContent.phase, 'ADMITTED', JSON.stringify(admitted));
          const image = availability === 'UNAVAILABLE'
            ? {type: 'image', mimeType: 'image/png', data: redacted}
            : {type: 'image', mimeType: 'image/png',
              imageTransfer: {operationId: id, index: 0, byteLength: 8, sha256: 'a'.repeat(64)}};
          await finish(fixture, id, {content: [image]});
          const result = await call('operation_status', {operationId: id});
          assert.deepEqual(receipt(result), {
            phase: 'SUCCEEDED', effectState: 'NONE', operationId: id, operationKey: key,
            resultAvailability: availability, target,
          });
          assert.deepEqual(result.content.map(item => item.type), ['text']);
          assert.equal(JSON.stringify(result).includes(redacted), false);
          assert.equal(JSON.stringify(result).includes('imageTransfer'), false);
        });
      }
    } finally { await h.close(); }
  });

test('F05 A09-revoked-during-projection revocation before the final result ACL withholds the hydrated receipt',
  {timeout: 30_000}, async () => {
    const fixture = await scopedFixture(true);
    const {h, f, call} = fixture;
    try {
      const key = operationKey();
      const admitted = await call('capture_page_image', {operationKey: key});
      const id = String(admitted.structuredContent.operationId);
      assert.equal(admitted.structuredContent.phase, 'ADMITTED');
      const polled = await h.browser(f, 'poll', {waitMs: 0});
      assert.equal((polled.operations as Record<string, unknown>[])[0]?.operationId, id);
      await h.browser(f, 'reply', {operationId: id, phase: 'RUNNING'});
      const pixels = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=';
      const data = await uploadImageResult({
        content: [{type: 'image', mimeType: 'image/png', data: pixels}],
      }, {
        operation: {operationId: id, workspaceId: f.workspaceId, epoch: Number(f.lease.epoch),
          bindingRevision: Number(f.lease.bindingRevision), tabInstanceId: String(f.lease.tabInstanceId)},
        send: body => h.browser(f, 'image', body),
      });
      await h.browser(f, 'reply', {operationId: id, phase: 'SUCCEEDED', result: {
        operationId: id, status: 'SUCCEEDED', effectState: 'VERIFIED', data,
      }});
      const authorized = await call('operation_status', {operationId: id});
      assert.deepEqual(authorized.content.slice(1), [{type: 'image', mimeType: 'image/png', data: pixels}]);
      assert.equal(JSON.stringify(authorized.structuredContent).includes(pixels), false);

      const grants = (await h.get(admin + '/grants')).items as Record<string, unknown>[];
      const grant = grants.find(item => item.agentId === f.agentId && item.state === 'active');
      assert.ok(grant);
      const hook = '/__fixture_revoke_before_authorization';
      const armed = await h.internal(h.registry, hook, {
        // Scoped tools/call skips the redundant generic ingress check. The
        // four required fresh checks are Target auth, Workspace status auth,
        // image auth, then post-hydration result-delivery revocation recheck.
        beforeAuthorization: 4, grantId: grant.id, revision: grant.revision,
        adminCredential: h.syntheticPairing().adminCredential,
      });
      assert.equal(armed.armed, true);
      const denied = await call('operation_status', {operationId: id});
      assert.equal(denied.isError, true);
      assert.equal(denied.structuredContent.phase, 'UNKNOWN');
      assert.equal(denied.structuredContent.operationId, id);
      assert.equal((denied.structuredContent.error as {code: string}).code, 'REVOKED');
      assert.deepEqual(denied.content.map(item => item.type), ['text']);
      assert.equal(JSON.stringify(denied).includes(pixels), false);
      const stored = (await h.get(admin + '/grants')).items as Record<string, unknown>[];
      assert.equal(stored.find(item => item.id === grant.id)?.state, 'revoked');
    } finally { await h.close(); }
  });

test('F05 F08 A16-net-zero-expiry retains the exact no-effect receipt across result cleanup and restart',
  {timeout: 30_000}, async context => {
    for (const native of [false, true]) {
      await context.test(native ? 'native storage' : 'legacy storage', async () => {
        const fixture = await scopedFixture(false, native);
        const {h, f, target, call, fault} = fixture;
        try {
          const key = operationKey();
          const admitted = await call('batch', {operationKey: key, actions: [
            {tool: 'write', args: writeArgs},
            {tool: 'delete', args: {base: 'previous', paths: [{path: 'scratch/asset'}]}},
          ]});
          assert.equal(admitted.structuredContent.phase, 'ADMITTED', JSON.stringify(admitted));
          const id = String(admitted.structuredContent.operationId);
          await finish(fixture, id, {effectState: 'NONE'}, 'SUCCEEDED', 'NONE');
          const beforeExpiry = await call('operation_status', {operationId: id});
          assert.equal(beforeExpiry.structuredContent.effectState, 'NONE');

          await fault({now: Date.now() + 601_000});
          const stub = h.wns.get(h.wns.idFromName(f.workspaceId));
          const restart = await stub.fetch('https://internal/__fixture_restart');
          assert.equal(restart.status, 200);
          const after = await call('operation_status', {operationKey: key});
          assert.deepEqual(receipt(after), {
            phase: 'SUCCEEDED', effectState: 'NONE', operationId: id, operationKey: key,
            resultAvailability: 'EXPIRED', target,
          });
          const afterCleanup = await call('operation_status', {operationId: id});
          assert.deepEqual(receipt(afterCleanup), receipt(after));
        } finally { await h.close(); }
      });
    }
  });
