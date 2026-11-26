import { ExecutionError } from './compute.js';

export interface PublicFetchOptions {
  /** Exact hosts explicitly approved by the Operator; no wildcards or model-provided additions. */
  approvedHosts: readonly string[];
  method?: 'GET' | 'POST';
  body?: string;
  allowPost?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}
export interface PublicFetchResult { bytes: Uint8Array; status: number; contentType: string; textPreview?: string; url: string }
const encoder = new TextEncoder();

export function validatePublicFetchUrl(raw: string, approvedHosts: readonly string[]): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new ExecutionError('INVALID_INPUT', 'Fetch requires an absolute HTTPS URL.'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' || url.hash || host.endsWith('.') || host.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/.test(host) || /(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/.test(host)) throw new ExecutionError('PATH_DENIED', 'Fetch permits approved public HTTPS hostnames only; credentials, IP literals, fragments and alternate ports are denied.');
  if (!approvedHosts.some(approved => approved === host && !approved.includes('*'))) throw new ExecutionError('SCOPE_DENIED', 'This exact public hostname has not been approved by the Operator.');
  return url;
}

/** Public retrieval only. Browser DNS cannot be independently attested: approve trusted hosts, never attacker-controlled DNS. */
export async function fetchPublic(raw: string, options: PublicFetchOptions): Promise<PublicFetchResult> {
  const url = validatePublicFetchUrl(raw, options.approvedHosts);
  const method = options.method ?? 'GET';
  if (method !== 'GET' && method !== 'POST' || method === 'GET' && options.body !== undefined || method === 'POST' && !options.allowPost) throw new ExecutionError('SCOPE_DENIED', 'POST requires FETCH_POST permission; GET cannot carry a body.');
  if (options.body !== undefined && encoder.encode(options.body).byteLength > 262_144) throw new ExecutionError('LIMIT_EXCEEDED', 'Fetch body exceeds 256 KiB.');
  const timeout = options.timeoutMs ?? 120_000, maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3_600_000 || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024) throw new ExecutionError('INVALID_INPUT', 'Fetch timeout or byte limit is outside the supported range.');
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
  let dispatched = false;
  try {
    dispatched = true;
    const response = await (options.fetchImpl ?? fetch)(url.href, { method, ...(options.body === undefined ? {} : { body: options.body }), credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store', signal: controller.signal, headers: { Accept: '*/*' } });
    if (response.redirected || response.status >= 300 && response.status <= 399 || response.type === 'opaqueredirect' || response.type === 'opaque' || response.url && new URL(response.url).origin !== url.origin) throw new ExecutionError('PATH_DENIED', 'Fetch redirects and opaque responses are denied.');
    if (!response.ok) throw new ExecutionError('PROVIDER_REJECTED', `Public server returned HTTP ${response.status}.`);
    const contentLength = response.headers.get('content-length');
    if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes)) throw new ExecutionError('LIMIT_EXCEEDED', 'Fetch response exceeds the configured byte limit.');
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (!response.body) { return { bytes: new Uint8Array(), status: response.status, contentType: response.headers.get('content-type') ?? 'application/octet-stream', url: url.href }; }
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) { await reader.cancel(); throw new ExecutionError('LIMIT_EXCEEDED', 'Fetch response exceeds the configured byte limit.'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const data = new Uint8Array(total);
    let offset = 0; for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
    const textPreview = /^(?:text\/|application\/(?:json|javascript|xml|[^;]+\+json))/.test(contentType) ? new TextDecoder().decode(data.subarray(0, 8192)).slice(0, 2000) : undefined;
    return { bytes: data, status: response.status, contentType, textPreview, url: url.href };
  } catch (error) {
    const state = method === 'POST' && dispatched ? 'UNKNOWN' : 'NONE';
    if (error instanceof ExecutionError) throw new ExecutionError(error.code, error.message, state);
    throw new ExecutionError(options.signal?.aborted ? 'CANCELLED' : timedOut ? 'TIMEOUT' : 'PROVIDER_REJECTED', options.signal?.aborted ? 'Public fetch was cancelled.' : timedOut ? 'Public fetch exceeded its deadline.' : 'Public fetch failed; check the approved host, CORS and network. Redirects are not followed.', state);
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
}
