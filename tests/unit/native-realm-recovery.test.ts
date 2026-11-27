import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { nativeBytes, NativeAdapter } from '../../apps/userscript/src/adapter.js';
import { BrowserController } from '../../apps/userscript/src/controller.js';
import { MemoryStore } from '../../apps/userscript/src/storage.js';
import { BrowserError } from '../../apps/userscript/src/native-types.js';
import { SourceTools } from '../../apps/userscript/src/source-tools.js';
import { VirtualFileSystem } from '../../apps/userscript/src/vfs.js';
import type { GatewayTransport } from '../../apps/userscript/src/transport.js';

test('page-realm ArrayBuffer preserves binary and empty bytes, rejecting stale declared lengths', async () => {
  const context = vm.createContext({});
  const result = vm.runInContext('({bytes:new Uint8Array([0,255,1,128,5]),zero:new ArrayBuffer(0),Uint8Array})',context) as {
    bytes:Uint8Array;zero:ArrayBuffer;Uint8Array:Uint8ArrayConstructor;
  };
  assert.deepEqual([...await nativeBytes(result.bytes.buffer,result.Uint8Array,5)],[0,255,1,128,5]);
  assert.equal((await nativeBytes(result.zero,result.Uint8Array,0)).length,0);
  await assert.rejects(nativeBytes(result.bytes.buffer,result.Uint8Array,4),
    (e:unknown)=>e instanceof BrowserError && e.code==='STALE_REVISION');
});

test('opaque foreign ArrayBuffer can use the page typed-array constructor without byte truncation', async () => {
  const raw = Uint8Array.from([0,255,2,127,255]);
  // Simulates a Firefox cross-compartment Xray/Proxy. All local brand and
  // structuredClone operations reject it, while the page constructor sees it.
  const foreign = new Proxy({__native:raw}, {});
  const pageCtor = function (value:unknown) {
    if(value !== foreign) throw new Error('wrong native buffer');
    return raw;
  } as unknown as Uint8ArrayConstructor;
  assert.deepEqual([...await nativeBytes(foreign,pageCtor,5)],[0,255,2,127,255]);
  await assert.rejects(nativeBytes(foreign,pageCtor,4),
    (e:unknown)=>e instanceof BrowserError && (e.code==='UNSUPPORTED_INTERFACE'||e.code==='STALE_REVISION'));
  await assert.rejects(nativeBytes(foreign,undefined),
    (e:unknown)=>e instanceof BrowserError && e.code==='UNSUPPORTED_INTERFACE');
});

test('an inaccessible old journal cannot block the browser lease; independent tools remain online', async () => {
  const identity={generatorId:'g',slug:'g',draftId:'d'};
  const store=new MemoryStore();
  await store.set('perch:workspace:w:journal:old',{id:'old',state:'UNKNOWN',kind:'SOURCE',paths:['src/a.bin'],baseRevision:'1:old',createdAt:1});
  const adapter={
    probe:async()=>({ready:true,identity,dirty:false,sourceRead:true,sourceWrite:true,sourceWriteBlocked:[],nativeSave:false}),
    identity:async()=>identity,
    snapshot:async()=>{throw new BrowserError('UNSUPPORTED_INTERFACE','Cross-realm byte buffer unavailable.');},
    bind:()=>undefined,
    ownership:async()=>true,
    canSave:async()=>true,
  } as unknown as NativeAdapter;
  let claimCount=0,releaseCount=0;
  let releasePoll!:()=>void;
  const pollPromise=new Promise<void>(resolve=>{releasePoll=resolve;});
  const status:{connection:string;reason?:string}[]=[];
  const transport={
    installationId:async()=> 'browser',
    configuration:()=>({paired:true}),
    request:async()=>({items:[],revision:1}),
    tab:async(path:string,body:Record<string,unknown>)=>{
      if(path==='/api/v1/tab/claim'){claimCount++;return {workspaceId:'w',tabInstanceId:body.tabInstanceId,epoch:1,leaseCredential:'lease',permissions:['READ_SOURCE'],expiresAt:Date.now()+180000,bindingRevision:1};}
      if(path==='/api/v1/tab/poll'){await pollPromise;return {operations:[]};}
      if(path==='/api/v1/tab/release'){releaseCount++;return {};}
      return {};
    },
  } as unknown as GatewayTransport;
  const c=new BrowserController(adapter,store,transport,undefined,st=>status.push(st));
  try {
    await c.attach({id:'w',binding:{...identity,browserInstallationId:'browser'}});
    assert.equal(claimCount,1);
    assert.equal(c.diagnostics().connection,'connected');
    assert.equal(c.diagnostics().leasePresent,true);
    assert.equal(c.diagnostics().localPendingHolds,1);
    const source=new SourceTools(new VirtualFileSystem(adapter,store,'w'),adapter);
    const result=await source.call('workspace_status') as Record<string,unknown>;
    assert.equal(result.snapshotVerified,false);
    assert.equal(result.sourceReadbackError,'UNSUPPORTED_INTERFACE');
    assert.equal(result.revision,null);
    assert.equal((result.unresolved as unknown[]).length,1);
    await assert.rejects(source.call('write',{path:'main.pjs',content:'do not change'}),
      (e:unknown)=>e instanceof BrowserError && e.code==='UNSUPPORTED_INTERFACE');
  } finally {
    await c.pause();releasePoll();
  }
  assert.equal(releaseCount,1);
});

test('failure to read local journals cannot block a lease but source status does not advertise safe writes', async()=>{
  const store=new MemoryStore();
  const unreliable={...store,
    get:<T>(key:string)=>store.get<T>(key),
    set:<T>(key:string,value:T)=>store.set(key,value),
    delete:(key:string)=>store.delete(key),
    list:async()=>{throw new Error('GM_listValues failed');},
  };
  const identity={generatorId:'g',slug:'g',draftId:'d'};
  const adapter={probe:async()=>({ready:true,identity,dirty:false,sourceRead:true,sourceWrite:true,sourceWriteBlocked:[]}),
    identity:async()=>identity,bind:()=>undefined,
    snapshot:async()=>({identity,files:{'main.pjs':new Uint8Array([1]),'index.html':new Uint8Array([2])},revision:'abc',dirty:false,saveState:'unsaved'})} as unknown as NativeAdapter;
  const source=new SourceTools(new VirtualFileSystem(adapter,unreliable,'w'),adapter);
  const status=await source.call('workspace_status') as Record<string,unknown>;
  assert.equal(status.localJournalError,'LOCAL_STORE_UNAVAILABLE');
  assert.equal(status.snapshotVerified,true);
  assert.deepEqual(status.unresolved,[]);
});

test('complete two-pass native snapshot succeeds with an opaque page-owned /src buffer',async()=>{
  const identity={generatorId:'g',slug:'fixture',draftId:'d'};
  const content=Uint8Array.from([0,255,42,128,0]);
  const opaque=new Proxy({__pageBuffer:content},{});
  const NativePageUint8Array=function(value:unknown){if(value!==opaque)throw Error('native mismatch');return content;} as unknown as Uint8ArrayConstructor;
  let reads=0;
  const page={Uint8Array:NativePageUint8Array,app:{data:{generator:{id:'g',name:'fixture'}}},
    modelTextEditor:{getValue:()=> 'output = hi\n'},outputTemplateEditor:{getValue:()=>'<div>hi</div>'},
    srcState:{getDraftId:()=>identity.draftId,ready:async()=>undefined,
      list:()=>({'binary.dat':{size:content.length}}),readFile:async()=>{reads++;return opaque;}}};
  const native=new NativeAdapter(page);
  const snapshot=await native.snapshot();
  assert.deepEqual([...snapshot.files['src/binary.dat']!],[...content]);
  assert.equal(reads,2,'verified independent native byte readback');
  assert.equal(snapshot.identity.generatorId,'g');
});

test('corrupt local intent remains preserved and is never treated as safe to overwrite',async()=>{
  const identity={generatorId:'g',slug:'g',draftId:'d'};
  const adapter={identity:async()=>identity,
    snapshot:async()=>({identity,files:{'main.pjs':new Uint8Array([1]),'index.html':new Uint8Array([2])},revision:'rev',dirty:false})} as unknown as NativeAdapter;
  const store=new MemoryStore();
  const key='perch:workspace:w:journal:bad';
  await store.set(key,{id:'bad',state:'UNKNOWN',paths:'not a path array',baseRevision:'old'});
  const vfs=new VirtualFileSystem(adapter,store,'w');
  await assert.rejects(vfs.unresolved(),(error:unknown)=>error instanceof BrowserError&&error.code==='STORAGE_CORRUPT');
  await assert.rejects(vfs.writeBatch([{path:'main.pjs',bytes:new Uint8Array([9])}]),
    (error:unknown)=>error instanceof BrowserError&&error.code==='STORAGE_CORRUPT');
  assert.ok(await store.get(key),'malformed journal remains durable');
});

test('page constructor never accepts phantom zero bytes without a zero-byte manifest',async()=>{
  const wrapper=new Proxy({},{});
  const constructor=function(){return new Uint8Array(0);} as unknown as Uint8ArrayConstructor;
  await assert.rejects(nativeBytes(wrapper,constructor),e=>e instanceof BrowserError && e.code==='UNSUPPORTED_INTERFACE');
  assert.equal((await nativeBytes(wrapper,constructor,0)).length,0);
});
