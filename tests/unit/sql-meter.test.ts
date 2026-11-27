import {test} from 'node:test';
import assert from 'node:assert/strict';
import {trackSql,withSqlUsage} from '../../apps/gateway/src/sql-meter.js';
test('failed optional SQL logging never changes success or masks the original failure',async()=>{
  const original=console.log;
  console.log=()=>{throw new Error('Synthetic logger outage');};
  try {
    assert.equal(await withSqlUsage(true,'workspace','/internal/admit',async()=>42),42);
    const expected=new Error('original failure');
    await assert.rejects(()=>withSqlUsage(true,'workspace','/internal/admit',async()=>{throw expected;}),error=>error===expected);
  } finally {console.log=original;}
});
test('measurement is scoped, source-free and bounded during a request flood',async()=>{
  const original=console.log,clock=Date.now,lines:string[]=[];
  const fixed=clock()+120000;
  Date.now=()=>fixed;console.log=(line:unknown)=>{lines.push(String(line));};
  try {
    await Promise.all(Array.from({length:20},()=>withSqlUsage(true,'workspace','/internal/migration',async()=>{
      await Promise.resolve();trackSql('SELECT * FROM operation_native_v2',{reads:3,writes:0,statements:1,unmetered:0});
    })));
    for(const row of lines.map(line=>JSON.parse(line))) {
      assert.equal(row.usage.reads,3);assert.equal(row.route,'internal/migration');
      assert.deepEqual(Object.keys(row.categories),['operation-canonical']);
    }
    for(let n=0;n<1000;n++)await withSqlUsage(true,'registry','/SECRET-private-path',async()=>{});
    assert.ok(lines.length<=120);assert.doesNotMatch(lines.join('\n'),/SECRET|SELECT|operation_native_v2/);
    assert.equal(await withSqlUsage(false,'workspace','/internal/status',async()=>7),7);
    assert.ok(lines.length<=120);
  } finally {console.log=original;Date.now=clock;}
});
