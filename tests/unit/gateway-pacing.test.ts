import {test} from "node:test";
import assert from "node:assert/strict";
import {pollWaitMs, paceIdlePoll} from "../../apps/gateway/src/poll-pacing.js";
test("legacy polls are bounded; explicit zero remains immediate",()=>{
  assert.equal(pollWaitMs(undefined),15000);
  assert.equal(pollWaitMs(25000),15000);
  assert.equal(pollWaitMs(0),0);
  for(const value of [-1,Infinity,NaN,"10",null]) assert.throws(()=>pollWaitMs(value));
});
test("only detached empty successful responses wait outside the DO",async()=>{
  const calls:number[]=[];
  const response=Response.json({operations:[],expiresAt:123});
  const result=await paceIdlePoll(response,15000,async ms=>{
    assert.equal(response.bodyUsed,true); calls.push(ms);
  });
  assert.deepEqual(await result.json(),{operations:[],expiresAt:123});
  await paceIdlePoll(Response.json({operations:[{id:1}]}),15000,async ms=>{calls.push(ms);});
  await paceIdlePoll(Response.json({}, {status:503}),15000,async ms=>{calls.push(ms);});
  await paceIdlePoll(Response.json({operations:[]}),0,async ms=>{calls.push(ms);});
  await paceIdlePoll(Response.json({operations:[],idleWaitMs:15000}),15000,async ms=>{calls.push(ms);});
  assert.deepEqual(calls,[5000,15000]);
});
