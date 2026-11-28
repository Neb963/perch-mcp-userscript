import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorizeSyntheticOfflineAccess, settleSyntheticOAuthTasks } from '../fixtures/oauth-refresh-client.js';
import { createCapacityHarness } from './gateway-capacity-harness.js';

const day = 86_400;
const base = 'https://capacity.test';
const admin = '/api/v1/admin';

test('F16 baseline: idle credential expiry and suspension classified as invalid_grant', {
  skip: process.env.PERCH_REPRODUCE_F16 !== '1', timeout: 30_000,
}, async () => {
  const h = await createCapacityHarness(0, { DEVELOPMENT_CONTRACT_V2_ENABLED: 'true' }, {
    entryPoint: 'tests/fixtures/oauth-refresh-runtime.ts',
  });
  try {
    const connector = await h.request(`${admin}/connectors`, {
      expectedRevision: (await h.get(`${admin}/state`)).revision,
      label: 'F16 offline Connector',
    });
    const start = Math.floor(Date.now() / 1000);
    const session = await authorizeSyntheticOfflineAccess(h, {
      agentId: String(connector.id), workspaceId: '', binding: {}, lease: {}, props: {}, permissions: [],
    });
    await settleSyntheticOAuthTasks(h);
    const end = Math.floor(Date.now() / 1000);
    const grants = (await h.get(`${admin}/grants`)).items as Array<Record<string, unknown>>;
    assert.equal(grants.length, 1);
    const grant = grants[0]!;
    assert.equal(grant.state, 'active');
    assert.equal(grant.clientId, session.clientId);
    const oauth = await h.mf.getKVNamespace('OAUTH_KV');
    const clientRecords = (await oauth.list({ prefix: 'client:' })).keys;
    const grantRecords = (await oauth.list({ prefix: 'grant:' })).keys;
    const tokenRecords = (await oauth.list({ prefix: 'token:' })).keys;

    function hasTTL(expiration: unknown, ttl: number) {
      assert.equal(typeof expiration, 'number');
      assert.ok(Number(expiration) >= start + ttl && Number(expiration) <= end + ttl + 1);
    }
    assert.equal(clientRecords.length, 1);
    assert.equal(grantRecords.length, 1);
    assert.equal(tokenRecords.length, 1);
    hasTTL(clientRecords[0]!.expiration, 90 * day);
    hasTTL(grantRecords[0]!.expiration, 30 * day);
    hasTTL(tokenRecords[0]!.expiration, 900);
    hasTTL(Number(grant.expiresAt) / 1000, 30 * day);

    const refresh = () => h.mf.dispatchFetch(`${base}/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: session.clientId,
        refresh_token: session.refreshToken, resource: session.resource }),
    });
    const suspended = await h.update(`${admin}/connectors/${connector.id}`, {
      expectedRevision: connector.revision, suspended: true,
    });
    const whileSuspended = await refresh();
    assert.equal(whileSuspended.status, 400);
    assert.equal((await whileSuspended.json() as { error: string }).error, 'invalid_grant');
    await h.update(`${admin}/connectors/${connector.id}`, {
      expectedRevision: suspended.revision, suspended: false,
    });
    assert.equal((await refresh()).status, 200);
    await settleSyntheticOAuthTasks(h);
    console.log(JSON.stringify({ kind: 'F16-baseline', accessTTL: session.expiresIn,
      registryGrantTTL: 30 * day, sdkGrantTTL: 30 * day, dynamicClientTTL: 90 * day,
      suspendRefresh: 'invalid_grant', resumeRefresh: 'OK' }));
  } finally {
    await h.close();
  }
});
