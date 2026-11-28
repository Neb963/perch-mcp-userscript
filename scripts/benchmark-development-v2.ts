/** Exercise the real local Worker/SDK and operation ledger; no browser or provider effects. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { createCapacityHarness } from '../tests/integration/gateway-capacity-harness.js';
import { activateSyntheticNative, fixtureSnapshot, issueSyntheticToken, metricDelta, syntheticMcp } from '../tests/fixtures/optimization-client.js';

const native = process.env.BENCHMARK_NATIVE === 'true';
const histories = (process.env.BENCHMARK_HISTORIES ?? '0,150,999,1000').split(',').map(Number);
assert.ok(histories.every((count,index)=>Number.isInteger(count)&&count>=0&&count<=1000&&(index===0||count>histories[index-1]!)));
const vars = {DEVELOPMENT_CONTRACT_V2_ENABLED:'true',DEVELOPMENT_CONTRACT_V2_EXECUTION_ENABLED:'true',
  ...(native ? {CANONICAL_STORAGE_MODE:'native',BINARY_PAYLOADS_ENABLED:'true'} : {})};
const h = await createCapacityHarness(1,vars,{entryPoint:'tests/fixtures/optimization-runtime.ts'});
const admin='/api/v1/admin';
try {
  const fixture=h.fixtures[0]!;
  if(native)await activateSyntheticNative(h,fixture);
  const path=admin+'/workspaces/'+fixture.workspaceId;
  const before=await h.get(path), connector=await h.get(admin+'/agents/'+fixture.agentId);
  const migrated=await h.request(admin+'/connectors/'+fixture.agentId+'/upgrade',{
    expectedRevision:connector.revision,expectedWorkspaceRevision:before.revision,acknowledgeReauthorization:true,
  });
  const work=migrated.workspace as Record<string,unknown>;
  const target='w2.'+fixture.workspaceId+'.'+work.assignmentGeneration+'.'+work.bindingGeneration;
  fixture.lease=await h.executionRequest('/api/v1/tab/claim',{
    workspaceId:fixture.workspaceId,binding:fixture.binding,adapterVersion:'2',tabInstanceId:'benchmark-v2-doc',
  });
  const token=await issueSyntheticToken(h,fixture);
  const samples: unknown[] = [];
  async function measure(name:string,tag:number,operation:()=>Promise<unknown>) {
    const start=await fixtureSnapshot(h,fixture),clock=performance.now();
    await operation();
    samples.push({name,tag,elapsedMs:performance.now()-clock,usage:metricDelta(start,await fixtureSnapshot(h,fixture))});
  }
  let tracePending=process.env.BENCHMARK_TRACE==='true';
  async function cycle(tool:string,args:Record<string,unknown>,effect?:'source-publication') {
    const traced=tracePending;
    if(traced)tracePending=false;
    async function step<T>(name:string,fn:()=>Promise<T>):Promise<T> {
      if(!traced)return fn();
      const baseline=await fixtureSnapshot(h,fixture),clock=performance.now();
      const result=await fn();
      samples.push({name:'trace:'+name,tag:0,elapsedMs:performance.now()-clock,
        usage:metricDelta(baseline,await fixtureSnapshot(h,fixture))});
      return result;
    }
    const operationKey='k2.'+Date.now()+'.'+crypto.randomUUID();
    const admitted=await step('mcp-admission',()=>syntheticMcp(h,fixture,token,tool,{target,operationKey,...args}));
    const operationId=String(admitted.operationId);
    const polled=await step('browser-poll',()=>h.browser(fixture,'poll',{waitMs:0}));
    assert.equal((polled.operations as Record<string,unknown>[])[0]?.operationId,operationId);
    await step('browser-running',()=>h.browser(fixture,'reply',{operationId,phase:'RUNNING'}));
    if(effect)await step('browser-segment',()=>h.browser(fixture,'segment',{operationId,
      segment:{sequence:0,kind:effect,digest:'a'.repeat(64)}}));
    await step('browser-terminal',()=>h.browser(fixture,'reply',{operationId,phase:'SUCCEEDED',
      result:{operationId,status:'SUCCEEDED',effectState:'VERIFIED',data:{fixture:true}}}));
    const status=await step('mcp-status',()=>syntheticMcp(h,fixture,token,'operation_status',{target,operationKey}));
    assert.equal(status.phase,'SUCCEEDED');
  }
  const read={files:[{path:'main.pjs'}]};
  let history=0;
  for(const wanted of histories) {
    while(history<wanted) {await cycle('read',read);history++;}
    await measure('full-read-lifecycle',history,()=>cycle('read',read));
    history++;
  }
  const files=Array.from({length:10},(_,i)=>({path:'scratch/file-'+i,encoding:'utf8',content:'fixture',ifAbsent:true}));
  await measure('ten-separate-writes',history+10,async()=>{
    for(const file of files)await cycle('write',{files:[file]},'source-publication');
  });
  await measure('one-ten-file-write',history+11,()=>cycle('write',{files},'source-publication'));
  // Comparable 10-action heterogeneous workload versus ten separate
  // transactions. No actual provider effect: synthetic browser replies settle
  // the same durable MCP/Registry/Workspace lifecycle for each tool.
  const mixed=Array.from({length:10},(_,i)=>i%2===0?
    {tool:'read',args:{files:[{path:'main.pjs'}]}}:
    {tool:'write',args:{files:[{path:'scratch/mixed-'+i,encoding:'utf8',content:'fixture',ifAbsent:true}]}});
  await measure('ten-mixed-individual-actions',history+12,async()=>{
    for(const step of mixed)await cycle(step.tool,step.args,
      step.tool==='write'?'source-publication':undefined);
  });
  await measure('one-ten-action-mixed-batch',history+13,()=>cycle('batch',{actions:mixed},'source-publication'));
  for(const count of [1,5,10,20,30,50]) {
    const state=await h.get(admin+'/workspaces');
    const owned=(state.items as unknown[]).length;
    for(let index=owned;index<count;index++)
      await h.request(admin+'/workspaces',{contractVersion:2,label:'Synthetic '+index,
        connectorId:fixture.agentId,expectedConnectorRevision:(migrated.connector as Record<string,unknown>).revision});
    await measure('indexed-discovery',count,async()=>{
      const result=await syntheticMcp(h,fixture,token,'workspace_status',{});
      assert.equal((result.workspaces as unknown[]).length,count);
    });
  }
  if (process.env.BENCHMARK_MULTI_CONNECTOR === 'true') {
    const clients: {agent:string;token:string}[]=[];
    for (const count of [10,20]) {
      await measure('connector-issuance',count,async()=>{
        for (let i=clients.length;i<count;i++) {
          const state=await h.get(admin+'/state');
          const connector=await h.request(admin+'/connectors',{expectedRevision:state.revision,label:'Connector '+i});
          const agent=String(connector.id);
          const token=await issueSyntheticToken(h,{...fixture,agentId:agent});
          clients.push({agent,token});
        }
      });
      await measure('connector-discovery',count,async()=>{
        const discovered=await Promise.all(clients.map(({agent,token})=>
          syntheticMcp(h,{...fixture,agentId:agent},token,'workspace_status',{})));
        assert.ok(discovered.every(result=>Array.isArray(result.workspaces)&&result.workspaces.length===0));
      });
    }
  }
  const report={mode:native?'native':'legacy',
    sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    sourceDirty:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim().length>0,
    runtime:'Miniflare 4.20260730.0 and actual pinned local SDK',
    scope:'Local SDK OAuth/MCP, Registry, Workspace SQL, exact selected synthetic dispatch and receipts. The browser is simulated by the harness. All runtime outbound network is denied.',
    samples};
  await writeFile(process.argv[2]??'/tmp/perch-development-v2.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({mode:report.mode,samples:samples.length}));
} finally {
  await h.close();
}
