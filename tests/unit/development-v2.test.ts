import assert from 'node:assert/strict';
import test from 'node:test';
import { developmentToolDefinitions, parseDevelopmentCall } from '../../packages/contracts/src/development-v2.js';
import { ToolError } from '../../packages/contracts/src/errors.js';
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

test('S03-002/003/004/005/006: malformed standalone requests fail before admission; valid Unicode and bytes pass', () => {
  const target = 'w2.workspace.1.1', operationKey = 'k2.' + Date.now() + '.' + crypto.randomUUID();
  const write = (content: string, encoding: 'utf8' | 'base64' = 'utf8', path = 'scratch/new') =>
    parseDevelopmentCall('write', {target, operationKey,
      files: [{path, encoding, content, ifAbsent: true}]});
  const invalid = (fn: () => unknown, code: string = 'INVALID_INPUT') =>
    assert.throws(fn, (error: unknown) => error instanceof ToolError && error.code === code);
  invalid(() => parseDevelopmentCall('read', {target, files: [{path: 'main.pjs'}], unrelated: 1}));
  invalid(() => parseDevelopmentCall('set_viewport_size', {
    target, operationKey, reset: true, width: 400, height: 300}));
  invalid(() => parseDevelopmentCall('capture_page_image', {target, format: 'gif'}));
  invalid(() => parseDevelopmentCall('read', {target, files: [{path: 'main.pjs', encoding: 'latin1'}]}));
  for (const text of ['\uD800', '\uDC00', 'valid\uD800invalid']) {
    invalid(() => write(text));
    invalid(() => parseDevelopmentCall('execute_js', {target, js: text, access: {}}));
    invalid(() => parseDevelopmentCall('batch', {target, operationKey,
      actions: [{tool: 'write', args: {files: [{path: 'scratch/new', encoding: 'utf8', content: text, ifAbsent: true}]}}]}));
  }
  const emoji = 'source 😀 stable';
  assert.equal((write(emoji).args.files as {content: string}[])[0]?.content, emoji);
  assert.equal((write('', 'base64').args.files as {content: string}[])[0]?.content, '');
  assert.equal((write('8J+YgA==', 'base64').args.files as {content: string}[])[0]?.content, '8J+YgA==');
  for (const bad of ['!', 'AAA', 'AB==', 'A===', 'A=AA', 'AA A']) invalid(() => write(bad, 'base64'));
  invalid(() => write('/w==', 'base64', 'index.html'));
  const transferId = '550e8400-e29b-41d4-a716-446655440000';
  for (const bad of ['!!AA', 'AAA', 'AB==']) invalid(() =>
    parseDevelopmentCall('write', {target, operationKey, mode: 'chunk', transferId, offset: 0, data: bad}));
  assert.equal((parseDevelopmentCall('write', {target, operationKey, mode: 'chunk', transferId,
    offset: 0, data: 'AAAA'}).args.data), 'AAAA');
  invalid(() => parseDevelopmentCall('write', {target, operationKey, files: [
    {path: 'scratch/A', encoding: 'utf8', content: 'a', ifAbsent: true},
    {path: 'scratch/a', encoding: 'utf8', content: 'b', ifAbsent: true},
  ]}), 'PATH_DENIED');
  invalid(() => parseDevelopmentCall('delete', {target, operationKey,
    paths: [{path: 'scratch/existing'}]}));
  invalid(() => parseDevelopmentCall('rename', {target, operationKey,
    moves: [{from: 'scratch/existing', to: 'src/moved', destination: 'absent', ifSha256: 'a'.repeat(64)}]}), 'PATH_DENIED');
});


test('S03-007/008 admission rejects excessive nesting and UTF-8 serialized bytes before durable effects', () => {
  const target = 'w2.workspace.1.1', operationKey='k2.'+Date.now()+'.'+crypto.randomUUID();
  const write=(content:string)=>parseDevelopmentCall('write',{target,operationKey,
    files:[{path:'scratch/budget.txt',encoding:'utf8',content,ifAbsent:true}]});
  const rejected=(fn:()=>unknown)=>
    assert.throws(fn,(error:unknown)=>error instanceof ToolError && error.code==='LIMIT_EXCEEDED');
  let tooDeep:unknown='leaf';
  for(let i=0;i<18;i++) tooDeep={nested:tooDeep};
  rejected(()=>parseDevelopmentCall('read',{target,files:[{path:'main.pjs'}],unrelated:tooDeep}));
  rejected(()=>parseDevelopmentCall('workspace_status',{target,unrelated:tooDeep}));
  const tooMany=Array.from({length:16_385},()=>0);
  rejected(()=>parseDevelopmentCall('read',{target,files:[{path:'main.pjs'}],unrelated:tooMany}));
  // Schema permits 512 KiB for an individual input field, but the wire
  // reserves bytes for the authenticated envelope and result metadata.
  rejected(()=>write('x'.repeat(512*1024)));
  assert.equal(write('x'.repeat(200_000)).name,'write');
  assert.equal(parseDevelopmentCall('read',{target,files:[{path:'main.pjs'}]}).name,'read');
});

test('S03-009 browser revalidates admitted standalone mutations before any effect',async()=>{
  const file={path:'scratch/revalidated.txt',encoding:'utf8' as const,content:'safe',ifAbsent:true as const};
  const f=await fixture('write',{files:[file]});
  const before=(await f.vfs.localView()).files.map(row=>row.path);
  const denied=async(args:Record<string,unknown>,code?:string)=>{
    f.context.envelope.args=args;
    await assert.rejects(executeDevelopment(f.context),
      (error:unknown)=>error instanceof BrowserError&&(!code||error.code===code));
    assert.deepEqual((await f.vfs.localView()).files.map(row=>row.path),before);
    assert.deepEqual(f.permits,[],'Invalid admitted work must not acquire a publication permit');
  };
  await denied({files:[file,{...file,content:'duplicate'}]},'PATH_DENIED');
  await denied({files:[{...file,content:'AA A',encoding:'base64'}]});
  await denied({files:[file],target:'w2.other.1.1'},'INVALID_INPUT');
  await denied({files:[file],operationKey:'k2.malformed'},'INVALID_INPUT');
  await denied({files:[file],unrecognized:true},'INVALID_INPUT');
  f.context.envelope.args={files:[file]};
  f.context.envelope.permissions=['READ_SOURCE'];
  await assert.rejects(executeDevelopment(f.context),
    (error:unknown)=>error instanceof BrowserError&&error.code==='SCOPE_DENIED');
  assert.deepEqual(f.permits,[]);
  f.context.envelope.permissions=['READ_SOURCE','WRITE_SOURCE'];
  const result=await executeDevelopment(f.context);
  assert.ok(result);
  assert.deepEqual(f.permits,['source-publication']);
  assert.equal(new TextDecoder().decode(await (await f.vfs.localView()).read(file.path)),'safe');
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

test('F09 directory-scoped compute lists metadata and hydrates only requested native bytes', async () => {
  const files = new Map(Array.from({length:100},(_,i) => ['src/file-'+i+'.txt', new Uint8Array([65+i%26])] as const));
  const f = await fixture('execute_js', {
    js: 'const paths=await fs.list("src"); let count=0; for(let i=0;i<100;i++) if(await fs.readTextFile("src/file-0.txt")==="A") count++; return {listed:paths.length,count};',
    access:{read:['src/'],maxReads:101},
  });
  const reads:string[][]=[];
  const adapter=f.vfs.adapter as unknown as Record<string,unknown>;
  adapter.listSourceMetadata=async()=>[
    {path:'main.pjs',bytes:null,sha256:null},
    {path:'index.html',bytes:null,sha256:null},
    ...[...files.keys()].map(path=>({path,bytes:1,sha256:null})),
  ];
  adapter.readSourceView=async(paths:string[],prefixes:string[])=>{
    assert.deepEqual(prefixes,[],'Directory permissions must not hydrate all matching source');
    reads.push(paths.slice());
    return new Map(paths.map(path=>[path,files.get(path)?.slice()??null]));
  };
  const result=await executeDevelopment(f.context,{execute:executeCompute}) as {result:unknown};
  assert.deepEqual(result.result,{listed:100,count:100});
  assert.deepEqual(reads,[['src/file-0.txt']]);
  assert.deepEqual(f.permits,['read-view']);
});

test('F09 lazy native read invalidates the view after a same-size edit to a previously selected file', async () => {
  const f=await fixture('execute_js',{
    js:'await fs.readTextFile("src/a.txt"); await fs.readTextFile("src/b.txt"); return "unexpected";',
    access:{read:['src/'],maxReads:3},
  });
  const files=new Map([['src/a.txt',new Uint8Array([65])],['src/b.txt',new Uint8Array([66])]]);
  const adapter=f.vfs.adapter as unknown as Record<string,unknown>;
  adapter.listSourceMetadata=async()=>[
    {path:'main.pjs',bytes:null,sha256:null},
    {path:'index.html',bytes:null,sha256:null},
    ...[...files.keys()].map(path=>({path,bytes:1,sha256:null})),
  ];
  adapter.readSourceView=async(paths:string[],prefixes:string[])=>{
    assert.deepEqual(prefixes,[]);
    if(paths.includes('src/b.txt'))files.set('src/a.txt',new Uint8Array([90]));
    return new Map(paths.map(path=>[path,files.get(path)?.slice()??null]));
  };
  await assert.rejects(executeDevelopment(f.context,{execute:executeCompute}),
    (error:unknown)=>(error as {code?:string}).code==='STALE_REVISION');
  assert.deepEqual(f.permits,['read-view']);
});

test('Invalid batch tail has zero effects. Valid batch reports partial on a failing subsequent action.', async () => {
  const first={tool:'write',args:{files:[{path:'scratch/new',encoding:'utf8',content:'safe',ifAbsent:true}]}};
  const f=await fixture('batch',{actions:[first,{tool:'read',args:{files:[{path:'../../outside'}]}}]});
  await assert.rejects(executeDevelopment(f.context),
    (error:unknown)=>error instanceof BrowserError && error.code==='INVALID_INPUT');
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

test('F12 verified public import stores bytes and a revision-pinned private receipt atomically',async()=>{
  const args={generators:[{slug:'fixture'}],timeoutMs:5000};
  const f=await fixture('fetch_generator',args);
  const source={generator:{id:42,name:'fixture',modelText:'output = fixture',
    outputTemplate:'<p>fixture</p>',srcManifest:{}}};
  let calls=0;
  const fetcher=(async(input:string|URL|Request,init?:RequestInit)=>{
    calls++;
    assert.equal(init?.credentials,'omit');
    assert.equal(init?.redirect,'error');
    assert.match(String(input),/getGeneratorPageData/);
    return Response.json(source);
  }) as typeof fetch;
  const result=await executeDevelopment(f.context,undefined,fetcher) as {
    imports:Array<{slug:string;revision:string;files:Array<{path:string;sha256:string;bytes:number}>}>};
  assert.equal(calls,4);
  assert.equal(result.imports.length,1);
  assert.equal(result.imports[0]?.slug,'fixture');
  assert.deepEqual(f.permits,['public-get','source-publication']);
  const view=await f.vfs.localView();
  const receipt=JSON.parse(new TextDecoder().decode(await view.read('imports/fixture/perch-receipt.json')));
  assert.match(receipt.snapshotId,/^[a-f0-9]{64}$/);
  assert.equal(receipt.materialization,'complete');
  assert.deepEqual(view.files.map(x=>x.path).sort(),[
    'imports/fixture/index.html','imports/fixture/main.pjs',
    'imports/fixture/perch-receipt.json',
    receipt.manifestPath,
    receipt.sourcePrefix+'index.html',receipt.sourcePrefix+'main.pjs',
    'scratch/input',
  ].sort());
  assert.deepEqual(JSON.parse(new TextDecoder().decode(await view.read(receipt.manifestPath))),receipt);
  assert.equal(receipt.revision,result.imports[0]?.revision);
  assert.deepEqual(receipt.files.map((x:{path:string})=>x.path).sort(),['index.html','main.pjs']);
  for (const row of receipt.files as Array<{path:string;sha256:string;bytes:number}>) {
    const bytes=await view.read('imports/fixture/'+row.path);
    assert.equal(bytes.length,row.bytes);
    assert.equal(await digest(bytes),row.sha256);
    assert.deepEqual(await view.read(receipt.sourcePrefix+row.path),bytes);
  }
});

test('F12 immutable snapshots retain prior public revisions while advancing only current Slug',async()=>{
  const f=await fixture('fetch_generator',{generators:[{slug:'fixture'}],timeoutMs:5000});
  let generation=0;
  const publicSource=(n:number)=>({generator:{id:42,name:'fixture',modelText:'output = version-'+n,
    outputTemplate:'<p>fixture</p>',srcManifest:{}}});
  const fetcher=(async()=>Response.json(publicSource(Math.floor(generation++/4)))) as typeof fetch;
  const first=await executeDevelopment(f.context,undefined,fetcher) as {imports:Array<{manifestPath:string;sourcePrefix:string;snapshotId:string}>};
  const receipt1=first.imports[0]!;
  const old=await f.vfs.localView();
  const prior=await old.read(receipt1.sourcePrefix+'main.pjs');
  assert.equal(new TextDecoder().decode(prior),'output = version-0');
  f.context.envelope.operationId='second-import';
  const next=await executeDevelopment(f.context,undefined,fetcher) as {imports:Array<{manifestPath:string;sourcePrefix:string;snapshotId:string}>};
  const receipt2=next.imports[0]!;
  assert.notEqual(receipt2.snapshotId,receipt1.snapshotId);
  const latest=await f.vfs.localView();
  assert.deepEqual(await latest.read(receipt1.sourcePrefix+'main.pjs'),prior);
  assert.equal(new TextDecoder().decode(await latest.read('imports/fixture/main.pjs')),'output = version-1');
  assert.equal(new TextDecoder().decode(await latest.read(receipt2.sourcePrefix+'main.pjs')),'output = version-1');
  assert.deepEqual(JSON.parse(new TextDecoder().decode(await latest.read(receipt1.manifestPath))).snapshotId,receipt1.snapshotId);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(await latest.read(receipt2.manifestPath))).snapshotId,receipt2.snapshotId);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(await latest.read('imports/fixture/perch-receipt.json'))).snapshotId,receipt2.snapshotId);
});

test('F12 conflicting archive bytes fail before publication and leave active receipt unchanged',async()=>{
  const f=await fixture('fetch_generator',{generators:[{slug:'fixture'}],timeoutMs:5000});
  const source={generator:{id:42,name:'fixture',modelText:'output = immutable',outputTemplate:'<p>fixture</p>',srcManifest:{}}};
  const fetcher=(async()=>Response.json(source)) as typeof fetch;
  const result=await executeDevelopment(f.context,undefined,fetcher) as {imports:Array<{sourcePrefix:string}>};
  const before=await f.vfs.localView();
  const original=await before.read('imports/fixture/perch-receipt.json');
  await assert.rejects(f.vfs.publishImportedFiles(['fixture'],{
    [result.imports[0]!.sourcePrefix+'main.pjs']:new TextEncoder().encode('output = IMMUTABLE'),
  },before.revision.value,'bad-import'),
    (error:unknown)=>(error as {code?:string}).code==='STORAGE_CORRUPT');
  const after=await f.vfs.localView();
  assert.equal(after.revision.value,before.revision.value);
  assert.deepEqual(await after.read('imports/fixture/perch-receipt.json'),original);
  assert.equal(new TextDecoder().decode(await after.read(result.imports[0]!.sourcePrefix+'main.pjs')),'output = immutable');
});

test('F12 timeout aborts verified public snapshot before any imported bytes or publication permit',async()=>{
  const args={generators:[{slug:'fixture'}],timeoutMs:80};
  const f=await fixture('fetch_generator',args);
  const pending=(async(_url:string|URL|Request,init?:RequestInit)=>new Promise<Response>((_resolve,reject)=>{
    if(init?.signal?.aborted) return reject(new Error('Aborted'));
    init?.signal?.addEventListener('abort',()=>reject(new Error('Aborted')),{once:true});
  })) as typeof fetch;
  await assert.rejects(executeDevelopment(f.context,undefined,pending),
    (error)=>(error as {code:string}).code==='TIMEOUT');
  assert.deepEqual(f.permits,['public-get']);
  assert.deepEqual((await f.vfs.localView()).files.map(x=>x.path),['scratch/input']);
});
