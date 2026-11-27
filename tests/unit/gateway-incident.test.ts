import test from 'node:test';
import assert from 'node:assert/strict';
import { incident, persistIncident, probeRegistryHealth, routeClass } from '../../apps/gateway/src/incident.js';
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
