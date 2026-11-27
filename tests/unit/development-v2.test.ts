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
  const valid=await fixture('batch',{actions:[first,{tool:'read',args:{files:[{path:'scratch/new'}]}},
    {tool:'delete',args:{paths:[{path:'scratch/input',ifSha256:await digest('wrong')}]}}]});
  const partial=await executeDevelopment(valid.context) as {status:string;steps:unknown[]};
  assert.equal(partial.status,'PARTIAL');
  assert.equal(partial.steps.length,3);
  const grouped=await fixture('batch',{actions:[first,{tool:'write',args:{base:'previous',files:[
    {path:'scratch/new',encoding:'utf8',content:'updated'},
  ]}}]});
  const published=await executeDevelopment(grouped.context) as {status:string;steps:unknown[]};
  assert.equal(published.status,'SUCCEEDED');
  assert.equal(published.steps.length,2);
  assert.deepEqual(grouped.permits,['source-publication']);
  assert.equal(new TextDecoder().decode(await (await grouped.vfs.localView()).read('scratch/new')),'updated');
});

test('actual-pixel capture reports an unavailable interface and opens no surface',async()=>{
  const {JSDOM}=await import('jsdom');
  const {DevelopmentPreview}=await import('../../apps/userscript/src/development-preview.js');
  const dom = new JSDOM('<iframe id="outputIframeEl"></iframe>');
  try {
    const f=await fixture('capture_page_image',{});
    const preview = new DevelopmentPreview({},dom.window.document,async()=> 'a'.repeat(64));
    await assert.rejects(preview.run('capture_page_image',{},f.context,{
      target:f.context.envelope.target,grantId:'grant',operationId:'operation',assertCurrent:()=>undefined,
      authorizePublication:async()=>{throw new Error('Unexpected publication');},
    }),/No verified userscript interface/);
    assert.deepEqual(f.permits,[]);
    preview.dispose();
  } finally { dom.window.close(); }
});

test('preview proof is cleared on document load and failed refresh',async()=>{
  const {JSDOM}=await import('jsdom');
  const {PreviewAdapter}=await import('../../apps/userscript/src/preview.js');
  const dom=new JSDOM('<iframe id="outputIframeEl"></iframe>');
  try {
    const frame=dom.window.document.querySelector('iframe')!;
    let fail=false;
    const revision='a'.repeat(64);
    const preview=new PreviewAdapter({frame:()=>frame,revision:async()=>revision,requireDocumentProof:true,
      verified:{refresh:true},bridge:{
        refresh:async()=>({appliedRevision:fail?'b'.repeat(64):revision,
          previewGeneration:'document-1',consoleOutput:[],perchanceErrors:[],syntaxErrors:[]}),
        evaluate:async()=>({consoleOutput:[],perchanceErrors:[],syntaxErrors:[]}),
      },
    });
    await preview.refresh();
    assert.equal((await preview.freshness()).previewRevision,revision);
    const epoch=preview.currentEpoch();
    frame.dispatchEvent(new dom.window.Event('load'));
    assert.ok(preview.currentEpoch()>epoch);
    assert.equal((await preview.freshness()).pageFreshnessUnknown,true);
    await preview.refresh();
    fail=true;
    await assert.rejects(preview.refresh(),/did not attest/);
    assert.equal((await preview.freshness()).pageFreshnessUnknown,true);
    preview.dispose();
  } finally { dom.window.close(); }
});

test('Save uses the native revision and independent saved base, leaving a hold after uncertainty',async()=>{
  const {saveDevelopment}=await import('../../apps/userscript/src/development-save.js');
  const f=await fixture('save_generator',{});
  f.context.envelope.permissions.push('SAVE');
  const identity={generatorId:'generator',slug:'fixture',draftId:''};
  const native={identity,files:{'main.pjs':new Uint8Array([65]),'index.html':new Uint8Array()},revision:'a'.repeat(64),
    dirty:true,saveState:'unsaved'};
  const saved={...native,revision:'b'.repeat(64)};
  const mock=f.vfs.adapter as unknown as Record<string,unknown>;
  mock.options={externalWritesVerified:true};
  mock.snapshot=async()=>native;
  let calls=0;
  mock.save=async (revision:string,context:{onDispatch:()=>Promise<void>})=>{
    assert.equal(revision,native.revision);
    await context.onDispatch();
    calls++;
    return {status:'UNKNOWN',revision,committed:[]};
  };
  await assert.rejects(saveDevelopment({intendedSourceRevision:native.revision,expectedSavedRevision:'c'.repeat(64)},
    f.context,async()=>saved),/saved base/);
  assert.equal(calls,0);
  const result=await saveDevelopment({intendedSourceRevision:native.revision,expectedSavedRevision:saved.revision},f.context,async()=>saved);
  assert.equal(result.status,'UNKNOWN');
  assert.equal((await f.vfs.unresolved()).length,1);
  await assert.rejects(saveDevelopment({intendedSourceRevision:native.revision,expectedSavedRevision:saved.revision},
    f.context,async()=>saved),/Reconcile/);
  assert.equal(calls,1);
});
