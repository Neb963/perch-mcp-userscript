import {writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {createCapacityHarness} from '../tests/integration/gateway-capacity-harness.js';
import {fixtureSnapshot,metricDelta,issueSyntheticToken,syntheticMcp,activateSyntheticNative} from '../tests/fixtures/optimization-client.js';
const histories=(process.env.BENCHMARK_HISTORIES??'0,150,999,1000').split(',').map(Number);
assert.ok(histories.every(n=>Number.isSafeInteger(n)&&n>=0&&n<=1000));
const h=await createCapacityHarness(1,{
  ...(process.env.BENCHMARK_NATIVE==='true'?{CANONICAL_STORAGE_MODE:'native',BINARY_PAYLOADS_ENABLED:'true'}:{})
},{entryPoint:'tests/fixtures/optimization-runtime.ts'});
try {
  const f=h.fixtures[0]!, startup=await fixtureSnapshot(h,f);
  const activated=process.env.BENCHMARK_NATIVE==='true'?await activateSyntheticNative(h,f):undefined;
  const prepared=await fixtureSnapshot(h,f),migration=metricDelta(startup,prepared);
  const token=await issueSyntheticToken(h,f), oauth=metricDelta(prepared,await fixtureSnapshot(h,f));
  const rows:unknown[]=[];
  async function measure(path:string,history:number,fn:()=>Promise<unknown>) {
    const before=await fixtureSnapshot(h,f),at=performance.now(); await fn();
    const after=await fixtureSnapshot(h,f);
    const sample={path,history,wallMs:performance.now()-at,usage:metricDelta(before,after)};
    rows.push(sample);return sample;
  }
  let history=0;
  for(const wanted of histories) {
    while(history<wanted){await h.cycle(f);history++;}
    for(let repeat=0;repeat<3;repeat++)await measure('http-idle',history,()=>h.browser(f,'poll',{waitMs:0}));
    await measure('full-mcp-lifecycle',history,async()=>{
      const admitted=await syntheticMcp(h,f,token,'read',{path:'main.pjs'});
      const operationId=String(admitted.operationId);
      const fetched=await h.browser(f,'poll',{waitMs:0});
      assert.equal((fetched.operations as {operationId:string}[])[0]?.operationId,operationId);
      await h.browser(f,'reply',{operationId,phase:'RUNNING'});
      await h.browser(f,'reply',{operationId,phase:'SUCCEEDED',result:{operationId,status:'SUCCEEDED',effectState:'VERIFIED',data:{marker:'synthetic'}}});
      await syntheticMcp(h,f,token,'operation_status',{operationId});
    });
    history++;
    await measure('activity-page',history,()=>h.get('/api/v1/admin/activity'));
  }
  const report={source:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    runtime:'Miniflare4.20260730.0/workerd1.20260730.1',fixture:'read main.pjs, tiny marker result; actual local SDK OAuth token and MCP HTTP; all outbound denied',
    measuredDimensions:'consumed SQL cursor rows/statements; Worker/DO invocations; KV method calls; alarm API calls; response bytes; wall proxy',
    unavailable:'provider billing/duration GB-s/physical hibernation/cold eviction/log billing DEFERRED_LIVE',startup,migration,activated,oauth,rows};
  await writeFile(process.argv[2]??'/tmp/perch-optimization-benchmark.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({samples:rows.length,output:process.argv[2]??'/tmp/perch-optimization-benchmark.json'}));
} finally {await h.close();}
