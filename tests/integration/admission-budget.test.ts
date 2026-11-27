import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCapacityHarness} from './gateway-capacity-harness.js';
import {activateSyntheticNative} from '../fixtures/optimization-client.js';
import {zeroBudget,type BudgetState} from '../../apps/gateway/src/admission-budget.js';
const entryPoint='tests/fixtures/admission-budget-runtime.ts';
type Harness=Awaited<ReturnType<typeof createCapacityHarness>>;
async function harness(native:boolean) {
  const h=await createCapacityHarness(1,{ADMISSION_BUDGET_ENABLED:'true',ADMISSION_BUDGET_BASELINE_JSON:JSON.stringify(zeroBudget()),
    ...(native?{CANONICAL_STORAGE_MODE:'native',BINARY_PAYLOADS_ENABLED:'true'}:{})},{entryPoint});
  try {if(native)await activateSyntheticNative(h,h.fixtures[0]!);return h;}
  catch(error){await h.close();throw error;}
}
async function budget(h:Harness,body?:Record<string,unknown>):Promise<BudgetState|null> {
  const f=h.fixtures[0]!,stub=h.wns.get(h.wns.idFromName(f.workspaceId));
  const response=await stub.fetch('https://internal/__fixture_budget',body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});
  assert.equal(response.status,200);return (await response.json() as {state:BudgetState|null}).state;
}
async function clock(h:Harness,now:number,seedLease=true) {
  const result=await h.registry.fetch('https://internal/__fixture_faults',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({now})});
  assert.equal(result.status,200);
  if(seedLease)await budget(h,{action:'clock',now});
  else {
    const f=h.fixtures[0]!,stub=h.wns.get(h.wns.idFromName(f.workspaceId));
    const advanced=await stub.fetch('https://internal/__fixture_faults',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({now})});
    assert.equal(advanced.status,200);
  }
}
const result=(operationId:string)=>({operationId,status:'SUCCEEDED',effectState:'VERIFIED',data:{fixture:true}});
for(const native of [false,true]) {
  const mode=native?'native':'legacy';
  test(`${mode}: exhausted or corrupt admission accounting never rejects an already admitted terminal result`,{timeout:30000},async()=>{
    const h=await harness(native);
    try {
      const f=h.fixtures[0]!,op=await h.admit(f),operationId=String(op.operationId);
      assert.ok(await budget(h),'Admission must durably reserve local headroom.');
      await budget(h,{action:'saturate',ratio:1});
      await assert.rejects(()=>h.admit(f),(error)=>(error as {status:number}).status===429);
      const polled=await h.browser(f,'poll',{waitMs:0});
      assert.equal((polled.operations as {operationId:string}[])[0]?.operationId,operationId);
      await h.browser(f,'reply',{operationId,phase:'RUNNING'});
      await budget(h,{action:'corrupt'});
      const stub=h.wns.get(h.wns.idFromName(f.workspaceId));
      assert.equal((await stub.fetch('https://internal/__fixture_faults',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sqlPattern:'^(?:INSERT|UPDATE|DELETE)',sqlFailures:1})})).status,200);
      await assert.rejects(()=>h.browser(f,'reply',{operationId,phase:'SUCCEEDED',result:result(operationId)}),
        error=>(error as {status:number}).status===503);
      assert.equal((await h.status(f,operationId)).status,'RUNNING','Provider persistence failure must not report a successful terminal commit.');
      assert.equal((await stub.fetch('https://internal/__fixture_faults',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,200);
      await h.browser(f,'reply',{operationId,phase:'SUCCEEDED',result:result(operationId)});
      assert.equal((await h.status(f,operationId)).status,'SUCCEEDED');
      const recovery=await h.get('/api/v1/admin/workspaces/'+f.workspaceId+'/recovery');
      assert.equal(recovery.workspaceId,f.workspaceId);
      assert.equal((recovery.admissionBudget as {reason:string}).reason,'ACCOUNTING_UNAVAILABLE');
      await assert.rejects(()=>h.admit(f),(error)=>(error as {status:number}).status===503);
    } finally {await h.close();}
  });
  test(`${mode}: UTC rollover carries an admitted operation reservation through restart`,{timeout:30000},async()=>{
    const h=await harness(native);
    try {
      const f=h.fixtures[0]!;
      const beforeMidnight=(Math.floor(Date.now()/86_400_000)+1)*86_400_000-10_000,afterMidnight=beforeMidnight+10_000;
      await clock(h,beforeMidnight);
      const first=await h.admit(f),old=await budget(h);
      assert.ok(old);
      await clock(h,afterMidnight,false);
      const stub=h.wns.get(h.wns.idFromName(f.workspaceId));
      assert.equal((await stub.fetch('https://internal/__fixture_restart')).status,200);
      await h.admit(f);
      const next=await budget(h);assert.ok(next);
      assert.equal(next.utcDay,old.utcDay+1);
      assert.equal(next.admissions,1);
      assert.equal(next.reserved.sqlWrites,(old.reserved.sqlWrites-old.retainedCleanup.sqlWrites)*2+next.retainedCleanup.sqlWrites);
      assert.equal((await h.status(f,String(first.operationId))).status,'ADMITTED');
    } finally {await h.close();}
  });
  test(`${mode}: rollover reserves already-notified retained results beyond active-operation carry`,{timeout:30000},async()=>{
    const h=await harness(native);
    try {
      const f=h.fixtures[0]!,midnight=(Math.floor(Date.now()/86_400_000)+1)*86_400_000;
      await clock(h,midnight-20_000);await h.cycle(f);
      const activity=await h.get('/api/v1/admin/activity');
      const operationId=String((activity.items as {operationId:string}[])[0]!.operationId);
      await clock(h,midnight,false);await h.admit(f);
      const current=await budget(h);assert.ok(current);
      assert.ok(current.cleanupSummary.retainedOperations>=1);
      assert.ok(current.cleanupSummary.retainedResultBytes>0);
      assert.ok(current.retainedCleanup.sqlWrites>=32);
      const retained=await h.status(f,operationId);
      assert.equal(retained.status,'SUCCEEDED');assert.ok(retained.data);
    } finally {await h.close();}
  });
  test(`${mode}: missing initialized accounting denies admission while persisted results remain readable`,{timeout:30000},async()=>{
    const h=await harness(native);
    try {
      const f=h.fixtures[0]!;await h.cycle(f);
      const activity=await h.get('/api/v1/admin/activity');
      const operationId=String((activity.items as {operationId:string}[])[0]!.operationId);
      await budget(h,{action:'delete'});
      assert.equal((await h.status(f,operationId)).status,'SUCCEEDED');
      await assert.rejects(()=>h.admit(f),(error)=>(error as {status:number}).status===503);
      const polled=await h.browser(f,'poll',{waitMs:0});assert.deepEqual(polled.operations,[]);
      const recovery=await h.get('/api/v1/admin/workspaces/'+f.workspaceId+'/recovery');
      assert.equal(recovery.workspaceId,f.workspaceId);
      assert.equal((recovery.admissionBudget as {reason:string}).reason,'ACCOUNTING_UNAVAILABLE');
    } finally {await h.close();}
  });
}
