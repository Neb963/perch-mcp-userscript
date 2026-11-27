import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCapacityHarness} from './gateway-capacity-harness.js';
import {fixtureSnapshot,metricDelta,syntheticMcp} from '../fixtures/optimization-client.js';
import {authorizeSyntheticOfflineAccess,refreshSyntheticSession,settleSyntheticOAuthTasks} from '../fixtures/oauth-refresh-client.js';

test('actual SDK offline refresh rotates scoped tokens with bounded KV writes and stops after revocation',{timeout:30000},async()=>{
  const h=await createCapacityHarness(1,{}, {entryPoint:'tests/fixtures/oauth-refresh-runtime.ts'});
  try {
    const f=h.fixtures[0]!;
    let session=await authorizeSyntheticOfflineAccess(h,f);await settleSyntheticOAuthTasks(h);
    assert.equal(session.expiresIn,900);
    for(let repeat=0;repeat<2;repeat++) {
      const before=await fixtureSnapshot(h,f);
      session=await refreshSyntheticSession(h,session);await settleSyntheticOAuthTasks(h);
      const usage=metricDelta(before,await fixtureSnapshot(h,f));
      assert.equal(usage.worker!.kvGet,2);
      assert.equal(usage.worker!.kvPut,2);
      assert.equal(usage.worker!.kvDelete,0);assert.equal(usage.worker!.kvList,0);
      assert.ok(usage.registry!.sqlReads!<=25);
      await syntheticMcp(h,f,session.accessToken,'list_skills',{});await settleSyntheticOAuthTasks(h);
    }
    const grants=await h.get('/api/v1/admin/grants');
    const grant=(grants.items as Record<string,unknown>[]).find(row=>row.clientId===session.clientId);
    assert.ok(grant,'Exact synthetic SDK Grant must be visible to the Operator.');
    await h.request('/api/v1/admin/grants/'+grant.id+'/revoke',{expectedRevision:grant.revision});
    const before=await fixtureSnapshot(h,f);
    await assert.rejects(()=>refreshSyntheticSession(h,session));await settleSyntheticOAuthTasks(h);
    const denied=metricDelta(before,await fixtureSnapshot(h,f));
    assert.equal(denied.worker!.kvPut,0,'Revocation must prevent a refreshed token from being persisted.');
  } finally {await h.close();}
});
