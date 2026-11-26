import test from 'node:test';
import assert from 'node:assert/strict';
import {
  blocksNewLease,blocksNewMutation,isTerminalViewportEffect,requiresGeneratorReservation,
} from '../../packages/contracts/src/effect-policy.js';

test('terminal CSS-only PARTIAL and UNKNOWN preserve history without blocking next lease/writer',()=>{
 for(const phase of ['PARTIAL','UNKNOWN']){
  const old={tool:'set_viewport_size',phase,terminalAt:Date.now()};
  assert.equal(isTerminalViewportEffect(old),true);
  assert.equal(blocksNewLease(old),false);
  assert.equal(blocksNewMutation(old),false);
  assert.equal(blocksNewLease({...old,resolution:undefined}),false);
  assert.equal(blocksNewLease({...old,terminalAt:undefined}),true);
 }
});
test('provider/source partials, in-flight view calls and opaque preview eval remain held',()=>{
 for(const tool of ['write','save_generator','generate_image','page_eval','upload_file','fetch_url']){
  for(const phase of ['PARTIAL','UNKNOWN']){
   const op={tool,phase,terminalAt:Date.now()};
   assert.equal(blocksNewLease(op),true,tool+' '+phase);
   assert.equal(blocksNewMutation(op),true,tool+' '+phase);
  }
 }
 for(const phase of ['DISPATCHED','RUNNING']){
  assert.equal(blocksNewLease({tool:'set_viewport_size',phase}),true);
 }
 assert.equal(blocksNewLease({tool:'save_generator',phase:'UNKNOWN',terminalAt:Date.now(),
   resolution:{resolvedByOperator:true}}),false);
});
test('only viewport geometry avoids persistent generator writer reservation',()=>{
 assert.equal(requiresGeneratorReservation('set_viewport_size',true),false);
 assert.equal(requiresGeneratorReservation('set_viewport_size',false),false);
 for(const tool of ['page_eval','page_refresh','write','save_generator','upload_file','fetch_url','execute_js']){
  assert.equal(requiresGeneratorReservation(tool,true),true,tool);
 }
 assert.equal(requiresGeneratorReservation('write',false),false);
});

test('viewport reset accepts no dimensions but rejects omitted size on actual resize',async()=>{
 const {validateToolCall}=await import('../../packages/contracts/src/tools.js');
 assert.deepEqual(validateToolCall('set_viewport_size',{reset:true}),{reset:true});
 assert.deepEqual(validateToolCall('set_viewport_size',{reset:true,width:390,height:844}),
  {reset:true,width:390,height:844});
 assert.throws(()=>validateToolCall('set_viewport_size',{}));
 assert.throws(()=>validateToolCall('set_viewport_size',{width:390}));
 assert.throws(()=>validateToolCall('set_viewport_size',{height:844}));
 assert.deepEqual(validateToolCall('set_viewport_size',{width:390,height:844}),
  {width:390,height:844,reset:false});
});
