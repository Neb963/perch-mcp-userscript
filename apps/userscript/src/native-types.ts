/** Browser-native data only. Never project native account/store objects. */
export interface NativeIdentity { generatorId: string; slug: string; publicId?: string; draftId: string }
export interface NativeSnapshot { identity: NativeIdentity; files: Record<string, Uint8Array>; revision: string; dirty: boolean; saveState: string }
export interface FileWrite { path: string; bytes: Uint8Array | null }
export interface MutationResult { status: 'SUCCEEDED' | 'PARTIAL' | 'UNKNOWN'; revision: string; committed: string[]; error?: { code: string; message: string; recovery: string } }
export interface CapabilityReport { adapterVersion: 1; ready: boolean; identity?: NativeIdentity; sourceRead: boolean; sourceWrite: boolean; nativeSave: boolean; preview: boolean; dirty: boolean; blocked: string[]; liveExternalWritesEnabled: boolean }
export interface KeyValueStore { get<T>(key: string): Promise<T | undefined>; set<T>(key: string, value: T): Promise<void>; delete(key: string): Promise<void>; list(): Promise<string[]> }
export class BrowserError extends Error {
  constructor(public readonly code: string, message: string, public readonly recovery = 'Inspect workspace_status and reconcile before retrying.') { super(message); this.name = 'BrowserError'; }
}
export const utf8 = new TextEncoder();
export function decodeText(bytes: Uint8Array): string { try { const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); if (text.includes('\0')) throw new Error(); return text; } catch { throw new BrowserError('BINARY_FILE', 'File is not UTF-8 text; use read_b64_file.'); } }
export async function digest(bytes: Uint8Array | string): Promise<string> { const value = typeof bytes === 'string' ? utf8.encode(bytes) : bytes; return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', value as BufferSource)), b => b.toString(16).padStart(2, '0')).join(''); }
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean { return a.length === b.length && a.every((v, i) => b[i] === v); }
export function equalIdentity(a: NativeIdentity, b: NativeIdentity): boolean { return a.generatorId === b.generatorId && a.slug === b.slug && a.draftId === b.draftId; }
export function canonicalPath(path: string): string {
  if (typeof path !== 'string' || path.length > 512 || !/^(main\.pjs|index\.html|(?:src|scratch|imports)\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*)$/.test(path) || path.split('/').some(p => p === '.' || p === '..')) throw new BrowserError('PATH_DENIED', 'Use main.pjs, index.html, src/, scratch/ or imports/ with canonical ASCII segments.');
  return path;
}
export function bytesToBase64(bytes: Uint8Array): string { let text = ''; for (let i = 0; i < bytes.length; i += 16384) text += String.fromCharCode(...bytes.subarray(i, i + 16384)); return btoa(text); }
export function base64ToBytes(text: string): Uint8Array { if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) throw new BrowserError('INVALID_INPUT', 'Invalid canonical base64.'); const decoded = atob(text); return Uint8Array.from(decoded, c => c.charCodeAt(0)); }
export async function snapshotRevision(identity: NativeIdentity, files: Record<string, Uint8Array>): Promise<string> { const manifest = await Promise.all(Object.keys(files).sort().map(async path => [path, files[path]!.length, await digest(files[path]!) ])); return digest(JSON.stringify([identity, manifest])); }
