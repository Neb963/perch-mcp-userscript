import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createCapacityHarness} from './gateway-capacity-harness.js';
import {activateSyntheticNative} from '../fixtures/optimization-client.js';

const entryPoint='tests/fixtures/optimization-fault-runtime.ts';
type Stub={fetch:(url:string,init?:RequestInit)=>Promise<Response>};
async function control(stub:Stub,body:Record<string,unknown>) {
  const response=await stub.fetch('https://internal/__fixture_faults',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal(response.status,200);
}
function result(operationId:string){return {operationId,status:'SUCCEEDED',effectState:'VERIFIED',data:{ok:true}};}

test('R04 native active-poll expiry fast path preserves exact dispatch and terminal receipt',{timeout:30000},async()=>{
  const h=await createCapacityHarness(1,{
    CANONICAL_STORAGE_MODE:'native',BINARY_PAYLOADS_ENABLED:'true'},{entryPoint});
  try {
    const f=h.fixtures[0]!;
    await activateSyntheticNative(h,f);
    const admitted=await h.admit(f),operationId=String(admitted.operationId);
    const polled=await h.browser(f,'poll',{waitMs:0});
    assert.equal((polled.operations as {operationId:string}[])[0]?.operationId,operationId);
    assert.equal((await h.status(f,operationId)).status,'DISPATCHED');
    await h.browser(f,'reply',{operationId,phase:'RUNNING'});
    await h.browser(f,'reply',{operationId,phase:'SUCCEEDED',result:result(operationId)});
    assert.equal((await h.status(f,operationId)).status,'SUCCEEDED');
    assert.deepEqual((await h.browser(f,'poll',{waitMs:0})).operations,[]);
    const events=await h.get('/api/v1/admin/activity');
    assert.equal((events.items as Array<{operationId:string}>).filter(x=>x.operationId===operationId).length,1);
  }finally{await h.close();}
});
test('R04 missing alarm never bypasses deadline maintenance or silently discards admitted work',{timeout:30000},async()=>{
  const h=await createCapacityHarness(1,{
    CANONICAL_STORAGE_MODE:'native',BINARY_PAYLOADS_ENABLED:'true'},{entryPoint});
  try {
    const f=h.fixtures[0]!;
    await activateSyntheticNative(h,f);
    const stub=h.wns.get(h.wns.idFromName(f.workspaceId)) as unknown as Stub;
    const admitted=await h.admit(f),operationId=String(admitted.operationId);
    await control(stub,{clearAlarm:true});
    const poll=await h.browser(f,'poll',{waitMs:0});
    assert.equal((poll.operations as {operationId:string}[])[0]?.operationId,operationId,
      'Absent alarm must use the full expiry/dispatch path, never suppress dispatch');
    await h.browser(f,'reply',{operationId,phase:'SUCCEEDED',result:result(operationId)});
    assert.equal((await h.status(f,operationId)).status,'SUCCEEDED');
  }finally{await h.close();}
});
test('R04 past native operation deadline cannot be dispatched by an active fast path',{timeout:30000},async()=>{
  const h=await createCapacityHarness(1,{
    CANONICAL_STORAGE_MODE:'native',BINARY_PAYLOADS_ENABLED:'true'},{entryPoint});
  try {
    const f=h.fixtures[0]!;
    await activateSyntheticNative(h,f);
    const stub=h.wns.get(h.wns.idFromName(f.workspaceId)) as unknown as Stub;
    const admitted=await h.admit(f),operationId=String(admitted.operationId);
    await control(stub,{now:Date.now()+40_000});
    const poll=await h.browser(f,'poll',{waitMs:0});
    assert.deepEqual(poll.operations,[],'Due operation must be expired, not dispatched');
    const status=await h.status(f,operationId);
    assert.equal(status.status,'REJECTED');
  }finally{await h.close();}
});
