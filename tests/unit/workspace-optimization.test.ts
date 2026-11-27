import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { DurableObjectState, DurableObjectStorage } from '@cloudflare/workers-types';
import { SqlRecords } from '../../apps/gateway/src/sql.js';
import { Workspace } from '../../apps/gateway/src/workspace.js';
import { digest, type Env } from '../../apps/gateway/src/common.js';

function fixture(onRpc: (path: string) => Promise<Response> = async () => Response.json({ ok: true })) {
  const sqlite = new DatabaseSync(':memory:');
  let alarm: number | null = null;
  const queries: string[] = [];
  const storage = {
    sql: { exec(sql: string, ...args: (string | number | null)[]) {
      queries.push(sql);
      const q = sqlite.prepare(sql);
      const result = /^\s*(?:SELECT|EXPLAIN)/i.test(sql) ? q.all(...args) : (q.run(...args), []);
      return { toArray: () => result, rowsRead: result.length, rowsWritten: 0 };
    } },
    transactionSync<T>(fn: () => T) {
      sqlite.exec('BEGIN');
      try { const value = fn(); sqlite.exec('COMMIT'); return value; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
    getAlarm: async () => alarm,
    setAlarm: async (value: number) => { alarm = value; },
    deleteAlarm: async () => { alarm = null; },
  } as unknown as DurableObjectStorage;
  const state = { storage } as DurableObjectState;
  const env = { REGISTRY: { idFromName: () => 'installation', get: () => ({ fetch: (request: Request) => onRpc(new URL(request.url).pathname) }) } } as unknown as Env;
  const records = new SqlRecords(storage);
  return { sqlite, records, queries, env, state, close: () => sqlite.close() };
}
function operation(operationId: string, phase = 'ADMITTED', deadline = Date.now() + 30000) {
  return { operationId, sequence: 1, argsDigest: 'a'.repeat(64), workspaceId: 'workspace-fixture', epoch: 1,
    bindingRevision: 1, tabInstanceId: 'tab-fixture', deadlineMs: deadline, tool: 'read', args: { path: 'main.pjs' },
    permissions: ['READ_SOURCE'], requiredPermissions: ['READ_SOURCE'], mutating: false,
    props: { grantId: 'grant-fixture', workspaceId: 'workspace-fixture', agentId: 'agent-fixture', bindingRevision: 1 },
    agentId: 'agent-fixture', traceId: 'trace-fixture', phase, createdAt: Date.now() - 100 };
}
function request(path: string, body: Record<string, unknown>, token = '') {
  return new Request('https://internal' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
}
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
async function lease(records: SqlRecords, token: string) {
  records.put('lease', { workspaceId: 'workspace-fixture', epoch: 1, bindingRevision: 1, tabInstanceId: 'tab-fixture',
    secretHash: await digest(token), claimedAt: Date.now(), expiresAt: Date.now() + 180000, credentialEpoch: 1, permissions: ['READ_SOURCE'] });
}

test('targeted status does not expire or materialize unrelated operations', async () => {
  const f = fixture();
  try {
    f.records.put('operation/current', operation('current', 'RUNNING'));
    f.records.put('operation/unrelated', operation('unrelated', 'RUNNING', Date.now() - 1));
    const workspace = new Workspace(f.state, f.env);
    f.queries.length = 0;
    const response = await workspace.fetch(request('/internal/status', { workspaceId: 'workspace-fixture', operationId: 'current' }));
    assert.equal(response.status, 200);
    assert.equal(f.records.get<{phase:string}>('operation/unrelated').phase, 'RUNNING');
    assert.equal(f.queries.filter(q => q.includes('operation_dirty_v1')).length, 0);
  } finally { f.close(); }
});

test('late failed dispatch authorization never overwrites a concurrently cancelled operation', async () => {
  const reached = deferred(), gate = deferred();
  const f = fixture(async (path) => {
    if (path === '/internal/dispatch') { reached.release(); await gate.promise; return Response.json({ code: 'REVOKED', message: 'Fixture revocation' }, { status: 403 }); }
    return Response.json({ ok: true });
  });
  try {
    const token = 'fixture-lease-token'.padEnd(64, 'x'); await lease(f.records, token);
    f.records.put('operation/current', operation('current'));
    const workspace = new Workspace(f.state, f.env);
    const poll = workspace.fetch(request('/api/v1/tab/poll', { workspaceId: 'workspace-fixture', epoch: 1, tabInstanceId: 'tab-fixture' }, token));
    await reached.promise;
    const cancelled = await workspace.fetch(request('/internal/cancel', { workspaceId: 'workspace-fixture', operationId: 'current' }));
    assert.equal(cancelled.status, 200);
    gate.release(); await poll;
    assert.equal(f.records.get<{phase:string}>('operation/current').phase, 'CANCELLED');
  } finally { gate.release(); f.close(); }
});

test('heartbeat cannot revive a lease which expired while Registry validation awaited', async () => {
  const reached = deferred(), gate = deferred();
  const f = fixture(async (path) => {
    if (path === '/internal/lease-check') { reached.release(); await gate.promise; return Response.json({ permissions: ['READ_SOURCE'] }); }
    return Response.json({ ok: true });
  });
  try {
    const token = 'fixture-lease-token'.padEnd(64, 'x'); await lease(f.records, token);
    const workspace = new Workspace(f.state, f.env);
    const pending = workspace.fetch(request('/api/v1/tab/heartbeat', { workspaceId: 'workspace-fixture', epoch: 1, tabInstanceId: 'tab-fixture' }, token));
    await reached.promise;
    const current = f.records.get<Record<string, unknown>>('lease');
    f.records.put('lease', { ...current, expiresAt: Date.now() - 1 });
    gate.release(); const response = await pending;
    assert.equal(response.status, 409);
    assert.ok(f.records.get<{expiresAt:number}>('lease').expiresAt < Date.now());
  } finally { gate.release(); f.close(); }
});

test('persisted interrupted dispatch attempt becomes UNKNOWN after restart and is never consumed again', async () => {
  let dispatches=0;
  const f=fixture(async(path)=>{if(path==='/internal/dispatch')dispatches++;return Response.json({ok:true});});
  try{
    const token='fixture-lease-token'.padEnd(64,'x');await lease(f.records,token);
    f.records.put('operation/current',{...operation('current'),dispatchAttempt:{id:'persisted-attempt',reconcileAt:Date.now()-1}});
    const workspace=new Workspace(f.state,f.env);
    const poll=await workspace.fetch(request('/api/v1/tab/poll',{workspaceId:'workspace-fixture',epoch:1,tabInstanceId:'tab-fixture'},token));
    assert.equal(poll.status,200);assert.deepEqual((await poll.json() as {operations:unknown[]}).operations,[]);
    assert.equal(dispatches,0);assert.equal(f.records.get<{phase:string}>('operation/current').phase,'UNKNOWN');
  }finally{f.close();}
});

test('a second poll cannot consume a durable dispatch attempt while its Registry call awaits',async()=>{
  const reached=deferred(),gate=deferred();let dispatches=0;
  const f=fixture(async(path)=>{if(path==='/internal/dispatch'){dispatches++;reached.release();await gate.promise;return Response.json({workspace:{permissions:['READ_SOURCE']},grant:{permissions:['READ_SOURCE']}});}return Response.json({ok:true});});
  try{
    const token='fixture-lease-token'.padEnd(64,'x');await lease(f.records,token);f.records.put('operation/current',operation('current'));
    const workspace=new Workspace(f.state,f.env);
    const first=workspace.fetch(request('/api/v1/tab/poll',{workspaceId:'workspace-fixture',epoch:1,tabInstanceId:'tab-fixture'},token));await reached.promise;
    const second=await workspace.fetch(request('/api/v1/tab/poll',{workspaceId:'workspace-fixture',epoch:1,tabInstanceId:'tab-fixture'},token));
    assert.equal(second.status,200);assert.deepEqual((await second.json() as {operations:unknown[]}).operations,[]);assert.equal(dispatches,1);
    gate.release();const response=await first;assert.equal(response.status,200);assert.equal((await response.json()as{operations:unknown[]}).operations.length,1);
  }finally{gate.release();f.close();}
});

test('pre-index preparation preserves pending terminal evidence until verified counter authority exists',async()=>{
  const f=fixture();try{
    const token='fixture-lease-token'.padEnd(64,'x');await lease(f.records,token);
    f.records.put('operation/current',operation('current','RUNNING'));
    f.env.CANONICAL_STORAGE_MODE='prepare';let workspace=new Workspace(f.state,f.env);
    const status=await workspace.fetch(request('/internal/status',{workspaceId:'workspace-fixture',operationId:'current'}));assert.equal(status.status,200);
    const recovery=await workspace.fetch(request('/internal/recovery',{workspaceId:'workspace-fixture'}));assert.equal(recovery.status,200);const view=await recovery.json() as {blockingOperationsKnown:boolean;leaseClaimAvailable:boolean;action:string};assert.equal(view.blockingOperationsKnown,false);assert.equal(view.leaseClaimAvailable,false);assert.equal(view.action,'WAIT_FOR_STORAGE');
    const terminal={operationId:'current',status:'SUCCEEDED',effectState:'VERIFIED',data:{retained:'browser-journal'}};
    const reply=()=>workspace.fetch(request('/api/v1/tab/reply',{workspaceId:'workspace-fixture',epoch:1,tabInstanceId:'tab-fixture',operationId:'current',phase:'SUCCEEDED',result:terminal},token));
    assert.equal((await reply()).status,503);assert.equal(f.records.get<{phase:string}>('operation/current').phase,'RUNNING');
    for(let n=0;n<30;n++){const response=await workspace.fetch(request('/internal/migration',{workspaceId:'workspace-fixture',action:'step',idempotencyKey:crypto.randomUUID()}));assert.equal(response.status,200);if((await response.json()as{stage:string}).stage==='READY')break;}
    assert.equal((await reply()).status,503,'prepare never acknowledges against unverified global counters');
    f.env.CANONICAL_STORAGE_MODE='native';workspace=new Workspace(f.state,f.env);
    for(let n=0;n<30;n++){const response=await workspace.fetch(request('/internal/migration',{workspaceId:'workspace-fixture',action:'step',idempotencyKey:crypto.randomUUID()}));assert.equal(response.status,200);if((await response.json()as{stage:string}).stage==='NATIVE')break;}
    assert.equal((await reply()).status,200);
    const completed=await workspace.fetch(request('/internal/status',{workspaceId:'workspace-fixture',operationId:'current'}));assert.equal((await completed.json()as{status:string}).status,'SUCCEEDED');
  }finally{f.close();}
});

test('failed migration action receipt rolls back cutover marker and restores cached authority before retry',async()=>{
  const f=fixture();try{
    f.env.CANONICAL_STORAGE_MODE='prepare';let workspace=new Workspace(f.state,f.env);
    const step=(key=crypto.randomUUID())=>workspace.fetch(request('/internal/migration',{workspaceId:'workspace-fixture',action:'step',idempotencyKey:key}));
    for(let n=0;n<30;n++){const response=await step();assert.equal(response.status,200);if((await response.json()as{stage:string}).stage==='READY')break;}
    f.sqlite.exec("CREATE TRIGGER fail_migration_receipt BEFORE INSERT ON operation_migration_actions_v2 BEGIN SELECT RAISE(ABORT,'fixture receipt storage unavailable'); END");
    f.env.CANONICAL_STORAGE_MODE='native';workspace=new Workspace(f.state,f.env);
    const key=crypto.randomUUID();assert.equal((await step(key)).status,500);assert.equal(f.records.get('schema'),1);
    const status=await workspace.fetch(request('/internal/migration',{action:'status'}));assert.equal((await status.json()as{stage:string}).stage,'READY');
    f.sqlite.exec('DROP TRIGGER fail_migration_receipt');const retry=await step(key);assert.equal(retry.status,200);assert.equal((await retry.json()as{stage:string}).stage,'NATIVE');assert.equal(f.records.get('schema'),2);
    assert.equal((await step(key)).status,200);
  }finally{f.close();}
});

test('first admission budget allocation prepares unknown retained media outside the failed admission transaction',async()=>{
  const f=fixture();try{
    const token='fixture-lease-token'.padEnd(64,'x');await lease(f.records,token);
    f.env.ADMISSION_BUDGET_ENABLED='true';
    f.records.put('operation/retained',{...operation('retained','SUCCEEDED'),terminalAt:Date.now(),terminalNotified:true,args:undefined});
    f.records.put('image/manifest/retained/0',{operationId:'retained',index:0,byteLength:8,sha256:'b'.repeat(64),workspaceId:'workspace-fixture',epoch:1,bindingRevision:1,tabInstanceId:'tab-fixture',agentId:'agent-fixture',mimeType:'image/png',nextOffset:0,state:'STAGING',expiresAt:Date.now()+600000});
    const workspace=new Workspace(f.state,f.env);
    const admit=()=>workspace.fetch(request('/internal/admit',{workspace:{id:'workspace-fixture',epoch:1,bindingRevision:1},tool:'read',args:{path:'main.pjs'},permissions:['READ_SOURCE'],requiredPermissions:['READ_SOURCE'],mutating:false,props:{grantId:'grant-fixture',agentId:'agent-fixture',workspaceId:'workspace-fixture',bindingRevision:1},agentId:'agent-fixture'}));
    const first=await admit();assert.equal(first.status,503);assert.equal(f.records.get('admission-budget/v1'),undefined);
    assert.ok((await f.state.storage.getAlarm())!>Date.now());
    await workspace.alarm();
    assert.equal((await admit()).status,200);
    const accounting=f.records.get<{cleanupSummary:{imageManifests:number;imageBytes:number}}>('admission-budget/v1');
    assert.equal(accounting.cleanupSummary.imageManifests,1);assert.equal(accounting.cleanupSummary.imageBytes,8);
    assert.equal(f.records.get<{state:string}>('image/manifest/retained/0').state,'STAGING');
  }finally{f.close();}
});
