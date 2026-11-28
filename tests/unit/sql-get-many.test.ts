import assert from 'node:assert/strict';
import test from 'node:test';
import type {DurableObjectStorage} from '@cloudflare/workers-types';
import {SqlRecords} from '../../apps/gateway/src/sql.js';

function fixture() {
 const rows=new Map<string,string[]>();
 const calls:Array<{sql:string;args:unknown[]}>=[];
 const storage={sql:{exec<T>(sql:string,...args:unknown[]){
   calls.push({sql,args});
   let values:Record<string,unknown>[]=[];
   if(sql.startsWith('SELECT key,part,value FROM records WHERE key IN (')){
     const selected=new Set(args);
     values=[...rows].filter(([key])=>selected.has(key)).sort(([a],[b])=>a.localeCompare(b))
       .flatMap(([key,parts])=>parts.map((value,part)=>({key,part,value})));
   } else if(!sql.startsWith('CREATE TABLE IF NOT EXISTS records'))throw Error('Unexpected test SQL');
   return {toArray:()=>values as T[],rowsRead:values.length,rowsWritten:0};
 }}} as unknown as DurableObjectStorage;
 const db=new SqlRecords(storage);
 const put=(key:string,object:unknown)=>rows.set(key,[JSON.stringify(object)]);
 return {db,rows,calls,put};
}
test('R04 canonical getMany joins one bounded SQLite SELECT and never rewrites or caches Grant authority',()=>{
 const f=fixture();
 f.put('core',{schemaVersion:3,policyRevision:2});
 f.put('grant/g',{id:'g',state:'active'});
 f.put('agent/a',{id:'a',suspended:false});
 const start=f.calls.length;
 const one=f.db.getMany<Record<string,unknown>>(['core','grant/g','agent/a','workspace/not-owned']);
 assert.equal(f.calls.length,start+1);
 assert.deepEqual([...one.keys()],['agent/a','core','grant/g']);
 assert.equal(one.has('workspace/not-owned'),false);
 assert.equal(one.get('grant/g')?.state,'active');
 const sql=f.calls.at(-1)!;
 assert.equal(sql.sql.includes('grant/g'),false,'Canonical keys must stay in prepared args');
 assert.equal(sql.args.length,4);
 f.put('grant/g',{id:'g',state:'revoked'});
 const second=f.db.getMany<Record<string,unknown>>(['grant/g']);
 assert.equal(second.get('grant/g')?.state,'revoked',
   'Every scope check must read current canonical Grant, not an earlier positive snapshot');
 assert.equal(f.calls.length,start+2);
});
test('R04 bulk query binds arbitrary string keys, preserves chunked UTF8 JSON and rejects partial/corrupt records',()=>{
 const f=fixture();
 const sensitive='grant/one\' OR 1=1--';
 const value={message:'Unicode 🛰️ / ครอบครัว',list:[1,2,3],large:'X'.repeat(50000)};
 const encoded=JSON.stringify(value);
 f.rows.set(sensitive,[encoded.slice(0,25000),encoded.slice(25000)]);
 const one=f.db.getMany<typeof value>([sensitive]);
 assert.deepEqual(one.get(sensitive),value);
 assert.equal(f.calls.at(-1)!.args[0],sensitive);
 assert.equal(f.calls.at(-1)!.sql.includes(sensitive),false);
 f.rows.set(sensitive,['{bad-json']);
 assert.throws(()=>f.db.getMany([sensitive]),/SQLITE_RECORD_CORRUPT/);
});
test('R04 bulk lookup rejects duplicate, empty or unbounded keys',()=>{
 const f=fixture();
 for(const keys of [[],['core','core'],[''],Array.from({length:9},(_,i)=>'k'+i),
   ['x'.repeat(257)]] as string[][])assert.throws(()=>f.db.getMany(keys),/SQLITE_RECORD_BATCH_INVALID/);
});
