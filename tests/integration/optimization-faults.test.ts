import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCapacityHarness} from './gateway-capacity-harness.js';
import {issueSyntheticToken,syntheticMcp,activateSyntheticNative} from '../fixtures/optimization-client.js';
const entryPoint='tests/fixtures/optimization-fault-runtime.ts';
async function faultHarness(count=1) {
  const native=process.env.OPTIMIZATION_FAULT_NATIVE==='true';
  const h=await createCapacityHarness(count,native?{CANONICAL_STORAGE_MODE:'native',BINARY_PAYLOADS_ENABLED:'true'}:{}, {entryPoint});
  try {if(native)for(const f of h.fixtures)await activateSyntheticNative(h,f);return h;}
  catch(error){await h.close();throw error;}
}
type Stub={fetch:(url:string,init?:RequestInit)=>Promise<Response>};
async function control(stub:Stub,body:Record<string,unknown>) {
  const response=await stub.fetch('https://internal/__fixture_faults',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal(response.status,200);return response.json();
}
function terminal(operationId:string) {return {operationId,status:'SUCCEEDED',effectState:'VERIFIED',data:{fixture:true}};}

test('SQL quota fault during terminal persistence preserves recoverable RUNNING and exact retry after restart',{timeout:30000},async()=>{
  const h=await faultHarness();
  try {
    const f=h.fixtures[0]!,stub=h.wns.get(h.wns.idFromName(f.workspaceId));
    const token=await issueSyntheticToken(h,f);
    const admitted=await syntheticMcp(h,f,token,'read',{path:'main.pjs'}),operationId=String(admitted.operationId);
    await h.browser(f,'poll',{waitMs:0});await h.browser(f,'reply',{operationId,phase:'RUNNING'});
    await control(stub as unknown as Stub,{sqlPattern:'^(?:INSERT|UPDATE|DELETE)',sqlFailures:1});
    await assert.rejects(()=>h.browser(f,'reply',{operationId,phase:'SUCCEEDED',result:terminal(operationId)}));
    await control(stub as unknown as Stub,{});
    assert.equal((await h.status(f,operationId)).status,'RUNNING');
    const beforeRestart=await (await stub.fetch('https://internal/__fixture_metrics')).json() as {sqlReads:number;coldStarts:number};
    const restarted=await stub.fetch('https://internal/__fixture_restart');assert.equal(restarted.status,200);
    const afterRestart=await (await stub.fetch('https://internal/__fixture_metrics')).json() as {sqlReads:number;coldStarts:number};
    assert.ok(afterRestart.sqlReads>=beforeRestart.sqlReads,'restart instrumentation never resets counters to zero');
    assert.equal(afterRestart.coldStarts,beforeRestart.coldStarts+1);
    await h.browser(f,'reply',{operationId,phase:'SUCCEEDED',result:terminal(operationId)});
    await h.browser(f,'reply',{operationId,phase:'SUCCEEDED',result:terminal(operationId)});
    assert.equal((await syntheticMcp(h,f,token,'operation_status',{operationId})).status,'SUCCEEDED');
    const activity=await h.get('/api/v1/admin/activity');
    assert.equal((activity.items as {operationId:string}[]).filter(row=>row.operationId===operationId).length,1);
    const faults=await (await stub.fetch('https://internal/__fixture_faults')).json() as {sqlFaults:number;starts:number};
    assert.equal(faults.sqlFaults,1);assert.equal(faults.starts,2);
  } finally {await h.close();}
});

test('failed alarm scheduling cannot turn admitted work into failed admission and later traffic repairs it',{timeout:30000},async()=>{
  const h=await faultHarness();
  try {
    const f=h.fixtures[0]!,stub=h.wns.get(h.wns.idFromName(f.workspaceId));
    await control(stub as unknown as Stub,{clearAlarm:true,alarmFailures:1});
    const admitted=await h.admit(f),operationId=String(admitted.operationId);
    assert.equal((await h.status(f,operationId)).status,'ADMITTED');
    const poll=await h.browser(f,'poll',{waitMs:0});
    assert.equal((poll.operations as {operationId:string}[])[0]?.operationId,operationId);
    const faults=await (await stub.fetch('https://internal/__fixture_faults')).json() as {alarmFaults:number};
    assert.equal(faults.alarmFaults,1);
    await h.browser(f,'reply',{operationId,phase:'SUCCEEDED',result:terminal(operationId)});
    assert.equal((await h.status(f,operationId)).status,'SUCCEEDED');
  } finally {await h.close();}
});

test('synthetic deadline crossing after restart rejects undispatched work without replay',{timeout:30000},async()=>{
  const h=await faultHarness();
  try {
    const f=h.fixtures[0]!,stub=h.wns.get(h.wns.idFromName(f.workspaceId));
    const admitted=await h.admit(f),operationId=String(admitted.operationId);
    await control(stub as unknown as Stub,{now:Date.now()+40_000});
    assert.equal((await stub.fetch('https://internal/__fixture_restart')).status,200);
    const status=await h.status(f,operationId);
    assert.equal(status.status,'REJECTED');
    const poll=await h.browser(f,'poll',{waitMs:0});
    assert.deepEqual(poll.operations,[]);
    const repeated=await h.status(f,operationId);
    assert.equal(repeated.status,'REJECTED');
  } finally {await h.close();}
});

test('Registry SQL outage keeps liveness independent, readiness uncached and OAuth KV untouched',{timeout:30000},async()=>{
  const h=await faultHarness();
  try {
    const kv=await h.mf.getKVNamespace('OAUTH_KV');
    const before=await kv.list({prefix:'infra-incident/'});
    await control(h.registry as unknown as Stub,{sqlPattern:'^SELECT',sqlFailures:10});
    const live=await h.mf.dispatchFetch('https://capacity.test/live');assert.equal(live.status,200);
    for(let repeat=0;repeat<3;repeat++) {
      const health=await h.mf.dispatchFetch('https://capacity.test/health');
      assert.equal(health.status,503);
      const body=await health.json() as {ok:boolean;code:string};assert.equal(body.ok,false);
    }
    const after=await kv.list({prefix:'infra-incident/'});
    assert.equal(after.keys.length,before.keys.length);
    await control(h.registry as unknown as Stub,{});
    const recovered=await h.mf.dispatchFetch('https://capacity.test/health');
    assert.equal(recovered.status,200);
    const ready=await recovered.json() as {paired:boolean;configured:boolean};
    assert.equal(ready.paired,true);assert.equal(ready.configured,true);
  } finally {await h.close();}
});


test('lost Registry terminal acknowledgement survives Workspace restart without duplicated Activity or replay',{timeout:30000},async()=>{
  const h=await faultHarness();
  try {
    const f=h.fixtures[0]!,stub=h.wns.get(h.wns.idFromName(f.workspaceId));
    const admitted=await h.admit(f),operationId=String(admitted.operationId);
    await h.browser(f,'poll',{waitMs:0});await h.browser(f,'reply',{operationId,phase:'RUNNING'});
    await control(h.registry as unknown as Stub,{dropAckPath:'/internal/terminal',dropAcks:1});
    await h.browser(f,'reply',{operationId,phase:'SUCCEEDED',result:terminal(operationId)});
    assert.equal((await h.status(f,operationId)).status,'SUCCEEDED');
    let activity=await h.get('/api/v1/admin/activity');
    assert.equal((activity.items as {operationId:string}[]).filter(row=>row.operationId===operationId).length,1);
    assert.equal((await stub.fetch('https://internal/__fixture_restart')).status,200);
    await control(stub as unknown as Stub,{now:Date.now()+3000});
    assert.equal((await stub.fetch('https://internal/__fixture_alarm')).status,200);
    activity=await h.get('/api/v1/admin/activity');
    assert.equal((activity.items as {operationId:string}[]).filter(row=>row.operationId===operationId).length,1);
    assert.equal((await h.status(f,operationId)).status,'SUCCEEDED');
    const faults=await (await h.registry.fetch('https://internal/__fixture_faults')).json() as {droppedAcks:number};
    assert.equal(faults.droppedAcks,1);
    const poll=await h.browser(f,'poll',{waitMs:0});assert.deepEqual(poll.operations,[]);
  } finally {await h.close();}
});

test('50-editor synthetic stress isolates one failed Workspace from 49 independent lifecycles',{timeout:60000},async()=>{
  const h=await faultHarness(50);
  try {
    const failing=h.fixtures[0]!,stub=h.wns.get(h.wns.idFromName(failing.workspaceId));
    await control(stub as unknown as Stub,{sqlPattern:'^SELECT',sqlFailures:1});
    const outcomes=await Promise.allSettled(h.fixtures.map(h.cycle));
    assert.equal(outcomes[0]!.status,'rejected');
    assert.equal(outcomes.filter(row=>row.status==='fulfilled').length,49);
    assert.equal(new Set(h.fixtures.map(row=>row.workspaceId)).size,50);
    await control(stub as unknown as Stub,{});
    assert.ok(await h.cycle(failing)<15_000);
    const activity=await h.get('/api/v1/admin/activity');
    assert.equal((activity.items as unknown[]).length,50);
  } finally {await h.close();}
});

test('lost consumed dispatch permit acknowledgement becomes UNKNOWN and never replays after restart',{timeout:30000},async()=>{
  const h=await faultHarness();
  try {
    const f=h.fixtures[0]!,stub=h.wns.get(h.wns.idFromName(f.workspaceId));
    const admitted=await h.admit(f),operationId=String(admitted.operationId);
    await control(h.registry as unknown as Stub,{dropAckPath:'/internal/dispatch',dropAcks:1});
    assert.deepEqual((await h.browser(f,'poll',{waitMs:0})).operations,[]);
    assert.equal((await h.status(f,operationId)).status,'UNKNOWN');
    assert.equal((await stub.fetch('https://internal/__fixture_restart')).status,200);
    assert.deepEqual((await h.browser(f,'poll',{waitMs:0})).operations,[]);
    assert.equal((await h.status(f,operationId)).status,'UNKNOWN');
    const activity=await h.get('/api/v1/admin/activity');
    const exact=(activity.items as {operationId:string;phase:string}[]).filter(row=>row.operationId===operationId);
    assert.equal(exact.length,1);assert.equal(exact[0]!.phase,'UNKNOWN');
    const faults=await (await h.registry.fetch('https://internal/__fixture_faults')).json() as {droppedAcks:number};
    assert.equal(faults.droppedAcks,1);
  } finally {await h.close();}
});
