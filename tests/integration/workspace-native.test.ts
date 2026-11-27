import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCapacityHarness} from './gateway-capacity-harness.js';
import {issueSyntheticToken,syntheticMcp} from '../fixtures/optimization-client.js';

type Stub={fetch:(url:string,init?:RequestInit)=>Promise<Response>};
async function control(stub:Stub,body:Record<string,unknown>) {
  const response=await stub.fetch('https://internal/__fixture_faults',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal(response.status,200);return response.json();
}
function result(operationId:string){return{operationId,status:'SUCCEEDED',effectState:'VERIFIED',data:{fixture:'native-operation'}};}

test('native Workspace complete ingress preserves lifecycle, exact terminal receipts after TTL and restart',{timeout:30000},async()=>{
  const h=await createCapacityHarness(1,{CANONICAL_STORAGE_MODE:'native'},{entryPoint:'tests/fixtures/optimization-fault-runtime.ts'});
  try{
    const f=h.fixtures[0]!,stub=h.wns.get(h.wns.idFromName(f.workspaceId));
    for(let n=0;n<50;n++){
      const state=await h.internal(stub,'/internal/migration',{action:'status'});
      if(state.stage==='NATIVE')break;
      await h.internal(stub,'/internal/migration',{workspaceId:f.workspaceId,action:'step',idempotencyKey:crypto.randomUUID()});
    }
    assert.equal((await h.internal(stub,'/internal/migration',{action:'status'})).stage,'NATIVE');
    const token=await issueSyntheticToken(h,f);
    const beforeW=await h.internal(stub,'/internal/sql-usage',{}),beforeR=await h.internal(h.registry,'/internal/sql-usage',{});
    const admitted=await syntheticMcp(h,f,token,'read',{path:'main.pjs'}),operationId=String(admitted.operationId);
    const poll=await h.browser(f,'poll',{waitMs:0});assert.equal((poll.operations as {operationId:string}[])[0]?.operationId,operationId);
    await h.browser(f,'reply',{operationId,phase:'RUNNING'});
    const runningBefore=await h.internal(stub,'/internal/sql-usage',{});
    await h.browser(f,'reply',{operationId,phase:'RUNNING'});
    const runningAfter=await h.internal(stub,'/internal/sql-usage',{});assert.equal(Number(runningAfter.writes)-Number(runningBefore.writes),0);
    await h.browser(f,'reply',{operationId,phase:'SUCCEEDED',result:result(operationId)});
    const status=await syntheticMcp(h,f,token,'operation_status',{operationId});assert.equal(status.status,'SUCCEEDED');
    const afterW=await h.internal(stub,'/internal/sql-usage',{}),afterR=await h.internal(h.registry,'/internal/sql-usage',{});
    const extraRunning={reads:Number(runningAfter.reads)-Number(runningBefore.reads),writes:Number(runningAfter.writes)-Number(runningBefore.writes)};
    console.log(JSON.stringify({fixture:'workspace-native-full-ingress',extraRunning,workspace:{reads:Number(afterW.reads)-Number(beforeW.reads)-extraRunning.reads,writes:Number(afterW.writes)-Number(beforeW.writes)-extraRunning.writes},registry:{reads:Number(afterR.reads)-Number(beforeR.reads),writes:Number(afterR.writes)-Number(beforeR.writes)}}));
    await control(stub as unknown as Stub,{now:Date.now()+660000});
    const expired=await h.status(f,operationId);assert.equal((expired.error as {code:string}).code,'RESULT_EXPIRED');
    await h.browser(f,'reply',{operationId,phase:'SUCCEEDED',result:result(operationId)});
    await assert.rejects(()=>h.browser(f,'reply',{operationId,phase:'SUCCEEDED',result:{...result(operationId),data:{changed:true}}}));
    const restarted=await stub.fetch('https://internal/__fixture_restart');assert.equal(restarted.status,200);
    assert.equal((await h.internal(stub,'/internal/migration',{action:'status'})).stage,'NATIVE');
    await h.browser(f,'reply',{operationId,phase:'SUCCEEDED',result:result(operationId)});
    assert.equal((await h.status(f,operationId)).status,'SUCCEEDED');
  }finally{await h.close();}
});

test('operator migration actions are exactly idempotent and cannot change action for an existing key',{timeout:30000},async()=>{
  const h=await createCapacityHarness(1,{CANONICAL_STORAGE_MODE:'prepare'});
  try{
    const f=h.fixtures[0]!,stub=h.wns.get(h.wns.idFromName(f.workspaceId)),key=crypto.randomUUID();
    const input={workspaceId:f.workspaceId,action:'step',idempotencyKey:key};
    const first=await h.internal(stub,'/internal/migration',input),again=await h.internal(stub,'/internal/migration',input);assert.deepEqual(again,first);
    await assert.rejects(()=>h.internal(stub,'/internal/migration',{...input,action:'resume'}),/CONFLICT/);
    for(let n=0;n<20;n++)await h.internal(stub,'/internal/migration',{...input,idempotencyKey:crypto.randomUUID()});
    const ready=await h.internal(stub,'/internal/migration',{action:'status'});assert.equal(ready.stage,'READY');assert.equal(ready.authority,'legacy');
    await h.cycle(f);
  }finally{await h.close();}
});

test('pinned workerd pre-index corpus migration processes bounded records without creating legacy projection',{timeout:30000},async()=>{
  const {build}=await import('esbuild'),{Miniflare}=await import('miniflare');
  const bundle=await build({stdin:{resolveDir:process.cwd(),contents:`
    import {SqlRecords} from './apps/gateway/src/sql.ts';
    import {OperationStore} from './apps/gateway/src/operation-store.ts';
    export class OperationFixture {
      constructor(state){this.state=state;this.db=new SqlRecords(state.storage);}
      async fetch(request){const b=await request.json();let result;
        if(b.action==='seed') {this.db.transaction(()=>{for(let n=0;n<b.count;n++){const operationId='fixture-'+String(n).padStart(5,'0');this.db.put('operation/'+operationId,{operationId,sequence:n,phase:'SUCCEEDED',tool:'read',createdAt:Date.now(),deadlineMs:Date.now()+30000,terminalAt:Date.now(),terminalNotified:true});}});result={seeded:b.count};}
        else {this.store??=new OperationStore(this.db,'native');const before=this.db.snapshotUsage();
          if(b.action==='migrate')result=this.store.prepareStep(16);
          else if(b.action==='reopen'){this.store=new OperationStore(this.db,'native');result=this.store.progress();}
          else if(b.action==='status')result=this.store.progress();
          const after=this.db.snapshotUsage();
          return Response.json({result,rows:this.db.query('SELECT key FROM operation_native_v2 ORDER BY key LIMIT 17').length,legacy:this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='operation_index_v1'").length,usage:{reads:after.reads-before.reads,writes:after.writes-before.writes,unmetered:after.unmetered-before.unmetered}});
        }return Response.json({result});
      }
    } export default {fetch(){return new Response('test-only',{status:404});}};
  `},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['cloudflare:*','node:*'],conditions:['workerd','worker','browser']});
  const mf=new Miniflare({cf:false,outboundService:()=>new Response('Synthetic fixture outbound access denied',{status:503}),modules:true,script:bundle.outputFiles[0]!.text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjects:{OPERATIONS:{className:'OperationFixture',useSQLite:true}}});
  try{
    await mf.ready;const ns=await mf.getDurableObjectNamespace('OPERATIONS'),stub=ns.get(ns.idFromName('ten-thousand-pre-index'));
    const call=async(action:string,extra:Record<string,unknown>={})=>{const response=await stub.fetch('https://synthetic.internal',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,...extra})});assert.equal(response.status,200);return response.json() as Promise<{result:Record<string,unknown>;rows:number;legacy:number;usage:{reads:number;writes:number;unmetered:number}}>};
    await call('seed',{count:10000});const first=await call('migrate');assert.equal(first.rows,16);assert.equal(first.legacy,0);assert.equal(first.usage.unmetered,0);assert.ok(first.usage.reads<300,'First step must not scan 10k records');
    await call('reopen');const second=await call('migrate');assert.equal(second.rows,17);assert.equal(second.legacy,0);assert.equal(second.result.stage,'BACKFILL');assert.ok(second.usage.reads<300);
    console.log(JSON.stringify({fixture:'workspace-pre-index-10000',first:first.usage,second:second.usage,legacyProjectionCreated:false}));
  }finally{await mf.dispose();}
});
