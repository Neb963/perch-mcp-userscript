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
  measureViewport?(timeoutMs: number): Promise<unknown>;
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
  requireDocumentProof?: boolean;
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
  private nativeBaseline: { width: number; height: number; parentWidth: number; parentHeight: number } | undefined;
  private viewport: { width: number; height: number } | undefined;
  private readonly attested = new Set<'refresh' | 'evaluate' | 'preamble'>();
  private readonly failedAttestation = new Set<'refresh' | 'evaluate' | 'preamble'>();
  private attestedFrame: HTMLIFrameElement | null = null;
  private verifiedAt = new Map<'refresh' | 'evaluate' | 'preamble',number>();
  private viewportResetTimer?: ReturnType<typeof setTimeout>;
  private readonly viewportIdleMs = 45000;
  private previewBusy = 0;
  private documentEpoch = 0;
  private readonly onFrameLoad = () => this.invalidateDocument();
  private invalidateDocument(): void {
    this.invalidateAttestation();
    this.appliedRevision = undefined;
    this.generation = undefined;
    this.documentEpoch++;
  }
  currentEpoch(): number {
    this.syncAttestationFrame();
    return this.documentEpoch;
  }
  dispose(): void {
    this.restoreViewport();
    this.attestedFrame?.removeEventListener('load',this.onFrameLoad);
    this.attestedFrame = null;
    this.invalidateDocument();
  }
  private invalidateAttestation(): void {
    this.attested.clear(); this.failedAttestation.clear(); this.verifiedAt.clear();
  }
  private syncAttestationFrame(): void {
    const frame = this.options.frame();
    if (frame !== this.attestedFrame) {
      this.attestedFrame?.removeEventListener('load',this.onFrameLoad);
      this.invalidateDocument();
      this.attestedFrame = frame;
      frame?.addEventListener('load',this.onFrameLoad);
    }
  }
  constructor(private readonly options: PreviewOptions) {}
  private async requireCapability(capability: 'refresh' | 'evaluate' | 'preamble'): Promise<void> {
    this.syncAttestationFrame();
    const frame = this.attestedFrame;
    if (this.options.verified?.[capability]) return;
    // The old implementation re-sent a native handshake on *every* preview
    // call even after attestation. Under a busy reload this intermittently
    // reported an otherwise working interface as unsupported. Bound cache
    // is invalidated on iframe load and expires after 15 seconds.
    if (this.attested.has(capability) &&
        Date.now() - (this.verifiedAt.get(capability) ?? 0) < 15000) return;
    try {
      if (!this.options.bridge?.attest || !(await this.options.bridge.attest(capability)))
        throw new ExecutionError('UNSUPPORTED_INTERFACE',
          `Native preview ${capability} capability could not be verified on the exact bound output frame.`);
      this.syncAttestationFrame();
      if (this.attestedFrame !== frame)
        throw new ExecutionError('STALE_EPOCH', 'Preview iframe changed during capability attestation.');
      this.attested.add(capability);
      this.verifiedAt.set(capability,Date.now());
      this.failedAttestation.delete(capability);
    } catch (error) {
      this.attested.delete(capability);
      this.verifiedAt.delete(capability);
      this.failedAttestation.add(capability);
      throw error;
    }
  }
  availability(): Record<string, { available: boolean; state: 'available'|'not-yet-attested'|'probe-failed'|'unavailable'; reason?: string }> {
    this.syncAttestationFrame();
    const available = (enabled: boolean, reason: string) => enabled
      ? { available:true, state:'available' as const }
      : { available:false, state:'unavailable' as const, reason };
    const capability = (key: 'evaluate'|'refresh', reason: string) => {
      if (this.options.bridge && (this.options.verified?.[key] || (this.attested.has(key) &&
        Date.now()-(this.verifiedAt.get(key)??0)<15000)))
        return available(true, reason);
      if (!this.options.bridge?.attest || !this.options.frame()) return available(false, reason);
      return {available:false,
        state:this.failedAttestation.has(key)?'probe-failed' as const:'not-yet-attested' as const,
        reason};
    };
    return {
      page_eval: capability('evaluate', 'Native preview evaluation requires a response-correlated probe on the bound frame.'),
      page_refresh: capability('refresh', 'Native preview refresh requires structural capability and source-receipt verification.'),
      preview_diagnostics: available(Boolean(this.options.bridge?.diagnostics), 'No verified native diagnostics collector is attached.'),
      set_viewport_size: available(Boolean(this.options.frame()), 'The native output frame is unavailable.'),
      capture_page_image: available(Boolean(this.options.verified?.capture && this.options.bridge?.capture), 'No real-pixel native capture or consented capture adapter is verified.'),
    };
  }
  supports(name: string): boolean { return this.availability()[name]?.available ?? false; }
  /** Read-only preflight for workspace_status; an absent native frame is a
   * capability result, not a Workspace-wide failure or a mutation attempt. */
  async preflight(): Promise<void> {
    if (!this.options.bridge || !this.options.frame()) return;
    for (const capability of ['evaluate','refresh'] as const) {
      try { await this.requireCapability(capability); }
      catch { /* Detailed unavailability remains exposed in availability(). */ }
    }
  }
  private async whilePreviewBusy<T>(task:()=>Promise<T>):Promise<T> {
    this.previewBusy++;
    try { return await task(); }
    finally { this.previewBusy--; if(this.viewport)this.armViewportReset(); }
  }
  private armViewportReset(): void {
    if (this.viewportResetTimer) clearTimeout(this.viewportResetTimer);
    if (!this.viewport) return;
    this.viewportResetTimer = setTimeout(() => {
      this.viewportResetTimer = undefined;
      if (this.previewBusy > 0) { this.armViewportReset(); return; }
      // Restore CSS only; never perform an unattended native provider action.
      this.restoreViewport();
    },this.viewportIdleMs);
    (this.viewportResetTimer as unknown as {unref?:()=>void}).unref?.();
  }
  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (name !== 'set_viewport_size' && this.viewport) this.armViewportReset();
    switch (name) {
      case 'page_refresh': return this.whilePreviewBusy(()=>this.refresh(body(args, 'preambleJs')));
      case 'page_eval': {
        const js = body(args, 'js'), path = body(args, 'path');
        if ((js === undefined) === (path === undefined)) throw new ExecutionError('INVALID_INPUT', 'Provide exactly one of js or path.');
        const source = js ?? (this.options.readText ? await this.options.readText(path!) : undefined);
        if (source === undefined) throw new ExecutionError('UNSUPPORTED_INTERFACE', 'Workspace code-file access is unavailable.');
        return this.whilePreviewBusy(()=>this.evaluate(source, { reload: args.reload === true, timeoutMs: args.timeoutMs as number | undefined, resultPath: body(args, 'resultPath') }));
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
    this.syncAttestationFrame();
    return { pendingSrcChanges: this.appliedRevision !== undefined && current !== this.appliedRevision, pageFreshnessUnknown: this.appliedRevision === undefined, previewRevision: this.appliedRevision, previewGeneration: this.generation };
  }
  async refresh(preambleJs?: string): Promise<unknown> {
    if (this.viewport) this.armViewportReset();
    if (!this.options.bridge) throw new ExecutionError('UNSUPPORTED_INTERFACE', 'Native preview bridge unavailable or not verified.');
    await this.requireCapability('refresh');
    if (preambleJs !== undefined) await this.requireCapability('preamble');
    const expected = await this.options.revision();
    this.appliedRevision = undefined;
    this.generation = undefined;
    const receipt = checkedReceipt(await deadline(this.options.bridge.refresh(preambleJs), 30_000));
    if (receipt.appliedRevision !== expected || await this.options.revision() !== expected ||
        (this.options.requireDocumentProof && !receipt.previewGeneration)) throw new ExecutionError('NATIVE_CONFLICT', 'Source changed during refresh or the native frame did not attest the intended source revision. Refresh again after inspecting manual edits.', 'PARTIAL');
    this.syncAttestationFrame();
    this.appliedRevision = expected; this.generation = receipt.previewGeneration;
    this.attested.add('refresh');
    if (this.viewport) await this.setViewport(this.viewport.width, this.viewport.height);
    return { ...receipt, ...await this.freshness() };
  }
  async evaluate(js: string, options: { reload?: boolean; timeoutMs?: number; resultPath?: string } = {}): Promise<unknown> {
    if (this.viewport) this.armViewportReset();
    if (!this.options.bridge) throw new ExecutionError('UNSUPPORTED_INTERFACE', 'Native preview bridge unavailable or not verified.');
    await this.requireCapability('evaluate');
    const timeout = options.timeoutMs ?? 120_000;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 500_000 || new TextEncoder().encode(js).byteLength > 262_144) throw new ExecutionError('INVALID_INPUT', 'Preview code or timeout exceeds its limit.');
    if (options.reload) await this.refresh();
    const before = await this.options.revision();
    const epoch = this.currentEpoch();
    const expectedGeneration = this.generation;
    const receipt = checkedReceipt(await deadline(this.options.bridge.evaluate(js, timeout), timeout));
    if (epoch !== this.currentEpoch() || (expectedGeneration &&
        (this.options.requireDocumentProof || receipt.previewGeneration) && receipt.previewGeneration !== expectedGeneration)) throw new ExecutionError('STALE_EPOCH', 'Preview document changed during evaluation. Inspect diagnostics before another call.', 'UNKNOWN');
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
  private async measuredViewport(timeoutMs: number): Promise<{width:number;height:number}> {
    if (!this.options.bridge)
      throw new ExecutionError('UNSUPPORTED_INTERFACE',
        'Native preview viewport verification is unavailable.', 'PARTIAL');
    const bridge = this.options.bridge;
    const value = bridge.measureViewport
      ? await deadline(bridge.measureViewport(timeoutMs), timeoutMs)
      : checkedReceipt(await deadline(bridge.evaluate(
          'return ({width: window.innerWidth, height: window.innerHeight});', timeoutMs), timeoutMs)).result;
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

  /** Let CSS layout and the frame viewport settle without depending on a
   * foreground requestAnimationFrame (which may be suspended in hidden tabs). */
  private async settleViewportLayout(frame:HTMLIFrameElement):Promise<void> {
    await new Promise<void>(resolve=>{
      let ended=false;
      const finish=()=>{if(ended)return;ended=true;clearTimeout(limit);resolve();};
      const limit=setTimeout(finish,120);
      const view=frame.ownerDocument.defaultView;
      if(view && typeof view.requestAnimationFrame==='function')
        view.requestAnimationFrame(()=>view.requestAnimationFrame(finish));
      else setTimeout(finish,24);
    });
  }

  /**
   * CSS updates and child viewport resizing are asynchronous in Firefox.
   * Measure the exact frame until both dimensions match the current outer
   * layout for two consecutive samples. A stale or replaced document cannot
   * satisfy the verification, even if it returns the requested dimensions.
   */
  private async verifyViewport(
    frame: HTMLIFrameElement,
    expected: () => {width:number;height:number},
    action: 'set' | 'reset',
  ): Promise<{width:number;height:number;attempts:number}> {
    const stop = performance.now() + 5000;
    let changed = false, attempts = 0, stable = 0;
    let actual: {width:number;height:number} | undefined;
    let previousTarget: {width:number;height:number} | undefined;
    const loaded = () => { changed = true; };
    frame.addEventListener('load', loaded);
    const stillBound = () => !changed && this.options.frame() === frame;
    const conflict = () => new ExecutionError('NATIVE_CONFLICT',
      `Viewport ${action}: preview iframe changed during layout verification; no stable dimensions verified. Persistent effects: none.`, 'PARTIAL');
    try {
      await this.settleViewportLayout(frame);
      while (performance.now() < stop && attempts < 24) {
        if (!stillBound()) throw conflict();
        attempts++;
        const remaining = Math.max(1, Math.floor(stop - performance.now()));
        try { actual = await this.measuredViewport(remaining); }
        catch {
          if (!stillBound()) throw conflict();
          throw new ExecutionError('NATIVE_CONFLICT',
            `Viewport ${action}: native child dimensions could not be measured before the deadline. Persistent effects: none.`, 'PARTIAL');
        }
        if (!stillBound()) throw conflict();
        const target = expected();
        const comparable = target.width > 0 && target.height > 0;
        const matches = comparable && Math.abs(actual.width - target.width) <= 2 &&
          Math.abs(actual.height - target.height) <= 2;
        stable = matches ? (previousTarget && previousTarget.width === target.width &&
          previousTarget.height === target.height ? stable + 1 : 1) : 0;
        previousTarget = target;
        if (stable >= 2) return {...actual, attempts};
        const wait = Math.min(250, 25 * 2 ** Math.min(attempts - 1, 4), stop - performance.now());
        if (wait > 0) await new Promise<void>(resolve => setTimeout(resolve, wait));
      }
      const target = expected();
      throw new ExecutionError('NATIVE_CONFLICT',
        `Viewport ${action}: expected ${target.width}x${target.height}px, observed ${actual?.width ?? 0}x${actual?.height ?? 0}px after ${attempts} samples; child layout did not converge. Persistent effects: none.`, 'PARTIAL');
    } finally { frame.removeEventListener('load', loaded); }
  }

  async setViewport(width: number, height: number, reset = false): Promise<unknown> {
    const frame = this.options.frame(), max = this.options.maxViewport ?? 16384;
    if (!frame) throw new ExecutionError('UNSUPPORTED_INTERFACE', 'Native output frame is unavailable.');
    if (reset) {
      if (this.viewportResetTimer) clearTimeout(this.viewportResetTimer);
      this.viewportResetTimer=undefined;
      const before = this.original?.frame === frame ? this.nativeBaseline : undefined;
      this.restoreViewport();
      // Restoring our CSS is safe even if the child is frozen; it is not
      // proof that the iframe has actually processed the resize.
      try { await this.requireCapability('evaluate'); }
      catch { throw new ExecutionError('NATIVE_CONFLICT',
        'Viewport reset: CSS restored but native viewport verification is unavailable. Persistent effects: none.', 'PARTIAL'); }
      const target = () => ({
        width: frame.clientWidth || (before && before.parentWidth > 0 &&
          Math.abs((frame.parentElement?.clientWidth ?? 0) - before.parentWidth) <= 2 ? before.width : 0),
        height: frame.clientHeight || (before && before.parentHeight > 0 &&
          Math.abs((frame.parentElement?.clientHeight ?? 0) - before.parentHeight) <= 2 ? before.height : 0),
      });
      const actual = await this.verifyViewport(frame, target, 'reset');
      const expectedNative = target();
      return {reset:true, emulationActive:false, width:actual.width, height:actual.height,
        expectedNativeWidth:expectedNative.width, expectedNativeHeight:expectedNative.height,
        verifiedBy:'native-preview-innerWidth', frameClientWidth:frame.clientWidth||null,
        frameClientHeight:frame.clientHeight||null, measurementAttempts:actual.attempts};
    }
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 200 || height < 150 ||
        width > Math.min(131072,max) || height > Math.min(131072,max))
      throw new ExecutionError('LIMIT_EXCEEDED', `Viewport must be 200–${max} by 150–${max}.`);
    await this.requireCapability('evaluate');
    if (this.options.frame() !== frame)
      throw new ExecutionError('NATIVE_CONFLICT', 'Native iframe changed before viewport mutation.');
    if (!this.original || this.original.frame !== frame) {
      this.restoreViewport();
      this.nativeBaseline = {
        width:frame.clientWidth, height:frame.clientHeight,
        parentWidth:frame.parentElement?.clientWidth??0, parentHeight:frame.parentElement?.clientHeight??0,
      };
      this.original = {frame,style:frame.getAttribute('style')};
    }
    frame.style.width = `${width}px`;
    frame.style.height = `${height}px`;
    frame.style.maxWidth = 'none'; frame.style.maxHeight = 'none';
    frame.style.transformOrigin = 'top left';
    const available = frame.parentElement?.clientWidth ?? width;
    const scale = Math.min(1, available > 0 ? available / width : 1);
    frame.style.transform = `scale(${scale})`;
    this.viewport = {width,height};
    this.previewBusy++;
    try {
      const actual = await this.verifyViewport(frame, () => ({width,height}), 'set');
      return {width:actual.width,height:actual.height,scale,emulationActive:true,
        verifiedBy:'native-preview-innerWidth',measuredBrowserLimit:false,measurementAttempts:actual.attempts,
        autoResetAfterIdleMs:this.viewportIdleMs};
    } catch(error) {
      // A failed sizing request cannot leave the human editor looking broken.
      this.restoreViewport();
      throw error;
    } finally { this.previewBusy--; this.armViewportReset(); }
  }

  restoreViewport(): void {
    if(this.viewportResetTimer) clearTimeout(this.viewportResetTimer);
    this.viewportResetTimer=undefined;
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
    const panes: Record<string, 'main.pjs'|'index.html'> = {
      'main.pjs':'main.pjs', pjs:'main.pjs', model:'main.pjs',
      modelText:'main.pjs', modelTextErrors:'main.pjs', modelTextEditor:'main.pjs',
      'index.html':'index.html', html:'index.html', output:'index.html',
      outputTemplate:'index.html', outputTemplateErrors:'index.html', outputTemplateEditor:'index.html',
    };
    let rows: {entry:unknown;pathHint?:'main.pjs'|'index.html'}[] = [];
    let shape = 'unknown';
    let partialShape = false;
    if (Array.isArray(raw) && raw.length <= 500) {
      rows = raw.map(entry => ({entry})); shape = 'array';
    } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const record = raw as Record<string,unknown>;
      const keys = Object.keys(record);
      if (keys.length <= 24) {
        for (const key of keys) {
          const pathHint = Object.hasOwn(panes,key) ? panes[key] : undefined;
          if (!pathHint && key !== 'errors' && key !== 'syntaxErrors') { partialShape = true; continue; }
          const values = record[key];
          if (!Array.isArray(values) || values.length > 500 || rows.length + values.length > 500) {
            partialShape = true; continue;
          }
          shape = 'grouped-arrays';
          rows.push(...values.map(entry => ({entry,pathHint})));
        }
      }
    }
    if (shape === 'unknown')
      return {...receipt,diagnosticsAvailability:availability,
        diagnosticChannels:{editorSyntax:'unsupported-result',editorSyntaxShape:
          raw===null?'null':Array.isArray(raw)?'oversized-array':typeof raw,
          console:'preview-iframe',nativeWarnings:'native-editor'}};
    let precise=!partialShape;
    const errors:Record<string,unknown>[]=[];
    for(const {entry,pathHint} of rows){
      if(typeof entry === 'string') {
        precise=false; errors.push({category:'editor-syntax',message:entry.slice(0,2000),path:pathHint??null,line:null,column:null,locationVerified:false,locationProvenance:'native-unverified',sourceRevision:sourceBefore}); continue;
      }
      if(!entry||typeof entry!=='object'||Array.isArray(entry)) {precise=false;continue;}
      const e=entry as Record<string,unknown>;
      const name=typeof e.message==='string'?e.message:typeof e.error==='string'?e.error:null;
      if(name===null){precise=false;continue;}
      const source=e.path??e.file??e.pane??e.type;
      const explicitPath=typeof source==='string'&&Object.hasOwn(panes,source)?panes[source]:undefined;
      const conflict=explicitPath && pathHint && explicitPath!==pathHint;
      const path=conflict?null:explicitPath??pathHint??null;
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
      diagnosticChannels:{editorSyntax:availability.syntax,editorSyntaxShape:shape,console:'preview-iframe',
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
  async measureViewport(timeoutMs: number): Promise<unknown> {
    // A geometry probe needs one fixed native request, not the general eval
    // pipeline (which performs extra diagnostics and editor syntax calls).
    const result = await this.request(`return (()=>{const d=document.${NATIVE_DIAGNOSTIC_KEY},r=document.__perchanceInternal?.renderReceipt;return {width:window.innerWidth,height:window.innerHeight,generation:d?.generation&&r?d.generation+':'+r.epoch:null};})();`, timeoutMs);
    if (this.previousGeneration && (!result || typeof result !== 'object' ||
        (result as {generation?:unknown}).generation !== this.previousGeneration))
      throw new ExecutionError('STALE_EPOCH', 'Native preview generation changed during geometry verification.', 'PARTIAL');
    return result;
  }
  async diagnostics():Promise<PreviewReceipt>{return this.withEditorSyntax(this.receipt(nativeDiagnostics(await this.request(nativeDiagnosticRead,5000))))}
}

/** Returns an exact protocol candidate; options are required to validate the native frame boundary. */
export function createNativePreviewBridge(page:unknown,options?:NativePreviewProtocolOptions):PreviewBridge|undefined {
  if(!page||typeof page!=='object'||!options)return undefined;
  return new NativeProtocolPreviewBridge(page,options);
}
