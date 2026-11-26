import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { NativeAdapter } from '../../apps/userscript/src/adapter.js';
import { LiveLifecycleReadback, NativeLifecycle, lifecycleApprovalDigest, type LifecycleContext, type LifecycleReadback, type SavedGenerator } from '../../apps/userscript/src/lifecycle.js';
import { BrowserError, utf8, type NativeSnapshot } from '../../apps/userscript/src/native-types.js';
import { MemoryStore } from '../../apps/userscript/src/storage.js';
import { VirtualFileSystem } from '../../apps/userscript/src/vfs.js';
import { SourceTools } from '../../apps/userscript/src/source-tools.js';
function fixture(enabled=true){const files={'main.pjs':utf8.encode('output = inert'),'index.html':utf8.encode('<h1>inert</h1>')};const original:SavedGenerator={identity:{generatorId:'123',slug:'old-name',draftId:''},files,owned:true,listing:'listed',revision:'saved-base'};const saved=new Map<string,SavedGenerator>([['old-name',structuredClone(original)]]);let deleted=false;let calls=0;const dom=new JSDOM('<div id="listingMenuEl"><button data-value="listed">Listed</button><button data-value="unlisted">Unlisted</button></div>');const settings={refs:{newGeneratorName:{value:''},duplicateGeneratorName:{value:''}},changeGeneratorName:async()=>{calls++;const item=saved.get('old-name')!;saved.delete('old-name');item.identity.slug=settings.refs.newGeneratorName.value;saved.set(item.identity.slug,item);return{status:'renamed',name:item.identity.slug};},duplicateGenerator:async()=>{calls++;const item=structuredClone(original);item.identity={generatorId:'456',slug:settings.refs.duplicateGeneratorName.value||'new-copy',draftId:''};item.listing='unlisted';saved.set(item.identity.slug,item);return{status:'duplicated',name:item.identity.slug,generatorId:item.identity.generatorId};},deleteGenerator:async()=>{calls++;deleted=true;saved.delete('old-name');return{status:'deleted'};}};const page={userOwnsThisGenerator:true,userCanSaveThisGenerator:()=>true,document:dom.window.document,settingsModal:settings,app:{data:{generator:{id:'123',name:'old-name'}},userOwnsThisGenerator:true,openSettingsModal:async()=>{},openListingMenu:async()=>{},saveGenerator:async()=>({status:'saved'})},modelTextEditor:{state:{readOnly:false},getValue:()=> 'output = inert',setValue:()=>{}},outputTemplateEditor:{state:{readOnly:false},getValue:()=>'<h1>inert</h1>',setValue:()=>{}},srcState:{ready:async()=>{},list:()=>({}),readFile:()=>new Uint8Array(),writeFile:()=>{},deleteFile:()=>{},getDraftId:()=>''},currentInterfaceMode:'edit',aiAgentActivityState:()=>({active:false,unknown:false,reason:'',queueHeldOnly:false}),__aiGeneratorGuard:{blocked:()=>false},__editorReady:true,__draftChoiceSettled:true};for(const button of dom.window.document.querySelectorAll('button'))button.addEventListener('click',()=>{calls++;saved.get('old-name')!.listing=button.getAttribute('data-value') as 'listed'|'unlisted';});const adapter=new NativeAdapter(page,{externalWritesVerified:enabled});const store=new MemoryStore();const readback:LifecycleReadback={readGenerator:async slug=>{const item=saved.get(slug);if(!item)throw new Error('not found');return structuredClone(item);},readDeletionEvidence:async(id)=>({inventoryAbsent:deleted,sourceNotFound:deleted,identityChecked:id})};const lifecycle=new NativeLifecycle(adapter,page,readback,store,{externalWritesVerified:enabled});const context=async(tool:string,args:Record<string,unknown>,approved=true):Promise<LifecycleContext>=>{const before=await adapter.snapshot();const c:LifecycleContext={operationId:crypto.randomUUID(),epoch:1,expectedRevision:before.revision,permissions:['RENAME','LISTING','DUPLICATE','DELETE','CREATE']};if(approved)c.approval={tool,target:before.identity,inputDigest:await lifecycleApprovalDigest(tool,args,before.identity,before.revision,1),sourceRevision:before.revision,epoch:1,expiresAt:Date.now()+60000,consumed:false,sourceChoice:'saved'};return c;};return{adapter,store,readback,lifecycle,page,settings,saved,original,context,getCalls:()=>calls};}
const code=(expected:string)=>(e:unknown)=>e instanceof BrowserError&&e.code===expected;
test('external lifecycle gate rejects every native mutation with no dispatch',async()=>{const f=fixture(false);for(const tool of ['rename_generator','set_listing','duplicate_generator','delete_generator'])await assert.rejects(f.lifecycle.call(tool,{newName:'new',listing:'unlisted'},await f.context(tool,{})),code('UNSUPPORTED_INTERFACE'));assert.equal(f.getCalls(),0);});
test('native rename verifies same Generator ID, source and owner and requires rebind',async()=>{const f=fixture();const args={newName:'renamed'};const result=await f.lifecycle.call('rename_generator',args,await f.context('rename_generator',args));assert.equal(result.status,'SUCCEEDED');assert.equal(result.data?.generatorId,'123');assert.equal(result.data?.requiresRebind,true);assert.equal(f.getCalls(),1);});
test('listing requires exact fresh approval and exact independent source/ID/listing result',async()=>{const f=fixture();const args={listing:'unlisted'};await assert.rejects(f.lifecycle.call('set_listing',args,await f.context('set_listing',args,false)),code('APPROVAL_REQUIRED'));const wrong=await f.context('set_listing',args);wrong.approval!.epoch=2;await assert.rejects(f.lifecycle.call('set_listing',args,wrong),code('APPROVAL_REQUIRED'));const result=await f.lifecycle.call('set_listing',args,await f.context('set_listing',args));assert.equal(result.status,'SUCCEEDED');assert.equal(result.data?.listing,'unlisted');assert.equal(f.getCalls(),1);});
test('native duplicate verifies new ID, Unlisted and saved source without reassigning original binding',async()=>{const f=fixture();const args={name:'new-copy'};const ctx=await f.context('duplicate_generator',args);const result=await f.lifecycle.call('duplicate_generator',args,ctx);assert.equal(result.status,'SUCCEEDED');assert.equal(result.data?.generatorId,'456');assert.equal(result.data?.originalBindingPreserved,true);assert.equal((await f.adapter.identity()).generatorId,'123');assert.equal(ctx.approval?.consumed,true);});
test('duplicate leaving Listed cannot be reported as successful parity',async()=>{const f=fixture();f.settings.duplicateGenerator=async()=>{const item=structuredClone(f.original);item.identity={generatorId:'456',slug:'copy',draftId:''};item.listing='listed';f.saved.set('copy',item);return{status:'duplicated',name:'copy',generatorId:'456'};};const args={name:'copy'};const ctx=await f.context('duplicate_generator',args);assert.equal((await f.lifecycle.call('duplicate_generator',args,ctx)).status,'UNKNOWN');await assert.rejects(f.lifecycle.call('set_listing',{listing:'unlisted'},await f.context('set_listing',{listing:'unlisted'})),code('EFFECT_UNKNOWN'));});
test('delete requires two independent exact-ID observations, not one failed source read',async()=>{const f=fixture();f.readback.readDeletionEvidence=async(id)=>({inventoryAbsent:false,sourceNotFound:true,identityChecked:id});const ctx=await f.context('delete_generator',{});assert.equal((await f.lifecycle.call('delete_generator',{},ctx)).status,'UNKNOWN');f.readback.readDeletionEvidence=async(id)=>({inventoryAbsent:true,sourceNotFound:true,identityChecked:id});assert.equal((await f.lifecycle.reconcile(ctx.operationId)).status,'SUCCEEDED');assert.equal(f.getCalls(),1);});
test('lost lifecycle receipt never repeats native effect; read-only reconciliation can verify',async()=>{const f=fixture();const original=f.settings.changeGeneratorName;let calls=0;f.settings.changeGeneratorName=async()=>{calls++;await original();throw new Error('response lost');};const args={newName:'renamed'};const ctx=await f.context('rename_generator',args);assert.equal((await f.lifecycle.call('rename_generator',args,ctx)).status,'UNKNOWN');assert.equal((await f.lifecycle.call('rename_generator',args,ctx)).status,'UNKNOWN');assert.equal(calls,1);const reconstructed=new NativeLifecycle(f.adapter,f.page,f.readback,f.store,{externalWritesVerified:true});assert.equal((await reconstructed.reconcile(ctx.operationId)).status,'SUCCEEDED');assert.equal(calls,1);});
test('wrong native readback owner/ID/source never certifies rename',async()=>{const f=fixture();f.readback.readGenerator=async slug=>{const item=structuredClone(f.original);if(slug==='wrong')item.identity.generatorId='999';item.identity.slug=slug;return item;};const args={newName:'wrong'};assert.equal((await f.lifecycle.call('rename_generator',args,await f.context('rename_generator',args))).status,'UNKNOWN');});
test('create has explicit native-document transition blocker and no fabricated successful artifact',async()=>{const f=fixture();await assert.rejects(f.lifecycle.call('create_generator',{},await f.context('create_generator',{})),code('UNSUPPORTED_INTERFACE'));assert.equal(f.getCalls(),0);});
test('saved-source import cache is byte-exact, revision-pinned, immutable to agent tools',async()=>{const f=fixture();const vfs=new VirtualFileSystem(f.adapter,f.store,'imports');const result=await vfs.importSnapshot('example',{'main.pjs':utf8.encode('public'),'src/empty.bin':new Uint8Array()});assert.ok(result.paths.includes('imports/example/main.pjs'));assert.equal(new TextDecoder().decode(await vfs.read('imports/example/main.pjs')),'public');assert.equal((await vfs.read('imports/example/src/empty.bin')).length,0);await assert.rejects(vfs.writeBatch([{path:'imports/example/main.pjs',bytes:utf8.encode('changed')}]),code('PATH_DENIED'));assert.equal((await vfs.snapshot()).revision,result.revision);});
test('source Save dispatch requires internal exact readback context; source permission alone is insufficient',async()=>{const f=fixture();const vfs=new VirtualFileSystem(f.adapter,f.store,'save');const tools=new SourceTools(vfs,f.adapter);const before=await vfs.snapshot();await assert.rejects(tools.call('save_generator',{intendedRevision:before.revision}),code('UNSUPPORTED_INTERFACE'));});
test('independent public saved-source reader verifies complete binary and empty bytes without credentials',async()=>{const {SavedSourceReader}=await import('../../apps/userscript/src/lifecycle.js');let calls=0;const identity={generatorId:'123',slug:'old-name',draftId:''};const fetcher:typeof fetch=async(input,init)=>{calls++;assert.equal(init?.credentials,'omit');assert.equal(init?.redirect,'error');const url=String(input);if(url.startsWith('https://perchance.org/'))return Response.json({status:'success',generator:{id:123,name:'old-name',modelText:'pjs',outputTemplate:'html',srcManifest:{'empty.bin':{key:'empty',size:0},'binary.bin':{key:'binary',size:3}}}});return new Response(url.endsWith('/empty')?new Uint8Array():new Uint8Array([0,255,128]));};const result=await new SavedSourceReader(fetcher).read('old-name',identity);assert.deepEqual([...result.files['src/binary.bin']!],[0,255,128]);assert.equal(result.files['src/empty.bin']!.length,0);assert.equal(calls,4);});
test('saved-source reader rejects empty-byte provider anomaly, absent manifest and source revision drift',async()=>{const {SavedSourceReader}=await import('../../apps/userscript/src/lifecycle.js');const identity={generatorId:'123',slug:'old-name',draftId:''};const base={id:123,name:'old-name',modelText:'pjs',outputTemplate:'html'};const malformed:typeof fetch=async(input)=>String(input).includes('/api/')?Response.json({status:'success',generator:{...base,srcManifest:{'empty.bin':{key:'empty',size:0}}}}):new Response(new Uint8Array([1]));await assert.rejects(new SavedSourceReader(malformed).read('old-name',identity),code('PROVIDER_REJECTED'));await assert.rejects(new SavedSourceReader(async()=>Response.json({status:'success',generator:base})).read('old-name',identity),code('UNSUPPORTED_INTERFACE'));let reads=0;await assert.rejects(new SavedSourceReader(async()=>Response.json({status:'success',generator:{...base,modelText:++reads===1?'old':'new',srcManifest:{}}})).read('old-name',identity),code('STALE_REVISION'));});
test('actual native duplicate draft override cannot duplicate unintended unsaved source',async()=>{const f=fixture();f.page.modelTextEditor.getValue=()=> 'unsaved owner draft';const ctx=await f.context('duplicate_generator',{});await assert.rejects(f.lifecycle.call('duplicate_generator',{},ctx),code('UNSUPPORTED_INTERFACE'));assert.equal(f.getCalls(),0);});
test('current native duplicate auto-name status link is only a hint before complete readback',async()=>{const f=fixture();const dom=new JSDOM('<div id="status"></div>');const status=dom.window.document.querySelector('#status')!;Object.assign(f.settings.refs,{duplicateGeneratorStatus:status});const original=f.settings.duplicateGenerator;(f.settings as unknown as {duplicateGenerator:()=>Promise<unknown>}).duplicateGenerator=async()=>{await original();status.innerHTML='<a href="/new-copy#edit">new-copy</a>';};const result=await f.lifecycle.call('duplicate_generator',{},await f.context('duplicate_generator',{}));assert.equal(result.status,'SUCCEEDED');assert.equal(result.data?.slug,'new-copy');assert.equal(result.data?.generatorId,'456');});


test('HAR-shaped public version attests actual Listing state without private credentials',async()=>{
 const f=fixture();const calls:{url:string;method:string;credentials:string|undefined;body?:string}[]=[];
 const fetcher=(async(url:string|URL|Request,init?:RequestInit)=>{
   const value=String(url);
   calls.push({url:value,method:init?.method??'GET',credentials:init?.credentials,body:typeof init?.body==='string'?init.body:undefined});
   if(value.includes('generatorPageDataVersion/old-name'))
     return Response.json({status:'success',id:'123',saveCount:5,isPrivate:true,schema:2});
   if(value.endsWith('/api/getGeneratorPageData'))
     return Response.json({status:'success',generator:{id:'123',name:'old-name',
       modelText:'output = inert',outputTemplate:'<h1>inert</h1>',srcManifest:{}}});
   throw new Error('Unexpected endpoint: '+value);
 }) as typeof fetch;
 const reader=new LiveLifecycleReadback(f.adapter,fetcher);
 const result=await reader.readGenerator('old-name');
 assert.equal(result.owned,true);
 assert.equal(result.listing,'unlisted');
 assert.equal(result.identity.generatorId,'123');
 assert.deepEqual(Object.keys(result.files).sort(),['index.html','main.pjs']);
 assert.ok(calls.every(c=>c.credentials==='omit' && !/sessionToken|email|password/.test(c.body??'')));
 assert.equal(calls.filter(c=>c.method==='POST').length,2);
 assert.equal(calls.filter(c=>c.method==='GET').length,1);
 const readback=(async(url:string|URL|Request,init?:RequestInit)=>{
   if(String(url).includes('generatorPageDataVersion'))
     return Response.json({status:'success',id:'different-id',isPrivate:false});
   return fetcher(url,init);
 }) as typeof fetch;
 await assert.rejects(new LiveLifecycleReadback(f.adapter,readback).readGenerator('old-name'),code('NATIVE_CONFLICT'));
 f.page.userOwnsThisGenerator=false;
 await assert.rejects(reader.readGenerator('old-name'),code('SCOPE_DENIED'));
});

test('listing menu created asynchronously is awaited before native click and verified once',async()=>{
 const f=fixture();
 f.page.document.querySelector('#listingMenuEl')!.remove();
 let nativeClicks=0;
 f.page.app.openListingMenu=async()=>{
   setTimeout(()=>{
     const menu=f.page.document.createElement('div');menu.id='listingMenuEl';
     const button=f.page.document.createElement('button');button.dataset.value='unlisted';
     button.addEventListener('click',()=>{nativeClicks++;f.saved.get('old-name')!.listing='unlisted';});
     menu.appendChild(button);f.page.document.body.appendChild(menu);
   },70);
 };
 const args={listing:'unlisted'};
 const result=await f.lifecycle.call('set_listing',args,await f.context('set_listing',args));
 assert.equal(result.status,'SUCCEEDED');
 assert.equal(result.data?.listing,'unlisted');
 assert.equal(nativeClicks,1);
});

test('rename waits for lazily loaded settings; no second rename when result is pending',async()=>{
 const f=fixture();
 const settings=f.settings;
 (f.page as unknown as Record<string,unknown>).settingsModal=undefined;
 f.page.app.openSettingsModal=async()=>{
   setTimeout(()=>{(f.page as unknown as Record<string,unknown>).settingsModal=settings;},60);
 };
 const args={newName:'new-slug'};
 const result=await f.lifecycle.call('rename_generator',args,await f.context('rename_generator',args));
 assert.equal(result.status,'SUCCEEDED');
 assert.equal(f.getCalls(),1);
});
test('listing readback convergence retries only reads, never another native click',async()=>{
 const f=fixture();let reads=0;const original=f.readback.readGenerator;
 f.readback.readGenerator=async slug=>{
  const result=await original(slug);if(++reads>=2 && reads<=3)return {...result,listing:'listed'};
  return result;
 };
 const args={listing:'unlisted'};
 const value=await f.lifecycle.call('set_listing',args,await f.context('set_listing',args));
 assert.equal(value.status,'SUCCEEDED');assert.equal(f.getCalls(),1);
 assert.ok(reads>=4);
});
