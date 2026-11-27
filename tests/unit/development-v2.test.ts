import assert from 'node:assert/strict';
import test from 'node:test';
import { developmentToolDefinitions, parseDevelopmentCall } from '../../packages/contracts/src/development-v2.js';
import { executeDevelopment, type DevelopmentContext } from '../../apps/userscript/src/development-v2.js';
import { executeCompute } from '../../apps/userscript/src/compute.js';
import { BrowserError, digest } from '../../apps/userscript/src/native-types.js';
import { VirtualFileSystem } from '../../apps/userscript/src/vfs.js';
import type { NativeAdapter } from '../../apps/userscript/src/adapter.js';
import { MemoryStore } from '../../apps/userscript/src/storage.js';

async function fixture(tool: string, args: Record<string,unknown>) {
  const store = new MemoryStore();
  const vfs = await VirtualFileSystem.openBound({} as NativeAdapter,store,{
    workspaceId:'workspace',installationId:'installation',assignmentGeneration:1,bindingGeneration:1,
    epoch:1,generatorId:'generator',draftId:'',
  },{assertCurrent:()=>undefined});
  const revision = (await vfs.localView()).revision.value;
  await vfs.writeLocalBatch([{path:'scratch/input',bytes:new Uint8Array([65])}],revision);
  const permits: string[] = [];
  const context: DevelopmentContext = {
    envelope:{version:2,target:'w2.workspace.1.1',workspaceId:'workspace',bindingRevision:1,
      assignmentGeneration:1,bindingGeneration:1,connectorId:'connector',grantId:'grant',epoch:1,
      tabInstanceId:'tab',operationId:'operation',operationKey:'k2.'+Date.now()+'.'+crypto.randomUUID(),
      policyRevision:1,permissionRevision:1,deadlineMs:Date.now()+30000,tool,args,
      permissions:['READ_SOURCE','WRITE_SOURCE','COMPUTE','FETCH_PUBLIC'],traceId:'trace'},
    vfs, signal:new AbortController().signal, assertCurrent:async()=>undefined,
    permit:async kind=>{permits.push(kind);}, recordStep:async()=>undefined,
    additional:async()=>{throw new BrowserError('UNSUPPORTED_INTERFACE','No external fixture available.');},
  };
  return {context,permits,vfs,store};
}

test('catalog contains 19 names and rejects nested management, Save, POST and missing mutation keys', () => {
  assert.equal(developmentToolDefinitions.length,19);
  const target='w2.workspace.1.1', operationKey='k2.'+Date.now()+'.'+crypto.randomUUID();
  assert.throws(()=>parseDevelopmentCall('write',{target,files:[{path:'scratch/new',encoding:'utf8',content:'safe',ifAbsent:true}]}),/operationKey/);
  for(const tool of ['save_generator','batch','operation_status','skill','workspace_status']) {
    assert.throws(()=>parseDevelopmentCall('batch',{target,operationKey,actions:[{tool,args:{}}]}),/Invalid development/);
  }
  assert.throws(()=>parseDevelopmentCall('batch',{target,operationKey,actions:[{tool:'fetch_url',
    args:{requests:[{method:'POST',url:'https://fixture.test/',path:'scratch/out',body:'x',ifAbsent:true}]}}]}),/Invalid development/);
});

test('100 QuickJS reads share a local read view and a denied publication leaves scratch unchanged', async () => {
  const input = {js:'let count=0; for(let i=0;i<100;i++) if(await fs.readTextFile("scratch/input")==="A") count++; return count;',
    access:{read:['scratch/input'],maxReads:100}};
  const f = await fixture('execute_js',input);
  const read = await executeDevelopment(f.context,{execute:executeCompute}) as {result:unknown};
  assert.equal(read.result,100);
  assert.deepEqual(f.permits,['read-view']);
  const denied = await fixture('execute_js',{js:'await fs.writeTextFile("scratch/output","x"); return 1;',
    access:{write:['scratch/output']}});
  denied.context.permit=async kind=>{
    denied.permits.push(kind);
    if (kind==='source-publication') throw new BrowserError('REVOKED','synthetic revoke');
  };
  await assert.rejects(executeDevelopment(denied.context,{execute:executeCompute}), /revok|staged write/i);
  assert.deepEqual((await denied.vfs.localView()).files.map(file=>file.path),['scratch/input']);
  assert.deepEqual(denied.permits,['read-view','source-publication']);
});

test('Invalid batch tail has zero effects. Valid batch reports partial on a failing subsequent action.', async () => {
  const first={tool:'write',args:{files:[{path:'scratch/new',encoding:'utf8',content:'safe',ifAbsent:true}]}};
  const f=await fixture('batch',{actions:[first,{tool:'read',args:{files:[{path:'../../outside'}]}}]});
  await assert.rejects(executeDevelopment(f.context),/Invalid v2/);
  assert.deepEqual(f.permits,[]);
  const valid=await fixture('batch',{actions:[first,{tool:'delete',args:{paths:[{path:'scratch/input',ifSha256:await digest('wrong')}]}}]});
  const partial=await executeDevelopment(valid.context) as {status:string;steps:unknown[]};
  assert.equal(partial.status,'PARTIAL');
  assert.equal(partial.steps.length,2);
});
