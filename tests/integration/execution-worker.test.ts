import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { build } from 'esbuild';
import { createComputeWorkerClient, type ComputeFileBroker, type ExecutionError } from '../../apps/userscript/src/compute.js';

test('real dedicated Worker runs the bundled engine and timeout cannot freeze the controller', async () => {
  const built = await build({ entryPoints:['apps/userscript/src/compute-worker.ts'],bundle:true,format:'iife',platform:'browser',target:'firefox128',write:false,logLevel:'silent' });
  const source = built.outputFiles[0]!.text;
  const broker: ComputeFileBroker = { revision:async()=>'r1',read:async()=>new Uint8Array([0,255]),list:async()=>['scratch/binary'],writeBatch:async()=>({revision:'r2'}) };
  const client = createComputeWorkerClient(source, code => {
    const thread=new Worker(`const {parentPort}=require('node:worker_threads'); globalThis.fetch=()=>{throw new Error('Runtime network is forbidden')};globalThis.self={postMessage:m=>parentPort.postMessage(m),onmessage:null};parentPort.on('message',data=>self.onmessage?.({data}));\n${code}`,{eval:true});
    const adapter={onmessage:null as ((event:MessageEvent)=>void)|null,onerror:null as ((event:ErrorEvent)=>void)|null,postMessage:(message:unknown)=>thread.postMessage(message),terminate:()=>{void thread.terminate();}};
    thread.on('message',data=>adapter.onmessage?.({data} as MessageEvent));thread.on('error',()=>adapter.onerror?.({} as ErrorEvent));
    return adapter;
  });
  assert.deepEqual((await client.execute({js:'return Array.from(await fs.readFile("scratch/binary"));',files:broker})).result,[0,255]);
  let publications = 0;
  const limited = {...broker, writeBatch:async () => { publications++; return {revision:'r2'}; }};
  await assert.rejects(client.execute({
    js:'await fs.writeTextFile("scratch/staged","value"); await tools.page_eval({js:"return 1"});',
    files:limited,fileAccess:{read:[],write:['scratch/staged'],maxReads:0,maxWrites:1},
  }), (error:ExecutionError) => error.code==='SCOPE_DENIED' && error.effectState==='NONE');
  assert.equal(publications,0,'denied v2 child call must occur before flushing staged writes');
  let controllerTicks=0;
  const timer=setInterval(()=>controllerTicks++,5);
  await assert.rejects(client.execute({js:'while(true){}',timeoutMs:100,files:broker}), (error:ExecutionError)=>error.code==='TIMEOUT');
  clearInterval(timer);assert.ok(controllerTicks>=2,'parent controller remains responsive during runaway guest loop');
});
