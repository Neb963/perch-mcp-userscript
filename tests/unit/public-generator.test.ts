import test from "node:test";
import assert from "node:assert/strict";
import { readPublicGenerator } from "../../apps/userscript/src/public-generator.js";
const generator = {
  id: 42,
  name: "fixture",
  modelText: "output = test",
  outputTemplate: "[output]",
  srcManifest: {
    "empty.bin": { key: "empty", size: 0 },
    "binary.bin": { key: "binary", size: 3 },
  },
};
test("complete public snapshot verifies exact binary and zero bytes without credentials", async () => {
  const calls: RequestInit[] = [];
  const f = (async (url: string | URL | Request, init: RequestInit) => {
    calls.push(init);
    return String(url).includes("getGeneratorPageData")
      ? Response.json({ status: "success", generator })
      : new Response(
          String(url).endsWith("/empty")
            ? new Uint8Array()
            : new Uint8Array([0, 255, 1]),
        );
  }) as typeof fetch;
  const s = await readPublicGenerator("fixture", f);
  assert.equal(s.generatorId, "42");
  assert.equal(s.files["src/empty.bin"]!.length, 0);
  assert.deepEqual(s.files["src/binary.bin"], new Uint8Array([0, 255, 1]));
  assert.ok(
    calls.every((c) => c.credentials === "omit" && c.redirect === "error"),
  );
});
test("saved revision drift rejects; absent manifest is explicitly panels-only, never a complete backup", async () => {
  let n = 0;
  const f = (async (url: string | URL | Request) =>
    String(url).includes("getGeneratorPageData")
      ? Response.json({
          status: "success",
          generator: { ...generator, saveCount: ++n },
        })
      : new Response(
          String(url).endsWith("/empty")
            ? new Uint8Array()
            : new Uint8Array([0, 255, 1]),
        )) as typeof fetch;
  await assert.rejects(
    readPublicGenerator("fixture", f),
    (e) => (e as { code: string }).code === "STALE_REVISION",
  );
  const partial = await readPublicGenerator("fixture", (async () =>
    Response.json({
      status: "success",
      generator: { ...generator, srcManifest: undefined },
    })) as typeof fetch);
  assert.equal(partial.completeness, 'panels-only');
  assert.equal(partial.missingManifest, true);
  assert.deepEqual(Object.keys(partial.files).sort(), ['index.html','main.pjs']);
});

test('realistic public API envelope without status and string-key srcManifest fetches complete snapshot',async()=>{
 const calls: string[]=[];
 const f=(async (url:string|URL|Request, init:RequestInit)=>{
  calls.push(String(url));
  if(String(url).endsWith('getGeneratorPageData'))return Response.json({generator:{
    id:'pub-42',name:'text-to-image-plugin',
    modelText:'plugin = {import:some-file}',outputTemplate:'<p>Plugin</p>',
    srcManifest:{'assets/empty.bin':'zero','assets/data.bin':{key:'bin',size:3}},
  }});
  if(String(url).endsWith('/zero'))return new Response(new Uint8Array());
  if(String(url).endsWith('/bin'))return new Response(new Uint8Array([0,255,4]));
  throw new Error('No unexpected network or Helper API');
 }) as typeof fetch;
 const result=await readPublicGenerator('text-to-image-plugin',f);
 assert.equal(result.completeness,'complete');
 assert.equal(result.missingManifest,false);
 assert.equal(result.count,4);
 assert.equal(result.files['src/assets/empty.bin']?.length,0);
 assert.deepEqual(result.files['src/assets/data.bin'],new Uint8Array([0,255,4]));
 assert.equal(calls.filter(x=>x.includes('getGeneratorPageData')).length,2);
 assert.ok(calls.every(x=>x.startsWith('https://perchance.org/api/getGeneratorPageData')||x.startsWith('https://user.uploads.dev/file/')));
});
test('public missing src manifest exposes panels-only without falsely claiming complete backup',async()=>{
 const result=await readPublicGenerator('fixture', (async()=>Response.json({
  generator:{id:'abc',name:'fixture',modelText:'hello',outputTemplate:'<p>hello</p>'}
 })) as typeof fetch);
 assert.equal(result.completeness,'panels-only');
 assert.equal(result.missingManifest,true);
 assert.deepEqual(Object.keys(result.files).sort(),['index.html','main.pjs']);
});
test('public failures are classified by stage and contain no provider response text',async()=>{
 for(const [status,phrase]of [[403,'not-public'],[404,'not-found'],[429,'rate-limited'],[503,'upstream-unavailable']] as const){
  const f=(async()=>new Response('CONFIDENTIAL-PROVIDER-BODY',{status})) as typeof fetch;
  await assert.rejects(readPublicGenerator('fixture',f),(e)=>{
   const error=e as {code:string;message:string};
   return error.code==='PROVIDER_REJECTED'&&error.message.includes(phrase)
    &&!error.message.includes('CONFIDENTIAL');
  });
 }
});
test('reject provider identity change, revision drift and malformed public asset before cache publication',async()=>{
 let n=0;
 const drift=(async()=>Response.json({generator:{
  id:42,name:'fixture',modelText:'v'+(++n),outputTemplate:'page',srcManifest:{}
 }})) as typeof fetch;
 await assert.rejects(readPublicGenerator('fixture',drift),(e)=> (e as {code:string}).code==='STALE_REVISION');
 const corrupted=(async(url:string|URL|Request)=>String(url).includes('getGeneratorPageData')
  ?Response.json({generator:{...generator,srcManifest:{'a.bin':{key:'missing',size:7}}}})
  :new Response(new Uint8Array([1,2]))) as typeof fetch;
 await assert.rejects(readPublicGenerator('fixture',corrupted),(e)=>(e as {code:string}).code==='NATIVE_CONFLICT');
});
