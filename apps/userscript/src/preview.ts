import { ExecutionError } from './compute.js';

export interface PreviewDiagnostics { consoleOutput: string[]; perchanceErrors: unknown[]; syntaxErrors: unknown[] }
export interface PreviewReceipt extends PreviewDiagnostics { appliedRevision?: string; previewGeneration?: string; result?: unknown; warnings?:unknown[]; diagnosticsAvailability?:Record<string,string>; diagnosticChannels?:Record<string,string> }
export interface PreviewBridge {
  /** Live, zero-source-mutation native protocol probe before first use. */
  attest?(capability: 'evaluate' | 'refresh' | 'preamble'): Promise<boolean>;
  /** Boolean-only readiness evidence; no frame URL, source or private IDs. */
  status?(): Record<string, boolean>;
  refresh(preambleJs?: string): Promise<PreviewReceipt>;
  evaluate(js: string, timeoutMs: number): Promise<PreviewReceipt>;
  diagnostics?(): Promise<PreviewReceipt>;
  capture?(): Promise<{ dataUrl: string; width: number; height: number }>;
}
export interface PreviewOptions {
  frame(): HTMLIFrameElement | null;
  revision(): Promise<string>;
  bridge?: PreviewBridge;
  /** True only after a fixed native request/reply contract has been verified, never a tool argument. */
  verified?: Partial<Record<'refresh' | 'evaluate' | 'preamble' | 'capture', boolean>>;
  readText?(path: string): Promise<string>;
  writeFile?(path: string, bytes: Uint8Array, expectedRevision: string): Promise<unknown>;
  maxViewport?: number;
}
function checkedReceipt(value: unknown): PreviewReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ExecutionError('UNSUPPORTED_INTERFACE', 'The native preview did not provide a structured receipt.');
  const r = value as Record<string, unknown>;
  if (!Array.isArray(r.consoleOutput) || !r.consoleOutput.every(x => typeof x === 'string') || !Array.isArray(r.perchanceErrors) || !Array.isArray(r.syntaxErrors)) throw new ExecutionError('UNSUPPORTED_INTERFACE', 'The native preview receipt contract changed.');
  const serialized = JSON.stringify(value);
  if (new TextEncoder().encode(serialized).byteLength > 262_144) throw new ExecutionError('LIMIT_EXCEEDED', 'Preview result exceeds 256 KiB.');
  return { consoleOutput: (r.consoleOutput as string[]).slice(0, 500), perchanceErrors: r.perchanceErrors.slice(0, 500), syntaxErrors: r.syntaxErrors.slice(0, 500), ...(typeof r.appliedRevision === 'string' ? { appliedRevision: r.appliedRevision } : {}), ...(typeof r.previewGeneration === 'string' ? { previewGeneration: r.previewGeneration } : {}), ...(Array.isArray(r.warnings)?{warnings:r.warnings.slice(0,500)}:{}),...(r.diagnosticsAvailability&&typeof r.diagnosticsAvailability==='object'?{diagnosticsAvailability:r.diagnosticsAvailability as Record<string,string>}:{}),...(r.diagnosticChannels&&typeof r.diagnosticChannels==='object'&&
    !Array.isArray(r.diagnosticChannels)&&
    Object.values(r.diagnosticChannels).every(x=>typeof x==='string'&&x.length<256)
    ?{diagnosticChannels:r.diagnosticChannels as Record<string,string>}:{}),...(Object.hasOwn(r, 'result') ? { result: JSON.parse(JSON.stringify(r.result ?? null)) as unknown } : {}) };
}
function body(args: Record<string, unknown>, key: string): string | undefined { const v = args[key]; if (v === undefined) return undefined; if (typeof v !== 'string' || new TextEncoder().encode(v).byteLength > 262_144) throw new ExecutionError('INVALID_INPUT', `${key} must be text no larger than 256 KiB.`); return v; }
async function deadline<T>(promise: Promise<T>, timeout: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ExecutionError('TIMEOUT', 'Preview execution timed out. A blocked preview main thread may require a manual reload.', 'UNKNOWN')), timeout); })]); }
  finally { clearTimeout(timer); }
}
/** No page message handler and no privileged JavaScript evaluation. All results remain untrusted generator data. */
export class PreviewAdapter {
  private appliedRevision: string | undefined;
  private generation: string | undefined;
  private original: { frame: HTMLIFrameElement; style: string | null } | undefined;
  private nativeBaseline: { width: number; height: number; parentWidth: number } | undefined;
  private viewport: { width: number; height: number } | undefined;
  private readonly attested = new Set<'refresh' | 'evaluate' | 'preamble'>();
  constructor(private readonly options: PreviewOptions) {}
  private async requireCapability(capability: 'refresh' | 'evaluate' | 'preamble'): Promise<void> {
    if (this.options.verified?.[capability]) return;
    if (!this.options.bridge?.attest ||
        !(await this.options.bridge.attest(capability)))
      throw new ExecutionError('UNSUPPORTED_INTERFACE',
        `Native preview ${capability} capability could not be verified on the exact bound output frame.`);
    this.attested.add(capability);
  }
  availability(): Record<string, { available: boolean; reason?: string }> {
    const available = (enabled: boolean, reason: string) => enabled ? { available: true } : { available: false, reason };
    return {
      page_eval: available(Boolean(this.options.bridge && (this.options.verified?.evaluate || this.attested.has('evaluate'))), 'Native preview evaluation has not yet passed a live response-correlated capability probe.'),
      page_refresh: available(Boolean(this.options.bridge && (this.options.verified?.refresh || this.attested.has('refresh'))), 'Native preview refresh has not yet passed a structural capability probe and source-receipt verification.'),
      preview_diagnostics: available(Boolean(this.options.bridge?.diagnostics), 'No verified native diagnostics collector is attached.'),
      set_viewport_size: available(Boolean(this.options.frame()), 'The native output frame is unavailable.'),
      capture_page_image: available(Boolean(this.options.verified?.capture && this.options.bridge?.capture), 'No real-pixel native capture or consented capture adapter is verified.'),
    };
  }
  supports(name: string): boolean { return this.availability()[name]?.available ?? false; }
  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case 'page_refresh': return this.refresh(body(args, 'preambleJs'));
      case 'page_eval': {
        const js = body(args, 'js'), path = body(args, 'path');
        if ((js === undefined) === (path === undefined)) throw new ExecutionError('INVALID_INPUT', 'Provide exactly one of js or path.');
        const source = js ?? (this.options.readText ? await this.options.readText(path!) : undefined);
        if (source === undefined) throw new ExecutionError('UNSUPPORTED_INTERFACE', 'Workspace code-file access is unavailable.');
        return this.evaluate(source, { reload: args.reload === true, timeoutMs: args.timeoutMs as number | undefined, resultPath: body(args, 'resultPath') });
      }
      case 'set_viewport_size': return this.setViewport(args.width as number, args.height as number, args.reset === true);
      case 'preview_diagnostics': {
        if (!this.options.bridge?.diagnostics) throw new ExecutionError('UNSUPPORTED_INTERFACE', 'Native diagnostics are not available.');
        const receipt = checkedReceipt(await deadline(this.options.bridge.diagnostics(), 10_000));
        return {
          ...receipt, ...await this.freshness(),
          capabilities: this.availability(),
          nativeReadiness: this.options.bridge.status?.() ?? { available: false },
          diagnosticScope: {
            nativeWarnings: true,
            consoleCaptureRequiresInstrumentedRefresh:
              receipt.diagnosticsAvailability?.console !== 'captured',
            runtimeErrorsPartial:
              receipt.diagnosticsAvailability?.runtimeErrors !== 'captured',
            syntaxErrorsUnavailable:
              receipt.diagnosticsAvailability?.syntax !== 'captured',
            previewFreshnessRequiresAppliedReceipt: this.appliedRevision === undefined,
          },
        };
      }
      case 'capture_page_image': {
        if (!this.options.verified?.capture || !this.options.bridge?.capture) throw new ExecutionError('UNSUPPORTED_INTERFACE', 'Real preview pixels cannot be captured by this verified adapter. DOM reconstruction is not equivalent.');
        const capture = await deadline(this.options.bridge.capture(), 30_000);
        if (!capture || typeof capture.dataUrl !== 'string' || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(capture.dataUrl) || !Number.isInteger(capture.width) || !Number.isInteger(capture.height) || capture.width < 1 || capture.height < 1 || capture.width > 16384 || capture.height > 16384 || capture.dataUrl.length > 1_400_000) throw new ExecutionError('LIMIT_EXCEEDED', 'Native pixel capture has an invalid image or dimensions.');
        return { ...capture, ...await this.freshness() };
      }
      default: throw new ExecutionError('UNSUPPORTED_INTERFACE', 'This is not a preview tool.');
    }
  }
  async freshness(): Promise<{ pendingSrcChanges: boolean; pageFreshnessUnknown: boolean; previewRevision?: string; previewGeneration?: string }> {
    const current = await this.options.revision();
    return { pendingSrcChanges: this.appliedRevision !== undefined && current !== this.appliedRevision, pageFreshnessUnknown: this.appliedRevision === undefined, previewRevision: this.appliedRevision, previewGeneration: this.generation };
  }
  async refresh(preambleJs?: string): Promise<unknown> {
    if (!this.options.bridge) throw new ExecutionError('UNSUPPORTED_INTERFACE', 'Native preview bridge unavailable or not verified.');
    await this.requireCapability('refresh');
    if (preambleJs !== undefined) await this.requireCapability('preamble');
    const expected = await this.options.revision();
    const receipt = checkedReceipt(await deadline(this.options.bridge.refresh(preambleJs), 30_000));
    if (receipt.appliedRevision !== expected || await this.options.revision() !== expected) throw new ExecutionError('NATIVE_CONFLICT', 'Source changed during refresh or the native frame did not attest the intended source revision. Refresh again after inspecting manual edits.', 'PARTIAL');
    this.appliedRevision = expected; this.generation = receipt.previewGeneration;
    if (this.viewport) await this.setViewport(this.viewport.width, this.viewport.height);
    return { ...receipt, ...await this.freshness() };
  }
  async evaluate(js: string, options: { reload?: boolean; timeoutMs?: number; resultPath?: string } = {}): Promise<unknown> {
    if (!this.options.bridge) throw new ExecutionError('UNSUPPORTED_INTERFACE', 'Native preview bridge unavailable or not verified.');
    await this.requireCapability('evaluate');
    const timeout = options.timeoutMs ?? 120_000;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 500_000 || new TextEncoder().encode(js).byteLength > 262_144) throw new ExecutionError('INVALID_INPUT', 'Preview code or timeout exceeds its limit.');
    if (options.reload) await this.refresh();
    const before = await this.options.revision();
    const receipt = checkedReceipt(await deadline(this.options.bridge.evaluate(js, timeout), timeout));
    if (this.generation && receipt.previewGeneration && receipt.previewGeneration !== this.generation) throw new ExecutionError('STALE_EPOCH', 'Preview document changed during evaluation. Inspect diagnostics before another call.', 'UNKNOWN');
    let savedTo: string | undefined;
    if (options.resultPath) {
      if (!this.options.writeFile || typeof receipt.result !== 'string') throw new ExecutionError('INVALID_INPUT', 'resultPath requires a data URL result and Workspace write access.');
      const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(receipt.result);
      if (!match || receipt.result.length > 1_400_000) throw new ExecutionError('INVALID_INPUT', 'Preview result is not a bounded data URL.');
      let data: Uint8Array;
      try { data = match[2] ? Uint8Array.from(atob(match[3]!), c => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(match[3]!)); }
      catch { throw new ExecutionError('INVALID_INPUT', 'Preview returned a malformed data URL.'); }
      if (await this.options.revision() !== before) throw new ExecutionError('STALE_REVISION', 'Source changed before the result file could be written.');
      await this.options.writeFile(options.resultPath, data, before); savedTo = options.resultPath;
    }
    return { ...receipt, ...(savedTo ? { savedTo } : {}), ...await this.freshness() };
  }
  /**
   * The outer iframe style alone is not proof of viewport size. A trusted,
   * exact-frame native evaluateJs reply measures the actual child innerWidth
   * and innerHeight after layout. We never claim success on a CSS-only change.
   */
  private async measuredViewport(): Promise<{width:number;height:number}> {
    if (!this.options.bridge)
      throw new ExecutionError('UNSUPPORTED_INTERFACE',
        'Native preview viewport verification is unavailable.', 'PARTIAL');
    await this.requireCapability('evaluate');
    const receipt=checkedReceipt(await deadline(
      this.options.bridge.evaluate(
        'return ({width: window.innerWidth, height: window.innerHeight});', 5000), 6000));
    const value=receipt.result;
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new ExecutionError('UNSUPPORTED_INTERFACE',
        'Native preview did not provide viewport dimensions.', 'PARTIAL');
    const r=value as {width?:unknown;height?:unknown};
    if (typeof r.width !== 'number' || typeof r.height !== 'number' ||
        !Number.isInteger(r.width) || !Number.isInteger(r.height) ||
        r.width<1 || r.height<1 || r.width>131072 || r.height>131072)
      throw new ExecutionError('UNSUPPORTED_INTERFACE',
        'Native viewport measurement has an invalid shape.', 'PARTIAL');
    return {width:r.width,height:r.height};
  }

  async setViewport(width: number, height: number, reset = false): Promise<unknown> {
    const frame=this.options.frame(),max=this.options.maxViewport??16384;
    if (!frame) throw new ExecutionError('UNSUPPORTED_INTERFACE','Native output frame is unavailable.');
    if (reset) {
      const before=this.nativeBaseline;
      const owned=this.original;
      this.restoreViewport();
      // If native refresh replaced the frame, its inherited styles are not
      // ours to erase. Report an unverified outcome instead of modifying them.
      if (owned && owned.frame!==frame)
        throw new ExecutionError('NATIVE_CONFLICT',
          'Preview iframe changed during viewport emulation. Reset cannot attest the replacement frame.', 'PARTIAL');
      const actual=await this.measuredViewport();
      const observedFrameWidth=frame.clientWidth;
      const parentWidth=frame.parentElement?.clientWidth??0;
      const baselineComparable=before && before.width>0 &&
        before.parentWidth>0 && Math.abs(parentWidth-before.parentWidth)<=2;
      if (baselineComparable && Math.abs(actual.width-before.width)>2)
        throw new ExecutionError('NATIVE_CONFLICT',
          'Viewport reset did not restore the native width in the unchanged editor pane.', 'PARTIAL');
      if (observedFrameWidth>0 && Math.abs(actual.width-observedFrameWidth)>2)
        throw new ExecutionError('NATIVE_CONFLICT',
          'Native iframe width and preview innerWidth disagree after reset.', 'PARTIAL');
      return {reset:true,emulationActive:false,width:actual.width,height:actual.height,
        expectedNativeWidth:baselineComparable?before.width:null,
        verifiedBy:'native-preview-innerWidth',frameClientWidth:observedFrameWidth||null};
    }
    if (!Number.isInteger(width)||!Number.isInteger(height)||width<200||height<150||
        width>Math.min(131072,max)||height>Math.min(131072,max))
      throw new ExecutionError('LIMIT_EXCEEDED',
        `Viewport must be 200–${max} by 150–${max}.`);
    if (!this.original || this.original.frame!==frame) {
      const previous=this.nativeBaseline;
      this.restoreViewport();
      this.nativeBaseline=previous??{
        width:frame.clientWidth,height:frame.clientHeight,
        parentWidth:frame.parentElement?.clientWidth??0,
      };
      this.original={frame,style:frame.getAttribute('style')};
    }
    frame.style.width=`${width}px`;
    frame.style.height=`${height}px`;
    frame.style.maxWidth='none';frame.style.maxHeight='none';
    frame.style.transformOrigin='top left';
    const available=frame.parentElement?.clientWidth??width;
    const scale=Math.min(1,available>0?available/width:1);
    frame.style.transform=`scale(${scale})`;
    this.viewport={width,height};
    const actual=await this.measuredViewport();
    if (Math.abs(actual.width-width)>2 || Math.abs(actual.height-height)>2)
      throw new ExecutionError('NATIVE_CONFLICT',
        'Preview reported different logical dimensions after requested viewport change.', 'PARTIAL');
    return {width:actual.width,height:actual.height,scale,
      emulationActive:true,verifiedBy:'native-preview-innerWidth',measuredBrowserLimit:false};
  }

  restoreViewport(): void {
    if(this.original){
      if(this.original.style===null)this.original.frame.removeAttribute('style');
      else this.original.frame.setAttribute('style',this.original.style);
    }
    this.original=undefined;this.viewport=undefined;this.nativeBaseline=undefined;
  }
}

/** Current public Perchance preview wire protocol, independently reimplemented from factual behavior. */
export interface NativePreviewProtocolOptions {
  host: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  frame(): HTMLIFrameElement | null;
  revision(): Promise<string>;
}
interface NativeSourceStamp { revision: string; panelHash: string; srcHash: string; pending: boolean }
interface NativeRenderReceipt { revision: string; srcRevision: string; epoch: number; srcHasPending: boolean; srcChangedDuringRender: boolean }
interface NativeDiagnosticSnapshot { receipt: NativeRenderReceipt | null; generation: string | null; consoleOutput: string[]; errors: unknown[]; warnings: unknown[]; preambleRan: boolean; }
const NATIVE_DIAGNOSTIC_KEY = '__perchMcpPreviewDiagnosticsV1';
const nativeDiagnosticRead = `return (() => { const p=document.__perchanceInternal||{}, d=document.${NATIVE_DIAGNOSTIC_KEY}; return { receipt:p.renderReceipt||null,generation:d?.generation||null,consoleOutput:d?.logs||[],errors:[...(d?.errors||[]),...(p.perchanceErrorString?[{message:String(p.perchanceErrorString)}]:[])],warnings:Array.isArray(window.codeWarningsArray)?window.codeWarningsArray.slice(0,500):[],preambleRan:p.agentPreambleRan===true }; })();`;
function diagnosticPreamble(generation: string): string {
  return `(() => { const key=${JSON.stringify(NATIVE_DIAGNOSTIC_KEY)}; if(document[key])return; const d={generation:${JSON.stringify(generation)},logs:[],errors:[],bytes:0};Object.defineProperty(document,key,{value:d,configurable:false});const format=v=>{try{return typeof v==='string'?v:(JSON.stringify(v)??String(v))}catch{return '[unserializable]'}};for(const level of ['log','info','warn','error','debug']){const original=console[level].bind(console);console[level]=(...args)=>{const text=level+': '+args.map(format).join(' ');if(d.logs.length<500&&d.bytes+text.length<=65536){d.logs.push(text.slice(0,8192));d.bytes+=text.length}return original(...args)}};window.addEventListener('error',e=>{if(d.errors.length<500)d.errors.push({message:String(e.message||'Runtime error').slice(0,2000),file:String(e.filename||'').slice(0,1000),line:e.lineno||null,column:e.colno||null})});window.addEventListener('unhandledrejection',e=>{if(d.errors.length<500)d.errors.push({message:format(e.reason).slice(0,2000),kind:'unhandledrejection'})});})();`;
}
async function nativeHash(value: unknown): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))))].map(x=>x.toString(16).padStart(2,'0')).join(''); }
function nativeDiagnostics(value: unknown): NativeDiagnosticSnapshot {
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new ExecutionError('UNSUPPORTED_INTERFACE','Native preview diagnostics changed shape.');
  const v=value as Record<string,unknown>;
  if(!Array.isArray(v.consoleOutput)||!v.consoleOutput.every(x=>typeof x==='string')||!Array.isArray(v.errors)||!Array.isArray(v.warnings)) throw new ExecutionError('UNSUPPORTED_INTERFACE','Native preview diagnostics changed shape.');
  const receipt=v.receipt as NativeRenderReceipt|null;
  if(receipt!==null&&(!receipt||typeof receipt.revision!=='string'||!/^[a-f0-9]{64}$/.test(receipt.revision)||typeof receipt.srcRevision!=='string'||!/^[a-f0-9]{64}$/.test(receipt.srcRevision)||!Number.isSafeInteger(receipt.epoch)||receipt.epoch<1||typeof receipt.srcHasPending!=='boolean'||typeof receipt.srcChangedDuringRender!=='boolean')) throw new ExecutionError('UNSUPPORTED_INTERFACE','Native render receipt changed shape.');
  return {receipt,generation:typeof v.generation==='string'?v.generation:null,consoleOutput:(v.consoleOutput as string[]).slice(0,500),errors:v.errors.slice(0,500),warnings:v.warnings.slice(0,500),preambleRan:v.preambleRan===true};
}
/**
 * Sends only native evaluateJs to the exact current output WindowProxy/origin.
 * Native evaluateText is Perchance expression evaluation and is deliberately unused.
 * The caller still gates activation behind real Firefox verification.
 */
export class NativeProtocolPreviewBridge implements PreviewBridge {
  private readonly page: Record<string,unknown>;
  private previousGeneration: string | undefined;
  private knownSource: NativeSourceStamp | undefined;
  private busy=false;
  private evaluateAttested=false;
  status(): Record<string, boolean> {
    const frame=this.options.frame();
    const id=this.page.generatorPublicId;
    const validId=typeof id==='string' && /^[a-z0-9]{16,64}$/.test(id);
    let originMatched=false;
    if(validId && frame?.contentWindow) {
      try { originMatched=new URL(frame.src).origin===`https://${id}.perchance.org`; }
      catch { /* No valid native frame URL. */ }
    }
    const src=this.page.srcState as Record<string, unknown>|undefined;
    return {
      framePresent:Boolean(frame?.contentWindow),
      exactFrameOrigin:originMatched,
      nativeEvaluateProtocolAttested:this.evaluateAttested,
      nativeManifestAvailable:typeof src?.manifestForIframe==='function',
      nativePendingStateAvailable:typeof src?.hasPending==='function',
      nativeHardReloadAvailable:typeof this.page.hardReloadOutputIframe==='function',
      nativePreambleUnoccupied:!this.page.__aiAgentPreambleJs,
    };
  }
  async attest(capability: 'evaluate' | 'refresh' | 'preamble'): Promise<boolean> {
    // For evaluation, prove the native evaluateJs request/reply contract against
    // the exact preview origin and WindowProxy using an inert constant. A forged
    // message cannot pass the existing source, origin and callerId checks.
    this.target();
    if (capability === 'evaluate') {
      const ok=(await this.request('return 6 * 7;', 4000)) === 42;
      this.evaluateAttested=ok;
      return ok;
    }
    // A hard reload will separately attest exact panel/src revision, startup
    // generation and preamble execution before claiming success.
    if (typeof this.page.hardReloadOutputIframe !== 'function') return false;
    await this.source();
    if (capability === 'preamble') {
      const descriptor=Object.getOwnPropertyDescriptor(this.page,'__aiAgentPreambleJs');
      return !this.page.__aiAgentPreambleJs &&
        (!descriptor || ('value' in descriptor ? descriptor.writable !== false : Boolean(descriptor.set)));
    }
    return true;
  }
  constructor(page: unknown, private readonly options: NativePreviewProtocolOptions) {
    if(!page||typeof page!=='object') throw new ExecutionError('UNSUPPORTED_INTERFACE','Native editor window is unavailable.');
    this.page=page as Record<string,unknown>;
  }
  private target(): {frame:HTMLIFrameElement;view:Window;origin:string} {
    const id=this.page.generatorPublicId;
    const frame=this.options.frame();
    if(typeof id!=='string'||!/^[a-z0-9]{16,64}$/.test(id)||!frame?.contentWindow) throw new ExecutionError('UNSUPPORTED_INTERFACE','The native preview identity is not ready.');
    const origin=`https://${id}.perchance.org`;
    let actual:URL;try{actual=new URL(frame.src)}catch{throw new ExecutionError('BINDING_MISMATCH','Native preview URL is invalid.')}
    if(actual.origin!==origin)throw new ExecutionError('BINDING_MISMATCH','Native preview origin differs from the bound Public ID.');
    return {frame,view:frame.contentWindow,origin};
  }
  private async source():Promise<NativeSourceStamp> {
    const p=this.page as {modelTextEditor?:{getValue?:()=>unknown};outputTemplateEditor?:{getValue?:()=>unknown};app?:{data?:{generator?:{name?:unknown}}};srcState?:{ready?:()=>unknown;idle?:()=>unknown;manifestForIframe?:()=>unknown;hasPending?:()=>unknown}};
    if(typeof p.modelTextEditor?.getValue!=='function'||typeof p.outputTemplateEditor?.getValue!=='function'||typeof p.app?.data?.generator?.name!=='string'||typeof p.srcState?.manifestForIframe!=='function'||typeof p.srcState.hasPending!=='function')throw new ExecutionError('UNSUPPORTED_INTERFACE','Native source/manifest capability changed.');
    await p.srcState.ready?.();await p.srcState.idle?.();
    const before=await this.options.revision(),mt=p.modelTextEditor.getValue(),ot=p.outputTemplateEditor.getValue(),name=p.app.data.generator.name;
    const manifest=p.srcState.manifestForIframe();
    if(typeof mt!=='string'||typeof ot!=='string'||!manifest||typeof manifest!=='object'||Array.isArray(manifest)||Object.keys(manifest).length>1000)throw new ExecutionError('UNSUPPORTED_INTERFACE','Native source/manifest shape changed.');
    const identity=Object.keys(manifest).sort().map(path=>{const entry=(manifest as Record<string,unknown>)[path] as {key?:unknown}|null;const key=entry?.key||null;if(key!==null&&typeof key!=='string')throw new ExecutionError('UNSUPPORTED_INTERFACE','Native src key changed shape.');return[path,key]});
    const [panelHash,srcHash]=await Promise.all([nativeHash([name,mt,ot]),nativeHash(identity)]);
    if(await this.options.revision()!==before)throw new ExecutionError('STALE_REVISION','Native source changed during preview preflight.');
    return {revision:before,panelHash,srcHash,pending:p.srcState.hasPending()===true};
  }
  private request(js:string,timeoutMs:number):Promise<unknown> {
    const {frame,view,origin}=this.target(),callerId=`perch-${crypto.randomUUID()}`;
    return new Promise((resolve,reject)=>{
      let settled=false;
      const finish=(error?:ExecutionError,result?:unknown)=>{if(settled)return;settled=true;clearTimeout(timer);this.options.host.removeEventListener('message',message as EventListener);frame.removeEventListener('load',loaded);error?reject(error):resolve(result)};
      const loaded=()=>finish(new ExecutionError('STALE_EPOCH','Native preview document reloaded during evaluation.','UNKNOWN'));
      const timer=setTimeout(()=>finish(new ExecutionError('TIMEOUT','Native preview did not answer. Reload a frozen preview manually; do not replay uncertain effects.','UNKNOWN')),timeoutMs);
      const message=(event:MessageEvent)=>{
        if(event.origin!==origin||event.source!==view||this.options.frame()!==frame||frame.contentWindow!==view)return;
        const data=event.data as Record<string,unknown>|null;
        if(!data||typeof data!=='object'||data.callerId!==callerId||data.type!=='evaluateJsResponse')return;
        try{
          const current=this.target();if(current.frame!==frame||current.view!==view||current.origin!==origin){finish(new ExecutionError('BINDING_MISMATCH','Native preview target changed before its reply.','UNKNOWN'));return}
          if(data.error!==null&&data.error!==undefined&&typeof data.error!=='string'){finish(new ExecutionError('UNSUPPORTED_INTERFACE','Native evaluation error shape changed.','UNKNOWN'));return}
          if(typeof data.error==='string'&&data.error){finish(new ExecutionError('PROVIDER_REJECTED',data.error.slice(0,500),'PARTIAL'));return}
          const serialized=JSON.stringify(data.result??null);
          if(new TextEncoder().encode(serialized).byteLength>262144){finish(new ExecutionError('LIMIT_EXCEEDED','Native evaluation result exceeds 256 KiB.','PARTIAL'));return}
          finish(undefined,JSON.parse(serialized) as unknown);
        }catch(error){finish(error instanceof ExecutionError?error:new ExecutionError('UNSUPPORTED_INTERFACE','Native evaluation reply changed shape.','UNKNOWN'))}
      };
      this.options.host.addEventListener('message',message as EventListener);frame.addEventListener('load',loaded,{once:true});
      try{view.postMessage({command:'evaluateJs',callerId,js},origin)}catch{finish(new ExecutionError('UNSUPPORTED_INTERFACE','Browser refused the fixed native preview command.'))}
    });
  }
  /**
   * The editor's own syntax collector is independent of the preview iframe
   * preamble. Only report exact path/line/column for recognized native rows.
   * Unrecognized rows are kept as partial evidence, never fabricated ranges.
   */
  private async withEditorSyntax(receipt:PreviewReceipt):Promise<PreviewReceipt> {
    const getter=this.page.getEditorSyntaxErrors;
    const availability={...receipt.diagnosticsAvailability,syntax:'unavailable'};
    if(typeof getter!=='function')
      return {...receipt,diagnosticsAvailability:availability,
        diagnosticChannels:{editorSyntax:'unavailable',console:'preview-iframe',nativeWarnings:'native-editor'}};
    const sourceBefore=await this.options.revision();
    let raw:unknown;
    try { raw=await Promise.resolve((getter as ()=>unknown).call(this.page)); }
    catch { return {...receipt,diagnosticsAvailability:availability,
      diagnosticChannels:{editorSyntax:'collector-failed',console:'preview-iframe',nativeWarnings:'native-editor'}}; }
    if(await this.options.revision()!==sourceBefore)
      throw new ExecutionError('STALE_REVISION',
        'Native editor changed during syntax collection. Diagnostics were not attributed to a stale revision.');
    if(!Array.isArray(raw)||raw.length>500)
      return {...receipt,diagnosticsAvailability:availability,
        diagnosticChannels:{editorSyntax:'unsupported-result',console:'preview-iframe',nativeWarnings:'native-editor'}};
    let precise=true;
    const errors:Record<string,unknown>[]=[];
    for(const entry of raw){
      if(!entry||typeof entry!=='object'||Array.isArray(entry)) {precise=false;continue;}
      const e=entry as Record<string,unknown>;
      const name=typeof e.message==='string'?e.message:typeof e.error==='string'?e.error:null;
      if(name===null){precise=false;continue;}
      const source=e.path??e.file??e.pane??e.type;
      const path=source==='main.pjs'||source==='model'||source==='pjs'
        ? 'main.pjs' : source==='index.html'||source==='output'||source==='html'
          ? 'index.html' : null;
      const line=e.line??e.lineNumber;
      const column=e.column??e.col;
      const validLine=Number.isSafeInteger(line) && (line as number)>0 && (line as number)<=1000000;
      const validColumn=Number.isSafeInteger(column) && (column as number)>0 && (column as number)<=1000000;
      if(!path||!validLine)precise=false;
      errors.push({category:'editor-syntax',message:name.slice(0,2000),
        path, line:validLine?line:null,column:validColumn?column:null,
        locationVerified:false,locationProvenance:'native-unverified',
        sourceRevision:sourceBefore});
    }
    // A non-empty well-formed native error is evidence of capture, not proof
    // of exact source-map fidelity. An empty array remains partial coverage
    // until a deliberately malformed live disposable source is verified.
    availability.syntax=precise&&errors.length>0?'captured':'partial';
    return {...receipt,syntaxErrors:errors,diagnosticsAvailability:availability,
      diagnosticChannels:{editorSyntax:availability.syntax,console:'preview-iframe',
        nativeWarnings:'native-editor',syntaxSourceRevision:sourceBefore}};
  }

  private receipt(d:NativeDiagnosticSnapshot,result?:unknown):PreviewReceipt {
    const native=d.receipt,applied=this.knownSource&&native&&native.revision===this.knownSource.panelHash&&native.srcRevision===this.knownSource.srcHash&&!native.srcChangedDuringRender?this.knownSource.revision:undefined;
    const generation=d.generation&&native?`${d.generation}:${native.epoch}`:undefined;
    if(this.previousGeneration&&generation!==this.previousGeneration)throw new ExecutionError('STALE_EPOCH','Native preview generation changed; refresh explicitly.');
    return {consoleOutput:d.consoleOutput,perchanceErrors:d.errors,syntaxErrors:[],...(applied?{appliedRevision:applied}:{}),...(generation?{previewGeneration:generation}:{}),...(arguments.length>1?{result}:{}),warnings:d.warnings,diagnosticsAvailability:{console:d.generation?'captured':'unavailable',runtimeErrors:d.generation?'captured':'partial',syntax:'unavailable',warnings:'native'}} as PreviewReceipt;
  }
  async refresh(preambleJs?:string):Promise<PreviewReceipt> {
    if(this.busy)throw new ExecutionError('TAB_BUSY','A native preview operation is already active.');
    if(typeof this.page.hardReloadOutputIframe!=='function')throw new ExecutionError('UNSUPPORTED_INTERFACE','Native hardReloadOutputIframe is unavailable.');
    if(this.page.currentlyReloadingOutputIframePromise)throw new ExecutionError('TAB_BUSY','A native preview reload is already pending.');
    const previous=Object.getOwnPropertyDescriptor(this.page,'__aiAgentPreambleJs');
    if(previous&&('value' in previous?previous.writable===false:!previous.set))throw new ExecutionError('UNSUPPORTED_INTERFACE','Native preamble hook is not writable.');
    if(this.page.__aiAgentPreambleJs)throw new ExecutionError('TAB_BUSY','A native preamble is already installed. Wait for its owner to finish.');
    const before=await this.source(),generation=crypto.randomUUID();this.target();
    this.busy=true;
    try{
      this.page.__aiAgentPreambleJs=diagnosticPreamble(generation)+(preambleJs===undefined?'':`\n${preambleJs}\n`);
      await deadline(Promise.resolve((this.page.hardReloadOutputIframe as ()=>unknown).call(this.page)),30000);
      let d:NativeDiagnosticSnapshot|undefined;
      for(let attempt=0;attempt<20;attempt++){
        d=nativeDiagnostics(await this.request(nativeDiagnosticRead,1000));
        if(d.receipt&&d.generation===generation)break;
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      const after=await this.source();
      if(!d?.receipt||d.generation!==generation||!d.preambleRan||d.receipt.revision!==before.panelHash||d.receipt.srcRevision!==before.srcHash||d.receipt.srcChangedDuringRender||d.receipt.srcHasPending!==before.pending||after.revision!==before.revision||after.panelHash!==before.panelHash||after.srcHash!==before.srcHash||after.pending!==before.pending)throw new ExecutionError('NATIVE_CONFLICT','Native preview did not attest the intended panels, src manifest and startup generation.','PARTIAL');
      this.knownSource=before;this.previousGeneration=`${generation}:${d.receipt.epoch}`;
      return this.withEditorSyntax(this.receipt(d));
    }finally{
      if(previous)Object.defineProperty(this.page,'__aiAgentPreambleJs',previous);else delete this.page.__aiAgentPreambleJs;
      this.busy=false;
    }
  }
  async evaluate(js:string,timeoutMs:number):Promise<PreviewReceipt> {
    if(this.busy)throw new ExecutionError('TAB_BUSY','A native preview operation is already active.');
    this.busy=true;
    try{
      const before=nativeDiagnostics(await this.request(nativeDiagnosticRead,Math.min(timeoutMs,5000)));
      if(this.previousGeneration)this.receipt(before);
      const result=await this.request(js,timeoutMs);
      const after=nativeDiagnostics(await this.request(nativeDiagnosticRead,Math.min(timeoutMs,5000)));
      if(before.generation!==after.generation||before.receipt?.epoch!==after.receipt?.epoch)throw new ExecutionError('STALE_EPOCH','Native preview changed during evaluation.','UNKNOWN');
      return this.withEditorSyntax(this.receipt(after,result));
    }finally{this.busy=false}
  }
  async diagnostics():Promise<PreviewReceipt>{return this.withEditorSyntax(this.receipt(nativeDiagnostics(await this.request(nativeDiagnosticRead,5000))))}
}

/** Returns an exact protocol candidate; options are required to validate the native frame boundary. */
export function createNativePreviewBridge(page:unknown,options?:NativePreviewProtocolOptions):PreviewBridge|undefined {
  if(!page||typeof page!=='object'||!options)return undefined;
  return new NativeProtocolPreviewBridge(page,options);
}
