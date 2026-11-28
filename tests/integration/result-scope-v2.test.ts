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

    // S03-011/012/014: inspect the real SDK-served v2 public catalog,
    // including unavailable screenshot metadata and conservative hint flags.
    const listed=await h.mf.dispatchFetch('https://capacity.test/mcp/'+f.agentId,{
      method:'POST',headers:{Authorization:'Bearer '+firstToken,'Content-Type':'application/json',
        Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25'},
      body:JSON.stringify({jsonrpc:'2.0',id:crypto.randomUUID(),method:'tools/list'}),
    });
    assert.equal(listed.status,200);
    const catalogResult=await listed.json() as {result?:{tools:{
      name:string;description:string;annotations?:{readOnlyHint?:boolean;openWorldHint?:boolean};
    }[]}};
    const catalog=catalogResult.result?.tools;
    assert.ok(catalog);
    const expected=['read','write','delete','rename','list_files','page_eval','page_refresh',
      'preview_diagnostics','set_viewport_size','capture_page_image','execute_js','fetch_url',
      'fetch_generator','workspace_status','generator_info','save_generator',
      'operation_status','cancel_operation','batch'];
    assert.deepEqual(catalog.map(tool=>tool.name).sort(),expected.sort());
    const capture=catalog.find(tool=>tool.name==='capture_page_image');
    assert.match(capture?.description??'',/UNSUPPORTED_INTERFACE/);
    assert.ok(!catalog.some(tool=>['skill','read_image','generate_image','get_workflow'].includes(tool.name)));
    for(const name of ['page_eval','page_refresh','set_viewport_size','execute_js','fetch_url',
      'fetch_generator','write','delete','rename','save_generator','batch']) {
      assert.equal(catalog.find(tool=>tool.name===name)?.annotations?.readOnlyHint,false,
        'Open-world/mixed/effectful tool must not advertise read-only: '+name);
    }

    const primaryKey='k2.'+Date.now()+'.'+crypto.randomUUID();
    const start=await syntheticMcp(h,f,firstToken,'read',{target,
      operationKey:primaryKey,files:[{path:'main.pjs'}]});
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
    // S03-056/057: exact-one selector grammar and original-Grant operationKey
    // are exercised through the real OAuth/Workerd tools/call path, not mocks.
    for(const name of ['operation_status','cancel_operation']) {
      for(const invalid of [{target},{target,operationId,operationKey:primaryKey}]) {
        const response=await raw(firstToken,name,invalid);
        assert.equal(response.isError,true);
        assert.equal((response.structuredContent.error as {code:string}).code,'INVALID_INPUT');
      }
    }
    const keyed=await syntheticMcp(h,f,firstToken,'operation_status',{
      target,operationKey:primaryKey,waitMs:0});
    assert.equal(keyed.operationId,operationId);
    assert.equal(keyed.phase,'ADMITTED');
    assert.equal((await h.status(f,operationId)).status,'ADMITTED',
      'Status must not replay or mutate original admission');
    const crossGrantKey=await raw(unrelatedGrantToken,'operation_status',{
      target,operationKey:primaryKey});
    assert.equal(crossGrantKey.isError,true);
    assert.equal((crossGrantKey.structuredContent.error as {code:string}).code,'NOT_FOUND');
    assert.equal(crossGrantKey.structuredContent.result,null);
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

    const cancelKey='k2.'+Date.now()+'.'+crypto.randomUUID();
    const keyedOperation=await syntheticMcp(h,f,firstToken,'read',{target,
      operationKey:cancelKey,files:[{path:'main.pjs'}]});
    const keyedId=String(keyedOperation.operationId);
    assert.equal(keyedOperation.phase,'ADMITTED');
    const foreignKeyCancel=await raw(unrelatedGrantToken,'cancel_operation',{
      target,operationKey:cancelKey});
    assert.equal(foreignKeyCancel.isError,true);
    assert.equal((foreignKeyCancel.structuredContent.error as {code:string}).code,'NOT_FOUND');
    assert.equal((await h.status(f,keyedId)).status,'ADMITTED');
    const cancelledByKey=await syntheticMcp(h,f,firstToken,'cancel_operation',{
      target,operationKey:cancelKey});
    assert.equal(cancelledByKey.operationId,keyedId);
    assert.equal(cancelledByKey.phase,'CANCELLED');
    assert.equal(cancelledByKey.effectState,'NONE','Only verified pre-dispatch cancellation is no-effect');
    assert.equal((await h.status(f,keyedId)).status,'CANCELLED');

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

    // A dispatched RUNNING mutation is not a proven no-effect when the
    // user requests cancellation. A cooperative cancellation only records
    // intent, exposing UNKNOWN until the actual browser receipt settles.
    const runningKey='k2.'+Date.now()+'.'+crypto.randomUUID();
    const running=await syntheticMcp(h,f,firstToken,'write',{
      target,operationKey:runningKey,
      files:[{path:'scratch/running-cancel',encoding:'utf8',content:'x',ifAbsent:true}],
    });
    const runningId=String(running.operationId);
    assert.equal(running.phase,'ADMITTED');
    const queued=await h.browser(f,'poll',{waitMs:0});
    assert.equal((queued.operations as {operationId:string}[])[0]?.operationId,runningId);
    await h.browser(f,'reply',{operationId:runningId,phase:'RUNNING'});
    const cooperative=await syntheticMcp(h,f,firstToken,'cancel_operation',{
      target,operationKey:runningKey});
    assert.equal(cooperative.phase,'RUNNING');
    assert.equal(cooperative.cancelRequested,true);
    assert.equal(cooperative.effectState,'UNKNOWN',
      'A dispatched mutation may have effected writes, never falsely report no-effect');
    const stillScoped=await syntheticMcp(h,f,firstToken,'operation_status',{
      target,operationKey:runningKey,waitMs:0});
    assert.equal(stillScoped.operationId,runningId);
    assert.equal(stillScoped.effectState,'UNKNOWN');
    assert.equal(stillScoped.cancelRequested,true);
    await h.browser(f,'reply',{operationId:runningId,phase:'UNKNOWN',
      result:{operationId:runningId,status:'UNKNOWN',effectState:'POSSIBLE',
        error:{code:'EFFECT_UNKNOWN',message:'Dispatched effect could not be proven absent.',
          retryable:false,recovery:'Inspect the retained operation receipt; never replay the intent.'}}});
    const settled=await syntheticMcp(h,f,firstToken,'operation_status',{
      target,operationKey:runningKey});
    assert.equal(settled.phase,'UNKNOWN');
    assert.equal(settled.effectState,'UNKNOWN');
    assert.equal((await h.status(f,runningId)).status,'UNKNOWN');
  } finally {await h.close();}
});
