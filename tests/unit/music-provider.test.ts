import test from 'node:test';
import assert from 'node:assert/strict';
import { buildElevenLabsRequest, generateElevenLabsMusic, inspectMp3, MusicProviderError } from '../../apps/gateway/src/media/elevenlabs.ts';
const input = { style: 'Synthetic test style', isInstrumental: true, userRequestedSeconds: 30 };
function frames(count = 1250): Uint8Array { const bytes = new Uint8Array(576 * count); for (let index = 0; index < count; index++) bytes.set([255, 251, 180, 0], index * 576); return bytes }
function audioResponse() { return new Response(frames().slice().buffer as ArrayBuffer, { headers: { 'content-type': 'audio/mpeg', 'song-id': 'test-song' } }) }
const options = { paidEnabled: true, apiKey: 'synthetic-key-not-a-real-secret' };
const errorCode = (code: string, effectState: 'NONE' | 'UNKNOWN') => (error: unknown) => error instanceof MusicProviderError && error.code === code && error.effectState === effectState;

test('provider input preserves requested duration and guaranteed instrumental controls', () => {
  const request = buildElevenLabsRequest(input); assert.equal(request.body.force_instrumental, true); assert.equal(request.body.music_length_ms, 30000); assert.equal(request.body.model_id, 'music_v2_5');
  assert.throws(() => buildElevenLabsRequest({ ...input, seed: 1 }), errorCode('UNSUPPORTED_CONTROL', 'NONE'));
  assert.throws(() => buildElevenLabsRequest({ ...input, userRequestedSeconds: 301 }), errorCode('INVALID_INPUT', 'NONE'));
});

test('lyrics + seed composition plans preserve text and total time within per-chunk bounds', () => {
  const lyrics = '[Verse]\nOriginal synthetic test lyrics\n'.repeat(20);
  const request = buildElevenLabsRequest({ ...input, isInstrumental: false, lyrics, seed: 42, userRequestedSeconds: 300 });
  const plan = request.body.composition_plan as { chunks: { text: string; duration_ms: number }[] };
  assert.equal(plan.chunks.map(chunk => chunk.text).join(''), lyrics); assert.equal(plan.chunks.reduce((sum, chunk) => sum + chunk.duration_ms, 0), 300000);
  assert.ok(plan.chunks.every(chunk => chunk.duration_ms <= 120000)); assert.equal(request.body.seed, 42); assert.equal(request.body.prompt, undefined);
});

test('MP3 frame validation rejects headers-only, corrupt and truncated results', () => {
  assert.equal(inspectMp3(frames()).frames, 1250); assert.ok(Math.abs(inspectMp3(frames()).durationSeconds - 30) < 0.001);
  assert.throws(() => inspectMp3(new Uint8Array([73, 68, 51])));
  assert.throws(() => inspectMp3(frames().slice(0, -1)));
  const corrupt = frames(); corrupt[576] = 0; assert.throws(() => inspectMp3(corrupt));
});

test('disabled paid capability and pre-dispatch cancellation do not make any request', async () => {
  let calls = 0; const fetch = async () => { calls++; return audioResponse() };
  await assert.rejects(generateElevenLabsMusic(input, { ...options, paidEnabled: false, fetch }), errorCode('APPROVAL_REQUIRED', 'NONE'));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(generateElevenLabsMusic(input, { ...options, fetch }, controller.signal), errorCode('CANCELLED', 'NONE')); assert.equal(calls, 0);
});

test('one fixed request omits cookies and refuses redirects; returns bounded verified audio', async () => {
  let calls = 0;
  const result = await generateElevenLabsMusic(input, { ...options, fetch: async (url, init) => {
    calls++; assert.equal(String(url), 'https://api.elevenlabs.io/v1/music?output_format=mp3_48000_192'); assert.equal(init?.redirect, 'error'); assert.equal(init?.credentials, 'omit'); assert.equal((init?.headers as Record<string, string>)['xi-api-key'], options.apiKey); return audioResponse();
  } });
  assert.equal(calls, 1); assert.equal(result.songId, 'test-song'); assert.equal(result.bytes.length, frames().length); assert.ok(Math.abs(result.actualSeconds - 30) < 0.001); assert.equal(JSON.stringify(result).includes(options.apiKey), false);
});

test('post-dispatch failures are unknown and never retried or leak provider response secrets', async () => {
  let calls = 0;
  await assert.rejects(generateElevenLabsMusic(input, { ...options, fetch: async () => { calls++; throw new Error(options.apiKey) } }), errorCode('EFFECT_UNKNOWN', 'UNKNOWN')); assert.equal(calls, 1);
  await assert.rejects(generateElevenLabsMusic(input, { ...options, fetch: async () => new Response(JSON.stringify({ error: options.apiKey }), { headers: { 'content-type': 'application/json' } }) }), error => errorCode('EFFECT_UNKNOWN', 'UNKNOWN')(error) && !String(error).includes(options.apiKey));
  await assert.rejects(generateElevenLabsMusic(input, { ...options, fetch: async () => new Response('private-provider-text', { status: 500 }) }), errorCode('EFFECT_UNKNOWN', 'UNKNOWN'));
});

test('known provider authorization/quota rejection stays separate from unknown output', async () => {
  await assert.rejects(generateElevenLabsMusic(input, { ...options, fetch: async () => new Response('', { status: 403 }) }), errorCode('AUTH_REQUIRED', 'NONE'));
  await assert.rejects(generateElevenLabsMusic(input, { ...options, fetch: async () => new Response('', { status: 429 }) }), errorCode('QUOTA_EXCEEDED', 'NONE'));
});

test('oversized music and invalid audio never become a successful artifact', async () => {
  await assert.rejects(generateElevenLabsMusic(input, { ...options, maxBytes: 1024, fetch: async () => audioResponse() }), errorCode('LIMIT_EXCEEDED', 'UNKNOWN'));
  await assert.rejects(generateElevenLabsMusic(input, { ...options, fetch: async () => new Response('fake mp3', { headers: { 'content-type': 'audio/mpeg' } }) }), errorCode('EFFECT_UNKNOWN', 'UNKNOWN'));
});
