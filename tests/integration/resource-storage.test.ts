import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

/** Test-only worker: it has no external routes, credentials, provider bindings or outbound fetch. */
async function fixture() {
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), contents: `
      import { SqlRecords } from './apps/gateway/src/sql.ts';
      import { ResourceLibrary } from './packages/resource-library/src/index.ts';
      import { NativeResourceLibrary, resourceStorageMaintenance, resourceStorageStatus } from './apps/gateway/src/resource-storage.ts';
      export class ResourceFixture {
        constructor(state) { this.state=state; this.db=new SqlRecords(state.storage); }
        async fetch(request) {
          const input=await request.json();
          const before=this.db.snapshotUsage();
          let result;
          if(input.action==='seed') {
            const l=new ResourceLibrary();
            await l.publish({id:'small',kind:'skill',body:'small body'},'absent');
            await l.publish({id:'large',kind:'skill',body:input.large},'absent');
            this.db.put('library',l.snapshot()); result={revision:l.revision};
          } else if(input.action==='migrate') result=resourceStorageMaintenance(this.db,input.mode??'native',1);
          else if(input.action==='status') result=resourceStorageStatus(this.db);
          else if(input.action==='reopen') { this.db=new SqlRecords(this.state.storage); result=resourceStorageStatus(this.db); }
          else if(input.action==='get') result=new NativeResourceLibrary(this.db).get(input.id);
          else if(input.action==='list') result=new NativeResourceLibrary(this.db).listMetadata();
          else if(input.action==='publish') {
            const l=new NativeResourceLibrary(this.db), revision=l.revision;
            result=await l.publish({id:'small',kind:'skill',body:input.body},input.expectedRevision);
            this.db.transaction(()=>l.commit(revision));
          } else throw new Error('Unknown synthetic action');
          const after=this.db.snapshotUsage();
          return Response.json({result,usage:{reads:after.reads-before.reads,writes:after.writes-before.writes,statements:after.statements-before.statements,unmetered:after.unmetered-before.unmetered}});
        }
      }
      export default { fetch() { return new Response('test-only', {status:404}); } };
    ` },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:*','node:*'], conditions: ['workerd','worker','browser'],
  });
  const mf = new Miniflare({ cf: false, outboundService: () => new Response('Synthetic fixture outbound access denied', { status: 503 }), modules: true, script: bundle.outputFiles[0]!.text, compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'], durableObjects: { RESOURCES: { className: 'ResourceFixture', useSQLite: true } } });
  try {
    await mf.ready;
    const ns = await mf.getDurableObjectNamespace('RESOURCES');
    const stub = ns.get(ns.idFromName('synthetic-resource-store'));
    async function request(action: string, rest: Record<string, unknown> = {}) {
      const response = await stub.fetch('https://synthetic.internal/fixture', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action,...rest }) });
      assert.equal(response.status,200);
      return await response.json() as {result: Record<string,unknown>;usage:{reads:number;writes:number;statements:number;unmetered:number}};
    }
    return { request, close: () => mf.dispose() };
  } catch(error) { await mf.dispose(); throw error; }
}

test('pinned workerd Resource BLOB-independent point lookup and publish preserve actual SQLite metering', async () => {
  const h = await fixture();
  try {
    await h.request('seed',{large:'😀🦦'.repeat(100000)});
    let totalReads=0,totalWrites=0;
    for(let step=0;step<200;step++) {
      const result=await h.request('migrate'); totalReads+=result.usage.reads; totalWrites+=result.usage.writes;
      assert.equal(result.usage.unmetered,0);
      if(result.result.phase==='NATIVE') break;
      if(step===199) assert.fail('Migration did not converge');
      if(step%5===0) await h.request('reopen');
    }
    assert.equal((await h.request('status')).result.phase,'NATIVE');
    const small=await h.request('get',{id:'small'}), large=await h.request('get',{id:'large'}), list=await h.request('list');
    assert.equal(small.result.body,'small body'); assert.equal(large.result.body,'😀🦦'.repeat(100000));
    assert.ok(small.usage.reads < large.usage.reads);
    assert.equal(small.usage.writes,0); assert.equal(list.usage.writes,0);
    assert.ok(list.usage.reads < large.usage.reads);
    const published=await h.request('publish',{body:'changed',expectedRevision:1});
    assert.equal(published.result.revision,2);
    assert.equal((await h.request('get',{id:'small'})).result.body,'changed');
    assert.ok(published.usage.writes < 20);
    console.log(JSON.stringify({fixture:'resource-native-workerd',migration:{reads:totalReads,writes:totalWrites},small:small.usage,large:large.usage,list:list.usage,publish:published.usage}));
  } finally { await h.close(); }
});
