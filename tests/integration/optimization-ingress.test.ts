import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCapacityHarness} from './gateway-capacity-harness.js';
import {fixtureSnapshot,metricDelta,issueSyntheticToken,syntheticMcp} from '../fixtures/optimization-client.js';
test('hermetic real OAuth/MCP ingress exposes separate SQL, DO, Worker, KV and alarm dimensions',{timeout:30000},async()=>{
  const h=await createCapacityHarness(1,{}, {entryPoint:'tests/fixtures/optimization-runtime.ts'});
  try {
    const f=h.fixtures[0]!,before=await fixtureSnapshot(h,f),token=await issueSyntheticToken(h,f);
    const auth=metricDelta(before,await fixtureSnapshot(h,f));
    assert.ok(auth.worker!.kvPut!>0,'actual OAuth SDK KV writes must be visible');
    const op=await syntheticMcp(h,f,token,'read',{path:'main.pjs'});
    const fetched=await h.browser(f,'poll',{waitMs:0});
    assert.equal((fetched.operations as {operationId:string}[])[0]!.operationId,op.operationId);
    const measured=metricDelta(before,await fixtureSnapshot(h,f));
    assert.ok(measured.registry!.sqlReads!>0&&measured.workspace!.sqlReads!>0);
    assert.ok(measured.registry!.requests!>0&&measured.worker!.requests!>0);
    assert.equal(measured.registry!.sqlFailures,0);
    assert.equal(measured.workspace!.sqlFailures,0);
  } finally {await h.close();}
});
test('terminal receipt arriving before delayed dispatch cannot later consume a permit',{timeout:30000},async()=>{
  const h=await createCapacityHarness(1);
  try {
    const f=h.fixtures[0]!,admitted=await h.admit(f),operationId=String(admitted.operationId);
    const cancelled=await h.internal(h.wns.get(h.wns.idFromName(f.workspaceId)),'/internal/cancel',{
      workspaceId:f.workspaceId,operationId});
    assert.equal(cancelled.status,'CANCELLED');
    await assert.rejects(()=>h.internal(h.registry,'/internal/dispatch',{
      props:f.props,agentId:f.agentId,permissions:['READ_SOURCE'],mutating:false,tool:'read',
      bindingRevision:f.lease.bindingRevision,epoch:f.lease.epoch,operationId}),
      (error:unknown)=>(error as {status:number}).status===409);
    assert.equal((await h.status(f,operationId)).status,'CANCELLED');
  } finally {await h.close();}
});
