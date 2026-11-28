import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createNativePreviewBridge,NativeProtocolPreviewBridge,PreviewAdapter,type PreviewReceipt} from '../../apps/userscript/src/preview.js';
import {ExecutionError} from '../../apps/userscript/src/compute.js';

const publicId='b95e4473dace29730b4433ad33b4c64c';
async function hash(value:unknown){return Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)))).toString('hex')}
async function fixture(){
 const dom=new JSDOM(`<iframe src="https://${publicId}.perchance.org/minimal"></iframe>`,{url:'https://perchance.org/minimal#edit'});
 const frame=dom.window.document.querySelector('iframe')! as unknown as HTMLIFrameElement;
 const stamp={revision:await hash(['minimal','animal\n  otter','<p>hello</p>']),srcRevision:await hash([['asset.png','abc.png']]),epoch:1,srcHasPending:false,srcChangedDuringRender:false};
 let revision='r1',generation:string|null=null,preambleRan=false,onUser:(()=>void)|undefined;
 const requests:Record<string,unknown>[]=[];
 const page:Record<string,unknown>={generatorPublicId:publicId,app:{data:{generator:{name:'minimal'}}},modelTextEditor:{getValue:()=> 'animal\n  otter'},outputTemplateEditor:{getValue:()=>'<p>hello</p>'},srcState:{manifestForIframe:()=>({'asset.png':{key:'abc.png'}}),hasPending:()=>false}};
 page.hardReloadOutputIframe=async()=>{const preamble=String(page.__aiAgentPreambleJs);generation=/generation:"([^"]+)"/.exec(preamble)?.[1]??null;preambleRan=true;stamp.epoch++;};
 const emit=(request:Record<string,unknown>,result:unknown,override:Record<string,unknown>={})=>dom.window.dispatchEvent(new dom.window.MessageEvent('message',{source:frame.contentWindow as unknown as Window,origin:`https://${publicId}.perchance.org`,data:{type:'evaluateJsResponse',callerId:request.callerId,result,error:null},...override}));
 frame.contentWindow!.postMessage=((request:Record<string,unknown>,origin:string)=>{requests.push(request);assert.equal(origin,`https://${publicId}.perchance.org`);const diagnostic=String(request.js).startsWith('return (() => { const p=document.__perchanceInternal');
   queueMicrotask(()=>{if(!diagnostic)onUser?.();const result=diagnostic?{receipt:{...stamp},generation,consoleOutput:['log: fixture'],errors:[],warnings:[],preambleRan}:42;
    emit(request,'forged',{origin:'https://evil.invalid'});emit(request,'forged',{source:null});emit({...request,callerId:'wrong'},'forged');emit(request,result);
   });}) as Window['postMessage'];
 const options={host:dom.window as unknown as Window,frame:()=>frame,revision:async()=>revision};
 const bridge=createNativePreviewBridge(page,options)!;
 return{dom,frame,page,stamp,requests,bridge,setRevision:(r:string)=>{revision=r},onUser:(fn:()=>void)=>{onUser=fn}};
}

test('actual native evaluateJs wire format maps results and rejects forged replies',async()=>{
 const f=await fixture();
 const result=await f.bridge.evaluate('return 42;',1000);
 assert.equal(result.result,42);
 assert.ok(f.requests.every(r=>r.command==='evaluateJs'&&typeof r.callerId==='string'&&r.callerId.startsWith('perch-')));
 assert.equal(result.diagnosticsAvailability?.syntax,'unavailable');
});

test('actual native hard reload installs one-load preamble, verifies panel/src hashes and restores hook',async()=>{
 const f=await fixture();
 const receipt=await f.bridge.refresh('window.fixturePreamble=true;');
 assert.equal(receipt.appliedRevision,'r1');assert.match(receipt.previewGeneration!,/^[0-9a-f-]+:2$/);
 assert.equal(Object.hasOwn(f.page,'__aiAgentPreambleJs'),false);
 assert.equal((await f.bridge.evaluate('return 42;',1000)).previewGeneration,receipt.previewGeneration);
});

test('native startup manifest mismatch or changed source cannot masquerade as current preview',async()=>{
 const f=await fixture();f.stamp.srcRevision='0'.repeat(64);
 await assert.rejects(f.bridge.refresh(),(e:ExecutionError)=>e.code==='NATIVE_CONFLICT'&&e.effectState==='PARTIAL');
 assert.equal(Object.hasOwn(f.page,'__aiAgentPreambleJs'),false);
 const second=await fixture();const original=second.page.hardReloadOutputIframe as ()=>Promise<void>;second.page.hardReloadOutputIframe=async()=>{await original();second.setRevision('r2')};
 await assert.rejects(second.bridge.refresh(),(e:ExecutionError)=>e.code==='NATIVE_CONFLICT');
});

test('native preamble ownership and reload concurrency block without replacing existing hooks',async()=>{
 const f=await fixture();f.page.__aiAgentPreambleJs='owner code';
 await assert.rejects(f.bridge.refresh(),(e:ExecutionError)=>e.code==='TAB_BUSY');assert.equal(f.page.__aiAgentPreambleJs,'owner code');
 delete f.page.__aiAgentPreambleJs;f.page.currentlyReloadingOutputIframePromise=Promise.resolve();
 await assert.rejects(f.bridge.refresh(),(e:ExecutionError)=>e.code==='TAB_BUSY');
});

test('a trusted DOM frame reload fences a pending native evaluation',async()=>{
 const f=await fixture();await f.bridge.refresh();
 f.onUser(()=>f.frame.dispatchEvent(new f.dom.window.Event('load')));
 await assert.rejects(f.bridge.evaluate('return 42;',1000),(e:ExecutionError)=>e.code==='STALE_EPOCH'&&e.effectState==='UNKNOWN');
});

test('native frame Public ID mismatch denies requests before dispatch',async()=>{
 const f=await fixture();f.page.generatorPublicId='0'.repeat(32);
 await assert.rejects(f.bridge.evaluate('return 42;',1000),(e:ExecutionError)=>e.code==='BINDING_MISMATCH');assert.equal(f.requests.length,0);
});

test('F04 native preview rechecks the deadline after diagnostics and before user evaluation', async () => {
 const f = await fixture();
 const abort = new AbortController();
 let dispatched = false;
 try {
  await assert.rejects(f.bridge.evaluate('return 42;', 1000, {
   signal: abort.signal,
   assertCurrent: async () => {
    assert.equal(f.requests.length, 1, 'the inert diagnostic request completed');
    throw new ExecutionError('TIMEOUT', 'Synthetic expired operation');
   },
   onDispatch: () => { dispatched = true; },
  }), (error: ExecutionError) => error.code === 'TIMEOUT' && error.effectState === 'NONE');
  assert.equal(dispatched, false);
  assert.equal(f.requests.length, 1);
 } finally { f.dom.window.close(); }
});

test('F04 cancelling preview observation after native dispatch preserves unknown effects', async () => {
 const f = await fixture();
 const abort = new AbortController();
 let dispatched = false;
 try {
  f.onUser(() => { assert.equal(dispatched, true); abort.abort(); });
  await assert.rejects(f.bridge.evaluate('return 42;', 1000, {
   signal: abort.signal, assertCurrent: async () => {},
   onDispatch: () => { dispatched = true; },
  }), (error: ExecutionError) => error.code === 'CANCELLED' && error.effectState === 'UNKNOWN');
  assert.equal(f.requests.filter(request => request.js === 'return 42;').length, 1);
 } finally { f.dom.window.close(); }
});

test('PreviewAdapter attests native evaluateJs with exact source/origin/caller ID before enabling page_eval',async()=>{
 const f=await fixture();
 const adapter=new PreviewAdapter({
  frame:()=>f.frame,revision:async()=> 'r1',bridge:f.bridge,verified:{},
 });
 assert.equal(adapter.availability().page_eval?.available,false);
 const evaluated=await adapter.call('page_eval',{js:'return 6 * 7;',timeoutMs:2000}) as
  {result:number;pageFreshnessUnknown:boolean;diagnosticsAvailability:Record<string,string>};
 assert.equal(evaluated.result,42);
 assert.equal(evaluated.pageFreshnessUnknown,true,'evaluation without native refresh must not claim current source');
 assert.equal(adapter.availability().page_eval?.available,true);
 assert.equal(f.requests.filter(r=>r.js==='return 6 * 7;').length,2,'inert handshake and user evaluation both use exact native protocol');
 const original=f.page.generatorPublicId;
 f.page.generatorPublicId='0'.repeat(32);
 await assert.rejects(adapter.call('page_eval',{js:'return 42;',timeoutMs:2000}),
   (e:ExecutionError)=>e.code==='BINDING_MISMATCH');
 f.page.generatorPublicId=original;
});
test('PreviewAdapter native refresh attests panel/manifest receipts and makes console/error scope explicit',async()=>{
 const f=await fixture();
 const adapter=new PreviewAdapter({
  frame:()=>f.frame,revision:async()=> 'r1',bridge:f.bridge,verified:{},
 });
 const refreshed=await adapter.call('page_refresh',{}) as
  {previewRevision:string;pageFreshnessUnknown:boolean;diagnosticsAvailability:Record<string,string>};
 assert.equal(refreshed.previewRevision,'r1');
 assert.equal(refreshed.pageFreshnessUnknown,false);
 const receipt=await adapter.call('preview_diagnostics',{}) as {
  previewRevision:string;diagnosticScope:Record<string,boolean>;
  diagnosticsAvailability:Record<string,string>;
 };
 assert.equal(receipt.previewRevision,'r1');
 assert.equal(receipt.diagnosticScope.syntaxErrorsUnavailable,true);
 const readiness=(receipt as unknown as {nativeReadiness:Record<string,boolean>}).nativeReadiness;
 assert.equal(readiness.exactFrameOrigin,true);
 assert.equal(readiness.nativeManifestAvailable,true);
 assert.equal(readiness.nativeHardReloadAvailable,true);
 assert.ok(Object.values(readiness).every(value=>typeof value==='boolean'));
 assert.ok(!JSON.stringify(readiness).includes(publicId));
 assert.equal(receipt.diagnosticScope.consoleCaptureRequiresInstrumentedRefresh,false);
 assert.equal(receipt.diagnosticsAvailability.console,'captured');
});
test('preview does not enable runtime evaluation without an attested native frame',async()=>{
 const adapter=new PreviewAdapter({
  frame:()=>null, revision:async()=> 'r1',
  verified:{},bridge:undefined,
 });
 await assert.rejects(adapter.call('page_eval',{js:'return 42;',timeoutMs:1000}),
  (e:ExecutionError)=>e.code==='UNSUPPORTED_INTERFACE');
 assert.equal(adapter.availability().page_eval?.available,false);
});

test('native editor syntax collector retains channel provenance and refuses false source-line attestation',async()=>{
 const f=await fixture();
 f.page.getEditorSyntaxErrors=()=>[
  {type:'model',line:12,column:3,message:'Known fixture indentation error'},
  {type:'output',line:4,column:7,message:'Known HTML fixture parse error'}
 ];
 const receipt=await f.bridge.diagnostics!() as PreviewReceipt;
 assert.equal(receipt.syntaxErrors.length,2);
 assert.equal((receipt.syntaxErrors[0] as Record<string,unknown>).path,'main.pjs');
 assert.equal((receipt.syntaxErrors[1] as Record<string,unknown>).path,'index.html');
 assert.equal((receipt.syntaxErrors[0] as Record<string,unknown>).locationVerified,false);
 assert.equal(receipt.diagnosticsAvailability?.syntax,'captured');
 assert.equal(receipt.diagnosticChannels?.editorSyntax,'captured');
 assert.equal(receipt.diagnosticChannels?.console,'preview-iframe');
});
test('empty native syntax result reports partial rather than verified error-free',async()=>{
 const f=await fixture();
 f.page.getEditorSyntaxErrors=()=>[];
 const receipt=await f.bridge.diagnostics!() as PreviewReceipt;
 assert.deepEqual(receipt.syntaxErrors,[]);
 assert.equal(receipt.diagnosticsAvailability?.syntax,'partial');
 f.page.getEditorSyntaxErrors=()=>[{message:'native error without a location'}];
 const partial=await f.bridge.diagnostics!() as PreviewReceipt;
 assert.equal(partial.diagnosticsAvailability?.syntax,'partial');
 assert.equal((partial.syntaxErrors[0] as Record<string,unknown>).line,null);
});

test('grouped native syntax arrays preserve pane hints and partial coverage',async()=>{
 const f=await fixture();
 f.page.getEditorSyntaxErrors=()=>({
  modelText:[{message:'fixture',line:12,column:2}],
  outputTemplate:['unlocated fixture'],
 });
 const receipt=await f.bridge.diagnostics!();
 assert.equal(receipt.syntaxErrors.length,2);
 assert.equal((receipt.syntaxErrors[0] as Record<string,unknown>).path,'main.pjs');
 assert.equal((receipt.syntaxErrors[1] as Record<string,unknown>).path,'index.html');
 assert.equal(receipt.diagnosticsAvailability?.syntax,'partial');
 assert.equal(receipt.diagnosticChannels?.editorSyntaxShape,'grouped-arrays');
 f.dom.window.close();
});
test('native syntax unknown object cannot claim a clean or captured result',async()=>{
 const f=await fixture();
 f.page.getEditorSyntaxErrors=()=>({unknown:{secret:'fixture-secret'}});
 const receipt=await f.bridge.diagnostics!();
 assert.equal(receipt.diagnosticsAvailability?.syntax,'unavailable');
 assert.equal(receipt.diagnosticChannels?.editorSyntaxShape,'object');
 assert.doesNotMatch(JSON.stringify(receipt),/fixture-secret/);
 f.dom.window.close();
});


test('preview capability probes are cached for the same loaded frame and invalidated on reload',async()=>{
 const f=await fixture();
 const attest=f.bridge.attest!.bind(f.bridge);
 let probes=0;
 const bridge={...f.bridge,attest:async(kind:'evaluate'|'refresh'|'preamble')=>{probes++;return attest(kind);}};
 // spread loses prototype methods: supply the required native bridge explicitly.
 const adapter=new PreviewAdapter({frame:()=>f.frame,revision:async()=> 'r1',
  bridge:{attest:bridge.attest,refresh:(p)=>f.bridge.refresh(p),
   evaluate:(js,ms)=>f.bridge.evaluate(js,ms),diagnostics:()=>f.bridge.diagnostics!()},verified:{}});
 await adapter.preflight();
 assert.equal(probes,2);
 await adapter.call('page_eval',{js:'return 6 * 7;',timeoutMs:2000});
 await adapter.call('page_eval',{js:'return 6 * 7;',timeoutMs:2000});
 assert.equal(probes,2,'a successful frame-bound handshake is not repeated on each call');
 f.frame.dispatchEvent(new f.dom.window.Event('load'));
 await adapter.call('page_eval',{js:'return 6 * 7;',timeoutMs:2000});
 assert.equal(probes,3,'iframe load invalidates native trust');
});

test('temporary viewport sizing self-restores after inactivity and on failed verification',async()=>{
 const f=await fixture();
 const original=f.frame.getAttribute('style');
 const bridge={attest:async()=>true,
  refresh:(p:string|undefined)=>f.bridge.refresh(p),
  evaluate:(js:string,ms:number)=>f.bridge.evaluate(js,ms),
  measureViewport:async()=>({width:parseInt(f.frame.style.width,10)||640,
    height:parseInt(f.frame.style.height,10)||480})};
 const adapter=new PreviewAdapter({frame:()=>f.frame,revision:async()=> 'r1',bridge,verified:{}});
 (adapter as unknown as {viewportIdleMs:number}).viewportIdleMs=35;
 const receipt=await adapter.call('set_viewport_size',{width:390,height:844}) as Record<string,unknown>;
 assert.equal(receipt.emulationActive,true);
 assert.equal(receipt.autoResetAfterIdleMs,35);
 assert.equal(f.frame.style.width,'390px');
 await new Promise<void>(r=>setTimeout(r,90));
 assert.equal(f.frame.getAttribute('style'),original,'the human editor must not remain shrunken');
 // No hidden/unknown state claimed as a successful resize.
 const broken=new PreviewAdapter({frame:()=>f.frame,revision:async()=> 'r1',
  bridge:{...bridge,measureViewport:async()=>{throw Error('native measurement unavailable')}}});
 await assert.rejects(broken.call('set_viewport_size',{width:390,height:844}));
 assert.equal(f.frame.getAttribute('style'),original,'failed viewport verification must restore CSS');
});
