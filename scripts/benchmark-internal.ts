/** Same tiny-read lifecycle as the pinned baseline gateway-capacity harness. */
import {writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createCapacityHarness} from '../tests/integration/gateway-capacity-harness.js';
import {activateSyntheticNative,fixtureSnapshot,metricDelta} from '../tests/fixtures/optimization-client.js';
const native=process.env.BENCHMARK_NATIVE==='true';
const h=await createCapacityHarness(1,native?{CANONICAL_STORAGE_MODE:'native',BINARY_PAYLOADS_ENABLED:'true'}:{},
  {entryPoint:'tests/fixtures/optimization-runtime.ts'});
try {
  const f=h.fixtures[0]!,startup=await fixtureSnapshot(h,f);
  if(native)await activateSyntheticNative(h,f);
  const prepared=await fixtureSnapshot(h,f),rows:unknown[]=[];
  let completed=0;
  for(const history of [0,150,999,1000]) {
    while(completed<history){await h.cycle(f);completed++;}
    const before=await fixtureSnapshot(h,f),begin=performance.now();
    await h.cycle(f);completed++;
    const usage=metricDelta(before,await fixtureSnapshot(h,f));
    const reads=usage.registry!.sqlReads!+usage.workspace!.sqlReads!;
    const writes=usage.registry!.sqlWrites!+usage.workspace!.sqlWrites!;
    rows.push({history,wallMs:performance.now()-begin,reads,writes,
      target:{reads:80,writes:30,met:reads<=80&&writes<=30},usage});
  }
  const output=process.argv[2]??'/tmp/perch-internal-benchmark.json';
  await writeFile(output,JSON.stringify({source:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    sourceDirty:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim().length>0,
    mode:native?'native':'legacy',runtime:'Miniflare4.20260730.0/workerd1.20260730.1',
    fixture:'Unmodified capacity harness cycle: authorize, admit read main.pjs, poll, RUNNING, tiny marker terminal, status and synchronous receipt drain. Both DOs; no MCP/OAuth acquisition/validation; retention/alarm work reported separately.',
    startup,migration:metricDelta(startup,prepared),rows},null,2)+'\n');
  console.log(JSON.stringify({output,samples:rows.length}));
} finally {await h.close();}
