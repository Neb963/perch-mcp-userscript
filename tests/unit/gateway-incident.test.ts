import test from 'node:test';
import assert from 'node:assert/strict';
import gateway from '../../apps/gateway/src/index.js';
import { incident, persistIncident, routeClass } from '../../apps/gateway/src/incident.js';
import type { Env } from '../../apps/gateway/src/common.js';
import type { ExecutionContext, ScheduledController } from '@cloudflare/workers-types';

function offlineFixture() {
  const traceId = '72094c21-3272-450a-89ef-969a00b90c18';
  const promises: Promise<unknown>[] = [];
  const writes: Array<{key: string; value: string; ttl: number}> = [];
  let probes = 0;
  const env = {
    ISSUER_URL: 'https://gateway.example',
    ALLOWED_ORIGINS: 'https://perchance.org',
    REGISTRY: {
      idFromName: () => 'installation',
      get: () => ({fetch: async () => {
        probes++;
        return Response.json({code:'INTERNAL_ERROR',traceId},{status:500});
      }}),
    },
    OAUTH_KV: {put: async (key:string,value:string,options:{expirationTtl:number})=>{
      writes.push({key,value,ttl:options.expirationTtl});
    }},
  } as unknown as Env;
  const ctx = {waitUntil: (promise: Promise<unknown>) => { promises.push(promise); }} as ExecutionContext;
  return {env,ctx,traceId,writes,promises,probes:()=>probes};
}

test('liveness survives Registry 500; readiness remains unhealthy and traceable',async()=>{
  const f=offlineFixture();
  const alive=await gateway.fetch(new Request('https://gateway.example/live'),f.env,f.ctx);
  assert.equal(alive.status,200);
  assert.equal((await alive.json() as {role:string}).role,'worker-liveness');
  assert.equal(f.probes(),0,'liveness must not access the failing Registry');
  const ready=await gateway.fetch(new Request('https://gateway.example/health'),f.env,f.ctx);
  assert.equal(ready.status,503,'Registry failure must not be advertised as healthy');
  const payload=await ready.json() as {ok:boolean;code:string;traceId:string;retryable:boolean};
  assert.equal(payload.ok,false);
  assert.equal(payload.code,'GATEWAY_DEGRADED');
  assert.equal(payload.traceId,f.traceId);
  assert.equal(payload.retryable,true);
  assert.equal(f.probes(),1);
  await Promise.all(f.promises);
  assert.ok(f.writes.length>=1,'incident evidence must persist outside Registry');
  const rows=f.writes.map(x=>JSON.parse(x.value) as Record<string,unknown>);
  assert.ok(rows.some(x=>x.traceId===f.traceId && x.route==='health'));
  assert.ok(f.writes.every(x=>x.ttl===7*86400));
});

test('background probe works without browser session and records Registry failure',async()=>{
  const f=offlineFixture();
  gateway.scheduled({cron:'*/5 * * * *'} as ScheduledController,f.env,f.ctx);
  await Promise.all(f.promises);
  assert.equal(f.probes(),1);
});

test('crash evidence excludes raw messages, URLs, credentials, and query strings',async()=>{
  const password='SECRET-DO-NOT-LOG';
  const e=new Error('SQLITE_FULL '+password+' https://gateway.example/token?code='+password);
  const row=incident('worker','/token?code='+password,500,e);
  assert.equal(routeClass('/mcp/agent-secret'), 'mcp');
  assert.equal(row.route,'other','untrusted path containing query never becomes persisted URL');
  assert.equal(row.causeClass,'STORAGE_FULL');
  assert.equal(row.errorClass,'Error');
  assert.doesNotMatch(JSON.stringify(row),/SECRET-DO-NOT-LOG|gateway\.example|\/token\?/);
  const puts:string[]=[];
  const env={OAUTH_KV:{put:async(_key:string,value:string)=>{puts.push(value);}}} as unknown as Env;
  await persistIncident(env,row);
  assert.equal(puts.length,1);
  assert.doesNotMatch(puts[0]!,/SECRET-DO-NOT-LOG/);
});
