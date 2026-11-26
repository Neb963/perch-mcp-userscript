import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { executeCompute, createComputeWorkerClient, runComputeWorker, ExecutionError, type ComputeFileBroker, type ComputeWrite } from '../../apps/userscript/src/compute.js';
import { PreviewAdapter, createNativePreviewBridge } from '../../apps/userscript/src/preview.js';
import { fetchPublic, validatePublicFetchUrl } from '../../apps/userscript/src/public-fetch.js';

function fixture() {
  const files = new Map<string, Uint8Array>([['main.pjs', new TextEncoder().encode('hello')], ['scratch/binary', new Uint8Array([0, 255, 128])]]);
  let revision = 1;
  const broker: ComputeFileBroker = {
    revision: async () => String(revision), list: async () => [...files.keys()].sort(),
    read: async p => { const value = files.get(p); if (!value) throw new ExecutionError('INVALID_INPUT', 'Missing file.'); return value.slice(); },
    writeBatch: async (writes: ComputeWrite[], expected: string) => {
      if (expected !== String(revision)) throw new ExecutionError('STALE_REVISION', 'Manual edits changed the revision.');
      for (const write of writes) write.bytes === null ? files.delete(write.path) : files.set(write.path, write.bytes.slice());
      return { revision: String(++revision) };
    },
  };
  return { files, broker, manual: () => revision++ };
}

test('QuickJS has no ambient DOM, networking, manager or host process capabilities', async () => {
  const f = fixture();
  const result = await executeCompute({ js: 'return [typeof window,typeof document,typeof fetch,typeof XMLHttpRequest,typeof WebSocket,typeof GM_getValue,typeof process,typeof require,typeof __perchBroker];', files: f.broker });
  assert.deepEqual(result.result, Array(9).fill('undefined'));
});

test('isolated async filesystem keeps immediate staged visibility and exact binary bytes', async () => {
  const f = fixture();
  const result = await executeCompute({ js: 'const t=await fs.readTextFile("main.pjs");await fs.writeTextFile("scratch/count.txt",String(t.length)); await fs.writeFile("scratch/copy",await fs.readFile("scratch/binary")); console.log(await fs.stat("scratch/copy")); return await fs.readTextFile("scratch/count.txt");', files: f.broker });
  assert.equal(result.result, '5');
  assert.deepEqual([...f.files.get('scratch/copy')!], [0,255,128]);
  assert.deepEqual(result.filesWritten, ['scratch/copy','scratch/count.txt']);
  assert.equal(result.effects[0]?.kind, 'files');
});

test('failed compute discards staged writes and rejects traversal/import writes', async () => {
  const f = fixture();
  await assert.rejects(executeCompute({ js: 'await fs.writeTextFile("scratch/uncommitted","x");throw new Error("intentional");', files: f.broker }), (e: ExecutionError) => e.effectState === 'NONE');
  assert.equal(f.files.has('scratch/uncommitted'), false);
  for (const p of ['scratch/../main.pjs', '/main.pjs','imports/readonly']) await assert.rejects(executeCompute({ js: `await fs.writeTextFile(${JSON.stringify(p)},"no");`, files: f.broker }), /canonical|read-only/);
});

test('child tool sees flushed files; subsequent error enumerates committed partial effects', async () => {
  const f = fixture();
  await assert.rejects(executeCompute({ js: 'await fs.writeTextFile("scratch/a","staged"); await tools.page_eval({js:"return 1"}); throw new Error("later");', files: f.broker, tools: { call: async () => { assert.equal(new TextDecoder().decode(f.files.get('scratch/a')), 'staged'); return { result: 1 }; } } }), (e: ExecutionError) => e.effectState === 'PARTIAL' && e.effects.length === 2);
});

test('manual revision change rejects staged commit without overwriting', async () => {
  const f = fixture();
  const original = f.broker.read;
  f.broker.read = async p => { const b = await original(p); f.manual(); return b; };
  await assert.rejects(executeCompute({ js: 'await fs.readTextFile("main.pjs"); await fs.writeTextFile("scratch/a","x");', files: f.broker }), (e: ExecutionError) => e.code === 'STALE_REVISION');
  assert.equal(f.files.has('scratch/a'),false);
});

test('infinite loops and allocation are bounded; the next runtime remains usable', async () => {
  const f = fixture();
  await assert.rejects(executeCompute({ js: 'while(true){}', timeoutMs: 30, files: f.broker }), (e: ExecutionError) => e.code === 'TIMEOUT');
  await assert.rejects(executeCompute({ js: 'const a=[];while(true)a.push(new Uint8Array(65536));', timeoutMs: 5000, memoryLimitBytes: 1_048_576, files: f.broker }), /out of memory/);
  assert.equal((await executeCompute({ js: 'return 2+2;', files: f.broker })).result,4);
});

test('only explicitly pinned modules load without network access', async () => {
  const f = fixture();
  assert.equal((await executeCompute({ js: 'return (await import("sum@1.0.0")).sum(2,3);', modules: { 'sum@1.0.0': 'export const sum=(a,b)=>a+b' }, files: f.broker })).result,5);
  await assert.rejects(executeCompute({ js: 'return await import("https://evil.invalid/x.js");', files: f.broker }), /approved pinned/);
});

test('compute broker has no recursive or administration tool facade', async () => {
  const f = fixture();
  const value = await executeCompute({ js: 'return [typeof tools.execute_js,typeof tools.save_generator,typeof tools.revoke,typeof tools.delete_generator];',files:f.broker });
  assert.deepEqual(value.result,Array(4).fill('undefined'));
});

test('dedicated Worker protocol binds file broker and terminates each computation', async () => {
  const f = fixture(); let terminated = false;
  const client = createComputeWorkerClient('fixed source', () => {
    const endpoint = { onmessage: null as ((event: MessageEvent) => void) | null, postMessage: (message: unknown) => queueMicrotask(() => worker.onmessage?.({data:message} as MessageEvent)) };
    const worker = { onmessage: null as ((event: MessageEvent) => void) | null, onerror: null as ((event: ErrorEvent) => void) | null, postMessage: (message: unknown) => queueMicrotask(() => endpoint.onmessage?.({data:message} as MessageEvent)), terminate: () => { terminated = true; } };
    runComputeWorker(endpoint); return worker;
  });
  assert.equal((await client.execute({js:'return await fs.readTextFile("main.pjs");',files:f.broker})).result,'hello');
  assert.equal(terminated,true);
});

test('public fetch restricts exact trusted hosts and denies redirects/private addresses', async () => {
  for (const url of ['http://perchance.org/a','https://127.0.0.1/a','https://[::1]/a','https://localhost/a','https://user:pass@perchance.org/a','https://perchance.org.evil.org/a','https://perchance.org:444/a','https://perchance.org/a#fragment']) assert.throws(() => validatePublicFetchUrl(url,['perchance.org']));
  let seen: RequestInit | undefined;
  const result = await fetchPublic('https://perchance.org/data', { approvedHosts:['perchance.org'], fetchImpl: (async (_url,init) => { seen=init;return new Response(new Uint8Array([0,255,128]),{status:200,headers:{'content-type':'application/octet-stream'}}); }) as typeof fetch });
  assert.deepEqual([...result.bytes],[0,255,128]);
  assert.equal(seen?.credentials,'omit');assert.equal(seen?.redirect,'error');assert.equal(seen?.referrerPolicy,'no-referrer');
  await assert.rejects(fetchPublic('https://perchance.org/data',{approvedHosts:['perchance.org'],fetchImpl:(async()=>new Response(null,{status:302,headers:{location:'https://127.0.0.1/'}})) as typeof fetch}),/redirect/);
});

test('public fetch bounds streamed bytes and treats uncertain POST as unknown', async () => {
  const response = () => new Response(new ReadableStream({ start(c) {c.enqueue(new Uint8Array(8));c.enqueue(new Uint8Array(8));c.close();} }));
  await assert.rejects(fetchPublic('https://perchance.org/x',{approvedHosts:['perchance.org'],maxBytes:10,fetchImpl:(async()=>response()) as typeof fetch}), (e:ExecutionError)=>e.code==='LIMIT_EXCEEDED');
  await assert.rejects(fetchPublic('https://perchance.org/x',{approvedHosts:['perchance.org'],method:'POST',body:'x',allowPost:true,fetchImpl:(async()=>{throw new Error('network');}) as typeof fetch}), (e:ExecutionError)=>e.effectState==='UNKNOWN');
});

test('preview refuses activation without verified native protocol support', async () => {
  const dom = new JSDOM('<div><iframe id="p"></iframe></div>');
  const frame=dom.window.document.querySelector('iframe') as unknown as HTMLIFrameElement;
  const bridge=createNativePreviewBridge({editor:{handleReloadButtonClick:()=>undefined,evaluateText:()=>undefined}});
  assert.equal(bridge,undefined,'invented structured return contract is not used');
  const adapter=new PreviewAdapter({frame:()=>frame,revision:async()=>'r1',bridge});
  await assert.rejects(adapter.call('page_eval',{js:'return 1'}),/verified/);
});

test('preview revision/freshness, preamble, viewport/reset and frame generation are explicit', async () => {
  const dom = new JSDOM('<div><iframe id="p" style="border: 0"></iframe></div>');
  const frame=dom.window.document.querySelector('iframe') as unknown as HTMLIFrameElement;
  let revision='r1',generation='g1'; const receipt=()=>({consoleOutput:[],perchanceErrors:[],syntaxErrors:[],appliedRevision:revision,previewGeneration:generation,result:42});
  const adapter=new PreviewAdapter({frame:()=>frame,revision:async()=>revision,
    bridge:{refresh:async()=>receipt(),evaluate:async(js:string)=>js.includes('innerWidth')
      ? {...receipt(),result:{width:frame.style.width?parseInt(frame.style.width):917,
        height:frame.style.height?parseInt(frame.style.height):505}}
      : receipt()},
    verified:{refresh:true,evaluate:true}});
  await adapter.call('page_refresh',{});
  assert.deepEqual((await adapter.call('page_eval',{js:'return 42'} ) as {result:number}).result,42);
  revision='r2';assert.equal((await adapter.freshness()).pendingSrcChanges,true);
  await assert.rejects(adapter.call('page_refresh',{preambleJs:'window.x=1'}),/preamble/);
  const set=await adapter.call('set_viewport_size',{width:1024,height:768}) as {width:number;height:number};
  assert.equal(set.width,1024);assert.equal(set.height,768);
  assert.equal(frame.style.width,'1024px');
  const reset=await adapter.call('set_viewport_size',{reset:true}) as {width:number;emulationActive:boolean};
  assert.equal(frame.getAttribute('style'),'border: 0');
  assert.equal(reset.width,917);assert.equal(reset.emulationActive,false);
  generation='g2';await assert.rejects(adapter.call('page_eval',{js:'return 1'}),/document changed/);
});

test('guest cannot swallow unknown child effect and commit later writes',async()=>{
  const f=fixture();
  await assert.rejects(executeCompute({js:'try {await tools.upload_file({path:"scratch/a"})} catch {} await fs.writeTextFile("scratch/after","unsafe"); return "success";',files:f.broker,tools:{call:async()=>({status:'UNKNOWN'})}}),(e:ExecutionError)=>e.effectState==='UNKNOWN');
  assert.equal(f.files.has('scratch/after'),false);
});

test('uncertain VFS commit is reported as unknown rather than no-effect',async()=>{
  const f=fixture();f.broker.writeBatch=async()=>{throw new ExecutionError('EFFECT_UNKNOWN','Native write receipt lost.','UNKNOWN');};
  await assert.rejects(executeCompute({js:'await fs.writeTextFile("scratch/a","value");',files:f.broker}),(e:ExecutionError)=>e.effectState==='UNKNOWN' && e.effects[0]?.kind==='files');
});

test('viewport reset rejects false success when live child remains at emulated width',async()=>{
 const dom=new JSDOM('<div><iframe style="border:0"></iframe></div>');
 const frame=dom.window.document.querySelector('iframe') as unknown as HTMLIFrameElement;
 const parent=frame.parentElement!;
 Object.defineProperty(parent,'clientWidth',{get:()=>917});
 Object.defineProperty(frame,'clientWidth',{get:()=>frame.style.width?parseInt(frame.style.width):917});
 Object.defineProperty(frame,'clientHeight',{get:()=>frame.style.height?parseInt(frame.style.height):505});
 let stillEmulated=false;
 const bridge={
  refresh:async()=>({consoleOutput:[],perchanceErrors:[],syntaxErrors:[]}),
  evaluate:async(js:string)=>{
   assert.match(js,/innerWidth/);
   const emulated=frame.style.width?parseInt(frame.style.width):917;
   const natural=stillEmulated?390:emulated;
   return {consoleOutput:[],perchanceErrors:[],syntaxErrors:[],result:{
    width:natural,height:frame.style.height?parseInt(frame.style.height):505,
   }};
  },
 };
 const adapter=new PreviewAdapter({frame:()=>frame,revision:async()=> 'r1',bridge,verified:{evaluate:true}});
 const applied=await adapter.call('set_viewport_size',{width:390,height:844}) as {width:number};
 assert.equal(applied.width,390);
 stillEmulated=true;
 await assert.rejects(adapter.call('set_viewport_size',{reset:true}),
  (e:ExecutionError)=>e.code==='NATIVE_CONFLICT'&&e.effectState==='PARTIAL');
 assert.equal(frame.getAttribute('style'),'border:0',
  'reset removes only the adapter-owned CSS without damaging existing native style');
});
