import test from 'node:test';
import assert from 'node:assert/strict';
import { incident, persistIncident, probeRegistryHealth, registryFailureReason, routeClass } from '../../apps/gateway/src/incident.js';
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
  const good=await probeRegistryHealth(async()=>Response.json({schemaVersion:1,version:'fixture'}));
  assert.equal(good.response.status,200);
  assert.equal(good.failure,undefined);
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
  assert.equal(puts.length,1);
  assert.equal(puts[0]!.ttl,7*86400);
  assert.doesNotMatch(puts[0]!.value,/SECRET-DO-NOT-LOG/);
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
