import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCapacityHarness} from './gateway-capacity-harness.js';
import {issueSyntheticToken} from '../fixtures/optimization-client.js';

test('R04 v2 single authorization still fails closed after suspension and explicit Grant revoke',async()=>{
  const h=await createCapacityHarness(0,{DEVELOPMENT_CONTRACT_V2_ENABLED:'true',
    DEVELOPMENT_CONTRACT_V2_EXECUTION_ENABLED:'true'});
  const base='https://capacity.test';
  try {
    const state=await h.get('/api/v1/admin/state');
    const c=await h.request('/api/v1/admin/connectors',{label:'Scoped authorization',expectedRevision:state.revision});
    const agent=String(c.id),endpoint=String(c.endpoint);
    const token=await issueSyntheticToken(h,{agentId:agent,workspaceId:'',binding:{},lease:{},props:{},permissions:[]});
    const invoke=(method:string,name?:string,argumentsObject:Record<string,unknown>={})=>
      h.mf.dispatchFetch(endpoint,{method:'POST',headers:{
        'Authorization':'Bearer '+token,'Content-Type':'application/json',
        'Accept':'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25'},
        body:JSON.stringify({jsonrpc:'2.0',id:1,method,
          ...(name?{params:{name,arguments:argumentsObject}}:{})})});
    let result=await invoke('tools/call','workspace_status',{});
    assert.equal(result.status,200,'Authorized empty discovery must still work');
    const accepted=await result.json() as {result:{isError:boolean;structuredContent:{workspaces:unknown[]}}};
    assert.equal(accepted.result.isError,false);
    assert.deepEqual(accepted.result.structuredContent.workspaces,[]);
    const suspended=await h.update('/api/v1/admin/connectors/'+agent,{expectedRevision:c.revision,suspended:true});
    result=await invoke('tools/call','workspace_status',{});
    assert.equal(result.status,200);
    const denied=await result.json() as {result:{isError:boolean;structuredContent:{error:{code:string};workspaces?:unknown[]}}};
    assert.equal(denied.result.isError,true);
    assert.equal(denied.result.structuredContent.error.code,'PAUSED');
    assert.equal(denied.result.structuredContent.workspaces,undefined);
    assert.equal((await invoke('tools/list')).status,403,'Listing remains protected by the outer Grant check');
    await h.update('/api/v1/admin/connectors/'+agent,{expectedRevision:suspended.revision,suspended:false});
    const grants=await h.get('/api/v1/admin/grants');
    const grant=(grants.items as Record<string,unknown>[])[0]!;
    await h.request('/api/v1/admin/grants/'+grant.id+'/revoke',{expectedRevision:grant.revision});
    result=await invoke('tools/call','workspace_status',{});
    assert.equal(result.status,200);
    const revoked=await result.json() as {result:{isError:boolean;structuredContent:{error:{code:string};workspaces?:unknown[]}}};
    assert.equal(revoked.result.isError,true);
    assert.equal(revoked.result.structuredContent.error.code,'REVOKED');
    assert.equal(revoked.result.structuredContent.workspaces,undefined);
    assert.equal((await invoke('tools/list')).status,403);
    assert.equal((await invoke('tools/call','unknown_tool',{})).status,403,
      'Invalid tools/call must not enter the optimized path before Grant authentication');
  }finally{await h.close();}
});
