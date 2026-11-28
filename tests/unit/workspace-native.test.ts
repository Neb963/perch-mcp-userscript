import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { DurableObjectStorage } from '@cloudflare/workers-types';
import { SqlRecords } from '../../apps/gateway/src/sql.js';
import { OperationStore, type StoredOperation } from '../../apps/gateway/src/operation-store.js';
function fixture(){const sqlite=new DatabaseSync(':memory:');const storage={sql:{exec(sql:string,...args:(string|number|null)[]){const q=sqlite.prepare(sql);const rows=/^\s*(SELECT|EXPLAIN)/i.test(sql)?q.all(...args):(q.run(...args),[]);return{toArray:()=>rows,rowsRead:rows.length,rowsWritten:0};}},transactionSync<T>(fn:()=>T){sqlite.exec('BEGIN');try{const result=fn();sqlite.exec('COMMIT');return result;}catch(error){sqlite.exec('ROLLBACK');throw error;}}}as unknown as DurableObjectStorage;return{sqlite,db:new SqlRecords(storage),close:()=>sqlite.close()};}
function op(id:string,n=1){return{operationId:id,sequence:n,phase:'SUCCEEDED',tool:'read',createdAt:Date.now()-1000,deadlineMs:Date.now()+30000,terminalAt:Date.now(),terminalNotified:true,argsDigest:'a'.repeat(64),workspaceId:'workspace',epoch:1,bindingRevision:1,tabInstanceId:'tab',permissions:['READ_SOURCE'],requiredPermissions:['READ_SOURCE'],mutating:false,props:{grantId:'grant',agentId:'agent',workspaceId:'workspace',bindingRevision:1},agentId:'agent',traceId:'trace',result:{operationId:id,status:'SUCCEEDED',effectState:'VERIFIED',data:{text:'😀'.repeat(40000)}},custom:{explicitNull:null,empty:''}};}
function finish<T extends StoredOperation>(store:OperationStore<T>,max=500){for(let i=0;i<max&&!store.native;i++)store.prepareStep();assert.equal(store.native,true);}
test('typed canonical migration preserves chunked Unicode, missing/null extensions and restart progress',()=>{const f=fixture();try{for(let n=0;n<35;n++)f.db.put('operation/op-'+n,op('op-'+n,n));let store=new OperationStore<ReturnType<typeof op>>(f.db,'prepare');for(let n=0;n<5;n++)store.prepareStep(2);const progress=store.progress();store=new OperationStore(f.db,'prepare');assert.deepEqual(store.progress(),progress);for(let n=0;n<200&&store.progress().stage!=='READY';n++)store.prepareStep();assert.equal(store.progress().stage,'READY');assert.equal(store.native,false);const original=f.db.get('operation/op-2');assert.deepEqual(store.get('operation/op-2'),original);const next=new OperationStore<ReturnType<typeof op>>(f.db,'native');finish(next);assert.equal(f.db.get('schema'),2);for(let n=0;n<35;n++)assert.deepEqual(next.get('operation/op-'+n),opSnapshot(f.db,'operation/op-'+n));const disabled=new OperationStore<ReturnType<typeof op>>(f.db,'legacy');assert.equal(disabled.native,true);const changed=disabled.get('operation/op-2')!;changed.custom.explicitNull=null;(changed as ReturnType<typeof op>&{resolution?:unknown}).resolution={observed:'latest'};disabled.put('operation/op-2',changed);assert.deepEqual((new OperationStore<ReturnType<typeof op>>(f.db,'legacy').get('operation/op-2')as ReturnType<typeof op>&{resolution?:unknown}).resolution,{observed:'latest'});assert.throws(()=>f.db.put('operation/op-2',original),/INCOMPATIBLE_OPERATION_WRITER/);}finally{f.close();}});
function opSnapshot(db:SqlRecords,key:string){return db.get(key);}
test('migration tracks old-writer update/delete/insert while backfilling and never cuts over stale rows',()=>{const f=fixture();try{for(let n=0;n<20;n++)f.db.put('operation/op-'+String(n).padStart(2,'0'),op('op-'+String(n).padStart(2,'0'),n));let store=new OperationStore<ReturnType<typeof op>>(f.db,'native');store.prepareStep(2);const updated={...op('op-00',0),resolution:{observed:null}};f.db.put('operation/op-00',updated);f.db.delete('operation/op-01');f.db.put('operation/earlier',op('earlier',99));store=new OperationStore(f.db,'native');finish(store);assert.deepEqual(store.get('operation/op-00'),updated);assert.equal(store.get('operation/op-01'),undefined);assert.deepEqual(store.get('operation/earlier'),f.db.get('operation/earlier'));assert.equal(store.stats().eligible,20);}finally{f.close();}});
test('corruption blocks migration without marker switch or guessed default and leaves legacy bytes intact',()=>{const f=fixture();try{f.db.put('operation/corrupt',{phase:'RUNNING',tool:'read',sequence:1,createdAt:1,deadlineMs:'not-time'});const store=new OperationStore(f.db,'native');assert.throws(()=>store.prepareStep(),/SQLITE_RECORD_CORRUPT/);assert.equal(store.native,false);assert.equal(f.db.get('schema'),undefined);assert.equal(f.db.get<{deadlineMs:string}>('operation/corrupt').deadlineMs,'not-time');assert.equal(store.progress().stage,'BLOCKED');assert.equal(store.blocked,true);}finally{f.close();}});
test('native phase guards preserve RUNNING and terminal identity while arguments and results have independent rows',()=>{const f=fixture();try{const store=new OperationStore<StoredOperation&Record<string,unknown>>(f.db,'native');finish(store);const value={...op('live'),phase:'ADMITTED',terminalAt:undefined,terminalNotified:undefined,result:undefined,args:{source:'😀'.repeat(40000)}};store.put('operation/live',value);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM operation_args_v2').get()!.n,1);const running=store.get('operation/live')!;running.phase='DISPATCHED';store.put('operation/live',running);running.phase='RUNNING';store.put('operation/live',running);assert.deepEqual(store.get('operation/live')!.args,value.args);const terminal=store.get('operation/live')!;terminal.phase='UNKNOWN';terminal.terminalAt=Date.now();terminal.result={error:{code:'EFFECT_UNKNOWN'}};delete terminal.args;store.put('operation/live',terminal);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM operation_args_v2').get()!.n,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM operation_result_v2').get()!.n,1);assert.equal(store.holds(),true);assert.throws(()=>store.put('operation/live',{...terminal,phase:'SUCCEEDED'}),/SQLITE_OPERATION_CONFLICT/);assert.equal(store.get('operation/live')!.phase,'UNKNOWN');}finally{f.close();}});

test('every migration stage restarts from its durable cursor and native payload corruption never defaults',()=>{const f=fixture();try{f.db.put('operation/original',op('original'));let store=new OperationStore<ReturnType<typeof op>>(f.db,'native');const seen=new Set<string>();for(let n=0;n<100&&!store.native;n++){seen.add(String(store.progress().stage));store.prepareStep(1);store=new OperationStore(f.db,'native');}assert.equal(store.native,true);for(const stage of ['BACKFILL','VERIFY','VERIFY_NATIVE','READY'])assert.ok(seen.has(stage),stage);f.db.query('DELETE FROM operation_result_v2 WHERE key=?','operation/original');assert.throws(()=>store.get('operation/original'),/SQLITE_RECORD_CORRUPT/);assert.equal(store.native,true);}finally{f.close();}});

test('terminal receipt digest survives native payload expiry without retaining result body',()=>{const f=fixture();try{const original=op('receipt');f.db.put('operation/receipt',original);const store=new OperationStore<ReturnType<typeof op>>(f.db,'native');finish(store);const receipt=store.receiptDigest('operation/receipt');assert.match(receipt!,/^[a-f0-9]{64}$/);const record=store.get('operation/receipt')!;delete (record as {result?:unknown}).result;store.put('operation/receipt',record);assert.equal(store.receiptDigest('operation/receipt'),receipt);assert.equal(store.get('operation/receipt')!.result,undefined);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM operation_result_v2').get()!.n,0);}finally{f.close();}});

test('migration rejects derived hold tampering and aggregate corruption before cutover',()=>{
  for(const tamper of ['UPDATE operation_native_v2 SET hold=0,leaseBlock=0','UPDATE operation_native_stats_v2 SET holdCount=0']){
    const f=fixture();try{
      const held={...op('held'),phase:'UNKNOWN',tool:'write',result:undefined};f.db.put('operation/held',held);
      const store=new OperationStore(f.db,'native');store.prepareStep();store.prepareStep();
      f.sqlite.exec(tamper);
      assert.throws(()=>finish(store),/SQLITE_RECORD_CORRUPT/);
      assert.equal(store.native,false);assert.equal(store.blocked,true);
      assert.equal(f.db.get('schema'),undefined);
    }finally{f.close();}
  }
});

test('migration rejects mismatched operation identity and oversized legacy record without cutover',()=>{
  for(const bad of [{...op('different')},{...op('bound'),result:{large:'x'.repeat(4*1024*1024)}}]){
    const f=fixture();try{f.db.put('operation/bound',bad);const store=new OperationStore(f.db,'native');assert.throws(()=>store.prepareStep(),/SQLITE_RECORD_CORRUPT/);assert.equal(store.blocked,true);assert.equal(f.db.get('schema'),undefined);}finally{f.close();}
  }
});

test('native last Activity time returns to zero after final retained operation deletion',()=>{
  const f=fixture();try{f.db.put('operation/last',op('last'));const store=new OperationStore(f.db,'native');finish(store);assert.ok(store.lastActivityAt()>0);store.delete('operation/last');assert.equal(store.lastActivityAt(),0);assert.equal(store.stats().eligible,0);}finally{f.close();}
});

test('true pre-index 10k legacy corpus starts bounded native migration without enumerating v1 projection',()=>{
  const f=fixture();try{
    f.db.transaction(()=>{for(let n=0;n<10000;n++){const id='retained-'+String(n).padStart(5,'0');f.db.put('operation/'+id,{phase:'SUCCEEDED',tool:'read',sequence:n,createdAt:1700000000000+n,deadlineMs:1700000030000+n,terminalAt:1700000001000+n,terminalNotified:true});}});
    const store=new OperationStore(f.db,'native');assert.equal(store.journalReady,false);
    assert.equal(f.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='operation_index_v1'").get(),undefined);
    store.prepareStep();assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM operation_native_v2').get()!.n,16);
    assert.throws(()=>store.activeStats(),/counter authority|index is unavailable/);
    finish(store,5000);
    assert.equal(store.journalReady,true);assert.equal(store.stats().eligible,10000);
    let passes=0;while(store.stats().eligible>1000){for(const {key} of store.excessRetention())store.delete(key);if(++passes>100)assert.fail('Oversized ordinary retention did not converge');}
    assert.equal(store.stats().eligible,1000);
    assert.equal(f.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='operation_index_v1'").get(),undefined);
  }finally{f.close();}
});

test('legacy expiry during migration resets reverse verification and never retains unverified receipt evidence',()=>{
  const f=fixture();try{
    const original=op('expiring');f.db.put('operation/expiring',original);const store=new OperationStore(f.db,'native');
    for(let n=0;n<100&&store.progress().stage!=='READY';n++)store.prepareStep();assert.equal(store.progress().stage,'READY');
    const expired=f.db.get<Record<string,unknown>>('operation/expiring');delete expired.result;f.db.put('operation/expiring',expired);
    store.prepareStep();assert.equal(store.progress().stage,'VERIFY_NATIVE');finish(store);assert.equal(store.get('operation/expiring')!.result,undefined);assert.equal(store.receiptDigest('operation/expiring'),undefined);
  }finally{f.close();}
});

test('incomplete phase/timestamp state blocks cutover rather than manufacturing an active terminal row',()=>{
  const f=fixture();try{
    const incomplete={phase:'SUCCEEDED',tool:'read',sequence:1,createdAt:1,deadlineMs:2};f.db.put('operation/incomplete',incomplete);
    const store=new OperationStore(f.db,'native');assert.throws(()=>store.prepareStep(),/SQLITE_RECORD_CORRUPT/);assert.equal(store.blocked,true);assert.deepEqual(f.db.get('operation/incomplete'),incomplete);assert.equal(f.db.get('schema'),undefined);
  }finally{f.close();}
});

test('R04 partial terminal index excludes active rows, preserves terminal ordering and old physical schema',()=>{
  const f=fixture();
  try {
    const store=new OperationStore<StoredOperation&Record<string,unknown>>(f.db,'native');
    finish(store);
    const ddl=f.sqlite.prepare("SELECT sql FROM sqlite_master WHERE name='operation_native_terminal_v2'").get() as {sql:string};
    assert.match(ddl.sql,/WHERE terminal IS NOT NULL/);
    const current={...op('partial-index'),phase:'ADMITTED',terminalAt:undefined,
      terminalNotified:undefined,result:undefined};
    store.put('operation/partial-index',current);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM operation_native_v2 WHERE terminal IS NOT NULL").get()!.n,0);
    assert.equal(f.sqlite.prepare('SELECT activeCount FROM operation_native_stats_v2 WHERE id=1').get()!.activeCount,1);
    const dispatched=store.get('operation/partial-index')!;
    dispatched.phase='DISPATCHED';
    store.put('operation/partial-index',dispatched);
    const running=store.get('operation/partial-index')!;
    running.phase='RUNNING';
    store.put('operation/partial-index',running);
    const terminal=store.get('operation/partial-index')!;
    terminal.phase='SUCCEEDED';
    terminal.terminalAt=Date.now();
    terminal.terminalNotified=true;
    terminal.result={operationId:'partial-index',status:'SUCCEEDED',effectState:'NONE'};
    store.put('operation/partial-index',terminal);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM operation_native_v2 WHERE terminal IS NOT NULL").get()!.n,1);
    assert.ok(store.lastActivityAt()>0);
    f.sqlite.exec("DROP INDEX operation_native_terminal_v2");
    f.sqlite.exec("CREATE INDEX operation_native_terminal_v2 ON operation_native_v2(terminal DESC)");
    const legacyShape=new OperationStore<StoredOperation&Record<string,unknown>>(f.db,'legacy');
    assert.equal(legacyShape.native,true);
    assert.equal(legacyShape.get('operation/partial-index')!.phase,'SUCCEEDED');
    legacyShape.delete('operation/partial-index');
    assert.equal(legacyShape.lastActivityAt(),0);
  }finally{f.close();}
});

test('R04 native small read selectors share canonical row, while large and mutating args retain external payloads',()=>{
  const f=fixture();
  try {
    const store=new OperationStore<StoredOperation&Record<string,unknown>>(f.db,'native');
    finish(store);
    const small={...op('small-read'),phase:'ADMITTED',terminalAt:undefined,
      terminalNotified:undefined,result:undefined,args:{files:[{path:'main.pjs'}]}};
    store.put('operation/small-read',small);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM operation_args_v2 WHERE key='operation/small-read'").get()!.n,0);
    const raw=f.sqlite.prepare("SELECT hasArgs,context FROM operation_native_v2 WHERE key='operation/small-read'").get() as {hasArgs:number;context:string};
    assert.equal(raw.hasArgs,0);
    assert.deepEqual(JSON.parse(raw.context).args,small.args);
    assert.deepEqual(store.get('operation/small-read'),small);
    assert.deepEqual(store.budgetObligations().find(x=>x.tool==='read')?.args,small.args);
    const large={...op('large-read'),phase:'ADMITTED',terminalAt:undefined,
      terminalNotified:undefined,result:undefined,args:{files:[{path:'x'.repeat(2048)}]}};
    store.put('operation/large-read',large);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM operation_args_v2 WHERE key='operation/large-read'").get()!.n,1);
    assert.deepEqual(store.get('operation/large-read')?.args,large.args);
    const mutation={...op('mutating-read'),phase:'ADMITTED',terminalAt:undefined,
      terminalNotified:undefined,result:undefined,mutating:true,args:{files:[{path:'main.pjs'}]}};
    store.put('operation/mutating-read',mutation);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM operation_args_v2 WHERE key='operation/mutating-read'").get()!.n,1);
    const running=store.get('operation/small-read')!;
    running.phase='DISPATCHED';
    store.put('operation/small-read',running);
    running.phase='RUNNING';
    store.put('operation/small-read',running);
    const terminal=store.get('operation/small-read')!;
    terminal.phase='SUCCEEDED';
    terminal.terminalAt=Date.now();
    terminal.terminalNotified=true;
    terminal.result={operationId:'small-read',status:'SUCCEEDED',effectState:'NONE'};
    delete terminal.args;
    store.put('operation/small-read',terminal);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM operation_args_v2 WHERE key='operation/small-read'").get()!.n,0);
    assert.equal(store.get('operation/small-read')?.args,undefined);
    assert.equal(store.receiptDigest('operation/small-read')?.length,64);
    assert.equal(new OperationStore<StoredOperation&Record<string,unknown>>(f.db,'legacy').get('operation/small-read')?.phase,'SUCCEEDED');
  }finally{f.close();}
});
test('R04 small selector survives legacy migration, legacy external conversion and corruption is rejected',()=>{
  const f=fixture();
  try{
    const args={files:[{path:'main.pjs'}]};
    const legacy={...op('small-legacy'),args};
    f.db.put('operation/small-legacy',legacy);
    const store=new OperationStore<StoredOperation&Record<string,unknown>>(f.db,'native');
    finish(store);
    assert.deepEqual(store.get('operation/small-legacy')?.args,args);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM operation_args_v2 WHERE key='operation/small-legacy'").get()!.n,0);
    assert.deepEqual(store.budgetObligations().find(x=>x.tool==='read'),undefined);
    const sql="UPDATE operation_native_v2 SET context=? WHERE key=?";
    const native=f.sqlite.prepare("SELECT context FROM operation_native_v2 WHERE key='operation/small-legacy'").get() as {context:string};
    const bad=JSON.parse(native.context) as Record<string,unknown>;
    bad.args={files:[{path:'x'.repeat(2048)}]};
    f.db.query(sql,JSON.stringify(bad),'operation/small-legacy');
    assert.throws(()=>store.get('operation/small-legacy'),/SQLITE_RECORD_CORRUPT/);
  }finally{f.close();}
});
