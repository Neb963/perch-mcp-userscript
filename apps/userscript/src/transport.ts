import type { KeyValueStore } from './native-types.js';

export class TransportError extends Error {
  constructor(readonly code: string, message: string, readonly status = 0) { super(message); this.name = 'TransportError'; }
}
export interface Pairing {
  schemaVersion: 1;
  origin: string;
  browserInstallationId: string;
  adminCredential: string;
  executionCredential: string;
}
export function gatewayOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new TransportError('INVALID_INPUT', 'Enter the HTTPS gateway origin.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.port || !url.hostname.includes('.') || /^(localhost|.*\.localhost)$/.test(url.hostname) || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(':')) {
    throw new TransportError('INVALID_INPUT', 'Use an HTTPS gateway origin without credentials, path, port or query.');
  }
  return url.origin;
}
/** Isolated-context fetch; redirect:error prevents credential forwarding BEFORE any redirect. */
export class GatewayTransport {
  private pairing?: Pairing;
  private suggestedOrigin = "";
  constructor(private readonly store: KeyValueStore, private readonly fetcher: typeof fetch = fetch) {}
  async initialize(): Promise<void> {
    const suggestion=await this.store.get<string>('perch:suggested-origin');if(suggestion)this.suggestedOrigin=gatewayOrigin(suggestion);
    const stored = await this.store.get<Pairing>('perch:pairing');
    if (stored) {
      if (stored.schemaVersion !== 1 || gatewayOrigin(stored.origin) !== stored.origin || !stored.adminCredential || !stored.executionCredential) throw new TransportError('INCOMPATIBLE_VERSION', 'Stored pairing is incompatible. Re-pair after recovery.');
      this.pairing = stored;
    }
  }
  configuration(): { origin: string; paired: boolean } { return { origin: this.pairing?.origin ?? this.suggestedOrigin, paired: !!this.pairing }; }
  async installationId(): Promise<string> {
    let id = await this.store.get<string>('perch:installation-id');
    if (!id) { id = crypto.randomUUID(); await this.store.set('perch:installation-id', id); }
    return id;
  }
  async health(origin = this.pairing?.origin): Promise<unknown> {
    if (!origin) throw new TransportError('AUTH_REQUIRED', 'Pair a gateway first.');
    return this.send(gatewayOrigin(origin), 'GET', '/health');
  }
  async pair(origin: string, bootstrapSecret: string): Promise<void> {
    const approvedOrigin = gatewayOrigin(origin);
    if (bootstrapSecret.length < 32 || bootstrapSecret.length > 512) throw new TransportError('INVALID_INPUT', 'Bootstrap secret must contain at least 32 characters.');
    if (this.pairing && approvedOrigin !== this.pairing.origin) throw new TransportError('RESOURCE_CONFLICT', 'Disconnect the existing gateway before pairing another.');
    const browserInstallationId = await this.installationId();
    const result = await this.send(approvedOrigin, 'POST', '/api/v1/admin/pair', { bootstrapSecret, browserInstallationId, issuer: approvedOrigin }) as Record<string, unknown>;
    if (typeof result.adminCredential !== 'string' || typeof result.executionCredential !== 'string') throw new TransportError('INVALID_RESPONSE', 'Gateway returned an invalid pairing response; use recovery instead of repeating uncertain pairing.');
    const next: Pairing = { schemaVersion: 1, origin: approvedOrigin, browserInstallationId, adminCredential: result.adminCredential, executionCredential: result.executionCredential };
    await this.store.set('perch:pairing', next);
    this.pairing = next;
  }
  async request(method: string, path: string, body?: unknown): Promise<unknown> {
    if (!path.startsWith('/api/v1/admin/') && !path.startsWith('/api/v1/approval/')) throw new TransportError('PATH_DENIED', 'Management route not permitted.');
    return this.authenticated('admin', method, path, body);
  }
  async tab(path: string, body: unknown, leaseSecret?: string, options?:{timeoutMs?:number;signal?:AbortSignal}): Promise<unknown> {
    if (!/^\/api\/v1\/tab\/(claim|poll|reply|release|heartbeat|ticket|permit|music|music-result)$/.test(path)) throw new TransportError('PATH_DENIED', 'Tab route not permitted.');
    return this.authenticated('execution', 'POST', path, body, leaseSecret,options);
  }
  private async authenticated(role: 'admin' | 'execution', method: string, path: string, body?: unknown, leaseSecret?: string,options?:{timeoutMs?:number;signal?:AbortSignal}): Promise<unknown> {
    const paired = this.pairing;
    if (!paired) throw new TransportError('AUTH_REQUIRED', 'Pair this browser with the gateway.');
    return this.send(paired.origin, method, path, body, leaseSecret ?? (role === 'admin' ? paired.adminCredential : paired.executionCredential),false,options);
  }
  async exportResources(): Promise<Uint8Array> {
    if (!this.pairing) throw new TransportError('AUTH_REQUIRED','Pair this browser first.');
    return await this.send(this.pairing.origin,'GET','/api/v1/admin/resources/export',undefined,this.pairing.adminCredential,true) as Uint8Array;
  }
  async recover(origin:string,recoverySecret:string):Promise<void>{
    const approved=gatewayOrigin(origin);if(recoverySecret.length<43||recoverySecret.length>256)throw new TransportError('INVALID_INPUT','Use a fresh43–256character recovery secret.');
    const browserInstallationId=await this.installationId();
    const value=await this.send(approved,'POST','/api/v1/admin/recover',{recoverySecret,browserInstallationId}) as Record<string,unknown>;
    if(typeof value.adminCredential!=='string'||typeof value.executionCredential!=='string')throw new TransportError('INVALID_RESPONSE','Recovery response invalid. Rotate recovery secret before retrying uncertain recovery.');
    const next:Pairing={schemaVersion:1,origin:approved,browserInstallationId,adminCredential:value.adminCredential,executionCredential:value.executionCredential};
    await this.store.set('perch:pairing',next);this.pairing=next;
  }
  async importSettingsOrigin(origin:string):Promise<void>{ this.suggestedOrigin=gatewayOrigin(origin); await this.store.set('perch:suggested-origin',this.suggestedOrigin); }
  async disconnect(): Promise<void> { await this.store.delete('perch:pairing'); this.pairing = undefined; }
  private async send(origin: string, method: string, path: string, body?: unknown, credential?: string, binary = false,options?:{timeoutMs?:number;signal?:AbortSignal}): Promise<unknown> {
    if (!path.startsWith('/') || path.includes('..') || path.includes('#') || path.includes('\\')) throw new TransportError('PATH_DENIED', 'Invalid gateway route.');
    const url = new URL(path, origin);
    for(const [name,value] of url.searchParams){if(name==='cursor'&&/^[A-Za-z0-9._:-]{1,512}$/.test(value))continue;if(name==='limit'&&/^(?:[1-9][0-9]?|100)$/.test(value))continue;throw new TransportError('PATH_DENIED','Only bounded pagination query values are permitted.');}
    if (url.origin !== origin) throw new TransportError('PATH_DENIED', 'Gateway origin mismatch.');
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    if (encoded && new TextEncoder().encode(encoded).length > (path.startsWith('/api/v1/admin/resources/import') ? 24 * 1024 * 1024 : 512 * 1024)) throw new TransportError('LIMIT_EXCEEDED', 'Gateway request exceeds 512 KiB.');
    const headers = new Headers({ Accept: binary ? 'application/zip' : 'application/json' });
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    if (credential) headers.set('Authorization', `Bearer ${credential}`);
    if (!['GET', 'HEAD'].includes(method)) headers.set('Idempotency-Key', crypto.randomUUID());
    let response: Response;
    try { response = await this.fetcher(url, { method, headers, body: encoded, credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal: options?.signal ? AbortSignal.any([options.signal,AbortSignal.timeout(options.timeoutMs??30000)]) : AbortSignal.timeout(options?.timeoutMs??30000) }); }
    catch { throw new TransportError('GATEWAY_UNAVAILABLE', 'Gateway request failed. Check gateway origin, CORS, CSP and connectivity; uncertain writes require reconciliation.'); }
    if (response.url && new URL(response.url).origin !== origin) throw new TransportError('PATH_DENIED', 'Gateway response origin mismatch.');
    if (!binary && !response.headers.get('content-type')?.includes('application/json')) throw new TransportError('INVALID_RESPONSE', 'Gateway response must be JSON.');
    const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let length = 0;
    if (reader) { try { while (true) { const { value, done } = await reader.read(); if (done) break; length += value.length; if (length > (binary ? 16 * 1024 * 1024 : 512 * 1024)) throw new TransportError('LIMIT_EXCEEDED', 'Gateway response exceeds 512 KiB.'); chunks.push(value); } } finally { await reader.cancel().catch(() => {}); } }
    const bytes = new Uint8Array(length); let cursor = 0; for (const chunk of chunks) { bytes.set(chunk, cursor); cursor += chunk.length; }
    if(binary && response.ok) return bytes;
    let data: unknown; try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new TransportError('INVALID_RESPONSE', 'Gateway returned invalid JSON.'); }
    if (!response.ok) {
      const code = typeof data === 'object' && data !== null && 'code' in data && typeof data.code === 'string' ? data.code : `HTTP_${response.status}`;
      // Server/provider text can contain source or secrets: expose stable code, not arbitrary raw messages.
      throw new TransportError(code, `Gateway rejected the request (${code}). Refresh authoritative state before retrying.`, response.status);
    }
    return data;
  }
}
