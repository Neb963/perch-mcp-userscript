/** Browser-native data only. Never project native account/store objects. */
export interface NativeIdentity { generatorId: string; slug: string; publicId?: string; draftId: string }
export interface NativeSnapshot { identity: NativeIdentity; files: Record<string, Uint8Array>; revision: string; dirty: boolean; saveState: string }
export interface FileWrite { path: string; bytes: Uint8Array | null }
export interface MutationResult { status: 'SUCCEEDED' | 'PARTIAL' | 'UNKNOWN'; revision: string; committed: string[]; error?: { code: string; message: string; recovery: string } }
export interface CapabilityReport { adapterVersion: 1; ready: boolean; identity?: NativeIdentity; sourceRead: boolean; sourceWrite: boolean; sourceWriteBlocked: string[]; nativeSave: boolean; preview: boolean; dirty: boolean; blocked: string[]; liveExternalWritesEnabled: boolean }
export interface KeyValueStore { get<T>(key: string): Promise<T | undefined>; set<T>(key: string, value: T): Promise<void>; delete(key: string): Promise<void>; list(): Promise<string[]> }
export class BrowserError extends Error {
  constructor(public readonly code: string, message: string, public readonly recovery = 'Inspect workspace_status and reconcile before retrying.') { super(message); this.name = 'BrowserError'; }
}
export const utf8 = new TextEncoder();
export function decodeText(bytes: Uint8Array): string { try { const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); if (text.includes('\0')) throw new Error(); return text; } catch { throw new BrowserError('BINARY_FILE', 'File is not UTF-8 text; use read_b64_file.'); } }
export async function digest(bytes: Uint8Array | string): Promise<string> { const value = typeof bytes === 'string' ? utf8.encode(bytes) : bytes; return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', value as BufferSource)), b => b.toString(16).padStart(2, '0')).join(''); }
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean { return a.length === b.length && a.every((v, i) => b[i] === v); }
export function equalIdentity(a: NativeIdentity, b: NativeIdentity): boolean { return a.generatorId === b.generatorId && a.slug === b.slug && a.draftId === b.draftId; }
export function canonicalPath(path: string): string {
  if (typeof path !== 'string' || path.length > 512 || !/^(main\.pjs|index\.html|(?:src|scratch|imports)\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*)$/.test(path) || path.split('/').some(p => p === '.' || p === '..')) throw new BrowserError('PATH_DENIED', 'Use main.pjs, index.html, src/, scratch/ or imports/ with canonical ASCII segments.');
  return path;
}
/** Typed-array brand, not realm-local instanceof (Firefox content globals may differ). */
const typedArrayTag = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag)?.get;
export function isUint8Array(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) && typedArrayTag?.call(value) === 'Uint8Array';
}
/** Cross-realm ArrayBuffer internal brand; rejects Symbol.toStringTag spoofing. */
const arrayBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')?.get;
export function copyArrayBuffer(value: unknown): Uint8Array | null {
  if (!value || typeof value !== 'object') return null;
  try {
    const length: unknown = arrayBufferLength?.call(value);
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) return null;
    // The native Uint8Array constructor accepts foreign-realm ArrayBuffers.
    const bytes = new Uint8Array(value as ArrayBuffer);
    // A cross-realm wrapper may be interpreted as an array-like object and
    // silently produce an empty view. Never accept truncated or phantom bytes.
    return bytes.byteLength === length ? bytes.slice() : null;
  } catch { return null; }
}
export function bytesToBase64(bytes: Uint8Array): string {
  // Divisible by three: independently encoded blocks concatenate without
  // intermediate padding or one enormous binary string.
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 24576)
    parts.push(btoa(String.fromCharCode(...bytes.subarray(i, i + 24576))));
  return parts.join('');
}
export function base64ToBytes(text: string): Uint8Array {
  const invalid = () => new BrowserError('INVALID_INPUT', 'Invalid canonical base64.');
  if (typeof text !== 'string' || text.length % 4 !== 0) throw invalid();
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const bodyLength = text.length - padding;
  // The old repeated-four-character group can overflow the regexp stack
  // on otherwise valid multi-megabyte files. A character-class scan is linear.
  if (/[^A-Za-z0-9+/]/.test(text.slice(0, bodyLength))) throw invalid();
  const bytes = new Uint8Array(text.length / 4 * 3 - padding);
  let offset = 0;
  for (let i = 0; i < text.length; i += 32768) {
    const decoded = atob(text.slice(i, i + 32768));
    for (let j = 0; j < decoded.length; j++) bytes[offset++] = decoded.charCodeAt(j);
  }
  return bytes;
}
export async function snapshotRevision(identity: NativeIdentity, files: Record<string, Uint8Array>): Promise<string> { const manifest = await Promise.all(Object.keys(files).sort().map(async path => [path, files[path]!.length, await digest(files[path]!) ])); return digest(JSON.stringify([identity, manifest])); }
