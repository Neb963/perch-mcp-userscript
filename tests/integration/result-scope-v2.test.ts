import assert from 'node:assert/strict';
import test from 'node:test';
import { createCapacityHarness } from './gateway-capacity-harness.js';
import { issueSyntheticToken, syntheticMcp } from '../fixtures/optimization-client.js';

test('W2 v2 result and cancel enforce original Grant/Target at Workspace before releasing or mutating',async()=>{
  const h=await createCapacityHarness(1,{DEVELOPMENT_CONTRACT_V2_ENABLED:'true',
    DEVELOPMENT_CONTRACT_V2_EXECUTION_ENABLED:'true'});
  try {
    const f=h.fixtures[0]!;
    const workspace=await h.get('/api/v1/admin/workspaces/'+f.workspaceId);
    const connector=await h.get('/api/v1/admin/agents/'+f.agentId);
    const updated=await h.request('/api/v1/admin/connectors/'+f.agentId+'/upgrade',{
      expectedRevision:connector.revision,expectedWorkspaceRevision:workspace.revision,
      acknowledgeReauthorization:true,
    });
    const w=updated.workspace as Record<string,unknown>;
    const target='w2.'+f.workspaceId+'.'+w.assignmentGeneration+'.'+w.bindingGeneration;
    f.lease=await h.executionRequest('/api/v1/tab/claim',{workspaceId:f.workspaceId,
      binding:f.binding,adapterVersion:'2',tabInstanceId:'original-grant-scope-fixture'});
    const firstToken=await issueSyntheticToken(h,f);
    const unrelatedGrantToken=await issueSyntheticToken(h,f);
    const start=await syntheticMcp(h,f,firstToken,'read',{target,
      operationKey:'k2.'+Date.now()+'.'+crypto.randomUUID(),files:[{path:'main.pjs'}]});
    const operationId=String(start.operationId);
    assert.equal(start.phase,'ADMITTED');
    const raw=async(token:string,name:string,args:Record<string,unknown>)=>{
      const response=await h.mf.dispatchFetch('https://capacity.test/mcp/'+f.agentId,{
        method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',
          Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25'},
        body:JSON.stringify({jsonrpc:'2.0',id:crypto.randomUUID(),method:'tools/call',params:{name,arguments:args}}),
      });
      assert.equal(response.status,200);
      return (await response.json() as {result:{isError:boolean;structuredContent:Record<string,unknown>}}).result;
    };
    const crossGrant=await raw(unrelatedGrantToken,'operation_status',{target,operationId});
    assert.equal(crossGrant.isError,true);
    assert.equal((crossGrant.structuredContent.error as {code:string}).code,'NOT_FOUND');
    assert.equal(crossGrant.structuredContent.result,null);
    const wrongTarget=await raw(firstToken,'operation_status',{
      target:'w2.'+f.workspaceId+'.'+w.assignmentGeneration+'.'+(Number(w.bindingGeneration)+1),operationId});
    assert.equal(wrongTarget.isError,true);
    assert.equal(wrongTarget.structuredContent.result,null);
    const foreignCancel=await raw(unrelatedGrantToken,'cancel_operation',{target,operationId});
    assert.equal(foreignCancel.isError,true);
    assert.equal((foreignCancel.structuredContent.error as {code:string}).code,'NOT_FOUND');
    assert.equal((await h.status(f,operationId)).status,'ADMITTED');
    const authorizedCancel=await syntheticMcp(h,f,firstToken,'cancel_operation',{target,operationId});
    assert.equal(authorizedCancel.phase,'CANCELLED');
    assert.equal((await h.status(f,operationId)).status,'CANCELLED');

    const second=await syntheticMcp(h,f,firstToken,'read',{target,
      operationKey:'k2.'+Date.now()+'.'+crypto.randomUUID(),files:[{path:'main.pjs'}]});
    const secondId=String(second.operationId);
    const polled=await h.browser(f,'poll',{waitMs:0});
    assert.equal((polled.operations as {operationId:string}[])[0]?.operationId,secondId);
    await h.browser(f,'reply',{operationId:secondId,phase:'RUNNING'});
    await h.browser(f,'reply',{operationId:secondId,phase:'SUCCEEDED',
      result:{operationId:secondId,status:'SUCCEEDED',effectState:'NONE',data:{fixture:true}}});
    const permitted=await syntheticMcp(h,f,firstToken,'operation_status',{target,operationId:secondId});
    assert.equal(permitted.phase,'SUCCEEDED');
    assert.match(JSON.stringify(permitted.data),/fixture/);
    const denied=await raw(unrelatedGrantToken,'operation_status',{target,operationId:secondId});
    assert.equal(denied.isError,true);
    assert.equal(denied.structuredContent.result,null);
  } finally {await h.close();}
});
