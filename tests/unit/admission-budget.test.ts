import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMISSION_BUDGET_KEY, BUDGET_DIMENSIONS, admissionBudgetPolicy, completionReservation,
  reserveAdmission, admissionBudgetSnapshot, zeroBudget, emptyCleanupSummary, retainedCleanupReservation, type BudgetOperation, type BudgetPolicy,
  type BudgetState, type BudgetVector,
} from '../../apps/gateway/src/admission-budget.js';

class Store {
  rows = new Map<string,unknown>();
  reads = 0; writes = 0; inTransaction = false; failRead = false; failWrite = false;
  get<T>(key:string): T {
    this.reads++;
    if (this.failRead) throw new Error('SQL fixture read failed');
    return structuredClone(this.rows.get(key)) as T;
  }
  put(key:string,value:unknown): void {
    this.writes++;
    if (this.failWrite) throw new Error('SQL fixture write failed');
    this.rows.set(key,structuredClone(value));
  }
  transaction<T>(fn:()=>T): T {
    if(this.inTransaction) return fn();
    const previous=structuredClone(this.rows);
    this.inTransaction=true;
    try{return fn();} catch(error){this.rows=previous;throw error;}
    finally{this.inTransaction=false;}
  }
}
const now=Date.UTC(2026,10,27,23,59,0);
function policy(): BudgetPolicy {
  return {enabled:true,caps:Object.fromEntries(BUDGET_DIMENSIONS.map(key=>[key,100_000_000])) as BudgetVector,baseline:zeroBudget()};
}
function admit(db:Store,p=policy(),time=now,op:BudgetOperation={tool:'read',args:{path:'main.pjs'}},outstanding:()=>BudgetOperation[]=()=>[]) {
  return db.transaction(()=>{
    const result=reserveAdmission(db,p,op,outstanding,time,emptyCleanupSummary);
    db.put('operation/fixture',{...op,budgetReservation:result?.reservation});
    return result;
  });
}
function corruptRecord(db:Store,key: keyof BudgetState,value:unknown): void {
  const state=db.rows.get(ADMISSION_BUDGET_KEY) as BudgetState;
  db.rows.set(ADMISSION_BUDGET_KEY,{...state,[key]:value});
}

test('disabled admission budget performs no accounting storage calls',()=>{
  const db=new Store();
  const value=reserveAdmission(db,admissionBudgetPolicy({ADMISSION_BUDGET_ENABLED:'false',ADMISSION_BUDGET_CAPS_JSON:'broken'}),{tool:'read'},()=>{throw new Error('must not inspect');});
  assert.equal(value,undefined);
  assert.equal(db.reads,0);
  assert.equal(db.writes,0);
});

test('budget configuration is explicit, bounded and local-only',()=>{
  const p=admissionBudgetPolicy({ADMISSION_BUDGET_ENABLED:'true',ADMISSION_BUDGET_CAPS_JSON:'{"sqlWrites":1000}',ADMISSION_BUDGET_BASELINE_JSON:'{"sqlWrites":50}'});
  assert.equal(p.caps.sqlWrites,1000);
  assert.equal(p.baseline.sqlWrites,50);
  assert.equal(p.baseline.sqlReads,200_000);
  assert.equal(p.caps.kvWrites,750);
  assert.equal(p.baseline.kvWrites,256);
  for(const env of [
    {ADMISSION_BUDGET_ENABLED:'TRUE'},
    {ADMISSION_BUDGET_CAPS_JSON:'{"sqlWrites":0}'},
    {ADMISSION_BUDGET_CAPS_JSON:'{"unknown":20}'},
    {ADMISSION_BUDGET_CAPS_JSON:'{"sqlWrites":-1}'},
    {ADMISSION_BUDGET_CAPS_JSON:'{"sqlWrites":1.5}'},
    {ADMISSION_BUDGET_CAPS_JSON:'{broken'},
    {ADMISSION_BUDGET_CAPS_JSON:'{"kvWrites":200}'},
    {ADMISSION_BUDGET_BASELINE_JSON:'{"sqlWrites":99999999}'},
  ]) assert.throws(()=>admissionBudgetPolicy({...env,ADMISSION_BUDGET_ENABLED:env.ADMISSION_BUDGET_ENABLED??'true'}));
});

test('reservation and canonical admission roll back together on failed write',()=>{
  const db=new Store();
  db.failWrite=true;
  assert.throws(()=>admit(db));
  assert.equal(db.rows.size,0);
  db.failWrite=false;
  const result=admit(db)!;
  assert.equal(result.status.admissions,1);
  assert.equal(result.status.scope,'workspace');
  assert.equal(result.status.coverage,'admission-estimates-only');
  assert.equal(result.status.accountUsage,'UNKNOWN');
  assert.equal(db.rows.size,3);
  assert.throws(()=>reserveAdmission(db,policy(),{tool:'read'},()=>[]),/canonical transaction/);
});

test('UTC rollover carries pending obligations and preserves baseline margin',()=>{
  const db=new Store(),p=policy(); p.baseline.sqlWrites=25;
  const first=admit(db,p)!;
  const obligation={tool:'read',budgetReservation:first.reservation};
  let inspected=0;
  const sameDay=admit(db,p,now+1000,undefined,()=>{inspected++;return [obligation];})!;
  assert.equal(inspected,0,'warm admissions do not scan outstanding operations');
  assert.equal(sameDay.status.admissions,2);
  const next=admit(db,p,now+120_000,undefined,()=>{inspected++;return [obligation];})!;
  assert.equal(inspected,1);
  assert.equal(next.status.utcDay,Math.floor((now+120_000)/86_400_000));
  assert.equal(next.status.admissions,1);
  assert.equal(next.status.reserved.sqlWrites,25+first.reservation.sqlWrites+next.reservation.sqlWrites);
});

test('restart retains budget and missing initialized state fails closed',()=>{
  const db=new Store(); const first=admit(db)!;
  const restarted=new Store(); restarted.rows=structuredClone(db.rows);
  const second=admit(restarted)!;
  assert.equal(second.status.reserved.sqlWrites,first.status.reserved.sqlWrites+second.reservation.sqlWrites);
  restarted.rows.delete(ADMISSION_BUDGET_KEY);
  assert.throws(()=>admit(restarted),/record is missing/);
  assert.equal(restarted.rows.has(ADMISSION_BUDGET_KEY),false);
});

test('corrupt or unknown accounting never defaults to zero',()=>{
  for(const [key,value] of [
    ['schemaVersion',99],['utcDay',0],['observedAt',NaN],['admissions',-1],
    ['reserved',{}],['reserved',{...zeroBudget(),sqlWrites:-1}],
  ] as const) {
    const db=new Store(); admit(db);
    corruptRecord(db,key,value);
    assert.throws(()=>admit(db));
  }
});

test('clock rollback never resets daily allocation and large skew fails admission',()=>{
  const db=new Store(); const first=admit(db)!;
  const slight=admit(db,policy(),now-1000)!;
  assert.equal(slight.status.admissions,2);
  assert.equal(slight.status.utcDay,first.status.utcDay);
  assert.throws(()=>admit(db,policy(),now-301_000),/clock moved backwards/);
});

test('concurrent admission serializes allocation with zero estimate overshoot',async()=>{
  const db=new Store(),p=policy(); p.caps.sqlWrites=10_000;
  const attempts=await Promise.all(Array.from({length:100},async()=>{
    try{return admit(db,p);}catch{return undefined;}
  }));
  const accepted=attempts.filter(Boolean);
  const state=db.rows.get(ADMISSION_BUDGET_KEY) as BudgetState;
  assert.ok(accepted.length>0 && accepted.length<100);
  assert.equal(state.admissions,accepted.length);
  assert.ok(state.reserved.sqlWrites<9500);
});

test('threshold modes preserve recovery headroom and expensive admission restricts at 85%',()=>{
  for(const [ratio,mode] of [[0.2,'NORMAL'],[0.5,'VISIBILITY'],[0.7,'REDUCE_OPTIONAL'],[0.86,'RESTRICT_EXPENSIVE']] as const) {
    const db=new Store(),p=policy(); p.baseline.sqlReads=Math.floor(p.caps.sqlReads*ratio);
    assert.equal(admit(db,p)!.status.mode,mode);
  }
  const db=new Store(),p=policy(); p.baseline.sqlReads=86_000_000;
  admit(db,p);
  assert.throws(()=>admit(db,p,now,{tool:'read_image',args:{file_path:'scratch/x.png'}}),/headroom/);
  const full=new Store(),p2=policy(); p2.baseline.sqlReads=95_000_000;
  assert.throws(()=>admit(full,p2),/headroom/);
  assert.equal(full.rows.size,0);
});

test('terminal result commit has no admission policy dependency even after budget exhaustion',()=>{
  const db=new Store(); admit(db);
  const state=db.rows.get(ADMISSION_BUDGET_KEY) as BudgetState;
  state.reserved.sqlWrites=policy().caps.sqlWrites;
  db.rows.set(ADMISSION_BUDGET_KEY,state);
  assert.throws(()=>admit(db),/headroom/);
  // Terminal/recovery routes retain their canonical transaction and never call
  // reserveAdmission. Actual provider persistence failure remains a real failure.
  db.transaction(()=>db.put('operation/fixture',{phase:'SUCCEEDED',result:{ok:true}}));
  assert.deepEqual(db.rows.get('operation/fixture'),{phase:'SUCCEEDED',result:{ok:true}});
  db.failWrite=true;
  assert.throws(()=>db.transaction(()=>db.put('operation/fixture',{phase:'UNKNOWN'})));
  assert.equal((db.rows.get('operation/fixture') as {phase:string}).phase,'SUCCEEDED');
});

test('failed accounting read and excessive rollover obligations deny before operation commit',()=>{
  const db=new Store(); db.failRead=true;
  assert.throws(()=>admit(db)); assert.equal(db.rows.size,0);
  db.failRead=false;
  assert.throws(()=>admit(db,policy(),now,undefined,()=>Array.from({length:265},()=>({tool:'read'}))),/bounded journal capacity/);
  assert.equal(db.rows.size,0);
});

test('payload and compute reservations include chunk, cleanup and bounded child-call exposure',()=>{
  const ordinary=completionReservation('read',{path:'main.pjs'});
  const image=completionReservation('read_image',{file_path:'scratch/large.png'});
  const music=completionReservation('generate_music',{style:'fixture',isInstrumental:true,outputPath:'scratch/x.mp3'});
  const compute=completionReservation('execute_js',{js:'return 1;'});
  assert.ok(image.sqlWrites>ordinary.sqlWrites);
  assert.ok(music.sqlWrites>image.sqlWrites);
  assert.ok(music.workerRequests>=43*2);
  assert.ok(compute.sqlWrites>=1000*96);
  for(const value of [ordinary,image,music,compute]) assert.ok(BUDGET_DIMENSIONS.every(key=>Number.isSafeInteger(value[key]) && value[key]>=0));
  assert.throws(()=>completionReservation('read',{path:'x'.repeat(512*1024)}),/transport bounds/);
});


test('budget snapshots never write or hide stale/unavailable accounting from recovery',()=>{
  const db=new Store();
  assert.equal(admissionBudgetSnapshot(db,admissionBudgetPolicy({})).known,false);
  assert.equal(db.reads,0);assert.equal(db.writes,0);
  assert.deepEqual(admissionBudgetSnapshot(db,policy(),now),{enabled:true,known:false,scope:'workspace',reason:'NOT_INITIALIZED'});
  admit(db);
  const writes=db.writes;
  const stale=admissionBudgetSnapshot(db,policy(),now+86_400_000);
  assert.equal(stale.known,true);
  if(stale.known)assert.equal(stale.staleDay,true);
  db.failRead=true;
  assert.deepEqual(admissionBudgetSnapshot(db,policy(),now),{enabled:true,known:false,scope:'workspace',reason:'ACCOUNTING_UNAVAILABLE'});
  assert.equal(db.writes,writes);
});


test('retained cleanup reserve survives midnight and includes result/media/retired state without body reads',()=>{
  const db=new Store(),p=policy();p.caps.storageBytes=10_000_000_000;
  const summary={...emptyCleanupSummary(),retainedOperations:20,retainedResultBytes:1024*1024,
    imageBytes:1024*1024,imageManifests:1,musicBytes:8*1024*1024,musicJournals:1,retiredLeases:2};
  const reserve=retainedCleanupReservation(summary);
  const first=db.transaction(()=>reserveAdmission(db,p,{tool:'read'},()=>[],now,()=>summary))!;
  assert.deepEqual(first.status.retainedCleanup,reserve);
  assert.equal(first.status.reserved.sqlWrites,reserve.sqlWrites+first.reservation.sqlWrites);
  assert.ok(reserve.sqlWrites>0&&reserve.storageBytes>9*1024*1024);
  const next=db.transaction(()=>reserveAdmission(db,p,{tool:'read'},()=>[],now+86_400_000,()=>summary))!;
  assert.equal(next.status.reserved.sqlWrites,first.status.reserved.sqlWrites,'retained cleanup is reserved again instead of discarded at midnight');
});

test('missing/corrupt/unbounded retained cleanup denies new admission, never defaults to empty',()=>{
  for(const summary of [undefined,{...emptyCleanupSummary(),retiredLeases:4097},
    {...emptyCleanupSummary(),retainedResultBytes:-1}]) {
    const db=new Store();
    assert.throws(()=>db.transaction(()=>reserveAdmission(db,policy(),{tool:'read'},()=>[],now,
      summary===undefined?undefined:()=>summary)));
    assert.equal(db.rows.size,0);
  }
});

test('retained cleanup counts are evaluated only on activation/UTC rollover',()=>{
  const db=new Store(),p=policy();let calls=0;
  const summary=()=>{calls++;return emptyCleanupSummary();};
  db.transaction(()=>reserveAdmission(db,p,{tool:'read'},()=>[],now,summary));
  db.transaction(()=>reserveAdmission(db,p,{tool:'read'},()=>[],now+1000,summary));
  assert.equal(calls,1);
  db.transaction(()=>reserveAdmission(db,p,{tool:'read'},()=>[],now+86_400_000,summary));
  assert.equal(calls,2);
});

test('R04 v2 execute_js costs one bounded local compute operation, not a thousand remote children',()=>{
  const args={js:'return 1;',access:{read:['main.pjs']}};
  const legacy=completionReservation('execute_js',args);
  const v2=completionReservation('execute_js',args,2);
  assert.ok(legacy.sqlReads>=512_000 && legacy.sqlWrites>=96_000);
  assert.ok(legacy.workerRequests>=1000);
  assert.ok(v2.sqlReads<1500 && v2.sqlWrites<700);
  assert.ok(v2.workerRequests<=20 && v2.durableObjectRequests<=40);
  assert.ok(v2.logEvents<20);
  assert.ok(BUDGET_DIMENSIONS.every(key=>Number.isSafeInteger(v2[key])&&v2[key]>=0));
  const p=policy();p.caps.sqlWrites=900;
  const isolated=admit(new Store(),p,now,{tool:'execute_js',args,props:{contractVersion:2}});
  assert.ok(isolated && isolated.reservation.sqlWrites<700);
  assert.throws(()=>admit(new Store(),p,now,{tool:'execute_js',args}),/headroom/);
});

test('R04 v2 batch estimate is bounded and monotonic in declared actions, including UTC rollover',()=>{
  const actions=(n:number)=>Array.from({length:n},(_,i)=>({tool:i%2?'write':'read',args:{path:'main.pjs'}}));
  const one=completionReservation('batch',{actions:actions(1)},2);
  const ten=completionReservation('batch',{actions:actions(10)},2);
  const max=completionReservation('batch',{actions:actions(32)},2);
  assert.ok(one.sqlReads < ten.sqlReads && ten.sqlReads < max.sqlReads);
  assert.ok(one.sqlWrites < ten.sqlWrites && ten.sqlWrites < max.sqlWrites);
  assert.ok(max.sqlReads < 4000 && max.sqlWrites<1400);
  assert.ok(max.workerRequests<=20 && max.durableObjectRequests<100);
  assert.deepEqual(BUDGET_DIMENSIONS.filter(key=>max[key]<0||!Number.isSafeInteger(max[key])),[]);
  assert.throws(()=>completionReservation('batch',{actions:[]},2),/1–32/);
  assert.throws(()=>completionReservation('batch',{actions:actions(33)},2),/1–32/);
  assert.throws(()=>completionReservation('batch',{actions:'invalid'},2),/1–32/);
  const db=new Store(),p=policy();
  const op:BudgetOperation={tool:'batch',props:{contractVersion:2},args:{actions:actions(10)}};
  const first=admit(db,p,now,op)!;
  assert.deepEqual(first.reservation,ten);
  const outstanding=()=>[{...op,budgetReservation:ten}];
  const second=admit(db,p,now+120_000,{tool:'read',props:{contractVersion:2}},outstanding)!;
  assert.equal(second.status.reserved.sqlWrites,
    p.baseline.sqlWrites+ten.sqlWrites+second.reservation.sqlWrites);
});
