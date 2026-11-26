import { validateToolCall } from '../../../packages/contracts/src/index.js';
import { base64ToBytes, bytesToBase64, canonicalPath, digest } from './native-types.js';

export interface PublicMediaOperation { operationId: string; deadlineMs: number; signal?: AbortSignal }
export interface PublicMediaOptions {
  /** Trusted controller evidence/configuration, never a model argument. False by default. */
  verifiedPreview?: boolean;
  /** Executes only in the unprivileged native preview. Return the native receipt.result, not arbitrary top-frame eval. */
  evaluate(js: string, timeoutMs: number): Promise<unknown>;
  revision(): Promise<string>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, bytes: Uint8Array, expectedRevision: string): Promise<{ status: string; revision: string }>;
  retainArtifact(bytes: Uint8Array, name: string, contentType: string): Promise<unknown>;
  retainUploadSecret(operationId: string, value: { url: string; deletionUrl: string }): Promise<void>;
  decodeImage(bytes: Uint8Array): Promise<{ width: number; height: number; mimeType: string }>;
  /** Revalidate current lease, native identity and current permission immediately before external effect. */
  beforeEffect(): Promise<void>;
  fetchImpl?: typeof fetch;
  maxBytes?: number;
}
export class PublicMediaError extends Error {
  constructor(public readonly code: string, message: string, public readonly effectState: 'NONE' | 'PARTIAL' | 'UNKNOWN' = 'NONE', public readonly evidence?: unknown) { super(message); this.name = 'PublicMediaError' }
}
const TRANSFER_CHUNK = 48 * 1024;
const MAX_BYTES = 8 * 1024 * 1024;
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PublicMediaError('UNSUPPORTED_INTERFACE', 'Public plugin returned an invalid response.', 'UNKNOWN'); return value as Record<string, unknown> }
function quoted(value: unknown): string { return JSON.stringify(value).replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029') }
function writableBinaryPath(path: string): string { canonicalPath(path); if (!/^(src|scratch)\//.test(path)) throw new PublicMediaError('PATH_DENIED', 'Media output requires a writable src/ or scratch/ binary path.'); return path }
function uploadedUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 1000) throw new PublicMediaError('EFFECT_UNKNOWN', 'Upload returned no bounded public asset URL.', 'UNKNOWN');
  let url: URL; try { url = new URL(value) } catch { throw new PublicMediaError('EFFECT_UNKNOWN', 'Upload returned an invalid asset URL.', 'UNKNOWN') }
  if (url.protocol !== 'https:' || url.origin !== 'https://user.uploads.dev' || url.username || url.password || url.port || url.search || url.hash || !/^\/file\/[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(url.pathname)) throw new PublicMediaError('EFFECT_UNKNOWN', 'Upload result is outside the verified public asset host/path.', 'UNKNOWN');
  return url.href;
}
function deletionUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value.length > 3000) return undefined;
  try { const url = new URL(value); if (url.protocol === 'https:' && ['https://user.uploads.dev', 'https://upload.perchance.org'].includes(url.origin) && !url.username && !url.password && !url.port && !url.hash) return url.href } catch { /* Untrusted capability is never invoked. */ }
  return undefined;
}
/** Public plugins remain upstream imports. This module transfers only fixed data and never exports a privileged callback into a page. */
export class PublicMedia {
  private readonly maxBytes: number;
  constructor(private readonly options: PublicMediaOptions) {
    this.maxBytes = options.maxBytes ?? MAX_BYTES;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes > MAX_BYTES) throw new PublicMediaError('INVALID_INPUT', 'Media byte budget must be between one byte and 8 MiB.');
  }
  private gate(operation: PublicMediaOperation): void {
    if (!this.options.verifiedPreview) throw new PublicMediaError('UNSUPPORTED_INTERFACE', 'Public media requires a verified unprivileged native preview bridge.');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(operation.operationId) || !Number.isSafeInteger(operation.deadlineMs)) throw new PublicMediaError('INVALID_INPUT', 'Trusted operation identity and deadline are required.');
    if (operation.signal?.aborted || Date.now() >= operation.deadlineMs) throw new PublicMediaError('CANCELLED', 'Media operation expired before dispatch.');
  }
  private async evaluate(source: string, operation: PublicMediaOperation, dispatched = false): Promise<Record<string, unknown>> {
    if (operation.signal?.aborted || Date.now() >= operation.deadlineMs) throw new PublicMediaError(dispatched ? 'EFFECT_UNKNOWN' : 'CANCELLED', dispatched ? 'Media dispatch may have completed; reconcile before repeating.' : 'Media staging was cancelled.', dispatched ? 'UNKNOWN' : 'NONE');
    try { return object(await this.options.evaluate(source, Math.max(1, Math.min(500000, operation.deadlineMs - Date.now())))) }
    catch (error) { if (error instanceof PublicMediaError) throw error; throw new PublicMediaError(dispatched ? 'EFFECT_UNKNOWN' : 'UNSUPPORTED_INTERFACE', dispatched ? 'Native preview media dispatch returned no verified result.' : 'Native preview media staging is unavailable.', dispatched ? 'UNKNOWN' : 'NONE') }
  }
  private async clean(key: string): Promise<void> { try { await this.options.evaluate(`delete globalThis[${quoted(key)}]; return {cleaned:true};`, 2000) } catch { /* Native navigation/reload also discards the unprivileged staging data. */ } }
  async generateImage(raw: Record<string, unknown>, operation: PublicMediaOperation): Promise<unknown> {
    this.gate(operation);
    const args = validateToolCall('generate_image', raw), expectedRevision = await this.options.revision();
    const path = writableBinaryPath(typeof args.outputPath === 'string' ? args.outputPath : `scratch/images/${operation.operationId}.png`), key = '__perchMcpImage_' + crypto.randomUUID().replaceAll('-', '');
    const probe = await this.evaluate('return {available:typeof root!=="undefined" && typeof root.generateImage==="function"};', operation);
    if (probe.available !== true) throw new PublicMediaError('UNSUPPORTED_INTERFACE', 'Import the public text-to-image-plugin as generateImage in this preview; no source was changed automatically.');
    await this.options.beforeEffect();
    if (await this.options.revision() !== expectedRevision) throw new PublicMediaError('STALE_REVISION', 'Source changed before public image dispatch.');
    let dispatched = false, pending: unknown;
    try {
      dispatched = true;
      const response = await this.evaluate(`const key=${quoted(key)}, args=${quoted(args)}; if(Object.hasOwn(globalThis,key))return {status:'UNKNOWN'};const state={phase:'INTENT'};Object.defineProperty(globalThis,key,{value:state,configurable:true});try{const result=await root.generateImage(args.prompt,{resolution:args.resolution??'512x512',...(args.negativePrompt===undefined?{}:{negativePrompt:args.negativePrompt}),...(args.seed===undefined?{}:{seed:args.seed})});const dataUrl=typeof result?.dataUrl==='string'?result.dataUrl:typeof result==='string'?result:null;const match=typeof dataUrl==='string'?/^data:(image\\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl):null;if(!match)return {status:'UNKNOWN',code:'INVALID_IMAGE'};if(match[2].length>${this.maxBytes * 4 / 3 + 8})return {status:'PARTIAL',code:'LIMIT_EXCEEDED'};const decoded=atob(match[2]);state.bytes=Uint8Array.from(decoded,c=>c.charCodeAt(0));if(state.bytes.length>${this.maxBytes})return {status:'PARTIAL',code:'LIMIT_EXCEEDED'};state.phase='READY';state.mime=match[1];return {status:'READY',bytes:state.bytes.length,mime:state.mime,seed:Number.isSafeInteger(result?.inputs?.seed)?result.inputs.seed:null};}catch{return {status:'UNKNOWN',code:'PROVIDER_REJECTED'};}`, operation, true);
      if (response.status !== 'READY' || !Number.isSafeInteger(response.bytes) || (response.bytes as number) < 1 || (response.bytes as number) > this.maxBytes || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(response.mime))) throw new PublicMediaError(response.code === 'LIMIT_EXCEEDED' ? 'LIMIT_EXCEEDED' : 'EFFECT_UNKNOWN', 'Image generation did not produce a bounded validated result; do not retry blindly.', response.status === 'PARTIAL' ? 'PARTIAL' : 'UNKNOWN');
      const bytes = new Uint8Array(response.bytes as number);
      for (let offset = 0; offset < bytes.length; offset += TRANSFER_CHUNK) {
        const chunk = await this.evaluate(`const state=globalThis[${quoted(key)}];if(!state||state.phase!=='READY')return {status:'UNKNOWN'};const bytes=state.bytes.subarray(${offset},${offset + TRANSFER_CHUNK});let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return {offset:${offset},total:state.bytes.length,base64:btoa(text)};`, operation, true);
        if (chunk.offset !== offset || chunk.total !== bytes.length || typeof chunk.base64 !== 'string') throw new PublicMediaError('EFFECT_UNKNOWN', 'Preview image changed during chunk transfer.', 'UNKNOWN');
        const decoded = base64ToBytes(chunk.base64); if (decoded.length !== Math.min(TRANSFER_CHUNK, bytes.length - offset)) throw new PublicMediaError('EFFECT_UNKNOWN', 'Preview image chunk length does not match its manifest.', 'UNKNOWN'); bytes.set(decoded, offset);
      }
      const sha256 = await digest(bytes); pending = await this.options.retainArtifact(bytes, operation.operationId + '.image', String(response.mime));
      const image = await this.options.decodeImage(bytes);
      if (image.mimeType !== response.mime || !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || image.width < 1 || image.height < 1 || image.width * image.height > 16 * 1024 * 1024) throw new PublicMediaError('EFFECT_UNKNOWN', 'Generated image failed independent decoding or dimension validation.', 'UNKNOWN', { pendingArtifact: pending });
      const written = await this.options.writeFile(path, bytes, expectedRevision);
      if (written.status !== 'SUCCEEDED') throw new PublicMediaError(written.status === 'PARTIAL' ? 'PARTIAL_EFFECT' : 'EFFECT_UNKNOWN', 'Generated image is retained, but local source write requires reconciliation.', written.status === 'PARTIAL' ? 'PARTIAL' : 'UNKNOWN', { pendingArtifact: pending });
      return { path, bytes: bytes.length, sha256, width: image.width, height: image.height, contentType: image.mimeType, revision: written.revision, seed: response.seed, pendingArtifact: pending, provider: 'perchance-public-plugin' };
    } catch (error) {
      if (error instanceof PublicMediaError) throw error;
      throw new PublicMediaError(pending ? 'PARTIAL_EFFECT' : 'EFFECT_UNKNOWN', pending ? 'Generated image remains in the local artifact store; inspect source before applying it again.' : 'Public image outcome requires reconciliation before another generation.', pending ? 'PARTIAL' : dispatched ? 'UNKNOWN' : 'NONE', pending ? { pendingArtifact: pending } : undefined);
    } finally { await this.clean(key) }
  }
  async uploadFile(raw: Record<string, unknown>, operation: PublicMediaOperation): Promise<unknown> {
    this.gate(operation); const args = validateToolCall('upload_file', raw), expectedRevision = await this.options.revision();
    let bytes: Uint8Array, contentType = 'application/octet-stream';
    if (typeof args.path === 'string') bytes = (await this.options.readFile(canonicalPath(args.path))).slice();
    else if (typeof args.text === 'string') { bytes = new TextEncoder().encode(args.text); contentType = 'text/plain;charset=utf-8' }
    else { const decoded = decodeDataUrl(String(args.dataUrl), this.maxBytes); bytes = decoded.bytes; contentType = decoded.contentType }
    if (bytes.length > this.maxBytes) throw new PublicMediaError('LIMIT_EXCEEDED', 'Upload input exceeds the negotiated 8 MiB public media budget.');
    const sha256 = await digest(bytes), key = '__perchMcpUpload_' + crypto.randomUUID().replaceAll('-', '');
    const expires = args.expiresDays === undefined ? undefined : Date.now() + Number(args.expiresDays) * 86400000;
    const probe = await this.evaluate('return {available:typeof root!=="undefined" && (typeof root.upload==="function" || typeof root.uploadPlugin==="function")};', operation);
    if (probe.available !== true) throw new PublicMediaError('UNSUPPORTED_INTERFACE', 'Import the public upload-plugin as upload or uploadPlugin in this preview; no source was changed automatically.');
    let dispatched = false, publicUrl: string | undefined, secretRetained = false;
    try {
      await this.evaluate(`const key=${quoted(key)};if(Object.hasOwn(globalThis,key))return {status:'UNKNOWN'};Object.defineProperty(globalThis,key,{value:{phase:'STAGING',received:0,bytes:new Uint8Array(${bytes.length})},configurable:true});return {status:'STAGING'};`, operation);
      for (let offset = 0; offset < bytes.length; offset += TRANSFER_CHUNK) {
        const encoded = bytesToBase64(bytes.subarray(offset, offset + TRANSFER_CHUNK));
        const part = await this.evaluate(`const state=globalThis[${quoted(key)}];if(!state||state.phase!=='STAGING'||state.received!==${offset})return {status:'UNKNOWN'};const text=atob(${quoted(encoded)}),bytes=Uint8Array.from(text,c=>c.charCodeAt(0));state.bytes.set(bytes,${offset});state.received+=bytes.length;return {status:'STAGING',received:state.received};`, operation);
        if (part.received !== Math.min(bytes.length, offset + TRANSFER_CHUNK)) throw new PublicMediaError('UNSUPPORTED_INTERFACE', 'Native upload staging did not preserve exact bytes.');
      }
      await this.options.beforeEffect();
      if (await this.options.revision() !== expectedRevision) throw new PublicMediaError('STALE_REVISION', 'Source changed while public upload was staged; nothing was uploaded.');
      dispatched = true;
      const response = await this.evaluate(`const state=globalThis[${quoted(key)}];if(!state||state.phase!=='STAGING'||state.received!==state.bytes.length)return {status:'REJECTED',code:'STAGING_MISMATCH'};state.phase='DISPATCHED';try{const fn=typeof root.upload==='function'?root.upload:root.uploadPlugin;const result=await fn(new Blob([state.bytes],{type:${quoted(contentType)}}),${expires === undefined ? '{}' : `{expires:${expires}}`});if(result?.error)return {status:'REJECTED',code:String(result.error).slice(0,100)};return {status:'UPLOADED',url:result?.url==null?null:String(result.url),size:result?.size,deletionUrl:typeof result?.deletionUrl==='string'?result.deletionUrl:null};}catch{return {status:'UNKNOWN'};}`, operation, true);
      if (response.status === 'REJECTED') {
        const knownNoEffect = ['STAGING_MISMATCH', 'over_daily_allowance', 'over-daily-allowance', 'file_too_big', 'invalid_file_type', 'invalid_data_url', 'invalid_size', 'captcha_needed', 'captcha-needed'].includes(String(response.code));
        throw new PublicMediaError(knownNoEffect ? 'PROVIDER_REJECTED' : 'EFFECT_UNKNOWN', knownNoEffect ? 'Public upload rejected the input or requires native verification before another attempt.' : 'Public upload reported an ambiguous provider failure; reconcile before repeating.', knownNoEffect ? 'NONE' : 'UNKNOWN');
      }
      if (response.status !== 'UPLOADED') throw new PublicMediaError('EFFECT_UNKNOWN', 'Public upload was dispatched without a verified result.', 'UNKNOWN');
      publicUrl = uploadedUrl(response.url); const capability = deletionUrl(response.deletionUrl);
      if (capability) { await this.options.retainUploadSecret(operation.operationId, { url: publicUrl, deletionUrl: capability }); secretRetained = true }
      if (response.size !== bytes.length) throw new PublicMediaError('EFFECT_UNKNOWN', 'Public upload receipt byte count does not match the intended bytes.', 'UNKNOWN', { url: publicUrl });
      await verifyPublicUpload(publicUrl, bytes, this.options.fetchImpl, operation.signal);
      return { url: publicUrl, bytes: bytes.length, sha256, contentType, deletionCapabilityRetained: secretRetained, ...(expires === undefined ? {} : { availableUntilAtLeast: expires }), warnings: capability ? [] : ['The public plugin supplied no recognized deletion capability; permanent deletion is not guaranteed.'] };
    } catch (error) {
      if (error instanceof PublicMediaError) throw error;
      const denied = error as { code?: string };
      if (!dispatched && ['AUTH_REQUIRED', 'SCOPE_DENIED', 'REVOKED', 'TAB_OFFLINE', 'STALE_EPOCH', 'BINDING_MISMATCH', 'STALE_REVISION'].includes(denied.code ?? '')) throw new PublicMediaError(denied.code!, 'Authorization or source changed before public upload; nothing was uploaded.');
      throw new PublicMediaError(publicUrl ? 'PARTIAL_EFFECT' : dispatched ? 'EFFECT_UNKNOWN' : 'UNSUPPORTED_INTERFACE', publicUrl ? 'Public asset was uploaded but verification or private capability retention failed; inspect the retained URL before any retry.' : dispatched ? 'Public upload outcome is unknown; do not repeat it automatically.' : 'Public upload staging failed before dispatch.', publicUrl ? 'PARTIAL' : dispatched ? 'UNKNOWN' : 'NONE', publicUrl ? { url: publicUrl, deletionCapabilityRetained: secretRetained } : undefined);
    } finally { await this.clean(key) }
  }
}
export function decodeDataUrl(dataUrl: string, maxBytes = MAX_BYTES): { bytes: Uint8Array; contentType: string } {
  if (typeof dataUrl !== 'string' || dataUrl.length > maxBytes * 4 + 1000) throw new PublicMediaError('LIMIT_EXCEEDED', 'Data URL exceeds public media limits.');
  const match = /^data:([A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+)?(;charset=[A-Za-z0-9_-]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) throw new PublicMediaError('INVALID_INPUT', 'Upload requires a bounded text or base64 data URL.');
  let bytes: Uint8Array; try { bytes = match[3] ? base64ToBytes(match[4]!) : decodePercentBytes(match[4]!, maxBytes) } catch (error) { if (error instanceof PublicMediaError) throw error; throw new PublicMediaError('INVALID_INPUT', 'Upload data URL encoding is invalid.') }
  if (bytes.length > maxBytes) throw new PublicMediaError('LIMIT_EXCEEDED', 'Decoded data URL exceeds public media limits.');
  return { bytes, contentType: (match[1] ?? 'text/plain') + (match[2] ?? '') };
}
async function verifyPublicUpload(url: string, expected: Uint8Array, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<void> {
  const response = await fetchImpl(uploadedUrl(url), { method: 'GET', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) });
  if (!response.ok || response.redirected || response.url && response.url !== url || response.type === 'opaque' || response.type === 'opaqueredirect') { await response.body?.cancel(); throw new PublicMediaError('EFFECT_UNKNOWN', 'Uploaded bytes could not be independently retrieved without redirects.', 'UNKNOWN', { url }) }
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) !== expected.length)) { await response.body?.cancel(); throw new PublicMediaError('EFFECT_UNKNOWN', 'Public asset length differs from the upload snapshot.', 'UNKNOWN', { url }) }
  let offset = 0; const reader = response.body?.getReader();
  try {
    if (reader) for (;;) {
      const next = await reader.read(); if (next.done) break;
      if (offset + next.value.length > expected.length || !next.value.every((byte, index) => byte === expected[offset + index])) { await reader.cancel(); throw new PublicMediaError('EFFECT_UNKNOWN', 'Public asset bytes differ from the upload snapshot.', 'UNKNOWN', { url }) }
      offset += next.value.length;
    }
    if (offset !== expected.length) throw new PublicMediaError('EFFECT_UNKNOWN', 'Public upload independent readback is incomplete.', 'UNKNOWN', { url });
  } finally { reader?.releaseLock() }
}

function decodePercentBytes(payload: string, maxBytes: number): Uint8Array {
  const output = new Uint8Array(Math.min(maxBytes, payload.length * 3)); let offset = 0;
  for (let cursor = 0; cursor < payload.length;) {
    if (payload[cursor] === '%') {
      const value = payload.slice(cursor + 1, cursor + 3); if (!/^[0-9a-f]{2}$/i.test(value)) throw new Error('Invalid percent escape');
      if (offset >= output.length) throw new PublicMediaError('LIMIT_EXCEEDED', 'Decoded data URL exceeds public media limits.');
      output[offset++] = Number.parseInt(value, 16); cursor += 3;
    } else {
      const end = payload.indexOf('%', cursor), text = payload.slice(cursor, end < 0 ? undefined : end), chunk = new TextEncoder().encode(text);
      if (offset + chunk.length > output.length) throw new PublicMediaError('LIMIT_EXCEEDED', 'Decoded data URL exceeds public media limits.');
      output.set(chunk, offset); offset += chunk.length; cursor = end < 0 ? payload.length : end;
    }
  }
  return output.slice(0, offset);
}
