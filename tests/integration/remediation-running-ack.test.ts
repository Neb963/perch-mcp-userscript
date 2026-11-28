import assert from 'node:assert/strict';
import test from 'node:test';
import {createCapacityHarness} from './gateway-capacity-harness.js';
import {activateSyntheticNative,issueSyntheticToken,syntheticMcp,fixtureSnapshot,metricDelta}
  from '../fixtures/optimization-client.js';

test('R04 native v2 RUNNING acknowledgment avoids unrelated maintenance yet expires its exact operation fail-closed', {timeout:45_000}, async()=>{
  const h=await createCapacityHarness(1,{
    DEVELOPMENT_CONTRACT_V2_ENABLED:'true',
    DEVELOPMENT_CONTRACT_V2_EXECUTION_ENABLED:'true',
    CANONICAL_STORAGE_MODE:'native',
    BINARY_PAYLOADS_ENABLED:'true',
  },{entryPoint:'tests/fixtures/optimization-runtime.ts'});
  try {
    const f=h.fixtures[0]!;
    await activateSyntheticNative(h,f);
    const admin='/api/v1/admin';
    const old=await h.get(admin+'/workspaces/'+f.workspaceId);
    const connector=await h.get(admin+'/agents/'+f.agentId);
    const upgraded=await h.request(admin+'/connectors/'+f.agentId+'/upgrade',{
      expectedRevision:connector.revision,expectedWorkspaceRevision:old.revision,
      acknowledgeReauthorization:true,
    });
    const bound=upgraded.workspace as Record<string,unknown>;
    const target='w2.'+f.workspaceId+'.'+bound.assignmentGeneration+'.'+bound.bindingGeneration;
    f.lease=await h.executionRequest('/api/v1/tab/claim',{
      workspaceId:f.workspaceId,binding:f.binding,adapterVersion:'2',tabInstanceId:'r04-running-fence',
    });
    const token=await issueSyntheticToken(h,f);
    const invoke=async()=> {
      const operationKey='k2.'+Date.now()+'.'+crypto.randomUUID();
      const admitted=await syntheticMcp(h,f,token,'read',{target,operationKey,
        files:[{path:'main.pjs'}]});
      assert.equal(admitted.phase,'ADMITTED');
      const poll=await h.browser(f,'poll',{waitMs:0});
      assert.equal((poll.operations as Record<string,unknown>[])[0]?.operationId,admitted.operationId);
      return {operationId:String(admitted.operationId),operationKey};
    };
    const normal=await invoke();
    const before=await fixtureSnapshot(h,f);
    await h.browser(f,'reply',{operationId:normal.operationId,phase:'RUNNING'});
    const cost=metricDelta(before,await fixtureSnapshot(h,f));
    assert.ok(cost.workspace,'A native Workspace metric sample is required');
    assert.equal(cost.workspace.requests,1);
    assert.ok((cost.workspace.sqlReads??Infinity)<20,
      'RUNNING acknowledgement should not enumerate global expiry and maintenance indexes');
    await h.browser(f,'reply',{operationId:normal.operationId,phase:'SUCCEEDED',result:{
      operationId:normal.operationId,status:'SUCCEEDED',effectState:'NONE',data:{fixture:true},
    }});
    const result=await syntheticMcp(h,f,token,'operation_status',{target,operationKey:normal.operationKey});
    assert.equal(result.phase,'SUCCEEDED');
    const expired=await invoke();
    const w=h.wns.get(h.wns.idFromName(f.workspaceId));
    const forced=await w.fetch('https://internal/__fixture_expire_operation',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({operationId:expired.operationId}),
    });
    assert.equal(forced.status,200);
    assert.equal((await forced.json() as {changed:number}).changed,1);
    await assert.rejects(h.browser(f,'reply',{operationId:expired.operationId,phase:'RUNNING'}),
      /CONFLICT|CANCELLED|EFFECT_UNKNOWN/);
    const status=await syntheticMcp(h,f,token,'operation_status',{target,operationKey:expired.operationKey});
    assert.equal(status.phase,'UNKNOWN');
    assert.equal(status.effectState,'UNKNOWN');
  }finally{await h.close();}
});
