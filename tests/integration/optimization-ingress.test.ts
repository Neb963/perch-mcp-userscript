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
