import type { BrowserToolV2 } from '../../../packages/contracts/src/development-v2.js';
import { ExecutionError } from './compute.js';
import type { DevelopmentContext } from './development-v2.js';
import { FilesystemV2, type FilesystemCallScope } from './filesystem-v2.js';
import { BrowserError, bytesToBase64, digest, utf8 } from './native-types.js';
import { createNativePreviewBridge, PreviewAdapter } from './preview.js';

interface Diagnostic {
  sequence: number;
  channel: string;
  content: string;
  bytes: number;
}
export const CAPTURE_UNAVAILABLE = 'No verified userscript interface can identify and crop actual pixels of the current preview. Firefox display capture requires operator selection and does not supply positive identity proof for this preview.';

export class DevelopmentPreview {
  readonly preview: PreviewAdapter;
  private diagnostics: Diagnostic[] = [];
  private epoch = 0;
  private sequence = 0;
  private dropped = 0;
  private retainedBytes = 0;
  constructor(page: unknown, document: Document, revision: () => Promise<string>) {
    const frame = () => document.querySelector<HTMLIFrameElement>('#outputIframeEl');
    this.preview = new PreviewAdapter({frame,revision,
      bridge:createNativePreviewBridge(page,{host:document.defaultView!,frame,revision}),
      requireDocumentProof:true,
    });
  }
  dispose() { this.preview.dispose(); }
  private observeEpoch() {
    const epoch = this.preview.currentEpoch();
    if (this.epoch !== epoch) {
      this.epoch = epoch;
      this.sequence = 0;
      this.dropped = 0;
      this.retainedBytes = 0;
      this.diagnostics = [];
    }
    return epoch;
  }
  private record(result: Record<string,unknown>) {
    this.observeEpoch();
    for (const channel of ['consoleOutput','perchanceErrors','syntaxErrors','warnings']) {
      const input = result[channel];
      if (!Array.isArray(input)) continue;
      for (const entry of input) {
        const raw = typeof entry === 'string' ? entry : JSON.stringify(entry);
        if (typeof raw !== 'string') continue;
        const content = raw.replace(/Bearer +[A-Za-z0-9._~+=/-]+/gi,'Bearer [redacted]')
          .replace(/(https?:\/\/[^\s?]+)\?[^\s]+/g,'$1?[redacted]').slice(0,1024);
        const bytes = utf8.encode(content).length;
        const tail = this.diagnostics.at(-1);
        if (tail?.channel === channel && tail.content === content) continue;
        this.diagnostics.push({sequence:++this.sequence,channel,content,bytes});
        this.retainedBytes += bytes;
        while (this.diagnostics.length > 1000 || this.retainedBytes > 262_144) {
          this.retainedBytes -= this.diagnostics.shift()!.bytes;
          this.dropped++;
        }
      }
    }
  }
  async run(name: BrowserToolV2, args: Record<string,unknown>, context: DevelopmentContext, scope: FilesystemCallScope) {
    await context.assertCurrent();
    const initialEpoch = this.observeEpoch();
    if (name==='capture_page_image')
      throw new BrowserError('UNSUPPORTED_INTERFACE',CAPTURE_UNAVAILABLE);
    if (name==='preview_diagnostics') {
      const cursor = args.cursor as {previewEpoch:number;lastSequence:number} | undefined;
      if ((args.previewEpoch !== undefined && args.previewEpoch !== initialEpoch) ||
          (cursor && cursor.previewEpoch !== initialEpoch))
        throw new BrowserError('STALE_EPOCH','Preview document changed. Restart diagnostics with the current epoch.');
      const receipt = await this.preview.call(name,{}) as Record<string,unknown>;
      this.record(receipt);
      if (this.epoch !== initialEpoch)
        throw new BrowserError('STALE_EPOCH','Preview document changed while collecting diagnostics.');
      const entries = this.diagnostics.filter(entry=>entry.sequence>(cursor?.lastSequence??0)).slice(0,Number(args.limit??100));
      return {previewEpoch:this.epoch,entries,dropped:this.dropped,capabilities:this.preview.availability(),
        diagnosticsAvailability:receipt.diagnosticsAvailability,diagnosticScope:receipt.diagnosticScope,
        gap:!!cursor && cursor.lastSequence+1 < (this.diagnostics[0]?.sequence??1),
        nextCursor:{previewEpoch:this.epoch,lastSequence:entries.at(-1)?.sequence??cursor?.lastSequence??0}};
    }
    const expected = await context.vfs.adapter.snapshot();
    if (name==='page_refresh' && args.intendedSourceRevision!==undefined && args.intendedSourceRevision!==expected.revision)
      throw new BrowserError('STALE_REVISION','The intended source changed before refresh.');
    const freshness = name==='page_eval' ? await this.preview.freshness() : null;
    if (freshness && args.requireFresh !== false && (freshness.pageFreshnessUnknown || freshness.pendingSrcChanges))
      throw new BrowserError('STALE_REVISION','Preview source is stale or unknown. Refresh explicitly or opt in to observed stale evaluation.');
    let callArgs = args;
    if (name==='page_eval' && typeof args.path==='string') {
      const fs = new FilesystemV2(context.vfs);
      const selected = await fs.read({files:[{path:args.path}]},scope);
      const result = selected.files[0];
      if (!result || !('content' in result) || result.next)
        throw new BrowserError('INVALID_INPUT','Preview code path requires a complete bounded UTF-8 file.');
      callArgs = {...args,path:undefined,js:result.content};
    }
    const local = args.resultPath ? await context.vfs.localView() : null;
    const inputDigest = await digest(JSON.stringify([name,callArgs,expected.revision,initialEpoch]));
    await context.permit('preview-effect',inputDigest);
    await context.assertCurrent();
    if (name!=='page_refresh' && initialEpoch!==this.observeEpoch())
      throw new BrowserError('STALE_EPOCH','Preview document changed before dispatch.');
    if ((await context.vfs.adapter.snapshot()).revision !== expected.revision)
      throw new BrowserError('STALE_REVISION','Native draft changed before preview dispatch.');
    let result: Record<string,unknown>;
    try {
      result = await this.preview.call(name,{...callArgs,resultPath:undefined}) as Record<string,unknown>;
    } catch (error) {
      if (error instanceof ExecutionError &&
          ['UNSUPPORTED_INTERFACE','STALE_REVISION','INVALID_INPUT'].includes(error.code) && error.effectState==='NONE') throw error;
      if (error instanceof ExecutionError && error.effectState!=='NONE') throw error;
      throw new ExecutionError('EFFECT_UNKNOWN','Preview call requires read-only reconciliation.','UNKNOWN');
    }
    this.record(result);
    if (typeof args.resultPath==='string' && local) {
      try {
        const payload = typeof result.result==='string' ? /^data:[^;,]*(;base64)?,(.*)$/s.exec(result.result) : null;
        if (!payload || payload[2]!.length > 1_400_000)
          throw new BrowserError('INVALID_INPUT','Preview did not return a bounded data URL.');
        const encoded = payload[1] ? payload[2]! : bytesToBase64(utf8.encode(decodeURIComponent(payload[2]!)));
        const exists = local.files.find(file=>file.path===args.resultPath);
        await new FilesystemV2(context.vfs).publishWrites({expectedLocalRevision:local.revision.value,
          files:[{path:args.resultPath,encoding:'base64',content:encoded,
            ...(exists ? {ifSha256:exists.sha256} : {ifAbsent:true})}]},scope);
      } catch {
        throw new ExecutionError('PARTIAL_EFFECT','Preview ran but result file publication did not verify.','PARTIAL');
      }
    }
    return {...result,previewEpoch:this.epoch,
      ...(name==='set_viewport_size' ? {devicePixelRatio:null,scale:null} : {})};
  }
}
