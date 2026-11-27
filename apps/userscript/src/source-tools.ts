import { parse } from '@babel/parser';
import { RE2JS } from 're2js';
import { NativeAdapter, type SaveContext } from './adapter.js';
import { VirtualFileSystem, type WorkspaceSnapshot } from './vfs.js';
import { BrowserError, base64ToBytes, bytesToBase64, canonicalPath, decodeText, digest, utf8, type FileWrite } from './native-types.js';
const tools = new Set(['workspace_status','workspace_snapshot','read','write','edit','patch','glob','grep','list_code_definition_names','copy_lines','put_files','save_b64_file','read_b64_file','list_files','rename_file','delete_file','checkpoint_create','checkpoint_list','checkpoint_restore','editor_undo','editor_redo','generator_info','save_generator']);
function string(args: Record<string, unknown>, key: string): string { const value = args[key]; if (typeof value !== 'string') throw new BrowserError('INVALID_INPUT', `${key} must be a string.`); return value; }
function integer(value: unknown, fallback: number, min: number, max: number): number { if (value === undefined) return fallback; if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new BrowserError('INVALID_INPUT', `Expected integer in ${min}..${max}.`); return value; }
function patternRegex(pattern: string): RE2JS { if (pattern.length > 1024 || pattern.includes('..') || pattern.startsWith('/') || pattern.includes('\\')) throw new BrowserError('PATH_DENIED', 'Invalid glob pattern.'); let regex = '^'; for (let i = 0; i < pattern.length; i++) { const c = pattern[i]!; if (c === '*') { if (pattern[i+1] === '*') { i++; if (pattern[i+1] === '/') { i++; regex += '(?:.*/)?'; } else regex += '.*'; } else regex += '[^/]*'; } else if (c === '?') regex += '[^/]'; else regex += /[\w/-]/.test(c) ? c : `\\${c}`; } return RE2JS.compile(regex + '$'); }
function page<T>(all: T[], cursor: unknown, limit: number): { items: T[]; cursor?: string } { let offset = 0; if (cursor !== undefined) { if (typeof cursor !== 'string' || !/^\d{1,10}$/.test(cursor)) throw new BrowserError('INVALID_INPUT', 'Invalid pagination cursor.'); offset = Number(cursor); } const items = all.slice(offset, offset+limit); return offset+items.length < all.length ? {items,cursor:String(offset+items.length)} : {items}; }
function file(snapshot: WorkspaceSnapshot, path: string): Uint8Array { canonicalPath(path); const value = snapshot.files[path]; if (!value) throw new BrowserError('FILE_NOT_FOUND', 'File does not exist.'); return value; }
function bytesFor(snapshot: WorkspaceSnapshot, path: string): string { return decodeText(file(snapshot, path)); }
/** UTF-8 text is positively detected; no MIME inference from filenames. */
function fileType(bytes: Uint8Array): 'text' | 'binary' | 'empty' {
  if (bytes.length === 0) return 'empty';
  if (bytes.includes(0)) return 'binary';
  try { decodeText(bytes); return 'text'; }
  catch { return 'binary'; }
}
/** Preflight exact patch. No fuzzy matching, shell paths, or partially validated effects. */
export function parsePatch(patch: string, snapshot: WorkspaceSnapshot): FileWrite[] {
  if (patch.length > 1024 * 1024) throw new BrowserError('LIMIT_EXCEEDED', 'Patch exceeds 1 MiB.');
  const lines = patch.replace(/\r\n/g,'\n').split('\n'); while (lines.at(-1) === '') lines.pop();
  if (lines.shift() !== '*** Begin Patch' || lines.pop() !== '*** End Patch') throw new BrowserError('INVALID_INPUT', 'Patch requires Begin Patch and End Patch markers.');
  const writes: FileWrite[] = []; const seen = new Set<string>(); let i = 0;
  while (i < lines.length) {
    const header = lines[i++]!; const match = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(header); if (!match) throw new BrowserError('INVALID_INPUT', 'Expected Add/Update/Delete File header.');
    const action = match[1]!; const path = canonicalPath(match[2]!); if (seen.has(path.toLowerCase())) throw new BrowserError('INVALID_INPUT', 'Patch repeats/collides a file.'); seen.add(path.toLowerCase());
    if (action === 'Delete') { file(snapshot,path); writes.push({path,bytes:null}); continue; }
    const body: string[] = []; while (i < lines.length && (!lines[i]!.startsWith('*** ') || lines[i] === '*** End of File')) body.push(lines[i++]!);
    if (action === 'Add') { if (snapshot.files[path]) throw new BrowserError('NATIVE_CONFLICT', 'Add File target exists.'); if (body.some(line => !line.startsWith('+'))) throw new BrowserError('INVALID_INPUT', 'Add File lines require + prefix.'); writes.push({path,bytes:utf8.encode(body.map(line=>line.slice(1)).join('\n')+'\n')}); continue; }
    let text = bytesFor(snapshot,path); const newline = text.includes('\r\n') ? '\r\n' : '\n'; let offset = 0;
    if (!body.length || !body[0]!.startsWith('@@')) throw new BrowserError('INVALID_INPUT', 'Update File requires exact @@ hunks.');
    let j = 0; while (j < body.length) {
      const anchor = body[j++]!; if (!anchor.startsWith('@@')) throw new BrowserError('INVALID_INPUT', 'Expected @@ patch hunk.');
      const oldLines: string[] = []; const newLines: string[] = []; let endMarker = false;
      while (j < body.length && !body[j]!.startsWith('@@')) { const line = body[j++]!; if (line === '*** End of File') { endMarker = true; continue; } const prefix = line[0]; if (prefix !== ' ' && prefix !== '+' && prefix !== '-') throw new BrowserError('INVALID_INPUT', 'Hunk lines require space/+/- prefix.'); if (prefix !== '+') oldLines.push(line.slice(1)); if (prefix !== '-') newLines.push(line.slice(1)); }
      if (!oldLines.length) throw new BrowserError('INVALID_INPUT', 'Update insertion requires exact context.');
      const oldText = oldLines.join(newline); const newText = newLines.join(newline); const positions: number[] = []; let searchAt = offset; while (searchAt <= text.length) { const candidate = text.indexOf(oldText, searchAt); if (candidate < 0) break; if ((candidate === 0 || text.slice(candidate-newline.length,candidate) === newline) && (candidate+oldText.length === text.length || text.slice(candidate+oldText.length,candidate+oldText.length+newline.length) === newline)) positions.push(candidate); searchAt = candidate + Math.max(1, oldText.length); } const at = positions[0] ?? -1;
      if (positions.length !== 1) throw new BrowserError('NATIVE_CONFLICT', 'Patch context missing or ambiguous.');
      if (anchor.length > 2) { const a = anchor.slice(2).trim(); if (a && text.lastIndexOf(a,at) < offset) throw new BrowserError('NATIVE_CONFLICT', 'Patch anchor not found before hunk.'); }
      if (endMarker && at+oldText.length !== text.length && at+oldText.length+newline.length !== text.length) throw new BrowserError('NATIVE_CONFLICT', 'Patch EOF context is not at end.');
      const consumed = oldText.length + (newLines.length === 0 && text.slice(at+oldText.length,at+oldText.length+newline.length) === newline ? newline.length : 0);
      text = text.slice(0,at)+newText+text.slice(at+consumed); offset = at+newText.length;
    }
    writes.push({path,bytes:utf8.encode(text)});
  }
  if (!writes.length) throw new BrowserError('INVALID_INPUT','Empty patch.'); return writes;
}
export class SourceTools {
  constructor(readonly vfs: VirtualFileSystem, readonly adapter: NativeAdapter) {}
  supports(name: string): boolean { return tools.has(name); }
  async call(name: string, args: Record<string, unknown> = {}, context?: {save?: SaveContext;operationId?:string}): Promise<unknown> {
    if (!tools.has(name)) throw new BrowserError('UNSUPPORTED_INTERFACE', `Source tool ${name} unavailable.`);
    if (name === 'save_generator') {
      if (!context?.save) throw new BrowserError('UNSUPPORTED_INTERFACE', 'Native Save is gated until an independent complete readback driver, saved base and explicit Save permission are supplied.');
      const source = await this.vfs.snapshot(); if (source.revision !== string(args, 'intendedRevision')) throw new BrowserError('STALE_REVISION', 'Intended Workspace revision no longer matches.');
      await this.vfs.reconcileRetained();
      // Import-cache uncertainty is irrelevant to native Save. A recent
      // source/save effect can still be running; old ones are automatically
      // rebased against two matching current-source observations above.
      const pending = (await this.vfs.unresolved()).filter(j=>j.kind!=='IMPORT');
      if (pending.length) throw new BrowserError('NATIVE_CONFLICT',
        'A recent source operation is settling. Inspect current Workspace status and retry this new Save after it settles.',
        'No old operation is replayed. Current source remains intact.');
      const operationId = context.save.operationId; if (!/^[A-Za-z0-9_-]{1,128}$/.test(operationId)) throw new BrowserError('INVALID_INPUT','Invalid Save Operation ID.');
      const key = `${this.vfs.prefix}:journal:${operationId}`; if (await this.vfs.store.get(key)) throw new BrowserError('EFFECT_UNKNOWN','Retained Save intent cannot be replayed; reconcile its Operation ID.');
      const checkpoint = await this.vfs.checkpoint('Before native Save', true); const journal = {id:operationId,gatewayOperationId:operationId,state:'INTENT',kind:'SAVE',paths:Object.keys(source.files).filter(path=>!path.startsWith('scratch/')&&!path.startsWith('imports/')),baseRevision:source.revision,checkpointId:checkpoint.id,createdAt:Date.now(),identity:source.identity}; await this.vfs.store.set(key,journal);
      let dispatched = false;
      try {
        const result = await this.adapter.save(source.nativeRevision, {
          ...context.save,
          onDispatch: async () => {
            // Persist BEFORE native execution. An interrupted or rejected
            // acknowledgement after this point is never classified NONE.
            await this.vfs.store.set(key, {...journal,state:'DISPATCHED'});
            dispatched = true;
          },
        });
        journal.state=result.status;
        await this.vfs.store.set(key,journal);
        // A concurrent manual edit may follow a verified native Save. Report
        // both revisions instead of labelling the newer draft as saved.
        let current: Awaited<ReturnType<VirtualFileSystem['snapshot']>> | undefined;
        try { current=await this.vfs.snapshot(); } catch { /* Save receipt remains valid. */ }
        return {...result,
          revision:current?.revision??source.revision,
          workspaceRevisionKnown:current!==undefined,
          savedRevision:result.status==='SUCCEEDED'?result.revision:null,
          draftChangedSinceSave:current ? current.nativeRevision!==result.revision : null};
      } catch(error) {
        journal.state=dispatched?'UNKNOWN':'REJECTED';
        await this.vfs.store.set(key,journal);
        if (dispatched) {
          const original=error instanceof BrowserError ? error : new BrowserError('EFFECT_UNKNOWN',
            'Native Save was dispatched but its outcome is unverified.');
          throw Object.assign(original,{effectState:'UNKNOWN'});
        }
        throw error;
      }
    }
    const expected = typeof args.expectedRevision === 'string' ? args.expectedRevision : undefined;
    if (name === 'checkpoint_list') return {checkpoints:await this.vfs.checkpointList()};
    if (name === 'checkpoint_create') return this.vfs.checkpoint(typeof args.label === 'string' ? args.label : 'Agent checkpoint',args.pinned===true);
    if (name === 'checkpoint_restore') return this.vfs.restore(string(args,'id'),string(args,'expectedRevision'),context?.operationId);
    if (name === 'workspace_status' || name === 'generator_info') {
      const capabilities = await this.adapter.probe();
      let unresolved: Awaited<ReturnType<VirtualFileSystem['unresolved']>> = [];
      let localJournalError: string | null = null;
      try {
        if ((await this.vfs.unresolved()).length) await this.vfs.reconcileRetained();
        unresolved = await this.vfs.unresolved();
      }
      catch(error) { localJournalError = error instanceof BrowserError ? error.code : 'LOCAL_STORE_UNAVAILABLE'; }
      try {
        const snapshot = await this.vfs.snapshot();
        const base = { identity:snapshot.identity,revision:snapshot.revision,
          dirty:snapshot.dirty,saveState:snapshot.saveState,
          snapshotVerified:true,sourceReadbackError:null,localJournalError,
          capabilities,unresolved,
          localJournalNamespace:'BROWSER_LOCAL',
          localJournalRecovery:'Old local intents are automatically rebased to the verified current editor. These local IDs are not Gateway operation IDs; do not retry the old operation.',
          recentLocalReconciliations:await this.vfs.recentReconciliations().catch(()=>[]) };
        return name === 'generator_info'
          ? { ...base, ...await this.adapter.generatorMetadata() }
          : base;
      } catch(error) {
        const code = error instanceof BrowserError ? error.code : 'SOURCE_READBACK_UNAVAILABLE';
        const base = {identity:capabilities.identity ?? await this.adapter.identity(),
          revision:null,dirty:capabilities.dirty,saveState:'unknown',
          snapshotVerified:false,sourceReadbackError:code,localJournalError,capabilities,unresolved,
          localJournalNamespace:'BROWSER_LOCAL',
          localJournalRecovery:'Native source readback is unavailable. Read and preview may still work; source edits require a verified current editor baseline.',
          recentLocalReconciliations:await this.vfs.recentReconciliations().catch(()=>[])};
        return name === 'generator_info'
          ? { ...base, ...await this.adapter.generatorMetadata() }
          : base;
      }
    }
    const snapshot = await this.vfs.snapshot();
    if (expected && expected !== snapshot.revision) throw new BrowserError('STALE_REVISION','Workspace changed; read current source before applying edits.');
    if (name === 'workspace_snapshot') { const entries = Object.entries(snapshot.files).sort(([a],[b])=>a.localeCompare(b)); const items = await Promise.all(entries.map(async ([path,bytes])=>({path,bytes:bytes.length,sha256:await digest(bytes)}))); const result = page(items,args.cursor,integer(args.limit,100,1,100)); const panels = Object.fromEntries(['main.pjs','index.html'].map(path => { const bytes = snapshot.files[path]!; return [path, {path,bytes:bytes.length,...(bytes.length <= 131072 ? {text:decodeText(bytes)} : {contentOmitted:true,recovery:'Use read with offset/limit for this panel.'})}]; })); return {revision:snapshot.revision,identity:snapshot.identity,panels,files:result.items,cursor:result.cursor}; }
    if (name === 'list_files' || name === 'glob') { const prefix = typeof args.path === 'string' ? args.path.replace(/\/$/,'') : ''; if (prefix && !['src','scratch','imports'].includes(prefix)) canonicalPath(prefix); const pattern = patternRegex(name === 'glob' ? string(args,'pattern') : '**'); const paths = Object.keys(snapshot.files).sort().filter(path=>(!prefix||path===prefix||path.startsWith(prefix+'/'))&&pattern.test(path)); const result=page(paths,args.cursor,integer(args.limit,100,1,100)); return name === 'list_files' ? {
      paths:result.items,
      entries:result.items.map(path => ({
        path, bytes:snapshot.files[path]!.length, type:fileType(snapshot.files[path]!),
      })),
      cursor:result.cursor,revision:snapshot.revision
    } : {paths:result.items,cursor:result.cursor,revision:snapshot.revision}; }
    if (name === 'read') { const path=string(args,'path'); const allPaths=Object.keys(snapshot.files).sort(); if (!snapshot.files[path] && (path===''||allPaths.some(p=>p.startsWith(path.replace(/\/$/,'')+'/')))) { const result=page(allPaths.filter(p=>!path||p.startsWith(path.replace(/\/$/,'')+'/')),args.cursor,integer(args.limit,2000,1,2000)); return {paths:result.items,cursor:result.cursor,revision:snapshot.revision}; } const text=bytesFor(snapshot,path); const lines=text.split('\n'); const offset=integer(args.offset,1,1,Number.MAX_SAFE_INTEGER); const limit=integer(args.limit,2000,1,2000); return {path,revision:snapshot.revision,content:lines.slice(offset-1,offset-1+limit).map((line,i)=>`${offset+i}: ${line}`).join('\n'),offset,totalLines:lines.length,truncated:offset-1+limit<lines.length}; }
    if (name === 'read_b64_file') { const path=string(args,'path'); const bytes=file(snapshot,path); const offset=integer(args.offset,0,0,Number.MAX_SAFE_INTEGER); const limit=integer(args.limit,262144,1,262144); return {path,data:bytesToBase64(bytes.subarray(offset,offset+limit)),bytes:bytes.length,offset,sha256:await digest(bytes),truncated:offset+limit<bytes.length,revision:snapshot.revision}; }
    if (name === 'write' || name === 'save_b64_file') {
      const path=string(args,'path');
      const bytes=name==='write'?utf8.encode(string(args,'content')):base64ToBytes(string(args,'data'));
      const result=await this.vfs.writeBatch([{path,bytes}],expected??snapshot.revision,context?.operationId);
      // The VFS has verified native complete-file readback before SUCCEEDED.
      // Partial/unknown results remain unchanged, without invented byte proofs.
      return result.status==='SUCCEEDED'
        ? {...result,path,bytes:bytes.length,sha256:await digest(bytes)}
        : result;
    }
    if (name === 'put_files') { if (!Array.isArray(args.files)) throw new BrowserError('INVALID_INPUT','files must be an array.'); const writes=args.files.map((row:unknown)=>{ if (!row||typeof row!=='object') throw new BrowserError('INVALID_INPUT','Invalid file entry.'); const r=row as Record<string,unknown>; if(r.encoding!=='utf8'&&r.encoding!=='base64') throw new BrowserError('INVALID_INPUT','Unknown encoding.'); return {path:string(r,'path'),bytes:r.encoding==='utf8'?utf8.encode(string(r,'content')):base64ToBytes(string(r,'content'))}; }); return this.vfs.writeBatch(writes,string(args,'expectedRevision'),context?.operationId); }
    if (name === 'edit') { const path=string(args,'path'); const text=bytesFor(snapshot,path); const old=string(args,'oldString'); const replacement=string(args,'newString'); if(!old||old===replacement) throw new BrowserError('INVALID_INPUT','oldString must be nonempty and differ from newString.'); const count=text.split(old).length-1; if(count===0||count>1&&args.replaceAll!==true) throw new BrowserError('NATIVE_CONFLICT','Exact edit anchor missing or ambiguous.'); const content=args.replaceAll===true?text.split(old).join(replacement):text.replace(old,()=>replacement); return this.vfs.writeBatch([{path,bytes:utf8.encode(content)}],snapshot.revision,context?.operationId); }
    if (name === 'patch') return this.vfs.writeBatch(parsePatch(string(args,'patchText'),snapshot),expected??snapshot.revision,context?.operationId);
    if (name === 'delete_file') return this.vfs.writeBatch([{path:string(args,'path'),bytes:null}],expected??snapshot.revision,context?.operationId);
    if (name === 'rename_file') { const path=string(args,'path'); const newPath=canonicalPath(string(args,'newPath')); if(snapshot.files[newPath]) throw new BrowserError('NATIVE_CONFLICT','Rename target exists.'); if(path==='main.pjs'||path==='index.html') throw new BrowserError('PATH_DENIED','Native panels cannot be renamed.'); return this.vfs.writeBatch([{path:newPath,bytes:file(snapshot,path)},{path,bytes:null}],expected??snapshot.revision,context?.operationId); }
    if (name === 'copy_lines') { const source=bytesFor(snapshot,string(args,'sourcePath')); const targetPath=string(args,'targetPath'); const target=snapshot.files[targetPath]?bytesFor(snapshot,targetPath):''; const parts=source.match(/[^\n]*\n|[^\n]+$/g)??[]; const start=integer(args.sourceStartLine,1,1,parts.length); const end=integer(args.sourceEndLine,start,start,parts.length); const selected=parts.slice(start-1,end).join(''); const targetParts=target.match(/[^\n]*\n|[^\n]+$/g)??[]; const at=args.targetLine===undefined?targetParts.length:integer(args.targetLine,1,1,targetParts.length+1)-1; const content=targetParts.slice(0,at).join('')+selected+targetParts.slice(at).join(''); return this.vfs.writeBatch([{path:targetPath,bytes:utf8.encode(content)}],snapshot.revision,context?.operationId); }
    if (name === 'grep') { let regex:RE2JS; try { const pattern=string(args,'pattern'); if(pattern.length>1024) throw new Error(); regex=RE2JS.compile(pattern); } catch { throw new BrowserError('INVALID_INPUT','Invalid or unsupported bounded RE2 expression. Backreferences/lookaround are unsupported.'); } const prefix=typeof args.path==='string'?args.path.replace(/\/$/,''):''; if(prefix&&!['src','scratch','imports'].includes(prefix)) canonicalPath(prefix); const include=typeof args.include==='string'?patternRegex(args.include):undefined; const matches:{path:string;line:number;text:string}[]=[]; let total=0; for(const path of Object.keys(snapshot.files).sort()){if(prefix&&path!==prefix&&!path.startsWith(prefix+'/'))continue;if(include&&!include.test(path))continue;const bytes=snapshot.files[path]!;total+=bytes.length;if(total>8*1024*1024)throw new BrowserError('LIMIT_EXCEEDED','Search exceeds 8 MiB scan budget; narrow path/include.');let text:string;try{text=decodeText(bytes);}catch{continue;} for(const [index,line] of text.split('\n').entries())if(regex.test(line)){matches.push({path,line:index+1,text:line.slice(0,500)});if(matches.length>10000)throw new BrowserError('LIMIT_EXCEEDED','Search exceeds 10000 matches; narrow pattern.');}}const result=page(matches,args.cursor,integer(args.limit,100,1,100));return{matches:result.items,cursor:result.cursor,revision:snapshot.revision}; }
    if (name === 'list_code_definition_names') return this.definitions(snapshot,string(args,'path'));
    if (name === 'editor_undo' || name === 'editor_redo') { const panel=string(args,'panel'); if(panel!=='pjs'&&panel!=='html')throw new BrowserError('INVALID_INPUT','Unknown panel.'); await this.vfs.checkpoint(`Before ${name}`); await this.adapter.undoRedo(panel,name==='editor_undo'?'undo':'redo',snapshot.nativeRevision); return {revision:(await this.vfs.snapshot()).revision}; }
    throw new BrowserError('UNSUPPORTED_INTERFACE',`Source tool ${name} unavailable.`);
  }
  private definitions(snapshot:WorkspaceSnapshot,path:string):unknown {
    const paths=snapshot.files[path]?[path]:Object.keys(snapshot.files).filter(p=>path === '' ? !p.includes('/') : p.startsWith(path.replace(/\/$/,'')+'/')&&!p.slice(path.length+1).includes('/')).sort(); if(!paths.length)throw new BrowserError('FILE_NOT_FOUND','No files at path.');const definitions:{path:string;name:string;type:string;startLine:number;endLine:number;signature:string}[]=[];let bytes=0;
    for(const p of paths){const content=bytesFor(snapshot,p);bytes+=utf8.encode(content).length;if(bytes>1024*1024)throw new BrowserError('LIMIT_EXCEEDED','Definition scan exceeds 1 MiB.');const chunks:{text:string;offset:number}[]=[];if(p.endsWith('.html')){const re=/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi;let m:RegExpExecArray|null;while((m=re.exec(content))){const start=m.index+m[0].indexOf('>')+1;chunks.push({text:m[1]!,offset:content.slice(0,start).split('\n').length-1});}}else if(p==='main.pjs'){const lines=content.split('\n');for(let i=0;i<lines.length;i++){const m=/^(\s*)([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*=>\s*$/.exec(lines[i]!);if(!m)continue;const body:string[]=[];let j=i+1;while(j<lines.length&&(lines[j]!.trim()===''||lines[j]!.match(/^\s*/)![0].length>m[1]!.length))body.push(lines[j++]!);chunks.push({text:`function ${m[2]}(${m[3]}) {\n${body.join('\n')}\n}`,offset:i});i=j-1;}}else chunks.push({text:content,offset:0});
      for(const chunk of chunks){let tree:unknown;try{tree=parse(chunk.text,{sourceType:'unambiguous',plugins:['typescript'],errorRecovery:false});}catch{throw new BrowserError('PARSE_ERROR',`JavaScript/TypeScript parse error in ${p}; source unchanged.`);}const visit=(node:unknown):void=>{if(!node||typeof node!=='object')return;const record=node as Record<string,unknown>;const type=record.type;if(typeof type!=='string')return;const loc=record.loc as {start:{line:number};end:{line:number}}|undefined;if(['FunctionDeclaration','ClassDeclaration','VariableDeclarator','ClassMethod','ObjectMethod','TSInterfaceDeclaration','TSTypeAliasDeclaration'].includes(type)&&loc){const id=record.id as {name?:string}|undefined;const key=record.key as {name?:string}|undefined;const name=id?.name??key?.name;if(name){const start=typeof record.start==='number'?record.start:0;const end=typeof record.end==='number'?record.end:start;definitions.push({path:p,name,type,startLine:chunk.offset+loc.start.line,endLine:chunk.offset+loc.end.line,signature:chunk.text.slice(start,Math.min(end,start+200)).split('\n')[0]!.slice(0,200)});}}for(const [key,value]of Object.entries(record)){if(['loc','tokens','comments','extra'].includes(key))continue;if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')visit(value);}};visit(tree);}
    }const truncated=definitions.length>1000;let output=definitions.slice(0,1000);while(utf8.encode(JSON.stringify(output)).length>45*1024)output=output.slice(0,-1);return{definitions:output,truncated:truncated||output.length<definitions.length,revision:snapshot.revision};
  }
}
