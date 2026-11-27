import test from 'node:test';
import assert from 'node:assert/strict';
import { incident, persistIncident, probeRegistryHealth, registryFailureReason, routeClass, IncidentRecorder, incidentSummary } from '../../apps/gateway/src/incident.js';
import { VERSION } from "../../apps/gateway/src/common.js";
import type { Env } from '../../apps/gateway/src/common.js';

const traceId='72094c21-3272-450a-89ef-969a00b90c18';
test('readiness stays unhealthy and preserves trace when Registry returns 500',async()=>{
  let probes=0;
  const outcome=await probeRegistryHealth(async()=>{
    probes++;
    return Response.json({code:'INTERNAL_ERROR',traceId},{status:500});
  });
  assert.equal(probes,1);
  assert.equal(outcome.response.status,503);
  const data=await outcome.response.json() as {ok:boolean;code:string;traceId:string;retryable:boolean};
  assert.equal(data.ok,false);
  assert.equal(data.code,'GATEWAY_DEGRADED');
  assert.equal(data.traceId,traceId);
  assert.equal(data.retryable,true);
  assert.equal(outcome.failure?.traceId,traceId);
});

test('connection error during scheduled/HTTP Registry probe stays an observable failed readiness',async()=>{
  const outcome=await probeRegistryHealth(async()=>{throw new TypeError('fixture network error');});
  assert.equal(outcome.response.status,503);
  assert.equal(outcome.failure?.error instanceof TypeError,true);
  assert.match(String(outcome.failure?.traceId),/^[0-9a-f-]{36}$/);
  const good=await probeRegistryHealth(async()=>Response.json({ok:true,schemaVersion:1,version:VERSION,paired:false,configured:false,providerWritesEnabled:false,nativeActionsEnabled:false,protocolVersions:['2026-07-28']}));
  assert.equal(good.response.status,200);
  assert.equal(good.failure,undefined);
});
test('readiness rejects malformed success bodies and projects only validated public fields',async()=>{
  const valid={ok:true,schemaVersion:1,version:VERSION,paired:false,configured:false,
    providerWritesEnabled:false,nativeActionsEnabled:false,protocolVersions:['2026-07-28']};
  for(const body of [{},{...valid,ok:false},{...valid,paired:'false'},
    {...valid,version:'0.0.0'},{...valid,protocolVersions:['SECRET-private-value']}]) {
    const result=await probeRegistryHealth(async()=>Response.json(body));
    assert.equal(result.response.status,503);
    const data=await result.response.text();
    assert.equal(JSON.parse(data).stage,'CORE_VALIDATE');
    assert.doesNotMatch(data,/SECRET-private-value/);
  }
  const html=await probeRegistryHealth(async()=>new Response('<html>SECRET-private</html>'));
  assert.equal(html.response.status,503);
  const good=await probeRegistryHealth(async()=>Response.json({...valid,private:'SECRET-private'}));
  assert.equal(good.response.status,200);
  assert.equal(good.response.headers.get('Cache-Control'),'no-store');
  assert.doesNotMatch(await good.response.text(),/SECRET-private/);
});

test('incident evidence excludes source, URLs, OAuth tokens and raw error messages',async()=>{
  const secret='SECRET-DO-NOT-LOG';
  const e=new Error('SQLITE_FULL '+secret+' https://gateway.example/token?code='+secret);
  const row=incident('worker','/token?code='+secret,500,e);
  assert.equal(routeClass('/mcp/agent-secret'),'mcp');
  assert.equal(row.route,'other','untrusted query string must not become persisted URL');
  assert.equal(row.causeClass,'STORAGE_FULL');
  assert.equal(row.errorClass,'Error');
  assert.doesNotMatch(JSON.stringify(row),/SECRET-DO-NOT-LOG|gateway\.example|\/token\?/);
  const puts:Array<{key:string;value:string;ttl:number}>=[];
  const env={OAUTH_KV:{put:async(key:string,value:string,options:{expirationTtl:number})=>{
    puts.push({key,value,ttl:options.expirationTtl});
  }}} as unknown as Env;
  await persistIncident(env,row);
  assert.equal(puts.length,0,'infrastructure incidents never consume OAuth KV writes');
  assert.doesNotMatch(JSON.stringify(incidentSummary()),/SECRET-DO-NOT-LOG/);
});


test('public readiness classifies quota and storage failures without exposing raw exception data',async()=>{
  for(const [message,reason] of [
    ['Your account has exceeded its free tier daily row read limit SECRET', 'REGISTRY_QUOTA'],
    ['Durable Object is overloaded SECRET', 'REGISTRY_OVERLOADED'],
    ['SQLITE_FULL SECRET', 'REGISTRY_STORAGE_FULL'],
    ['SQLITE_RECORD_CORRUPT SECRET', 'REGISTRY_STORAGE_CORRUPT'],
    ['invalid URL SECRET', 'REGISTRY_CONFIGURATION_INVALID'],
  ] as const) {
    assert.equal(registryFailureReason(new Error(message)),reason);
    const response=(await probeRegistryHealth(async()=>{throw new Error(message)})).response;
    assert.equal(response.status,503);
    const raw=await response.text();
    assert.equal(JSON.parse(raw).reason,reason);
    assert.doesNotMatch(raw,/SECRET/);
  }
  const invalid=await probeRegistryHealth(async()=>Response.json({traceId},{status:409,headers:{'X-Perch-Registry-Failure':'REGISTRY_SCHEMA_INCOMPATIBLE'}}));
  assert.equal(invalid.response.status,503);
  assert.equal((await invalid.response.json() as {reason:string}).reason,'REGISTRY_SCHEMA_INCOMPATIBLE');
  const forged=await probeRegistryHealth(async()=>Response.json({traceId},{status:500,headers:{'X-Perch-Registry-Failure':'secret-fixture'}}));
  assert.equal((await forged.response.json() as {reason:string}).reason,'REGISTRY_HTTP_ERROR');
});

test("quota dimensions are allowlisted and omit raw errors", async () => {
  const result=await probeRegistryHealth(async()=>{throw new Error("daily row read limit exceeded SECRET");});
  const data=await result.response.json() as {quotaDimension:string};
  assert.equal(data.quotaDimension,"ROWS_READ");
  assert.doesNotMatch(JSON.stringify(data),/SECRET/);
  const forged=await probeRegistryHealth(async()=>Response.json({}, {status:503,headers:{"X-Perch-Registry-Failure":"REGISTRY_QUOTA","X-Perch-Registry-Quota":"secret"}}));
  assert.equal((await forged.response.json() as {quotaDimension:string}).quotaDimension,"UNKNOWN");
});

test("generic limit errors are not evidence of account quota exhaustion", async()=>{
  for(const [message,reason] of [
    ["Exceeded CPU time limit", "REGISTRY_RUNTIME_LIMIT"],
    ["Durable Object storage operation exceeded timeout which caused object to be reset", "REGISTRY_TIMEOUT"],
    ["Exceeded account's spending cap for Durable Objects.", "REGISTRY_QUOTA"],
    ["Exceeded the limit for this object", "REGISTRY_LIMIT_UNSPECIFIED"],
    ["Your account is doing too many concurrent storage operations", "REGISTRY_OVERLOADED"],
  ] as const) assert.equal(registryFailureReason(new Error(message)),reason);
  const response=(await probeRegistryHealth(async()=>{throw new Error("Exceeded limit for durable object SECRET-123 https://example.com/token");})).response;
  const result=await response.json() as {signal:string;stage:string};
  assert.equal(result.stage,"DO_STUB");
  assert.match(result.signal,/exceeded limit for durable object/);
  assert.doesNotMatch(result.signal,/secret|123|example|https|token/);
  const upstream=await probeRegistryHealth(async()=>Response.json({}, {status:500,headers:{"X-Perch-Registry-Stage":"CORE_READ","X-Perch-Registry-Signal":"sqlite database error"}}));
  assert.equal((await upstream.response.json() as {stage:string}).stage,"CORE_READ");
});

test("exact provider quota signature emits connectivity-only delay, not mutation retry permission",async()=>{
  const {errorResponse}=await import("../../apps/gateway/src/common.js");
  const r=errorResponse(new Error("exceeded allowed rows read in durable objects free tier"));
  assert.equal(r.status,503);
  const b=await r.json() as Record<string,unknown>;
  assert.equal(b.connectivityRetryAfterSeconds,300);
  assert.equal(b.retryable,false);
  assert.equal(b.code,"GATEWAY_DEGRADED");
  const generic=await errorResponse(new Error("limit exceeded")).json() as Record<string,unknown>;
  assert.equal(generic.connectivityRetryAfterSeconds,undefined);
});


test('incident flood is bounded without SQL, KV or recurring timers',()=>{
  const logs:string[]=[];
  const recorder=new IncidentRecorder(value=>logs.push(value));
  const now=1_800_000_000_000;
  for(let i=0;i<10_000;i++) recorder.record(incident('registry','/internal/health',503,
    new Error('SQLITE_FULL private source'),traceId,now+i),now+i);
  assert.equal(logs.length,1);
  const summary=recorder.summary();
  assert.equal(summary.total,10_000);
  assert.equal(summary.suppressed,9999);
  assert.equal(summary.categories,1);
  assert.equal(summary.events[0]!.count,10_000);
  assert.equal(summary.durable,false);
  assert.doesNotMatch(logs.join(''),/private source/);
  recorder.record(incident('registry','/internal/health',503,new Error('SQLITE_FULL'),traceId,now+60_001),now+60_001);
  assert.equal(logs.length,2);
  assert.equal(JSON.parse(logs[1]!).suppressedSinceLast,9999);
});

test('independent isolates bound logs locally without claiming a global cap',()=>{
  const logs:string[]=[];
  const now=1_800_000_000_000;
  const first=new IncidentRecorder(value=>logs.push(value));
  const second=new IncidentRecorder(value=>logs.push(value));
  for(let i=0;i<300;i++) {
    const value=incident('worker','/token',500+i%100,new Error('timeout'),traceId,now);
    first.record(value,now);
    second.record(value,now);
  }
  assert.equal(logs.length,24,'each isolate independently emits at most12/window');
  for(const summary of [first.summary(),second.summary()]) {
    assert.equal(summary.categories,64);
    assert.equal(summary.events.length,32);
    assert.ok(summary.evictedCategories>0);
  }
});

test('incident summary cannot mutate recorder state and logging failure is auxiliary',()=>{
  const now=1_800_000_000_000;
  const recorder=new IncidentRecorder(()=>{throw new Error('unavailable logs');});
  assert.doesNotThrow(()=>recorder.record(incident('scheduled','/health',503,undefined,traceId,now),now));
  const summary=recorder.summary();
  summary.events[0]!.event.status=200;
  assert.equal(recorder.summary().events[0]!.event.status,503);
  assert.equal(recorder.summary().total,1);
});

test('untrusted Error.name is never logged even when syntactically valid',()=>{
  const error=new Error('unavailable');
  error.name='SecretCredential';
  const value=incident('worker','/token',500,error,traceId);
  assert.equal(value.errorClass,'Unknown');
  assert.doesNotMatch(JSON.stringify(value),/SecretCredential/);
});


test('wall-clock rollback does not refill the incident logging window',()=>{
  const logs:string[]=[];
  const recorder=new IncidentRecorder(value=>logs.push(value));
  const now=1_800_000_000_000;
  for(let i=0;i<100;i++) recorder.record(incident('worker','/token',500+i%100,
    new Error('timeout'),traceId,now-i),now-i);
  assert.equal(logs.length,12);
});
