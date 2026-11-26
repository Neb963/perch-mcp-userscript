import { canonicalPath, digest, utf8 } from "./native-types.js";
import { ExecutionError } from "./compute.js";

export interface PublicGeneratorSnapshot {
  generatorId: string;
  slug: string;
  revision: string;
  files: Record<string, Uint8Array>;
  count: number;
  bytes: number;
  completeness: 'complete' | 'panels-only';
  missingManifest: boolean;
}

const SOURCE_ENDPOINT = 'https://perchance.org/api/getGeneratorPageData';
const MAX_PANEL_JSON = 4 * 1024 * 1024;
const MAX_SOURCE = 32 * 1024 * 1024;
const MAX_FILE = 16 * 1024 * 1024;

/**
 * A public response is untrusted. Do not leak its text into a tool error.
 * The status and stage are bounded, actionable, and contain no source content.
 */
async function boundedResponse(response: Response, max: number, stage: 'metadata' | 'asset'): Promise<Uint8Array> {
  const status = response.status;
  if (response.redirected || response.type === 'opaque' || response.type === 'opaqueredirect')
    throw new ExecutionError('PROVIDER_REJECTED', `Public ${stage} redirected or returned an opaque response; no source installed.`);
  if (!response.ok) {
    const reason = status === 404 ? 'not-found' : status === 401 || status === 403 ? 'not-public' :
      status === 429 ? 'rate-limited' : status >= 500 ? 'upstream-unavailable' : 'http-error';
    throw new ExecutionError('PROVIDER_REJECTED', `Public ${stage} ${reason} (HTTP ${status}); no source installed.`);
  }
  const contentLength = response.headers.get('content-length');
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > max))
    throw new ExecutionError('LIMIT_EXCEEDED', `Public ${stage} exceeds its size budget.`);
  const reader = response.body?.getReader();
  if (!reader) throw new ExecutionError('PROVIDER_REJECTED', `Public ${stage} returned no readable body.`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.length;
      if (size > max) throw new ExecutionError('LIMIT_EXCEEDED', `Public ${stage} exceeds its size budget.`);
      chunks.push(value);
    }
  } finally {
    try { await reader.cancel(); } catch { /* Cancellation is best effort. */ }
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

interface PublicPanels {
  id: string;
  name: string;
  modelText: string;
  outputTemplate: string;
  manifest?: Record<string, unknown>;
  fingerprint: string;
}

/** Uses the documented public Perchance page-data endpoint, never the AI Helper's private APIs. */
export async function readPublicGenerator(
  slug: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<PublicGeneratorSnapshot> {
  if (!/^[a-z0-9][a-z0-9-]{0,119}$/.test(slug))
    throw new ExecutionError('INVALID_INPUT', 'Use a canonical public generator Slug.');
  const options: RequestInit = {
    credentials: 'omit', redirect: 'error', cache: 'no-store',
    referrerPolicy: 'no-referrer',
    signal: signal ?? AbortSignal.timeout(30000),
  };
  async function metadata(): Promise<PublicPanels> {
    let response: Response;
    try {
      response = await fetcher(SOURCE_ENDPOINT, {
        ...options, method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ generatorName: slug }),
      });
    } catch {
      throw new ExecutionError('PROVIDER_REJECTED',
        'Public metadata request failed (network/CORS/CSP or timeout); no source installed.');
    }
    let data: unknown;
    try {
      const bytes = await boundedResponse(response, MAX_PANEL_JSON, 'metadata');
      data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch (e) {
      if (e instanceof ExecutionError) throw e;
      throw new ExecutionError('PROVIDER_REJECTED',
        'Public metadata was not bounded JSON; no source installed.');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data))
      throw new ExecutionError('PROVIDER_REJECTED', 'Public metadata envelope is invalid.');
    const root = data as Record<string, unknown>;
    // Perchance's public page-data endpoint is used by clients which read
    // data.generator directly. A status field is not part of every response.
    if (root.status !== undefined && root.status !== 'success')
      throw new ExecutionError('PROVIDER_REJECTED', 'Public metadata returned a non-success status.');
    const g = root.generator;
    if (!g || typeof g !== 'object' || Array.isArray(g))
      throw new ExecutionError('PROVIDER_REJECTED', 'Public generator does not exist or is not source-readable.');
    const gen = g as Record<string, unknown>;
    const id = typeof gen.id === 'number' && Number.isSafeInteger(gen.id)
      ? String(gen.id) : gen.id;
    if (typeof id !== 'string' || !id || id.length > 512 ||
        gen.name !== slug || typeof gen.modelText !== 'string' ||
        typeof gen.outputTemplate !== 'string')
      throw new ExecutionError('UNSUPPORTED_INTERFACE',
        'Public metadata lacks exact Generator ID, Slug or bounded source panels.');
    if (utf8.encode(gen.modelText).length + utf8.encode(gen.outputTemplate).length > MAX_PANEL_JSON)
      throw new ExecutionError('LIMIT_EXCEEDED', 'Public source panels exceed the 4 MiB limit.');
    const manifest = gen.srcManifest ?? root.srcManifest;
    if (manifest !== undefined && (!manifest || typeof manifest !== 'object' ||
        Array.isArray(manifest) || Object.keys(manifest).length > 1000))
      throw new ExecutionError('UNSUPPORTED_INTERFACE', 'Public source manifest has an unsupported shape.');
    const normalized = manifest as Record<string, unknown> | undefined;
    // Canonical, sorted fingerprint: property order changes must not present
    // a false provider revision mismatch.
    const fields = normalized
      ? Object.keys(normalized).sort().map(path => [path, normalized[path]]) : null;
    return {
      id, name: slug, modelText: gen.modelText, outputTemplate: gen.outputTemplate,
      manifest: normalized,
      fingerprint: JSON.stringify([id, slug, gen.modelText, gen.outputTemplate, fields,
        gen.sourceRevision ?? null, gen.editorPayloadRevision ?? null, gen.saveCount ?? null]),
    };
  }
  const before = await metadata();
  const files: Record<string, Uint8Array> = Object.create(null);
  files['main.pjs'] = utf8.encode(before.modelText);
  files['index.html'] = utf8.encode(before.outputTemplate);
  let total = files['main.pjs']!.length + files['index.html']!.length;
  const paths = Object.keys(before.manifest ?? {}).sort();
  const seen = new Set<string>();
  for (const relative of paths) {
    const path = canonicalPath(`src/${relative}`);
    if (seen.has(path.toLowerCase()))
      throw new ExecutionError('PATH_DENIED', 'Public source manifest contains duplicate/colliding paths.');
    seen.add(path.toLowerCase());
    const entry = before.manifest![relative];
    const key = typeof entry === 'string' ? entry :
      entry && typeof entry === 'object' && !Array.isArray(entry) ? (entry as Record<string, unknown>).key : undefined;
    const size = entry && typeof entry === 'object' && !Array.isArray(entry)
      ? (entry as Record<string, unknown>).size : undefined;
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9_.~-]{0,511}$/.test(key) ||
        (size !== undefined && (typeof size !== 'number' ||
          !Number.isSafeInteger(size) || size < 0 || size > MAX_FILE)))
      throw new ExecutionError('UNSUPPORTED_INTERFACE',
        'Public manifest asset key or declared byte size is unsupported.');
    let response: Response;
    try {
      response = await fetcher(`https://user.uploads.dev/file/${encodeURIComponent(key)}`, options);
    } catch {
      throw new ExecutionError('PROVIDER_REJECTED',
        'Public asset request failed (network/CORS/CSP or timeout); no source installed.');
    }
    const bytes = await boundedResponse(response, Math.min(MAX_FILE, MAX_SOURCE - total), 'asset');
    if (size !== undefined && bytes.length !== size)
      throw new ExecutionError('NATIVE_CONFLICT',
        'Public asset byte size differs from the saved manifest; no source installed.');
    files[path] = bytes;
    total += bytes.length;
  }
  const after = await metadata();
  if (before.fingerprint !== after.fingerprint)
    throw new ExecutionError('STALE_REVISION',
      'Public source changed during retrieval; no mixed source installed.');
  const manifest = await Promise.all(Object.keys(files).sort()
    .map(async path => [path, files[path]!.length, await digest(files[path]!) ]));
  return {
    generatorId: before.id, slug,
    revision: await digest(JSON.stringify([before.id, manifest])),
    files, count: Object.keys(files).length, bytes: total,
    completeness: before.manifest ? 'complete' : 'panels-only',
    missingManifest: before.manifest === undefined,
  };
}
