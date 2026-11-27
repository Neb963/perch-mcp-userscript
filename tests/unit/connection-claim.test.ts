import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserController } from '../../apps/userscript/src/controller.js';
import { GatewayTransport, TransportError } from '../../apps/userscript/src/transport.js';
import { MemoryStore } from '../../apps/userscript/src/storage.js';
import { NativeAdapter } from '../../apps/userscript/src/adapter.js';

const identity={generatorId:'g',slug:'fixture',draftId:'d'};
const binding={...identity,browserInstallationId:'browser'};
function fixture(ready=true){
 const states:{connection:string;workspace?:string;reason?:string}[]=[];
 const paths:string[]=[];
 let probeReady=ready;
 const adapter={probe:async()=>({ready:probeReady,identity:probeReady?identity:undefined,dirty:false}),bind:()=>undefined} as unknown as NativeAdapter;
 const transport={
  configuration:()=>({paired:true,origin:'https://gateway.test'}),
  installationId:async()=> 'browser',
  tab:async(path:string)=>{paths.push(path);return {};},
  request:async()=>({items:[],revision:1}),
 } as unknown as GatewayTransport;
 const controller=new BrowserController(adapter,new MemoryStore(),transport,undefined,state=>states.push(state));
 return {controller,transport,states,paths,workspace:{id:'w',binding},setReady:(v:boolean)=>probeReady=v};
}
test('native preflight failure never becomes a phantom operator Pause and never claims',async()=>{
 const f=fixture(false);
 await assert.rejects(f.controller.attach(f.workspace),e=>
   !!e&&typeof e==='object'&&'code'in e&&e.code==='NATIVE_EDITOR_NOT_READY');
 const status=f.controller.diagnostics();
 assert.equal(status.connection,'offline');
 assert.equal(status.workspaceId,'w');
 assert.equal(status.failureStage,'NATIVE_EDITOR');
 assert.equal(status.attachFailureCode,'NATIVE_EDITOR_NOT_READY');
 assert.deepEqual(f.paths,[]);
 assert.ok(f.states.every(s=>s.connection!=='paused'));
});
test('mismatched binding rejects before any lease effect and displays intended Workspace',async()=>{
 const f=fixture();
 await assert.rejects(f.controller.attach({id:'w',binding:{...binding,slug:'other'}}),e=>
   !!e&&typeof e==='object'&&'code'in e&&e.code==='BINDING_MISMATCH');
 assert.equal(f.controller.diagnostics().connection,'blocked');
 assert.equal(f.controller.diagnostics().workspaceId,'w');
 assert.equal(f.controller.diagnostics().failureStage,'NATIVE_EDITOR');
 assert.deepEqual(f.paths,[]);
});
test('Gateway claim rejection reports precise stage and does not masquerade as Stop',async()=>{
 const f=fixture();
 f.transport.tab=async(path:string)=>{f.paths.push(path);throw new TransportError('PAUSED','Workspace paused',403);};
 await assert.rejects(f.controller.attach(f.workspace),e=>
   !!e&&typeof e==='object'&&'code'in e&&e.code==='PAUSED');
 assert.equal(f.controller.diagnostics().connection,'blocked');
 assert.equal(f.controller.diagnostics().failureStage,'GATEWAY_CLAIM');
 assert.equal(f.controller.diagnostics().attachFailureCode,'PAUSED');
 assert.deepEqual(f.paths,['/api/v1/tab/claim']);
});
test('Stop during an in-flight claim fences late lease and releases it without reconnecting',async()=>{
 const f=fixture();
 let ready!: (value:unknown)=>void,started!:()=>void;
 const observed=new Promise<void>(resolve=>{started=resolve;});
 const claim=new Promise<unknown>(resolve=>{ready=resolve;});
 const releases:{credential:string|undefined;body:unknown}[]=[];
 f.transport.tab=async(path,body,credential)=>{
  f.paths.push(path);
  if(path==='/api/v1/tab/claim'){started();return claim;}
  if(path==='/api/v1/tab/release'){releases.push({credential,body});return {ok:true};}
  throw new Error('Unexpected transport call');
 };
 const connecting=f.controller.attach(f.workspace);
 await observed;
 await f.controller.pause();
 ready({workspaceId:'w',epoch:1,bindingRevision:2,tabInstanceId:f.controller.tabInstanceId,
   leaseCredential:'late-secret',expiresAt:Date.now()+120000,permissions:['READ_SOURCE']});
 await connecting;
 assert.equal(f.controller.diagnostics().connection,'paused');
 assert.equal(f.controller.diagnostics().leasePresent,false);
 assert.equal(releases.length,1);
 assert.equal(releases[0]!.credential,'late-secret');
});
