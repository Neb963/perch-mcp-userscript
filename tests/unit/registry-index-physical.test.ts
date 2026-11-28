import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {RegistryIndex} from '../../apps/gateway/src/registry-index.js';
import {SqlRecords} from '../../apps/gateway/src/sql.js';
import type {DurableObjectStorage} from '@cloudflare/workers-types';

function fixture() {
  const sqlite=new DatabaseSync(':memory:');
  const storage={
    sql:{exec(sql:string,...args:(string|number|null)[]){
      const stmt=sqlite.prepare(sql);
      const rows=/^\s*(SELECT|WITH|EXPLAIN|PRAGMA)\b/i.test(sql)?stmt.all(...args): (stmt.run(...args),[]);
      return {toArray:()=>rows,rowsRead:rows.length,rowsWritten:0};
    }},
    transactionSync<T>(fn:()=>T):T{
      sqlite.exec('BEGIN IMMEDIATE');
      try{const value=fn();sqlite.exec('COMMIT');return value;}
      catch(error){sqlite.exec('ROLLBACK');throw error;}
    },
  } as unknown as DurableObjectStorage;
  const db=new SqlRecords(storage),index=new RegistryIndex(db);
  return {sqlite,db,index,close:()=>sqlite.close()};
}
test('R04 fresh Registry index avoids redundant kind/key B-tree while keyset pagination remains indexed',()=>{
 const f=fixture();
 try {
  const indexes=f.sqlite.prepare('SELECT name FROM sqlite_master WHERE type=\'index\' AND tbl_name=\'registry_entity_v1\'').all()
    .map(x=>x.name);
  assert.ok(!indexes.includes('registry_kind_v1'));
  assert.ok(indexes.includes('registry_due_v1'));
  assert.ok(!indexes.includes('registry_workspace_v1'));
  for (const name of ['registry_workspace_grant_v1','registry_workspace_permit_v1','registry_workspace_hold_v1'])
    assert.ok(indexes.includes(name),name);
  const query=f.sqlite.prepare(
    'EXPLAIN QUERY PLAN SELECT key,kind FROM registry_entity_v1 WHERE key>=? AND key<? ORDER BY key LIMIT 100 OFFSET ?')
      .all('grant/','grant/\uffff',0);
  assert.match(query.map(x=>String(x.detail)).join(' '),/PRIMARY KEY/);
  for(let n=0;n<213;n++)f.db.put('grant/g'+String(n).padStart(4,'0'),{
    id:'g'+n,state:'active',workspaceId:'workspace-1',expiresAt:null});
  const first=f.index.page('grant',0,Date.now());
  const second=f.index.page('grant',100,Date.now());
  const third=f.index.page('grant',200,Date.now());
  assert.equal(first.length,100);assert.equal(second.length,100);assert.equal(third.length,13);
  const keys=[...first,...second,...third];
  assert.equal(new Set(keys).size,213);
  assert.deepEqual(keys,[...keys].sort());
  assert.equal(f.index.count('grant'),213);
  assert.deepEqual(f.index.grants('workspace-1').sort(),keys);
 }finally{f.close();}
});
test('R04 expiry, v1 index coexistence, dirty updates and corruption retain exact authority',()=>{
 const f=fixture();
 try {
  const now=Date.now();
  for(let n=0;n<10;n++)f.db.put('approval/a'+n,{
    id:'a'+n,state:'pending',expiresAt:now+(n<3?-1000:60000),workspaceId:'workspace-1'});
  const approved=f.index.page('approval',0,now);
  assert.deepEqual(approved,Array.from({length:7},(_,i)=>'approval/a'+(i+3)));
  assert.equal(f.index.due('approval',now).length,3);
  f.db.delete('approval/a5');
  assert.equal(f.index.page('approval',0,now).length,6);
  f.sqlite.exec('CREATE INDEX registry_kind_v1 ON registry_entity_v1(kind,key)');
  assert.equal(f.index.page('approval',0,now).length,6,
    'An existing physical kind index remains compatible with new keyset page');
  f.db.put('grant/held',{state:'active',workspaceId:'w1',expiresAt:null});
  assert.deepEqual(f.index.page('grant',0,now),['grant/held']);
  f.db.query("UPDATE registry_entity_v1 SET kind='agent' WHERE key='grant/held'");
  assert.throws(()=>f.index.page('grant',0,now),/SQLITE_RECORD_CORRUPT/);
 }finally{f.close();}
});

test('R04 derived count triggers write only hot count kinds, all non-hot counts remain exact',()=>{
  const f=fixture();
  try {
    const now=Date.now();
    for(const kind of ['idempotency','workspace','agent'] as const){
      const key=kind+'/one';
      f.db.put(key,{id:'one',workspaceId:'w',state:'active',expires:now+60000});
      assert.equal(f.index.count(kind),1,kind);
      assert.deepEqual(f.db.query<{count:number}>(
        'SELECT count FROM registry_counts_v1 WHERE kind=?',kind).map(x=>x.count),[1],kind);
    }
    f.db.put('permit/op-1',{workspaceId:'w',createdAt:now,epoch:1,state:'consumed'});
    f.db.put('terminal-notice/w/op-1',{workspaceId:'w',phase:'UNKNOWN',expires:now+60000,
      event:{workspaceId:'w',operationId:'op-1',phase:'UNKNOWN',tool:'write',timestamp:now}});
    assert.equal(f.index.count('permit'),1);
    assert.equal(f.index.count('terminal-notice'),1);
    assert.deepEqual(f.db.query('SELECT count FROM registry_counts_v1 WHERE kind=?','permit'),[]);
    assert.deepEqual(f.db.query('SELECT count FROM registry_counts_v1 WHERE kind=?','terminal-notice'),[]);
    assert.equal(f.index.bindingBlocked('w'),true);
    f.db.delete('permit/op-1');
    assert.equal(f.index.bindingBlocked('w'),true,'UNKNOWN notice continues to hold a fresh bind');
    assert.equal(f.index.count('permit'),0);
    f.db.delete('terminal-notice/w/op-1');
    assert.equal(f.index.bindingBlocked('w'),false);
    assert.equal(f.index.count('terminal-notice'),0);
    const reopened=new RegistryIndex(f.db);
    assert.equal(reopened.count('workspace'),1);
    assert.equal(reopened.count('terminal-notice'),0);
  }finally{f.close();}
});


test('R04 partial workspace indexes preserve grant and Hold predicates with terminal history',()=>{
  const f=fixture();
  try {
    const now=Date.now();
    const queries=[
      ["SELECT key FROM registry_entity_v1 WHERE kind='grant' AND workspace=? AND state='active'",'registry_workspace_grant_v1'],
      ["SELECT key FROM registry_entity_v1 WHERE kind='permit' AND workspace=? AND state='consumed' LIMIT 1",'registry_workspace_permit_v1'],
      ["SELECT key FROM registry_entity_v1 WHERE kind='terminal-notice' AND workspace=? AND hold=1 LIMIT 1",'registry_workspace_hold_v1'],
    ] as const;
    for(const [sql,index] of queries){
      const plan=f.sqlite.prepare('EXPLAIN QUERY PLAN '+sql).all('w1');
      assert.ok(plan.some(row=>String(row.detail).includes(index)),JSON.stringify(plan));
    }
    for(let i=0;i<1000;i++){
      f.db.put('permit/old-'+i,{workspaceId:'w1',state:'terminal',createdAt:now});
      f.db.put('terminal-notice/w1/old-'+i,{phase:'SUCCEEDED',expires:now+60000,
        event:{workspaceId:'w1',operationId:'old-'+i,tool:'read',phase:'SUCCEEDED',timestamp:now}});
    }
    f.db.put('grant/active',{workspaceId:'w1',state:'active',expiresAt:null});
    f.db.put('grant/revoked',{workspaceId:'w1',state:'revoked',revokedAt:now,expiresAt:null});
    f.db.put('grant/foreign',{workspaceId:'w2',state:'active',expiresAt:null});
    assert.deepEqual(f.index.grants('w1'),['grant/active']);
    assert.equal(f.index.bindingBlocked('w1'),false);
    f.db.put('permit/live',{workspaceId:'w1',state:'consumed',createdAt:now});
    assert.equal(f.index.bindingBlocked('w1'),true);
    f.db.put('permit/live',{workspaceId:'w1',state:'terminal',createdAt:now});
    const held={phase:'UNKNOWN',expires:now+60000,
      event:{workspaceId:'w1',operationId:'live',tool:'write',phase:'UNKNOWN',timestamp:now}};
    f.db.put('terminal-notice/w1/live',held);
    assert.equal(f.index.bindingBlocked('w1'),true);
    assert.equal(f.index.bindingBlocked('w2'),false);
    f.db.put('terminal-notice/w1/live',{...held,event:{...held.event,resolution:{timestamp:now+1}}});
    assert.equal(f.index.bindingBlocked('w1'),false);
    // Exact legacy physical layout remains usable after restart. No schema migration.
    for(const [,index] of queries)f.sqlite.exec('DROP INDEX '+index);
    f.sqlite.exec('CREATE INDEX registry_workspace_v1 ON registry_entity_v1(kind,workspace,state,hold)');
    const reopened=new RegistryIndex(f.db);
    assert.deepEqual(reopened.grants('w1'),['grant/active']);
    assert.equal(reopened.bindingBlocked('w1'),false);
    f.db.put('permit/restarted',{workspaceId:'w1',state:'consumed',createdAt:now});
    assert.equal(reopened.bindingBlocked('w1'),true);
    assert.equal(reopened.bindingBlocked('w2'),false);
  } finally {f.close();}
});

// A gap can leave valid JSON, so parsing alone cannot authorize a record.
test('Canonical record integrity refuses missing, noncanonical and oversized parts without mutation',()=>{
  const f=fixture();
  try {
    for (const [key,parts] of [
      ['orphan',[[1,'{"active":true}']]],
      ['gap',[[0,'{"active":'],[2,'true}']]],
      ['negative',[[-1,'{"active":true}']]],
      ['fractional',[[0,'{"active":'],[0.5,'true}']]],
      ['oversized',[[0,JSON.stringify({body:'x'.repeat(32000)})]]],
    ] as const) {
      for (const [part,value] of parts) f.db.query('INSERT INTO records(key,part,value) VALUES(?,?,?)',key,part,value);
      const before=f.db.query('SELECT part,value FROM records WHERE key=? ORDER BY part',key);
      assert.throws(()=>f.db.get(key,{active:false}),/SQLITE_RECORD_CORRUPT/,key);
      assert.deepEqual(f.db.query('SELECT part,value FROM records WHERE key=? ORDER BY part',key),before);
    }
    assert.deepEqual(f.db.get('missing',{active:false}),{active:false});
    const value={body:'x'.repeat(31995)+'😀'.repeat(20000)};
    f.db.put('healthy',value);
    assert.deepEqual(f.db.get('healthy'),value);
  } finally {f.close();}
});
