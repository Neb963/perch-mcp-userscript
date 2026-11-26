import { build } from 'esbuild';
import { readFile, writeFile, mkdir, cp, readdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import ts from 'typescript';
execFileSync(process.execPath,['packages/resources/generate-defaults.mjs'],{stdio:'inherit'});
await rm('dist',{recursive:true,force:true});
await mkdir('dist',{recursive:true});
const worker=await build({entryPoints:['apps/userscript/src/compute-worker.ts'],bundle:true,write:false,format:'iife',platform:'browser',target:'firefox128',legalComments:'inline'});
const workerSource=worker.outputFiles[0]!.text;
const metadata=`// ==UserScript==
// @name         Perch MCP (verification candidate)
// @namespace    https://github.com/Neb963/perch-mcp-userscript
// @version      0.1.0
// @description  Isolated Perchance workspace MCP controller. External acceptance gates remain open.
// @match        https://perchance.org/*
// @exclude      https://perchance.org/ai-agent*
// @run-at       document-start
// @inject-into  content
// @noframes
// @grant        GM_info
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// ==/UserScript==
`;
await build({entryPoints:['apps/userscript/src/main.ts'],bundle:true,outfile:'dist/perch-mcp.user.js',format:'iife',platform:'browser',target:'firefox128',legalComments:'inline',banner:{js:metadata},define:{__COMPUTE_WORKER_SOURCE__:JSON.stringify(workerSource)}});
const userscript=await readFile('dist/perch-mcp.user.js');await writeFile('dist/perch-mcp.user.txt',userscript);
await build({entryPoints:['apps/gateway/src/index.ts'],bundle:true,outfile:'dist/cloudflare/worker.mjs',format:'esm',platform:'neutral',target:'es2022',external:['node:*','cloudflare:*'],conditions:['workerd','worker','browser'],mainFields:['browser','module','main'],legalComments:'inline'});
const parsedConfig=ts.parseConfigFileTextToJson('wrangler.jsonc',await readFile('apps/gateway/wrangler.jsonc','utf8'));if(parsedConfig.error)throw new Error('Invalid gateway configuration.');const sourceConfig=parsedConfig.config;sourceConfig.main='worker.mjs';sourceConfig.$schema=undefined;
await writeFile('dist/cloudflare/wrangler.json',JSON.stringify(sourceConfig,null,2)+'\n');
await writeFile('dist/cloudflare/package.json',JSON.stringify({name:'perch-mcp-gateway-candidate',private:true,type:'module',scripts:{deploy:'wrangler deploy',dev:'wrangler dev'},devDependencies:{wrangler:JSON.parse(await readFile('package.json','utf8')).devDependencies.wrangler}},null,2)+'\n');
await cp('docs','dist/docs',{recursive:true});await cp('README.md','dist/README.md');await cp('CLIENT_SPEC.md','dist/CLIENT_SPEC.md');
await cp('apps/gateway/.dev.vars.example','dist/cloudflare/.dev.vars.example');
await writeFile('dist/STATUS.txt','VERIFICATION CANDIDATE — NOT A FULL-PARITY RELEASE. Read docs/RELEASE_VERIFICATION.md before installation. Production provider mutations and unverified preview capabilities remain gated.\n');
const hashes:Record<string,string>={};
async function collect(path:string,prefix=''):Promise<Record<string,Uint8Array>>{const entries:Record<string,Uint8Array>={};for(const item of await readdir(path,{withFileTypes:true})){const rel=prefix+item.name;if(item.isDirectory())Object.assign(entries,await collect(`${path}/${item.name}`,rel+'/'));else{const bytes=await readFile(`${path}/${item.name}`);entries[rel]=bytes;hashes[rel]=createHash('sha256').update(bytes).digest('hex');}}return entries;}
const cloud=await collect('dist/cloudflare');await writeFile('dist/perch-mcp-cloudflare.zip',zipSync(cloud,{level:9}));
const archive=await collect('dist');delete archive['perch-mcp-candidate.zip'];archive['SHA256SUMS.txt']=new TextEncoder().encode(Object.entries(hashes).map(([name,hash])=>`${hash}  ${name}`).join('\n')+'\n');
await writeFile('dist/perch-mcp-candidate.zip',zipSync(archive,{level:9}));await writeFile('dist/SHA256SUMS.txt',archive['SHA256SUMS.txt']!);
console.log(JSON.stringify({userscriptBytes:userscript.length,workerSourceBytes:new TextEncoder().encode(workerSource).length,artifacts:['perch-mcp.user.js','perch-mcp.user.txt','perch-mcp-cloudflare.zip','perch-mcp-candidate.zip']}));
