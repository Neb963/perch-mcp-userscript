import assert from 'node:assert/strict';
import test from 'node:test';
import { trackSql, withSqlUsage } from '../../apps/gateway/src/sql-meter.js';

test('R04 fingerprinted SQL profiler records measured rows but never secrets, source keys or raw SQL arguments',async()=>{
  const logs:string[]=[];
  const original=console.log;
  try {
    console.log=(...args:unknown[])=>logs.push(args.map(String).join(' '));
    await withSqlUsage(true,'registry','/internal/authorize',async()=>{
      trackSql('SELECT value FROM records WHERE key=? ORDER BY part',
        {reads:5,writes:0,statements:1,unmetered:0},['grant/supersecret-private-id']);
      trackSql('SELECT value FROM records WHERE key=? ORDER BY part',
        {reads:2,writes:0,statements:1,unmetered:0},['grant/different-private-id']);
      trackSql('INSERT INTO registry_entity_v1 VALUES(?,?,?,?,?,?,?,?,?)',
        {reads:0,writes:3,statements:1,unmetered:0},['sensitive-string']);
    },true);
  } finally {console.log=original;}
  assert.equal(logs.length,1);
  assert.doesNotMatch(logs[0]!,/supersecret|different-private|sensitive-string|SELECT value FROM/);
  const output=JSON.parse(logs[0]!) as {
    kind:string;route:string;usage:{reads:number;writes:number;statements:number};
    queryProfile:Array<{verb:string;table:string;keyKind:string;fingerprint:string;
      usage:{reads:number;writes:number;statements:number}}>;
  };
  assert.equal(output.kind,'perch-mcp-sql-usage');
  assert.equal(output.route,'internal/authorize');
  assert.deepEqual(output.usage,{reads:7,writes:3,statements:3,unmetered:0});
  assert.equal(output.queryProfile.length,2);
  assert.deepEqual(output.queryProfile.map(q=>[q.verb,q.table,q.keyKind,q.usage.reads,q.usage.writes]),[
    ['SELECT','records','grant',7,0],['INSERT','registry_entity_v1','other',0,3],
  ]);
  for(const row of output.queryProfile)assert.match(row.fingerprint,/^[a-f0-9]{8}$/);
});
test('R04 SQL profiler disabled preserves result and emits zero records',async()=>{
  const logs:string[]=[],original=console.log;
  try {
    console.log=(...args:unknown[])=>logs.push(args.map(String).join(' '));
    const result=await withSqlUsage(false,'workspace','/internal/admit',async()=>{
      trackSql('UPDATE records SET value=?',{reads:100,writes:50,statements:1,unmetered:0},['admin-secret']);
      return 42;
    },true);
    assert.equal(result,42);
  } finally {console.log=original;}
  assert.equal(logs.length,0);
});
