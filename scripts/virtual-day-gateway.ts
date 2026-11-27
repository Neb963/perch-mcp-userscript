/** Real pinned local SQLite calls under virtual clocks; no provider network. */
import {writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {createCapacityHarness} from '../tests/integration/gateway-capacity-harness.js';
import {fixtureSnapshot,metricDelta,activateSyntheticNative} from '../tests/fixtures/optimization-client.js';
const operations=Number(process.env.VIRTUAL_OPERATIONS??200);
assert.ok(Number.isSafeInteger(operations)&&operations>=1&&operations<=1000);
const native=process.env.VIRTUAL_NATIVE==='true';
const h=await createCapacityHarness(1,native?{CANONICAL_STORAGE_MODE:'native',BINARY_PAYLOADS_ENABLED:'true'}:{},
  {entryPoint:'tests/fixtures/optimization-fault-runtime.ts'});
try {
  const f=h.fixtures[0]!,stub=h.wns.get(h.wns.idFromName(f.workspaceId));
  let metricSnapshots=0;
  async function snapshot(){metricSnapshots++;return fixtureSnapshot(h,f);}
  const migrationBefore=await snapshot();
  if(native)await activateSyntheticNative(h,f);
  const migrationUsage=metricDelta(migrationBefore,await snapshot());
  const baseTime=Date.now(),started=performance.now();
  const before=await snapshot(),operationIds:string[]=[],samples:unknown[]=[];
  let completed=0,lastOperationMinute=-Infinity,idlePolls=0,heartbeats=0;
  let registryAlarms=0,workspaceAlarms=0,fixtureClockCommands=0,fixtureSchedulerChecks=0;
  async function advance(now:number) {
    for(const object of [h.registry,stub]) {
      const response=await object.fetch('https://internal/__fixture_faults',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({now})});
      assert.equal(response.status,200);fixtureClockCommands++;
    }
  }
  async function dueAlarms() {
    for(const [name,object] of [['registry',h.registry],['workspace',stub]] as const) {
      const response=await object.fetch('https://internal/__fixture_alarm_if_due');
      assert.equal(response.status,200);
      const result=await response.json() as {fired:boolean};fixtureSchedulerChecks++;
      if(result.fired) {if(name==='registry')registryAlarms++;else workspaceAlarms++;}
    }
  }
  for(let minute=0;minute<=1440;minute++) {
    await advance(baseTime+minute*60_000);
    // Deliver due callbacks before request maintenance can reschedule them.
    await dueAlarms();
    if(minute>0) {await h.browser(f,'heartbeat');heartbeats++;}
    const wanted=minute<480?Math.min(operations,Math.floor(minute*operations/480)+1):operations;
    let dispatchedHere=0;
    while(completed<wanted) {
      const admitted=await h.admit(f),operationId=String(admitted.operationId);
      operationIds.push(operationId);
      const poll=await h.browser(f,'poll',{waitMs:0});
      assert.equal((poll.operations as {operationId:string}[])[0]?.operationId,operationId);
      await h.browser(f,'reply',{operationId,phase:'RUNNING'});
      await h.browser(f,'reply',{operationId,phase:'SUCCEEDED',result:{operationId,status:'SUCCEEDED',effectState:'VERIFIED',data:{marker:'virtual-day'}}});
      assert.equal((await h.status(f,operationId)).status,'SUCCEEDED');
      completed++;dispatchedHere++;lastOperationMinute=minute;
    }
    // Real empty-poll SQL calls at current5s/recent,15s/stable cadence.
    // Logical time is quantized to 60 s; no wall-clock sleep or network latency.
    if(minute<1440)for(let slot=0;slot<Math.max(0,(minute-lastOperationMinute<2?12:4)-dispatchedHere);slot++) {
      assert.deepEqual((await h.browser(f,'poll',{waitMs:0})).operations,[]);idlePolls++;
    }
    if(minute===720)for(const object of [h.registry,stub]) {
      const result=await object.fetch('https://internal/__fixture_restart');assert.equal(result.status,200);
    }
    if(minute%360===0) {
      const sample=await snapshot();
      samples.push({minute,completed,usage:metricDelta(before,sample)});
      console.log(JSON.stringify({kind:'virtual-day-progress',minute,completed,idlePolls,heartbeats}));
    }
  }
  assert.equal(completed,operations);assert.equal(heartbeats,1440);
  const earliest=await h.status(f,operationIds[0]!);
  assert.equal(earliest.status,'SUCCEEDED');
  assert.equal((earliest.error as {code:string}).code,'RESULT_EXPIRED');
  const after=await snapshot(),usage=metricDelta(before,after);
  assert.equal(usage.registry!.sqlFailures,0);assert.equal(usage.workspace!.sqlFailures,0);
  assert.equal(usage.registry!.coldStarts,1);assert.equal(usage.workspace!.coldStarts,1);
  const output={schemaVersion:1,source:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    sourceDirty:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim().length>0,
    mode:native?'native':'legacy',runtime:'Miniflare4.20260730.0/workerd1.20260730.1',
    virtualStart:new Date(baseTime).toISOString(),virtualEnd:new Date(baseTime+86_400_000).toISOString(),
    virtualHours:24,operations:completed,activeOperationHours:8,heartbeats,idlePolls,registryAlarms,workspaceAlarms,
    fixtureAdministration:{fixtureClockCommands,fixtureSchedulerChecks,metricSnapshots,metricEndpointRequests:3*metricSnapshots,readerRestarts:2,excludedSchedulerAlarmReads:fixtureSchedulerChecks,excludedSchedulerAlarmConsumptions:registryAlarms+workspaceAlarms,excludedFromProductionCounts:true},
    wallMs:performance.now()-started,initializationUsage:before,migrationUsage,usage,samples,
    resultRetention:'First operation remains SUCCEEDED and returns RESULT_EXPIRED after 24 h; no replay.',
    evidenceBoundary:'Trusted-AS internal admissions and actual local HTTP browser routes. This is NOT SDK OAuth/MCP ingress or physical hibernation evidence.',
    schedule:'60 second logical ticks,5 second recent/15 second stable poll call counts; zero jitter is conservative; heartbeat every 60 seconds; due-only alarm callbacks; restart both canonical readers at 12 h.',
    unavailable:'Provider billable GB-s, true cold eviction, real-browser timing/latency, logs and account billing DEFERRED_LIVE.'};
  const path=process.argv[2]??'/tmp/perch-virtual-day.json';
  await writeFile(path,JSON.stringify(output,null,2)+'\n');
  console.log(JSON.stringify({output:path,operations:completed,wallMs:output.wallMs}));
} finally {await h.close();}
