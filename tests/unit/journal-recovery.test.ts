import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeAdapter } from '../../apps/userscript/src/adapter.js';
import { BrowserError, digest, snapshotRevision, utf8, type FileWrite, type NativeIdentity } from '../../apps/userscript/src/native-types.js';
import { SourceTools } from '../../apps/userscript/src/source-tools.js';
import { MemoryStore } from '../../apps/userscript/src/storage.js';
import { VirtualFileSystem } from '../../apps/userscript/src/vfs.js';

function fixture() {
  const identity:NativeIdentity={generatorId:'g-1',slug:'synthpin',draftId:''};
  const files:Record<string,Uint8Array>={
    'main.pjs':utf8.encode('output = original'),
    'index.html':utf8.encode('<main>original</main>'),
    'src/synthpin.css':utf8.encode('.old {}'),
  };
  const store = new MemoryStore();
  let nativeWrites=0;
  let observedIdentity=identity;
  let readFail=false;
  const adapter={
    identity:async()=>observedIdentity,
    probe:async()=>({ready:true,identity:observedIdentity,dirty:false,saveState:'saved',
      sourceRead:true,sourceWrite:true,sourceWriteBlocked:[],nativeSave:true}),
    snapshot:async()=>{
      if(readFail)throw new BrowserError('UNSUPPORTED_INTERFACE','Injected native file read failure');
      return {identity:observedIdentity,files:Object.fromEntries(Object.entries(files).map(([p,b])=>[p,b.slice()])),
        revision:await snapshotRevision(observedIdentity,files),dirty:false,saveState:'saved'};
    },
    applyFiles:async(writes:FileWrite[],expectedRevision:string,onDispatch?:()=>Promise<void>)=>{
      assert.equal(expectedRevision,await snapshotRevision(observedIdentity,files),'native revision is optimistic');
      await onDispatch?.();nativeWrites++;
      for(const w of writes)if(w.bytes===null)delete files[w.path];else files[w.path]=w.bytes.slice();
      return {status:'SUCCEEDED',revision:await snapshotRevision(observedIdentity,files),committed:writes.map(w=>w.path)};
    },
  } as unknown as NativeAdapter;
  const vfs=new VirtualFileSystem(adapter,store,'w');
  return {adapter,store,vfs,files,identity,
    countWrites:()=>nativeWrites,changeIdentity:(id:NativeIdentity)=>{observedIdentity=id;},
    failRead:(flag:boolean)=>{readFail=flag;}};
}
async function hold(f:ReturnType<typeof fixture>,id:string,paths:string[],opts:{
  ageMs?:number;kind?:string;state?:string;plannedHash?:string;plannedPaths?:Record<string,string|null>;
}={}) {
  const key=`${f.vfs.prefix}:journal:${id}`;
  const row={id,kind:opts.kind??'SOURCE',state:opts.state??'UNKNOWN',paths,
    baseRevision:'32:2da9cfa4e5e8ed329c5200fdc9da5a8b6e420ce7dddacbfb4d9f14614fcbd8c2',
    createdAt:Date.now()-(opts.ageMs??60000),
    ...(opts.plannedHash?{plannedHash:opts.plannedHash,plannedPaths:opts.plannedPaths}:{}),
  };
  await f.store.set(key,row);
  return key;
}

test('live v0.1.15 single-file UNKNOWN journal adopts current saved revision without Gateway lookup',async()=>{
  const f=fixture();
  f.files['src/synthpin.css']=utf8.encode('.new { color: red }');
  f.files['index.html']=utf8.encode('<main>updated independently</main>');
  const key=await hold(f,'4e01ad79-d630-42ab-809e-110fce6e9bce',['src/synthpin.css']);
  const status=await new SourceTools(f.vfs,f.adapter).call('workspace_status') as {
    unresolved:unknown[];revision:string;recentLocalReconciliations:Array<{id:string;mode:string}>;
  };
  assert.equal(status.unresolved.length,0,'old source intent no longer blocks development');
  assert.match(status.revision,/^\d+:[a-f0-9]{64}$/);
  assert.deepEqual(status.recentLocalReconciliations.map(row=>row.mode),['ADOPTED_CURRENT_SAVED_SOURCE']);
  const original=await f.store.get<{state:string;resolvedByReadback:boolean;resolutionMode:string;inspectedRevision:string}>(key);
  assert.equal(original?.state,'UNKNOWN','do not fabricate success for the original command');
  assert.equal(original?.resolvedByReadback,true);
  assert.equal(original?.inspectedRevision,status.revision);
  const result=await f.vfs.writeBatch([{path:'src/synthpin.css',bytes:utf8.encode('.new {color:blue}') }],status.revision);
  assert.equal(result.status,'SUCCEEDED');
  assert.equal(f.countWrites(),1);
});

test('multiple old unknown source/save intents rebase together without changing native code',async()=>{
  const f=fixture();
  const a=await hold(f,'old-css',['src/synthpin.css']);
  const b=await hold(f,'old-save',['index.html','main.pjs'],{kind:'SAVE'});
  const before=await snapshotRevision(f.identity,f.files);
  const reconciled=await f.vfs.reconcileRetained();
  assert.equal(reconciled.length,2);
  assert.equal((await f.vfs.unresolved()).length,0);
  assert.equal(await snapshotRevision(f.identity,f.files),before);
  assert.equal(f.countWrites(),0,'recovery never replays old effects');
  assert.equal((await f.store.get<{state:string}>(a))?.state,'UNKNOWN');
  assert.equal((await f.store.get<{state:string}>(b))?.state,'UNKNOWN');
});

test('exact planned-byte proof can verify old unknown result without replay',async()=>{
  const f=fixture();
  const current=await f.vfs.snapshot();
  const path='src/synthpin.css';
  const key=await hold(f,'exact',[path],{ageMs:0,state:'UNKNOWN',plannedHash:current.revision.split(':')[1],
    plannedPaths:{[path]:await digest(f.files[path]!)}});
  const r=await f.vfs.reconcileRetained();
  assert.equal(r[0]?.mode,'VERIFIED_INTENDED_BYTES');
  assert.equal((await f.store.get<{state:string}>(key))?.state,'SUCCEEDED');
  assert.equal(f.countWrites(),0);
});

test('recent overlapping effect is held, but non-overlapping writes succeed immediately',async()=>{
  const f=fixture();
  await hold(f,'still-running',['src/synthpin.css'],{ageMs:0});
  const baseline=await f.vfs.snapshot();
  await assert.rejects(f.vfs.writeBatch([{path:'src/synthpin.css',bytes:utf8.encode('collision')}],baseline.revision),
    (e:unknown)=>e instanceof BrowserError && e.code==='NATIVE_CONFLICT');
  const other=await f.vfs.writeBatch([{path:'src/other.js',bytes:utf8.encode('export const ok = true;')}],baseline.revision);
  assert.equal(other.status,'SUCCEEDED');
  assert.equal(f.countWrites(),1);
  assert.equal((await f.vfs.unresolved()).length,1,'other write does not falsely erase the recent hold');
});

test('unresolved import from another prefix cannot fence native source writes',async()=>{
  const f=fixture();
  await hold(f,'import',['imports/old/main.pjs'],{ageMs:0,kind:'IMPORT'});
  const before=await f.vfs.snapshot();
  const result=await f.vfs.writeBatch([{path:'src/app.js',bytes:utf8.encode('safe') }],before.revision);
  assert.equal(result.status,'SUCCEEDED');
  assert.equal((await f.vfs.unresolved()).length,1);
});

test('identity mismatch and unavailable readback never silently adopt an old intent',async()=>{
  const f=fixture();
  await hold(f,'identity',['src/synthpin.css']);
  f.changeIdentity({generatorId:'different',slug:'other',draftId:''});
  // Status is intentionally still obtainable, but the journal cannot be
  // rebased against an identity that disagrees with the native capability probe.
  f.failRead(true);
  assert.deepEqual(await f.vfs.reconcileRetained(),[]);
  assert.equal((await f.vfs.unresolved()).length,1);
  f.failRead(false);
  assert.equal((await f.vfs.reconcileRetained()).length,1,
    'a new canonical bound source is permitted to supersede old local metadata');
});

test('recent uncertain native Save does not block independent scratch operations',async()=>{
  const f=fixture();
  await hold(f,'save-in-flight',['main.pjs','index.html','src/synthpin.css'],{ageMs:0,kind:'SAVE'});
  const baseline=await f.vfs.snapshot();
  const independent=await f.vfs.writeBatch([{path:'scratch/plan.md',bytes:utf8.encode('continue planning')}],baseline.revision);
  assert.equal(independent.status,'SUCCEEDED');
  assert.equal((await f.vfs.unresolved()).length,1);
  await assert.rejects(f.vfs.writeBatch([{path:'src/another.js',bytes:utf8.encode('pending save')}]),
    (e:unknown)=>e instanceof BrowserError&&e.code==='NATIVE_CONFLICT');
  assert.equal(f.countWrites(),0,'scratch operations do not invoke native source setters');
});
