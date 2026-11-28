import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeAdapter } from '../../apps/userscript/src/adapter.js';
import { executeCompute, ExecutionError } from '../../apps/userscript/src/compute.js';
import { executeDevelopment, type DevelopmentContext } from '../../apps/userscript/src/development-v2.js';
import { digest, utf8 } from '../../apps/userscript/src/native-types.js';
import { MemoryStore } from '../../apps/userscript/src/storage.js';
import { VirtualFileSystem } from '../../apps/userscript/src/vfs.js';
import { parseDevelopmentCall } from '../../packages/contracts/src/development-v2.js';

async function fixture(args: Record<string, unknown>) {
  let panel = 'native source';
  const readAssets: string[] = [];
  const native = new Map(Array.from({length:100}, (_, i) => ['unrelated-' + i, utf8.encode('fixture')]));
  native.set('lib/module.js', utf8.encode('export const value=42'));
  const adapter = new NativeAdapter({
    app: {data: {generator: {id:123, name:'fixture'}}},
    modelTextEditor: {state:{readOnly:false},getValue:()=>panel,setValue:(value:string)=>{panel=value;}},
    outputTemplateEditor: {state:{readOnly:false},getValue:()=>'',setValue:()=>undefined},
    srcState: {
      ready:async()=>undefined,idle:async()=>undefined,getDraftId:()=>'',
      list:()=>[...native.keys()],readFile:(path:string)=>{readAssets.push(path);return native.get(path)!;},
      writeFile:(path:string,bytes:Uint8Array)=>{native.set(path,bytes.slice());},deleteFile:(path:string)=>{native.delete(path);},
    },
    aiAgentActivityState:()=>({active:false,unknown:false,reason:''}),__aiGeneratorGuard:{blocked:()=>false},
    __editorReady:true,__draftChoiceSettled:true,currentInterfaceMode:'edit',perchanceSaveState:'unsaved',
  });
  const store = new MemoryStore();
  const vfs = await VirtualFileSystem.openBound(adapter,store,{
    workspaceId:'fixture',installationId:'inst',assignmentGeneration:1,bindingGeneration:1,epoch:1,generatorId:'123',draftId:'',
  },{assertCurrent:()=>undefined});
  const permits: string[] = [];
  const context: DevelopmentContext = {
    envelope:{version:2,target:'w2.fixture.1.1',workspaceId:'fixture',bindingRevision:1, assignmentGeneration:1,
      bindingGeneration:1,connectorId:'connector',grantId:'grant',epoch:1,tabInstanceId:'tab',operationId:'operation',
      operationKey:`k2.${Date.now()}.${crypto.randomUUID()}`,policyRevision:1,permissionRevision:1,
      deadlineMs:Date.now()+30_000,tool:'execute_js',args,permissions:['COMPUTE','READ_SOURCE','WRITE_SOURCE'],traceId:'trace'},
    vfs,signal:AbortSignal.timeout(30000),assertCurrent:async()=>undefined,
    permit:async kind=>{permits.push(kind);},recordStep:async()=>undefined,additional:async()=>undefined,
  };
  return {context,permits,readAssets,native,setPanel:(value:string)=>{panel=value;}};
}

test('F09 100 repeated reads of one PJS use no unrelated native content or per-file permits', async () => {
  const f = await fixture({js:`let n=0;
    for(let i=0;i<100;i++) if(await fs.readTextFile("main.pjs")==="native source") n++;
    return n;`, access:{read:['main.pjs'],maxReads:100}});
  const response = await executeDevelopment(f.context,{execute:executeCompute}) as {result:unknown};
  assert.equal(response.result,100);
  assert.deepEqual(f.readAssets,[]);
  assert.deepEqual(f.permits,['read-view']);
});

test('F09 exact scoped pinned module loads through immutable view without granting guest file access', async () => {
  const path = 'src/lib/module.js';
  const module = {specifier:'@scope/math@1.2.3',path,sha256:await digest('export const value=42')};
  const f = await fixture({js:`const m=await import("@scope/math@1.2.3");
      let denied=false;try{await fs.readTextFile("src/lib/module.js");}catch(e){denied=e.code==="SCOPE_DENIED";}
      return {value:m.value,denied};`, access:{},modules:[module]});
  const response = await executeDevelopment(f.context,{execute:executeCompute}) as {result:unknown};
  assert.deepEqual(response.result,{value:42,denied:true});
  assert.deepEqual(f.readAssets,['lib/module.js','lib/module.js']);
  const {args, target, operationKey} = f.context.envelope;
  for (const invalid of [[{...module,specifier:'math@1'}],[{...module,specifier:'math@1.02.3'}],
    [module,{...module,specifier:'other@1.2.3'}],[module,{...module,path:'src/lib/second.js'}]]) {
    assert.throws(()=>parseDevelopmentCall('execute_js',{...args,target,operationKey,modules:invalid}),/Invalid development/);
  }
  f.context.envelope.permissions = ['COMPUTE'];
  await assert.rejects(executeDevelopment(f.context,{execute:executeCompute}),/permission ceiling/);
});

test('F09 read prefix expansion checks selected content twice and yields sorted permitted metadata', async () => {
  const f = await fixture({js:'return await fs.list();',access:{read:['src/lib/','src/lib/module.js','main.pjs']}});
  const response = await executeDevelopment(f.context,{execute:executeCompute}) as {result:unknown};
  assert.deepEqual(response.result,['main.pjs','src/lib/module.js']);
  assert.deepEqual(f.readAssets,['lib/module.js','lib/module.js']);
});

test('F09 same-size selected native edit between view and publication discards staged bytes', async () => {
  const f = await fixture({js:'await fs.writeTextFile("main.pjs","replace");',access:{write:['main.pjs']}});
  await assert.rejects(executeDevelopment(f.context,{execute:opts=>{
    f.setPanel('human change!');
    return executeCompute(opts);
  }}),(e:unknown)=>e instanceof ExecutionError && e.code==='STALE_REVISION' && e.effectState==='NONE');
  assert.deepEqual(f.permits,['read-view']);
  assert.equal(new TextDecoder().decode((await f.context.vfs.adapter.readSelectedSource(['main.pjs'])).get('main.pjs')!),
    'human change!');
});

test('F09 guest rejects unauthorized staged writes before exposing stage or invoking publication', async () => {
  const f = await fixture({js:`let failure;try{await fs.writeTextFile("scratch/foreign","new");}catch(e){failure=e.code;}
    return {failure,list:await fs.list()};`,access:{read:['scratch/'],write:['scratch/allowed']}});
  const response = await executeDevelopment(f.context,{execute:executeCompute}) as {result:unknown};
  assert.deepEqual(response.result,{failure:'SCOPE_DENIED',list:[]});
  assert.deepEqual(f.permits,['read-view']);
});
