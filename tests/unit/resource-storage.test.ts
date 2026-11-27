import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { DurableObjectStorage } from '@cloudflare/workers-types';
import { ResourceLibrary, type LibraryState, type ResourceInput } from '../../packages/resource-library/src/index.js';
import { SqlRecords } from '../../apps/gateway/src/sql.js';
import { NativeResourceLibrary, resourceStorageMaintenance, resourceStorageStatus, resourceLibraryRevision } from '../../apps/gateway/src/resource-storage.js';
import { resourceAdmin, resourceTool } from '../../apps/gateway/src/resources.js';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  const queries: { sql: string; args: unknown[] }[] = [];
  let fail: string | undefined;
  const storage = {
    sql: { exec(sql: string, ...args: (string | number | null)[]) {
      queries.push({ sql, args });
      if (fail && sql.includes(fail)) { fail = undefined; throw new Error('synthetic SQL failure'); }
      const q = sqlite.prepare(sql);
      const result = /^\s*(?:SELECT|EXPLAIN)/i.test(sql) ? q.all(...args) : (q.run(...args), []);
      return { toArray: () => result, rowsRead: result.length, rowsWritten: 0 };
    } },
    transactionSync<T>(fn: () => T) {
      sqlite.exec('BEGIN');
      try { const value = fn(); sqlite.exec('COMMIT'); return value; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  } as unknown as DurableObjectStorage;
  const db = new SqlRecords(storage);
  return { db, queries, fail: (pattern: string) => { fail = pattern; }, close: () => sqlite.close() };
}
const input = (id: string, body = 'original'): ResourceInput => ({ id, kind: 'skill', body, provenance: 'Synthetic fixture', license: 'test' });
async function source() {
  const l = new ResourceLibrary();
  await l.publish(input('base', 'x'.repeat(31990) + '😀🦦\\\"{}'.repeat(20000)), 'absent');
  await l.publish({ ...input('child', 'first'), dependencies: ['base'], files: { 'ref.md': 'reference 🦦' } }, 'absent');
  await l.publish({ ...input('child', 'second'), dependencies: ['base'], files: { 'ref.md': 'changed' } }, 1);
  await l.publish({ ...input('private', 'private body'), enabled: false }, 'absent');
  l.assign('agent', 'agent-a', 'private', true, l.revision);
  return l.snapshot();
}
function migrate(db: SqlRecords, mode: 'prepare' | 'native' = 'native', limit = 5000) {
  for (let i = 0; i < limit; i++) {
    const status = resourceStorageMaintenance(db, mode, 1);
    if (status.phase === (mode === 'prepare' ? 'VERIFY' : 'NATIVE') && (mode !== 'prepare' || status.verified)) return status;
  }
  throw new Error('resource migration failed to converge');
}
function admin(path: string, body: unknown, key = crypto.randomUUID(), method = 'POST') {
  return new Request('https://fixture.test/api/v1/admin/resources' + path, { method, headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
}

test('Resource migration is resumable, exact across Unicode chunks, verified before sticky cutover', async () => {
  const f = fixture();
  try {
    const original = await source(); f.db.put('library', original);
    const prepared = migrate(f.db, 'prepare');
    assert.equal(prepared.phase, 'VERIFY');
    assert.deepEqual(f.db.get('library'), original);
    assert.equal(resourceStorageStatus(f.db).phase, 'VERIFY');
    migrate(f.db);
    const l = new NativeResourceLibrary(f.db);
    assert.deepEqual(l.snapshot(), original);
    assert.equal(resourceLibraryRevision(f.db), original.revision);
    assert.equal(resourceStorageMaintenance(f.db, 'legacy', 1).phase, 'NATIVE');
    assert.equal(l.get('child', {}, 1).body, 'first');
    assert.throws(() => l.get('private', { agentId: 'agent-b' }, 1), /unavailable/);
    assert.equal(l.get('private', { agentId: 'agent-a' }).body, 'private body');
  } finally { f.close(); }
});

test('Legacy mutation during backfill invalidates generation and only latest state can cut over', async () => {
  const f = fixture();
  try {
    const original = await source(); f.db.put('library', original);
    resourceStorageMaintenance(f.db, 'prepare', 1);
    resourceStorageMaintenance(f.db, 'prepare', 1);
    const changed = new ResourceLibrary(original); await changed.publish(input('base', 'latest'), 1);
    f.db.put('library', changed.snapshot());
    migrate(f.db);
    assert.deepEqual(new NativeResourceLibrary(f.db).snapshot(), changed.snapshot());
    assert.equal(new NativeResourceLibrary(f.db).get('base').body, 'latest');
    f.db.put('library', original);
    assert.throws(() => new NativeResourceLibrary(f.db), /LEGACY_WRITE_AFTER_RESOURCE_CUTOVER/);
  } finally { f.close(); }
});

test('Native point reads and lists do not load unrelated Resource bodies or historical revisions', async () => {
  const f = fixture();
  try {
    f.db.put('library', await source()); migrate(f.db);
    f.queries.length = 0;
    const l = new NativeResourceLibrary(f.db);
    assert.equal(l.get('child').body, 'second');
    assert.equal(l.listMetadata().length, 3);
    const content = f.queries.filter(q => q.sql.includes('FROM resource_content_v2'));
    const bodyId = f.db.query<{ content_id: number }>("SELECT content_id FROM resource_revision_v2 WHERE id='child' AND revision=2")[0]!.content_id;
    const baseId = f.db.query<{ content_id: number }>("SELECT content_id FROM resource_revision_v2 WHERE id='base'")[0]!.content_id;
    assert.equal(content.filter(q => q.args[1] === bodyId).length, 1);
    assert.ok(content.every(q => q.args[1] !== baseId));
    assert.ok(!f.queries.some(q => q.sql.includes('FROM records') && q.args.includes('library')));
    assert.equal(l.historyMetadata('child').length, 2);
  } finally { f.close(); }
});

test('Native resource publish, restore and assignment preserve immutable history, CAS and export', async () => {
  const f = fixture();
  try {
    const original = await source(); f.db.put('library', original); migrate(f.db);
    const expected = new ResourceLibrary(original);
    const l = new NativeResourceLibrary(f.db);
    const changed = { ...input('child', 'third'), dependencies: ['base'] };
    assert.deepEqual(await l.publish(changed, 2), await expected.publish(changed, 2));
    f.db.transaction(() => l.commit(original.revision));
    assert.deepEqual(new NativeResourceLibrary(f.db).snapshot(), expected.snapshot());
    const restored = new NativeResourceLibrary(f.db);
    await restored.restore('child', 1, 3); await expected.restore('child', 1, 3);
    f.db.transaction(() => restored.commit(l.revision));
    const assigned = new NativeResourceLibrary(f.db);
    assigned.assign('workspace', 'workspace-a', 'private', true, assigned.revision);
    expected.assign('workspace', 'workspace-a', 'private', true, expected.revision);
    f.db.transaction(() => assigned.commit(restored.revision));
    const latest = new NativeResourceLibrary(f.db);
    assert.deepEqual(latest.snapshot(), expected.snapshot());
    const restoredZip = new ResourceLibrary();
    await restoredZip.commitImport(await restoredZip.previewImport(latest.exportZip()), {}, 0);
    assert.deepEqual(restoredZip.list().map(r => [r.id, r.hash]), expected.list().map(r => [r.id, r.hash]));
    assert.equal(f.db.get<LibraryState>('library').revision, original.revision);
  } finally { f.close(); }
});

test('Native Resource admin idempotency, concurrent publishes and failed commit cannot lose updates', async () => {
  const f = fixture();
  try {
    f.db.put('library', await source()); migrate(f.db);
    const request = { resource: { ...input('child', 'committed'), dependencies: ['base'] }, expectedRevision: 2 };
    const key = crypto.randomUUID();
    const result = await resourceAdmin(admin('/child', request, key, 'PUT'), f.db, () => {});
    assert.equal(result.status, 200);
    assert.deepEqual(await (await resourceAdmin(admin('/child', request, key, 'PUT'), f.db, () => {})).json(), await result.json());
    const a = new NativeResourceLibrary(f.db), b = new NativeResourceLibrary(f.db), before = a.revision;
    await a.publish({ ...input('child', 'winner'), dependencies: ['base'] }, 3);
    await b.publish({ ...input('child', 'loser'), dependencies: ['base'] }, 3);
    f.db.transaction(() => a.commit(before));
    assert.throws(() => f.db.transaction(() => b.commit(before)), /changed/);
    const failing = new NativeResourceLibrary(f.db); await failing.publish({ ...input('child', 'not committed'), dependencies: ['base'] }, 4);
    f.fail('INSERT INTO resource_content_v2');
    assert.throws(() => f.db.transaction(() => failing.commit(a.revision)), /synthetic SQL failure/);
    assert.equal(new NativeResourceLibrary(f.db).get('child').body, 'winner');
  } finally { f.close(); }
});

test('Corrupt legacy snapshot and native content fail closed, without stale snapshot fallback', async () => {
  const f = fixture();
  try {
    f.db.put('library', { schemaVersion: 1, revision: 1, resources: { broken: null }, assignments: [] });
    assert.throws(() => migrate(f.db), /RESOURCE|SNAPSHOT/);
    f.db.put('library', await source()); migrate(f.db);
    f.db.query("UPDATE resource_content_v2 SET value='{}' WHERE content_id=(SELECT content_id FROM resource_revision_v2 WHERE id='child' AND revision=2) AND part=0");
    assert.throws(() => new NativeResourceLibrary(f.db).get('child'), /CORRUPT/);
  } finally { f.close(); }
});

test('Resource tools use normalized metadata and preserve scoped documentation content semantics', async () => {
  const f = fixture();
  try {
    f.db.put('library', await source()); migrate(f.db);
    const list = await resourceTool(f.db, 'list_skills', {}, { agentId: 'agent-a' }) as { items: Record<string, unknown>[] };
    assert.equal(list.items.length, 3);
    assert.ok(list.items.every(x => !('body' in x) && !('files' in x)));
    const ref = await resourceTool(f.db, 'read_documentation', { id: 'child', revision: 1, path: 'ref.md', offset: 1, limit: 10 }, {}) as { text: string };
    assert.equal(ref.text, '1: reference 🦦');
  } finally { f.close(); }
});

test('Resource migration corruption becomes BLOCKED while transient persistence failures remain resumable', async () => {
  const f = fixture();
  try {
    f.db.put('library', { schemaVersion: 1, revision: 1, resources: { broken: null }, assignments: [] });
    assert.throws(() => migrate(f.db), /RESOURCE_SNAPSHOT/);
    assert.equal(resourceStorageStatus(f.db).phase,'BLOCKED');
    const { resourceStorageNeedsMaintenance } = await import('../../apps/gateway/src/resource-storage.js');
    assert.equal(resourceStorageNeedsMaintenance(f.db,'native'),false);
    const replacement=await source(); f.db.put('library',replacement);
    assert.equal(resourceStorageNeedsMaintenance(f.db,'native'),true);
    resourceStorageMaintenance(f.db,'native',1);
    f.fail('INSERT INTO resource_content_v2');
    assert.throws(() => migrate(f.db), /synthetic SQL failure/);
    assert.notEqual(resourceStorageStatus(f.db).phase,'BLOCKED');
    migrate(f.db);
    assert.deepEqual(new NativeResourceLibrary(f.db).snapshot(),replacement);
  } finally { f.close(); }
});

test('Resource migration rejects malformed framing, duplicate assignment, missing/null fields and hidden chunks', async () => {
  const valid = new ResourceLibrary(); await valid.publish(input('one'),'absent');
  const state = valid.snapshot();
  const corruptStates: unknown[] = [
    { ...state, schemaVersion:2 }, { ...state, revision:null }, { ...state, resources:null }, { ...state, assignments:null },
    { schemaVersion:1,revision:1,resources:{} },
    { ...state, resources:{ one:[] } },
    { ...state, assignments:[{scopeType:'global',scopeId:'global',resourceId:'missing',enabled:true}] },
    { ...state, assignments:Array.from({length:2},()=>({scopeType:'global',scopeId:'global',resourceId:'one',enabled:true})) },
  ];
  for(const source of corruptStates) {
    const f=fixture(); try { f.db.put('library',source); assert.throws(()=>migrate(f.db)); assert.equal(resourceStorageStatus(f.db).phase,'BLOCKED'); } finally {f.close();}
  }
  for(const raw of [JSON.stringify(state).slice(0,-1)+',}',JSON.stringify(state).replace('"assignments":[]','"assignments":[,]'),JSON.stringify(state)+'\v']) {
    const f=fixture();try {f.db.query('INSERT INTO records VALUES(?,?,?)','library',0,raw);assert.throws(()=>migrate(f.db));assert.equal(resourceStorageStatus(f.db).phase,'BLOCKED');}finally{f.close();}
  }
  const f=fixture();try {
    f.db.put('library',state); f.db.query('INSERT INTO records VALUES(?,?,?)','library',2,'ignored-corruption');
    assert.throws(()=>migrate(f.db),/RESOURCE_SNAPSHOT_CHUNK_GAP/);
  }finally{f.close();}
});

test('Resource verification detects shadow corruption and preserves legacy authority', async () => {
  const f=fixture();try {
    const original=await source();f.db.put('library',original);
    for(let step=0;step<100;step++) {const status=resourceStorageMaintenance(f.db,'prepare',1);if(status.phase==='VERIFY')break;}
    f.db.query("UPDATE resource_revision_v2 SET metadata='{}' WHERE id='child' AND revision=1");
    assert.throws(()=>migrate(f.db),/RESOURCE_SNAPSHOT_VERIFY_FAILED/);
    assert.equal(resourceStorageStatus(f.db).phase,'BLOCKED');assert.deepEqual(f.db.get('library'),original);
  }finally{f.close();}
});

test('Resource assignment replacement preserves exact order and physically prunes old assignment content boundedly', async () => {
  const f=fixture();try {
    const l=new ResourceLibrary();for(const id of ['one','two','three'])await l.publish(input(id),'absent');
    for(const id of ['one','two','three'])l.assign('global','global',id,true,l.revision);
    f.db.put('library',l.snapshot());migrate(f.db);
    for(const enabled of [true,false,true]) {
      const n=new NativeResourceLibrary(f.db),before=n.revision;
      n.assign('global','global','one',enabled,before);l.assign('global','global','one',enabled,l.revision);
      f.db.transaction(()=>n.commit(before));
      assert.deepEqual(new NativeResourceLibrary(f.db).assignments(),l.snapshot().assignments);
      const {resourceStorageNeedsMaintenance}=await import('../../apps/gateway/src/resource-storage.js');
      for(let i=0;resourceStorageNeedsMaintenance(f.db,'legacy')&&i<100;i++)resourceStorageMaintenance(f.db,'legacy',1);
      assert.equal(resourceStorageNeedsMaintenance(f.db,'legacy'),false);
    }
    assert.deepEqual(new NativeResourceLibrary(f.db).snapshot(),l.snapshot());
  }finally{f.close();}
});

test('Native history budget equals exact canonical snapshot size and never loads unrelated bodies while publishing', async () => {
  const f=fixture();try {
    f.db.put('library',await source());migrate(f.db);f.queries.length=0;
    const l=new NativeResourceLibrary(f.db),before=l.revision;
    await l.publish({...input('child','new exact Unicode 🦦'),dependencies:['base']},2);
    f.db.transaction(()=>l.commit(before));
    const contentReads=f.queries.filter(q=>q.sql.includes('SELECT part,value FROM resource_content_v2'));
    const resourceIds=f.db.query<{content_id:number}>("SELECT content_id FROM resource_revision_v2 WHERE id IN ('base','private')").map(x=>x.content_id);
    assert.ok(contentReads.every(q=>!resourceIds.includes(Number(q.args[1]))));
    const h=f.db.query<Record<string,number>>('SELECT * FROM resource_header_v2')[0]!;
    const expected=new TextEncoder().encode(JSON.stringify(new NativeResourceLibrary(f.db).snapshot())).length;
    const empty=new TextEncoder().encode(JSON.stringify({schemaVersion:1,revision:h.revision,resources:{},assignments:[]})).length;
    assert.equal(empty+h.row_bytes!+h.key_bytes!+Math.max(0,h.resource_count!-1)+h.revision_count!-h.resource_count!+h.assignment_bytes!+Math.max(0,h.assignment_count!-1),expected);
  }finally{f.close();}
});

test('Resource cutover atomically fences legacy Registry binaries without changing policy/entity revisions', async () => {
  const f=fixture();try {
    f.db.put('core',{schemaVersion:1,revision:27,policyRevision:19,paired:true,credentialEpoch:4});
    f.db.put('library',await source());migrate(f.db,'prepare');
    assert.equal(f.db.get<{schemaVersion:number}>('core').schemaVersion,1);
    // The marker uses an UPSERT; fail exactly that write and keep both authorities legacy.
    f.fail('INSERT INTO resource_storage_v2');
    assert.throws(()=>resourceStorageMaintenance(f.db,'native',1),/synthetic SQL failure/);
    assert.equal(f.db.get<{schemaVersion:number}>('core').schemaVersion,1);
    assert.equal(resourceStorageStatus(f.db).phase,'VERIFY');
    resourceStorageMaintenance(f.db,'native',1);
    assert.deepEqual(f.db.get('core'),{schemaVersion:2,revision:27,policyRevision:19,paired:true,credentialEpoch:4});
    assert.equal(resourceStorageStatus(f.db).phase,'NATIVE');
  }finally{f.close();}
});
