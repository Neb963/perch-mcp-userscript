import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isScopedDevelopmentCall} from '../../apps/gateway/src/mcp-scope.js';

const url='https://capacity.test/mcp/connector-1';
function message(method:string,name?:string,args:unknown={}):Request {
  return new Request(url,{method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method,
      ...(name!==undefined?{params:{name,arguments:args}}:{})})});
}
test('R04 validated tools/call performs its precise Grant/Target authorization once, not two generic checks',async()=>{
  const valid=message('tools/call','workspace_status',{});
  assert.equal(await isScopedDevelopmentCall(valid),true);
  const original=await valid.json() as {method:string};
  assert.equal(original.method,'tools/call','The bounded clone must not consume the SDK request body');
});
test('R04 malformed, non-tool and oversized MCP requests retain outer Grant authorization',async()=>{
  for(const request of [
    message('tools/list'),message('initialize'),
    message('tools/call','nonexistent_tool',{}),
    message('tools/call','save_generator',{}),
    new Request(url,{method:'GET'}),
    new Request(url,{method:'POST',headers:{'Content-Type':'text/plain'},body:'{}'}),
    new Request(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify([
      {jsonrpc:'2.0',method:'tools/call',params:{name:'workspace_status',arguments:{}}},
    ])}),
    new Request(url,{method:'POST',headers:{'Content-Type':'application/json'},body:'{not valid JSON'}),
    new Request(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'workspace_status',arguments:{pad:'x'.repeat(512*1024)}},
    })}),
  ])assert.equal(await isScopedDevelopmentCall(request),false,'Unexpected optimization of unsafe MCP input');
});
