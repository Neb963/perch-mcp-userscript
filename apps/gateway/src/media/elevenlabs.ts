/** Fixed-endpoint optional provider. The caller owns MEDIA authorization, durable operation intent, artifact ACL and spend policy. */
export interface MusicInput { style: string; isInstrumental: boolean; lyrics?: string; seed?: number; userRequestedSeconds?: number }
export interface MusicProviderOptions { apiKey: string; paidEnabled: boolean; timeoutMs?: number; maxBytes?: number; fetch?: typeof globalThis.fetch }
export interface MusicOutput { bytes: Uint8Array; contentType: 'audio/mpeg'; provider: 'elevenlabs'; model: 'music_v2_5'; songId?: string; requestedSeconds: number; actualSeconds: number; seed?: number; warnings: string[]; validation: { framing: true; playback: 'UNVERIFIED'; lyrics: 'UNVERIFIED' } }
export class MusicProviderError extends Error {
  constructor(public readonly code: string, message: string, public readonly effectState: 'NONE' | 'UNKNOWN', public readonly retryable = false) { super(message); this.name = 'MusicProviderError' }
}
const API_URL = 'https://api.elevenlabs.io/v1/music?output_format=mp3_48000_192';
function invalid(message: string): never { throw new MusicProviderError('INVALID_INPUT', message, 'NONE') }
export function buildElevenLabsRequest(input: MusicInput): { body: Record<string, unknown>; requestedSeconds: number; warnings: string[] } {
  if (!input || typeof input !== 'object' || typeof input.style !== 'string' || !input.style.trim() || input.style.length > 4000 || typeof input.isInstrumental !== 'boolean') invalid('A nonempty style of at most 4000 characters and instrumental flag are required');
  if (Object.keys(input).some(key => !['style', 'isInstrumental', 'lyrics', 'seed', 'userRequestedSeconds'].includes(key))) invalid('Unknown music input field');
  const requestedSeconds = input.userRequestedSeconds ?? 60;
  if (!Number.isInteger(requestedSeconds) || requestedSeconds < 30 || requestedSeconds > 300) invalid('Requested music duration must be 30–300 whole seconds');
  if (input.seed !== undefined && (!Number.isInteger(input.seed) || input.seed < 0 || input.seed > 2147483647)) invalid('Provider seed must be an integer from 0 to 2147483647');
  if (input.lyrics !== undefined && (typeof input.lyrics !== 'string' || input.lyrics.length > 12000)) invalid('Lyrics must be text of at most 12000 characters');
  if (input.isInstrumental && input.lyrics?.trim()) invalid('Instrumental music cannot have sung lyrics');
  // The provider's documented guaranteed instrumental flag is prompt-only; seed is plan-only.
  if (input.isInstrumental && input.seed !== undefined) throw new MusicProviderError('UNSUPPORTED_CONTROL', 'This provider cannot combine guaranteed instrumental mode and a seed; choose one explicitly', 'NONE');
  const warnings = ['Provider generation may vary across updates; a seed does not guarantee identical audio'];
  if (input.seed === undefined && !input.lyrics?.trim()) return { body: { prompt: input.style, music_length_ms: requestedSeconds * 1000, model_id: 'music_v2_5', force_instrumental: input.isInstrumental, store_for_inpainting: false }, requestedSeconds, warnings };
  const count = Math.ceil(requestedSeconds / 120), text = input.lyrics ?? '[Song]', parts: string[] = [];
  let remaining = text;
  for (let index = 0; index < count; index++) {
    if (index === count - 1) { parts.push(remaining); break }
    const ideal = Math.ceil(remaining.length / (count - index));
    const newline = remaining.lastIndexOf('\n', ideal), space = remaining.lastIndexOf(' ', ideal);
    const boundary = newline > ideal / 2 ? newline + 1 : space > ideal / 2 ? space + 1 : ideal;
    parts.push(remaining.slice(0, boundary)); remaining = remaining.slice(boundary);
  }
  if (parts.join('') !== text) invalid('Composition plan did not preserve lyrics');
  const milliseconds = requestedSeconds * 1000, baseDuration = Math.floor(milliseconds / count);
  const chunks = parts.map((part, index) => ({ text: part || '[Instrumental break]', duration_ms: index === count - 1 ? milliseconds - baseDuration * index : baseDuration, positive_styles: [input.style], negative_styles: [], context_adherence: 'high' }));
  const body: Record<string, unknown> = { composition_plan: { chunks }, model_id: 'music_v2_5', store_for_inpainting: false };
  if (input.seed !== undefined) body.seed = input.seed;
  warnings.push(input.lyrics ? 'Lyrics are preserved in the request; real output must be checked for truncation and singing fidelity' : 'A composition plan without supplied lyrics leaves vocal content to the provider');
  return { body, requestedSeconds, warnings };
}

/** No retries: after dispatch, a missing/invalid result may still represent billable generation. */
export async function generateElevenLabsMusic(input: MusicInput, options: MusicProviderOptions, signal?: AbortSignal): Promise<MusicOutput> {
  const request = buildElevenLabsRequest(input);
  if (!options.paidEnabled) throw new MusicProviderError('APPROVAL_REQUIRED', 'Operator must enable paid music generation before any request', 'NONE');
  if (typeof options.apiKey !== 'string' || options.apiKey.length < 16 || options.apiKey.length > 512 || /[\r\n]/.test(options.apiKey)) throw new MusicProviderError('AUTH_REQUIRED', 'Configure a scoped ElevenLabs Worker secret', 'NONE');
  const timeoutMs = options.timeoutMs ?? 300000, maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000 || !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 16 * 1024 * 1024) invalid('Invalid provider execution budget');
  if (signal?.aborted) throw new MusicProviderError('CANCELLED', 'Music request cancelled before dispatch', 'NONE');
  const controller = new AbortController(), abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    let response: Response;
    try {
      response = await (options.fetch ?? globalThis.fetch)(API_URL, { method: 'POST', redirect: 'error', credentials: 'omit', headers: { 'Content-Type': 'application/json', 'xi-api-key': options.apiKey, Accept: 'audio/mpeg' }, body: JSON.stringify(request.body), signal: controller.signal });
    } catch { throw new MusicProviderError('EFFECT_UNKNOWN', 'Music request was dispatched but its outcome is unknown; inspect provider usage and Operation ID before another generation', 'UNKNOWN') }
    if (!response.ok) {
      await response.body?.cancel();
      const knownRejection = [400, 401, 402, 403, 404, 413, 422, 429].includes(response.status);
      const code = response.status === 401 || response.status === 403 ? 'AUTH_REQUIRED' : response.status === 402 || response.status === 429 ? 'QUOTA_EXCEEDED' : 'PROVIDER_REJECTED';
      throw new MusicProviderError(knownRejection ? code : 'EFFECT_UNKNOWN', knownRejection ? `Music provider rejected request (HTTP ${response.status}); no automatic retry` : 'Music provider failed after dispatch; reconcile before another paid request', knownRejection ? 'NONE' : 'UNKNOWN');
    }
    if (response.redirected || (response.url && new URL(response.url).origin !== 'https://api.elevenlabs.io')) { await response.body?.cancel(); throw new MusicProviderError('EFFECT_UNKNOWN', 'Music response origin could not be verified', 'UNKNOWN') }
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (!['audio/mpeg', 'audio/mp3', 'application/octet-stream'].includes(contentType ?? '')) { await response.body?.cancel(); throw new MusicProviderError('EFFECT_UNKNOWN', 'Music provider returned a non-audio result; generation may still be billable', 'UNKNOWN') }
    const contentLength = response.headers.get('content-length');
    if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes)) { await response.body?.cancel(); throw new MusicProviderError('LIMIT_EXCEEDED', 'Music response exceeds the configured artifact budget; reconcile before regenerating', 'UNKNOWN') }
    if (!response.body) throw new MusicProviderError('EFFECT_UNKNOWN', 'Music response has no audio body', 'UNKNOWN');
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        length += next.value.length;
        if (length > maxBytes) { await reader.cancel(); throw new MusicProviderError('LIMIT_EXCEEDED', 'Music audio exceeds artifact budget; no retry was attempted', 'UNKNOWN') }
        chunks.push(next.value);
      }
    } catch (error) { if (error instanceof MusicProviderError) throw error; throw new MusicProviderError('EFFECT_UNKNOWN', 'Music audio transfer was interrupted after dispatch', 'UNKNOWN') } finally { reader.releaseLock() }
    const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    let actualSeconds: number;
    try { actualSeconds = inspectMp3(bytes).durationSeconds } catch { throw new MusicProviderError('EFFECT_UNKNOWN', 'Music response failed MP3 structure/duration validation; preserve provider operation evidence before regeneration', 'UNKNOWN') }
    if (actualSeconds < 1 || actualSeconds > 610) throw new MusicProviderError('EFFECT_UNKNOWN', 'Music output duration is outside provider bounds', 'UNKNOWN');
    const warnings = [...request.warnings];
    if (Math.abs(actualSeconds - request.requestedSeconds) > 2) warnings.push(`Decoded frame duration differs from requested duration: ${actualSeconds.toFixed(3)}s versus ${request.requestedSeconds}s`);
    const rawSongId = response.headers.get('song-id'), songId = rawSongId && /^[A-Za-z0-9_-]{1,128}$/.test(rawSongId) ? rawSongId : undefined;
    return { bytes, contentType: 'audio/mpeg', provider: 'elevenlabs', model: 'music_v2_5', ...(songId ? { songId } : {}), requestedSeconds: request.requestedSeconds, actualSeconds, ...(input.seed === undefined ? {} : { seed: input.seed }), warnings, validation: { framing: true, playback: 'UNVERIFIED', lyrics: 'UNVERIFIED' } };
  } catch (error) {
    if (error instanceof MusicProviderError) throw error;
    throw new MusicProviderError('EFFECT_UNKNOWN', 'Music provider processing failed after dispatch; reconcile provider usage before generating again', 'UNKNOWN');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}

/** Validates complete MPEG Layer III framing and derives duration; playback/lyrics fidelity still needs real decoding/listening. */
export function inspectMp3(bytes: Uint8Array): { durationSeconds: number; frames: number } {
  let cursor = 0, frames = 0, durationSeconds = 0;
  const fail = (): never => { throw new Error('Invalid MP3 framing') };
  if (bytes.length >= 10 && bytes[0] === 73 && bytes[1] === 68 && bytes[2] === 51) {
    if (bytes.subarray(6, 10).some(byte => byte > 127)) fail();
    const size = ((bytes[6]! << 21) | (bytes[7]! << 14) | (bytes[8]! << 7) | bytes[9]!) + 10 + ((bytes[5]! & 16) ? 10 : 0);
    if (size > bytes.length) fail(); cursor = size;
  }
  while (cursor < bytes.length) {
    if (bytes.length - cursor === 128 && bytes[cursor] === 84 && bytes[cursor + 1] === 65 && bytes[cursor + 2] === 71) { cursor += 128; break }
    if (cursor + 4 > bytes.length || bytes[cursor] !== 255 || (bytes[cursor + 1]! & 224) !== 224) fail();
    const version = (bytes[cursor + 1]! >> 3) & 3, layer = (bytes[cursor + 1]! >> 1) & 3, bitrateIndex = bytes[cursor + 2]! >> 4, sampleIndex = (bytes[cursor + 2]! >> 2) & 3, padding = (bytes[cursor + 2]! >> 1) & 1;
    if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || sampleIndex === 3) fail();
    const bitrate = (version === 3 ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160])[bitrateIndex]!;
    const sampleRate = [44100, 48000, 32000][sampleIndex]! / (version === 3 ? 1 : version === 2 ? 2 : 4);
    const size = Math.floor((version === 3 ? 144000 : 72000) * bitrate / sampleRate) + padding;
    if (size < 4 || cursor + size > bytes.length) fail();
    cursor += size; frames++; durationSeconds += (version === 3 ? 1152 : 576) / sampleRate;
  }
  if (cursor !== bytes.length || frames === 0) fail();
  return { durationSeconds, frames };
}
