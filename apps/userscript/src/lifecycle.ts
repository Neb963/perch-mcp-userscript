import { NativeAdapter } from './adapter.js';
import { readPublicGenerator } from './public-generator.js';
import { BrowserError, digest, equalIdentity, snapshotRevision, type KeyValueStore, type NativeIdentity, type NativeSnapshot } from './native-types.js';
export interface SavedGenerator { identity: NativeIdentity; files: Record<string, Uint8Array>; owned: boolean; listing: 'listed'|'unlisted'; revision: string }
export interface LifecycleReadback { readGenerator(slug: string): Promise<SavedGenerator>; readDeletionEvidence(generatorId: string, oldSlug: string): Promise<{ inventoryAbsent: boolean; sourceNotFound: boolean; identityChecked: string }> }
export interface LifecycleApproval { tool: string; target: NativeIdentity; inputDigest: string; sourceRevision: string; epoch: number; expiresAt: number; consumed: boolean; sourceChoice?: 'saved' }
export interface LifecycleContext { operationId: string; epoch: number; expectedRevision: string; permissions: string[]; approval?: LifecycleApproval }
export interface LifecycleResult { status: 'SUCCEEDED'|'UNKNOWN'; operationId: string; effectState: 'VERIFIED'|'POSSIBLE'; data?: Record<string,unknown>; error?: {code:string;message:string;recovery:string} }
interface Intent { version: 1; operationId: string; digest: string; tool: string; args: Record<string,unknown>; identity: NativeIdentity; sourceRevision: string; saved: {revision:string;sourceDigest:string;listing:'listed'|'unlisted'}; phase:'DISPATCHED'|'SUCCEEDED'|'UNKNOWN'; createdAt: number; result?: LifecycleResult; receipt?: {status:string;name?:string;generatorId?:string} }
interface NameField { value: string; disabled?: boolean }
interface NativeSettings { refs?: {newGeneratorName?:NameField;duplicateGeneratorName?:NameField;duplicateGeneratorStatus?:{querySelector(selector:string):Element|null}}; changeGeneratorName?:()=>unknown; duplicateGenerator?:()=>unknown; deleteGenerator?:()=>unknown }
interface NativeLifecyclePage { app?: { openSettingsModal?:()=>unknown; openListingMenu?:()=>unknown; userOwnsThisGenerator?:unknown }; settingsModal?: NativeSettings; document?: Document }
const permissions:Record<string,string>={rename_generator:'RENAME',duplicate_generator:'DUPLICATE',set_listing:'LISTING',delete_generator:'DELETE',create_generator:'CREATE'};
const approved=new Set(['duplicate_generator','set_listing','delete_generator','create_generator']);
async function sourceDigest(files:Record<string,Uint8Array>):Promise<string>{return snapshotRevision({generatorId:'source-only',slug:'source-only',draftId:''},files);}
export async function lifecycleApprovalDigest(tool:string,args:Record<string,unknown>,identity:NativeIdentity,sourceRevision:string,epoch:number):Promise<string>{return digest(JSON.stringify([tool,Object.keys(args).sort().map(key=>[key,args[key]]),identity,sourceRevision,epoch]));}
/** Candidate fixed native UI adapter. Production enablement requires separately recorded live evidence. */
export class NativeLifecycle {
  private page:NativeLifecyclePage; private prefix='perch:lifecycle:';
  constructor(readonly adapter:NativeAdapter,page:unknown,readonly readback:LifecycleReadback,readonly store:KeyValueStore,readonly options:{externalWritesVerified?:boolean}={}){this.page=page as NativeLifecyclePage;}
  supports(tool:string):boolean{return tool in permissions;}
  async call(tool:string,args:Record<string,unknown>,context:LifecycleContext):Promise<LifecycleResult>{
    if(!this.supports(tool))throw new BrowserError('UNSUPPORTED_INTERFACE','No fixed native lifecycle adapter for this tool.');
    if(!context.permissions.includes(permissions[tool]!))throw new BrowserError('SCOPE_DENIED','Lifecycle permission is disabled.');
    if(!this.options.externalWritesVerified)throw new BrowserError('UNSUPPORTED_INTERFACE','Native lifecycle requires recorded Firefox/disposable live verification.');
    this.adapter.assertMutationReady();
    if(tool==='create_generator')throw new BrowserError('UNSUPPORTED_INTERFACE','Native fork creation requires opening /minimal#edit:new as a new document, inert source, native Save and verified Unlisted state; the current Workspace cannot silently navigate or inherit the template Binding.');
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(context.operationId))throw new BrowserError('INVALID_INPUT','Invalid lifecycle Operation ID.');
    const before=await this.adapter.snapshot();if(before.revision!==context.expectedRevision)throw new BrowserError('STALE_REVISION','Native source changed before lifecycle action.');
    const hash=await lifecycleApprovalDigest(tool,args,before.identity,before.revision,context.epoch);const key=this.prefix+context.operationId;const previous=await this.store.get<Intent>(key);
    if(previous){if(previous.digest!==hash)throw new BrowserError('INVALID_INPUT','Operation ID already records another lifecycle intent.');return previous.result??this.unknown(previous.operationId,'Retained dispatched lifecycle intent cannot be replayed.');}
    for(const candidate of(await this.store.list()).filter(k=>k.startsWith(this.prefix))){const unresolved=await this.store.get<Intent>(candidate);if(unresolved&&unresolved.identity.generatorId===before.identity.generatorId&&unresolved.phase!=='SUCCEEDED')throw new BrowserError('EFFECT_UNKNOWN','An earlier lifecycle effect remains unresolved.');}
    if(await this.adapter.ownership()!==true)throw new BrowserError('SCOPE_DENIED','Native page-global generator ownership is not positively established.');
    if(approved.has(tool)){const a=context.approval;if(!a||a.consumed||a.expiresAt<=Date.now()||a.tool!==tool||a.epoch!==context.epoch||a.sourceRevision!==before.revision||a.inputDigest!==hash||!equalIdentity(a.target,before.identity))throw new BrowserError('APPROVAL_REQUIRED','Fresh exact action-bound Operator approval is required.');if(tool==='duplicate_generator'&&a.sourceChoice!=='saved')throw new BrowserError('APPROVAL_REQUIRED','Duplicate requires the Operator to approve saved source as its explicit source choice.');}
    const saved=await this.readback.readGenerator(before.identity.slug);if(!saved.owned||saved.identity.generatorId!==before.identity.generatorId)throw new BrowserError('BINDING_MISMATCH','Independent saved identity/ownership differs.');
    if(tool==='duplicate_generator'&&await sourceDigest(before.files)!==await sourceDigest(saved.files))throw new BrowserError('UNSUPPORTED_INTERFACE','The current native duplicate control includes unsaved owner draft changes; a saved-source duplicate requires the complete native draft to match saved source before dispatch.');
    const dispatch=await this.prepare(tool,args); // Feature detection precedes the durable dispatched state.
    if((await this.adapter.snapshot()).revision!==before.revision)throw new BrowserError('STALE_REVISION','Source changed during lifecycle preflight.');
    const intent:Intent={version:1,operationId:context.operationId,digest:hash,tool,args:structuredClone(args),identity:before.identity,sourceRevision:before.revision,saved:{revision:saved.revision,sourceDigest:await sourceDigest(saved.files),listing:saved.listing},phase:'DISPATCHED',createdAt:Date.now()};
    this.adapter.assertMutationReady();
    await this.store.set(key,intent);if(context.approval)context.approval.consumed=true;
    try{const raw=await dispatch();if(raw&&typeof raw==='object'){const r=raw as Record<string,unknown>;if(typeof r.status==='string'){intent.receipt={status:r.status};if(typeof r.name==='string')intent.receipt.name=r.name;if(typeof r.generatorId==='string'||typeof r.generatorId==='number')intent.receipt.generatorId=String(r.generatorId);await this.store.set(key,intent);}}}catch{intent.phase='UNKNOWN';intent.result=this.unknown(context.operationId,'Native lifecycle call failed after dispatch; its effect may have occurred.');await this.store.set(key,intent);return intent.result;}
    return this.verify(intent);
  }
  /** The native listing menu loads appExtras and refreshes metadata
   * asynchronously; an awaited app.openListingMenu() is not a readiness ack. */
  private async listingButton(listing:'listed'|'unlisted'):Promise<HTMLButtonElement> {
    const doc=this.page.document;
    if(!doc)throw new BrowserError('UNSUPPORTED_INTERFACE','Native listing document is unavailable.');
    const deadline=Date.now()+5000;
    for(;;){
      const node=doc.querySelector<HTMLButtonElement>(`#listingMenuEl button[data-value="${listing}"]`);
      if(node && node.isConnected && !node.disabled && !node.hidden &&
        node.getAttribute('aria-disabled')!=='true')return node;
      if(Date.now()>=deadline)throw new BrowserError('UNSUPPORTED_INTERFACE','Native listing menu did not expose an enabled matching action.');
      await new Promise<void>(resolve=>setTimeout(resolve,75));
    }
  }
  private async prepare(tool:string,args:Record<string,unknown>):Promise<()=>Promise<unknown>>{
    if(tool==='set_listing'){
      if(args.listing!=='listed'&&args.listing!=='unlisted')throw new BrowserError('INVALID_INPUT','Listing must be listed or unlisted.');
      if(typeof this.page.app?.openListingMenu!=='function'||!this.page.document)throw new BrowserError('UNSUPPORTED_INTERFACE','Native listing controls unavailable.');
      const existing=this.page.document.querySelector('#listingMenuEl');
      if(!existing)await this.page.app.openListingMenu();
      const button=await this.listingButton(args.listing);
      return async()=>{if(!button.isConnected || button.disabled)throw new BrowserError('UNSUPPORTED_INTERFACE','Native listing menu closed before dispatch.');button.click();return undefined;};
    }
    if(typeof this.page.app?.openSettingsModal!=='function')throw new BrowserError('UNSUPPORTED_INTERFACE','Native settings opener unavailable.');
    await this.page.app.openSettingsModal();
    // The native opener schedules appExtras loading asynchronously and
    // returns before settingsModal exists. Wait for the exact native controls.
    let settings:NativeSettings|undefined;
    const readyBy=Date.now()+5000;
    for(;;) {
      settings=this.page.settingsModal;
      if(settings && (tool!=='rename_generator' ||
        (typeof settings.changeGeneratorName==='function' &&
         !!settings.refs?.newGeneratorName)))break;
      if(Date.now()>=readyBy)
        throw new BrowserError('UNSUPPORTED_INTERFACE','Native settings controls did not become ready.');
      await new Promise<void>(resolve=>setTimeout(resolve,75));
    }
    if(tool==='rename_generator'){if(typeof args.newName!=='string'||!/^[a-z0-9][a-z0-9-]{3,99}$/.test(args.newName) && args.newName!=='hub')throw new BrowserError('INVALID_INPUT','Native URL requires 4–100 lower-case letters, digits or hyphens (except hub).');const input=settings.refs?.newGeneratorName;if(!input||input.disabled||typeof settings.changeGeneratorName!=='function')throw new BrowserError('UNSUPPORTED_INTERFACE','Native rename field/method unavailable.');const name=args.newName;return async()=>{input.value=name;return settings.changeGeneratorName!();};}
    if(tool==='duplicate_generator'){if(args.name!==undefined&&(typeof args.name!=='string'||!/^[a-z0-9][a-z0-9-]{0,99}$/.test(args.name)))throw new BrowserError('INVALID_INPUT','Invalid duplicate Slug.');if(typeof settings.duplicateGenerator!=='function')throw new BrowserError('UNSUPPORTED_INTERFACE','Verified native duplicate control unavailable.');if(args.name!==undefined&&!settings.refs?.duplicateGeneratorName)throw new BrowserError('UNSUPPORTED_INTERFACE','Native duplicate name field unavailable.');return async()=>{if(typeof args.name==='string')settings.refs!.duplicateGeneratorName!.value=args.name;const result=await settings.duplicateGenerator!();if(result===undefined){const href=settings.refs?.duplicateGeneratorStatus?.querySelector('a[href]')?.getAttribute('href');const match=typeof href==='string'?/^\/([a-z0-9][a-z0-9-]{0,99})#edit$/.exec(href):null;if(match)return{status:'native-control-returned',name:match[1]};}return result;};}
    if(tool==='delete_generator'){if(typeof settings.deleteGenerator!=='function')throw new BrowserError('UNSUPPORTED_INTERFACE','Verified native delete control unavailable.');return async()=>settings.deleteGenerator!();}
    throw new BrowserError('UNSUPPORTED_INTERFACE','Native lifecycle control unavailable.');
  }
  async reconcile(operationId:string):Promise<LifecycleResult>{if(!/^[A-Za-z0-9_-]{1,128}$/.test(operationId))throw new BrowserError('INVALID_INPUT','Invalid lifecycle Operation ID.');const intent=await this.store.get<Intent>(this.prefix+operationId);if(!intent)throw new BrowserError('FILE_NOT_FOUND','Lifecycle operation missing.');if(intent.phase==='SUCCEEDED'&&intent.result)return intent.result;return this.verify(intent);}
  private async verify(intent:Intent):Promise<LifecycleResult>{let result:LifecycleResult;try{
    if(intent.tool==='delete_generator'){const evidence=await this.readback.readDeletionEvidence(intent.identity.generatorId,intent.identity.slug);if(evidence.identityChecked===intent.identity.generatorId&&evidence.inventoryAbsent&&evidence.sourceNotFound)result={status:'SUCCEEDED',operationId:intent.operationId,effectState:'VERIFIED',data:{generatorId:intent.identity.generatorId,deleted:true,requiresDetach:true}};else result=this.unknown(intent.operationId,'Deletion lacks independent exact-ID owner inventory and source evidence.');}
    else{const slug=intent.tool==='rename_generator'?String(intent.args.newName):intent.tool==='duplicate_generator'?(typeof intent.args.name==='string'?intent.args.name:intent.receipt?.name):intent.identity.slug;if(!slug)throw new Error('Unknown resulting Slug.');
      // Provider version and source cache may settle after native UI submission.
      // Poll only independent GET/read operations, never the mutation again.
      let observed: SavedGenerator|undefined;
      for(let attempt=0;attempt<6;attempt++){
        if(attempt)await new Promise<void>(resolve=>setTimeout(resolve,160*attempt));
        try {
          const candidate=await this.readback.readGenerator(slug);
          if((intent.tool==='duplicate_generator' ||
              candidate.identity.generatorId===intent.identity.generatorId) &&
             (intent.tool!=='set_listing'||candidate.listing===intent.args.listing)){
            observed=candidate;break;
          }
        } catch { /* Retain UNKNOWN if verification cannot complete. */ }
      }
      if(!observed)throw new Error('Public lifecycle readback did not settle.');
      const sameSource=await sourceDigest(observed.files)===intent.saved.sourceDigest;const sameIdentity=observed.identity.generatorId===intent.identity.generatorId;
      if(intent.tool==='rename_generator'&&sameIdentity&&observed.identity.slug===slug&&observed.owned&&sameSource)result={status:'SUCCEEDED',operationId:intent.operationId,effectState:'VERIFIED',data:{generatorId:observed.identity.generatorId,oldSlug:intent.identity.slug,newSlug:slug,requiresRebind:true}};
      else if(intent.tool==='set_listing'&&sameIdentity&&observed.owned&&observed.listing===intent.args.listing&&sameSource)result={status:'SUCCEEDED',operationId:intent.operationId,effectState:'VERIFIED',data:{generatorId:observed.identity.generatorId,listing:observed.listing}};
      else if(intent.tool==='duplicate_generator'&&!sameIdentity&&observed.owned&&observed.listing==='unlisted'&&sameSource&&observed.identity.slug===slug)result={status:'SUCCEEDED',operationId:intent.operationId,effectState:'VERIFIED',data:{generatorId:observed.identity.generatorId,slug,listing:'unlisted',sourceChoice:'saved',requiresNewBinding:true,originalBindingPreserved:true}};
      else result=this.unknown(intent.operationId,'Independent lifecycle readback does not match exact identity, source, ownership and listing intent.');
    }
  }catch{result=this.unknown(intent.operationId,'Independent lifecycle verification unavailable.');}intent.result=result;intent.phase=result.status;await this.store.set(this.prefix+intent.operationId,intent);return result;}
  private unknown(operationId:string,message:string):LifecycleResult{return{status:'UNKNOWN',operationId,effectState:'POSSIBLE',error:{code:'EFFECT_UNKNOWN',message,recovery:'Read-only reconcile this Operation ID; never replay the native lifecycle mutation.'}};}
}

/**
 * The same fixed public Perchance source contract backs read-only imports and
 * independent Save readback. The verification requires a complete manifest;
 * a useful panels-only import is NEVER equivalent to a verified saved source.
 */
export class SavedSourceReader {
  constructor(readonly fetchImpl: typeof fetch = fetch, readonly maxBytes = 64 * 1024 * 1024) {}
  async read(slug: string, expected: NativeIdentity): Promise<NativeSnapshot> {
    if (!/^[a-z0-9][a-z0-9-]{0,119}$/.test(slug) || slug !== expected.slug)
      throw new BrowserError('BINDING_MISMATCH', 'Saved readback Slug does not match the bound Generator.');
    let publicSnapshot: Awaited<ReturnType<typeof readPublicGenerator>>;
    try { publicSnapshot = await readPublicGenerator(slug, this.fetchImpl); }
    catch (error) {
      const failure = error as {code?:unknown};
      const code = typeof failure?.code === 'string' ? failure.code : 'PROVIDER_REJECTED';
      if (code === 'NATIVE_CONFLICT') throw new BrowserError('PROVIDER_REJECTED',
        'Saved asset bytes differ from the declared public source manifest.');
      throw new BrowserError(code, 'Independent public saved-source readback failed before complete verification.');
    }
    if (publicSnapshot.completeness !== 'complete')
      throw new BrowserError('UNSUPPORTED_INTERFACE',
        'Public saved-source response lacks a complete src manifest; panel-only reads cannot verify native Save.');
    if (publicSnapshot.generatorId !== expected.generatorId)
      throw new BrowserError('BINDING_MISMATCH',
        'Public saved Generator ID does not match the assigned native Generator.');
    if (publicSnapshot.bytes > this.maxBytes)
      throw new BrowserError('LIMIT_EXCEEDED', 'Independent saved-source snapshot exceeds the configured budget.');
    return {
      identity: structuredClone(expected),
      files: publicSnapshot.files,
      revision: await snapshotRevision(expected, publicSnapshot.files),
      dirty: false, saveState: 'saved',
    };
  }
}

/** Public, credential-free verification of HAR-observed native lifecycle effects.
 * No app.store, sessionToken, email, or privileged direct API writes are read.
 * Same-Generator ownership remains a native page-global attestation, not a
 * claim extracted from a public URL or editable generator content. */
export class LiveLifecycleReadback implements LifecycleReadback {
  constructor(readonly adapter:NativeAdapter,readonly fetcher:typeof fetch=fetch) {}
  async readGenerator(slug:string):Promise<SavedGenerator> {
    if(!/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug))
      throw new BrowserError('INVALID_INPUT','Invalid public Generator Slug.');
    const bound=await this.adapter.assertIdentity();
    if(await this.adapter.ownership()!==true)
      throw new BrowserError('SCOPE_DENIED','Native owner status could not be verified.');
    const request=new URL('/api/generatorPageDataVersion/'+encodeURIComponent(slug),'https://perchance.org');
    const response=await this.fetcher(request.toString(),{method:'GET',credentials:'omit',cache:'no-store',redirect:'error'});
    if(!response.ok)throw new BrowserError('PROVIDER_REJECTED','Public Generator version readback did not return success.');
    const version:unknown=await response.json();
    if(!version||typeof version!=='object'||Array.isArray(version))
      throw new BrowserError('UNSUPPORTED_INTERFACE','Public Generator version returned an invalid object.');
    const meta=version as Record<string,unknown>;
    if(meta.status!=='success'||String(meta.id)!==bound.generatorId||typeof meta.isPrivate!=='boolean')
      throw new BrowserError('NATIVE_CONFLICT','Public Generator ID/listing does not match the owned bound Generator.');
    const identity={...bound,slug};
    const stored=await new SavedSourceReader(this.fetcher).read(slug,identity);
    if((await this.adapter.assertIdentity()).generatorId!==bound.generatorId ||
      await this.adapter.ownership()!==true)
      throw new BrowserError('BINDING_MISMATCH','Native ownership changed during independent verification.');
    return {identity,files:stored.files,owned:true,
      listing:meta.isPrivate?'unlisted':'listed',revision:stored.revision};
  }
  async readDeletionEvidence():Promise<{inventoryAbsent:boolean;sourceNotFound:boolean;identityChecked:string}> {
    throw new BrowserError('UNSUPPORTED_INTERFACE','Deletion requires a separate authorized native owner inventory check.');
  }
}
