import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { PublicMedia, PublicMediaError, decodeDataUrl, type PublicMediaOptions } from '../../apps/userscript/src/public-media.ts';
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=', 'base64'));
const publicUrl = 'https://user.uploads.dev/file/0123456789abcdef0123456789abcdef.png';
const privateDeletion = 'https://upload.perchance.org/api/delete?key=synthetic-private-deletion-capability';
const operation = () => ({ operationId: 'operation-a', deadlineMs: Date.now() + 600000 });
const code = (value: string, state?: string) => (error: unknown) => error instanceof PublicMediaError && error.code === value && (state === undefined || error.effectState === state);
function fixture() {
  let revision = 'source-a', writeError = false, beforeCalls = 0, generatedPrompt: unknown, uploaded = new Uint8Array();
  let imageBytes: Uint8Array = png.slice(), uploadResult: Record<string, unknown> | undefined;
  const artifacts: { bytes: Uint8Array; name: string }[] = [], secrets: unknown[] = [], writes: { path: string; bytes: Uint8Array; revision: string }[] = [];
  // This VM only models the unprivileged generator. It has no GM, application credentials or privileged callbacks.
  const context = vm.createContext({ Blob, Uint8Array, atob, btoa, root: {
    generateImage: async (prompt: unknown) => { generatedPrompt = prompt; return { dataUrl: 'data:image/png;base64,' + Buffer.from(imageBytes).toString('base64'), inputs: { seed: 42 } } },
    upload: async (blob: Blob) => { uploaded = new Uint8Array(await blob.arrayBuffer()); return uploadResult ?? { url: new String(publicUrl), error: null, size: uploaded.length, deletionUrl: privateDeletion } },
  } });
  const options: PublicMediaOptions = {
    verifiedPreview: true,
    evaluate: async source => await vm.runInContext('(async()=>{' + source + '\n})()', context, { timeout: 1000 }),
    revision: async () => revision,
    readFile: async () => uploaded.slice(),
    writeFile: async (path, bytes, expectedRevision) => { if (writeError || expectedRevision !== revision) throw new Error('synthetic stale write'); writes.push({ path, bytes: bytes.slice(), revision: expectedRevision }); revision = 'source-b'; return { status: 'SUCCEEDED', revision } },
    retainArtifact: async (bytes, name) => { artifacts.push({ bytes: bytes.slice(), name }); return { id: 'artifact-a' } },
    retainUploadSecret: async (operationId, value) => { secrets.push({ operationId, ...value }) },
    decodeImage: async bytes => { if (bytes[0] !== 137) throw new Error('invalid image'); return { width: 1, height: 1, mimeType: 'image/png' } },
    beforeEffect: async () => { beforeCalls++ },
    fetchImpl: async (url, init) => { assert.equal(url, publicUrl); assert.equal(init?.credentials, 'omit'); assert.equal(init?.redirect, 'error'); return new Response(uploaded.slice().buffer as ArrayBuffer, { headers: { 'content-length': String(uploaded.length) } }) },
  };
  return { options, context, artifacts, secrets, writes, generatedPrompt: () => generatedPrompt, uploaded: () => uploaded, beforeCalls: () => beforeCalls, changeRevision: () => { revision = 'manual-edit' }, failWrites: () => { writeError = true }, setImage: (bytes: Uint8Array) => { imageBytes = bytes }, setUploadResult: (result: Record<string, unknown>) => { uploadResult = result } };
}

test('unverified preview and absent public callable fail before any media effect', async () => {
  const f = fixture();
  await assert.rejects(new PublicMedia({ ...f.options, verifiedPreview: false }).generateImage({ prompt: 'test' }, operation()), code('UNSUPPORTED_INTERFACE', 'NONE'));
  vm.runInContext('root.generateImage=undefined', f.context);
  await assert.rejects(new PublicMedia(f.options).generateImage({ prompt: 'test' }, operation()), code('UNSUPPORTED_INTERFACE', 'NONE'));
  assert.equal(f.beforeCalls(), 0); assert.equal(f.artifacts.length, 0);
});

test('image prompt is quoted as data; no privileged object reaches the preview', async () => {
  const f = fixture(), prompt = '";globalThis.injected=true;// ` ${process.env.SECRET} </script> \u2028';
  const result = await new PublicMedia(f.options).generateImage({ prompt, outputPath: 'scratch/image.png', resolution: '512x512' }, operation()) as Record<string, unknown>;
  assert.equal(f.generatedPrompt(), prompt); assert.equal(vm.runInContext('globalThis.injected', f.context), undefined);
  assert.equal(vm.runInContext('typeof GM_getValue', f.context), 'undefined'); assert.equal(result.path, 'scratch/image.png'); assert.equal(result.seed, 42);
  assert.deepEqual(f.writes[0]!.bytes, png); assert.equal(f.artifacts.length, 1);
  assert.equal(vm.runInContext('Object.keys(globalThis).filter(x=>x.startsWith("__perchMcp"))', f.context).length, 0);
});

test('large image is transferred in bounded chunks and retained before the source commit', async () => {
  const f = fixture(), bytes = new Uint8Array(100000); bytes.set(png); bytes[99999] = 18; f.setImage(bytes);
  const result = await new PublicMedia(f.options).generateImage({ prompt: 'test' }, operation()) as Record<string, unknown>;
  assert.equal(result.bytes, bytes.length); assert.deepEqual(f.writes[0]!.bytes, bytes); assert.deepEqual(f.artifacts[0]!.bytes, bytes);
});

test('manual edit after generation preserves generated bytes and reports PARTIAL instead of overwriting', async () => {
  const f = fixture(); f.failWrites();
  await assert.rejects(new PublicMedia(f.options).generateImage({ prompt: 'test' }, operation()), code('PARTIAL_EFFECT', 'PARTIAL'));
  assert.equal(f.artifacts.length, 1); assert.equal(f.writes.length, 0);
});

test('upload converts text and data URL input to exact Blob bytes, verifies independent public readback, hides deletion capability', async () => {
  const f = fixture(), media = new PublicMedia(f.options), text = 'Original text 🦦 " data';
  const result = await media.uploadFile({ text, expiresDays: 1 }, operation()) as Record<string, unknown>;
  assert.deepEqual(f.uploaded(), new TextEncoder().encode(text)); assert.equal(result.url, publicUrl); assert.equal(result.deletionCapabilityRetained, true);
  assert.equal(JSON.stringify(result).includes('synthetic-private-deletion'), false); assert.equal(f.secrets.length, 1);
  const dataUrl = 'data:application/octet-stream;base64,AP8BgAo=';
  const binary = await media.uploadFile({ dataUrl }, operation()) as Record<string, unknown>;
  assert.deepEqual(f.uploaded(), new Uint8Array([0, 255, 1, 128, 10])); assert.equal(binary.bytes, 5);
});

test('zero-byte upload is allowed only with exact independent empty readback', async () => {
  const f = fixture(); const result = await new PublicMedia(f.options).uploadFile({ text: '' }, operation()) as Record<string, unknown>;
  assert.equal(result.bytes, 0); assert.equal(f.uploaded().length, 0);
  const broken = { ...f.options, fetchImpl: async () => new Response('unexpected bytes') };
  await assert.rejects(new PublicMedia(broken).uploadFile({ text: '' }, operation()), code('EFFECT_UNKNOWN', 'UNKNOWN'));
});

test('unsafe public URLs, incorrect size and hostile readback fail without exposing deletion capability', async () => {
  const f = fixture(); f.setUploadResult({ url: 'https://attacker.invalid/file/x', size: 1, error: null });
  await assert.rejects(new PublicMedia(f.options).uploadFile({ text: 'a' }, operation()), code('EFFECT_UNKNOWN', 'UNKNOWN'));
  const g = fixture(); g.setUploadResult({ url: publicUrl, size: 999, error: null, deletionUrl: privateDeletion });
  await assert.rejects(new PublicMedia(g.options).uploadFile({ text: 'a' }, operation()), code('EFFECT_UNKNOWN', 'UNKNOWN')); assert.equal(g.secrets.length, 1);
  const h = fixture(); await assert.rejects(new PublicMedia({ ...h.options, fetchImpl: async () => new Response('b') }).uploadFile({ text: 'a' }, operation()), code('EFFECT_UNKNOWN', 'UNKNOWN'));
});

test('staged upload rechecks source revision and permission before external dispatch', async () => {
  const f = fixture(); const options = { ...f.options, beforeEffect: async () => { f.changeRevision() } };
  await assert.rejects(new PublicMedia(options).uploadFile({ text: 'a' }, operation()), code('STALE_REVISION', 'NONE')); assert.equal(f.uploaded().length, 0);
  const denied = fixture(); await assert.rejects(new PublicMedia({ ...denied.options, beforeEffect: async () => { throw new Error('revoked') } }).uploadFile({ text: 'a' }, operation()), code('UNSUPPORTED_INTERFACE', 'NONE')); assert.equal(denied.uploaded().length, 0);
});

test('data URL validation preserves UTF-8 and rejects noncanonical or oversized payloads', () => {
  assert.deepEqual(decodeDataUrl('data:text/plain;charset=utf-8,Otter%20%F0%9F%A6%A6').bytes, new TextEncoder().encode('Otter 🦦'));
  assert.throws(() => decodeDataUrl('https://example.com/file'), code('INVALID_INPUT'));
  assert.throws(() => decodeDataUrl('data:text/plain;base64,%%%%'), code('INVALID_INPUT'));
  assert.throws(() => decodeDataUrl('data:text/plain;base64,YWJj', 2), code('LIMIT_EXCEEDED'));
});

test('percent-encoded binary data URL preserves non-UTF8 bytes instead of treating them as text', () => {
  assert.deepEqual(decodeDataUrl('data:application/octet-stream,%00%FF%01%80%0A').bytes, new Uint8Array([0, 255, 1, 128, 10]));
});

test('native quota rejection is known-no-effect, ambiguous server failure remains UNKNOWN', async () => {
  const f = fixture(); f.setUploadResult({ error: 'over_daily_allowance' });
  await assert.rejects(new PublicMedia(f.options).uploadFile({ text: 'x' }, operation()), code('PROVIDER_REJECTED', 'NONE'));
  const g = fixture(); g.setUploadResult({ error: 'server_error' });
  await assert.rejects(new PublicMedia(g.options).uploadFile({ text: 'x' }, operation()), code('EFFECT_UNKNOWN', 'UNKNOWN'));
});
