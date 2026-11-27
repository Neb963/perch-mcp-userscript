import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
const bundle = await build({ entryPoints: ['tests/fixtures/binary-media-worker.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['node:*', 'cloudflare:*'] });
type Call = (path: string, body?: Record<string, unknown>) => Promise<any>;
async function fixture(run: (call: Call) => Promise<void>) { const mf = new Miniflare({ cf: false, modules: true, script: bundle.outputFiles[0]!.text, compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'], outboundService: () => { throw new Error('OFFLINE_ONLY'); }, durableObjects: { MEDIA: { className: 'MediaFixture', useSQLite: true } } }); const call: Call = async (path, body = {}) => { const r = await mf.dispatchFetch('https://media.test' + path, { method: 'POST', body: JSON.stringify(body) }); const data = await r.json() as Record<string, unknown>; if (r.status !== 200)
    throw Object.assign(new Error(JSON.stringify(data)), data); return data; }; try {
    await mf.ready;
    await run(call);
}
finally {
    await mf.dispose();
} }
const bytesOf = (size: number) => { const b = Buffer.alloc(size, 37); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(b); return b; };
async function image(call: Call, bytes: Buffer) { const sha256 = createHash('sha256').update(bytes).digest('hex'); await call('/image', { action: 'start', index: 0, byteLength: bytes.length, sha256, mimeType: 'image/png' }); for (let offset = 0; offset < bytes.length; offset += 196608)
    await call('/image', { action: 'chunk', index: 0, offset, data: bytes.subarray(offset, offset + 196608).toString('base64') }); await call('/image', { action: 'commit', index: 0 }); return { operationId: 'image-op', index: 0, byteLength: bytes.length, sha256 }; }
test('native full-size image and music use6/43 actual BLOB rows and survive flag disable/restart', { timeout: 15000 }, () => fixture(async (call) => { await call('/setup', { binary: true }); const bytes = bytesOf(1048576), reference = await image(call, bytes); let stats = await call('/stats'); assert.deepEqual(stats.binary, { count: 6, bytes: 1048576, type: 'blob' }); assert.equal(stats.legacyPayloadRows.count, 0); await call('/flag', { binary: false }); await call('/restart'); const read = await call('/read-image', { reference }); assert.equal(read.data, bytes.toString('base64')); await call('/flag', { binary: true }); const music = await call('/music'); stats = await call('/stats'); assert.equal(stats.binary.count, 49); assert.equal(stats.binary.bytes, 1048576 + 8388608); assert.equal(stats.legacyPayloadRows.count, 0); await call('/flag', { binary: false }); await call('/restart'); const chunk = await call('/music-result', { offset: 0 }); assert.equal(Buffer.from(chunk.base64, 'base64').length, 196608); await call('/music-result', { offset: music.bytes, ackSha256: music.sha256 }); assert.equal((await call('/music-result', { offset: music.bytes, ackSha256: music.sha256 })).status, 'DELIVERED'); await call('/advance', { now: 601000 }); await call('/expire'); stats = await call('/stats'); assert.equal(stats.binary.count, 0); assert.equal(stats.providerCalls, 1); assert.equal(stats.music.phase, 'DELIVERED'); }));
test('legacy image and music stay byte-compatible after native activation and exact expiry', { timeout: 15000 }, () => fixture(async (call) => { await call('/setup', { binary: false }); const bytes = bytesOf(1048576), reference = await image(call, bytes); assert.equal((await call('/stats')).legacyPayloadRows.count, 48); const music = await call('/music'); await call('/flag', { binary: true }); await call('/restart'); assert.equal((await call('/read-image', { reference })).data, bytes.toString('base64')); assert.equal(Buffer.from((await call('/music-result', { offset: 196608 })).base64, 'base64').length, 196608); let stats = await call('/stats'); assert.equal(stats.binary.count, 0); assert.equal(stats.legacyPayloadRows.count, 432); console.log(JSON.stringify({kind:'o06-payload-rows',imageBytes:1048576,musicBytes:8388608,legacy:{image:48,music:384},native:{image:6,music:43},metadataAndIndexWrites:'excluded'})); await call('/advance', { now: 601000 }); await call('/expire'); stats = await call('/stats'); assert.equal(stats.legacyPayloadRows.count, 0); assert.equal(stats.music.phase, 'EXPIRED'); assert.equal(stats.providerCalls, 1); }));
test('SQL quota fault rolls back an image chunk and preserves UNKNOWN after one paid intent', { timeout: 15000 }, () => fixture(async (call) => { await call('/setup', { binary: true }); const bytes = bytesOf(24), sha256 = createHash('sha256').update(bytes).digest('hex'); await call('/image', { action: 'start', index: 0, byteLength: bytes.length, sha256, mimeType: 'image/png' }); await call('/fault', { after: 1 }); await assert.rejects(call('/image', { action: 'chunk', index: 0, offset: 0, data: bytes.toString('base64') })); let stats = await call('/stats'); assert.equal(stats.binary.count, 0); assert.equal(stats.image.nextOffset, 0); await call('/image', { action: 'chunk', index: 0, offset: 0, data: bytes.toString('base64') }); await call('/fault', { after: 5 }); await assert.rejects(call('/music'), e => (e as {
    code?: string;
}).code === 'EFFECT_UNKNOWN'); stats = await call('/stats'); assert.equal(stats.binary.count, 1); assert.equal(stats.music.phase, 'UNKNOWN'); assert.equal(stats.music.bytes, 0); assert.equal(stats.providerCalls, 1); await assert.rejects(call('/music'), e => (e as {
    code?: string;
}).code === 'STALE_EPOCH'); assert.equal((await call('/stats')).providerCalls, 1); }));
test('bounded catalog backfill resumes1000 legacy journals and catches old writes/deletes', { timeout: 15000 }, () => fixture(async (call) => { await call('/setup', { binary: true }); await call('/seed-history', { count: 1000 }); const first = await call('/prepare'); assert.equal(first.music, false); await call('/delete', { key: 'music/journal/history-0001' }); await call('/seed', { key: 'music/journal/history-0000', value: { operationId: 'history-0000', workspaceId: 'media-w', epoch: 1, bindingRevision: 1, tabInstanceId: 'media-tab', requestDigest: 'legacy-rewrite', phase: 'UNKNOWN', createdAt: 1000, bytes: 0, metadata: { unicode: '🚀'.repeat(20000) } } }); await call('/seed', { key: 'music/journal/history-0000a', value: { operationId: 'history-0000a', workspaceId: 'media-w', epoch: 1, bindingRevision: 1, tabInstanceId: 'media-tab', requestDigest: 'new-old-write', phase: 'UNKNOWN', createdAt: 1000, bytes: 0 } }); let steps = 1, progress = first; while (!progress.music && steps < 20) {
    await call('/restart');
    progress = await call('/prepare');
    steps++;
} assert.equal(progress.music, true); assert.ok(steps > 1 && steps < 20); const before = await call('/stats'); assert.equal(before.catalog.find((x: any) => x.kind === 'music').count, 1000); await assert.rejects(call('/music'), e => (e as {
    code?: string;
}).code === 'QUOTA_EXCEEDED'); const after = await call('/stats'); assert.equal(after.providerCalls, 0); assert.equal(after.catalog.find((x: any) => x.kind === 'music').count, 1000); }));
test('native music point read costs stay independent of1000 unrelated retained journals', { timeout: 15000 }, () => fixture(async (call) => { await call('/setup', { binary: true }); await call('/music'); let before = await call('/usage'); await call('/music-result', { offset: 0 }); let after = await call('/usage'); const clean = { reads: after.reads - before.reads, writes: after.writes - before.writes }; await call('/seed-history', { count: 1000 }); let progress = { music: false }; for (let i = 0; i < 20 && !progress.music; i++)
    progress = await call('/prepare'); assert.equal(progress.music, true); before = await call('/usage'); await call('/music-result', { offset: 0 }); after = await call('/usage'); const retained = { reads: after.reads - before.reads, writes: after.writes - before.writes }; assert.deepEqual(retained, clean); assert.equal(retained.writes, 0); console.log(JSON.stringify({ kind: 'o06-music-point-read', clean, retained, history: 1000, chunkBytes: 196608 })); }));
test('rejected paid admission commits bounded preparation and requests background progress before INTENT', { timeout: 15000 }, () => fixture(async (call) => { await call('/setup', { binary: true }); await call('/seed-history', { count: 1000 }); await assert.rejects(call('/music'), e => (e as {
    code?: string;
}).code === 'TAB_BUSY'); let stats = await call('/stats'); assert.equal(stats.providerCalls, 0); assert.equal(stats.music, undefined); assert.equal(stats.preparationSignals, 1); assert.ok(stats.catalog.find((x: any) => x.kind === 'music').count > 0 && stats.catalog.find((x: any) => x.kind === 'music').count <= 128); let terminal = ''; for (let i = 0; i < 12; i++) {
    try {
        await call('/music');
        throw new Error('Oversized journal admission unexpectedly succeeded');
    }
    catch (error) {
        if ((error as {
            code?: string;
        }).code === 'QUOTA_EXCEEDED') {
            terminal = (error as {
                code: string;
            }).code;
            break;
        }
        assert.equal((error as {
            code?: string;
        }).code, 'TAB_BUSY');
    }
} assert.equal(terminal, 'QUOTA_EXCEEDED'); stats = await call('/stats'); assert.equal(stats.catalog.find((x: any) => x.kind === 'music').count, 1000); assert.equal(stats.providerCalls, 0); assert.equal(stats.music, undefined); }));


test('pre-index maintenance startup and10000-journal convergence stay bounded across restart', { timeout: 15000 }, () => fixture(async call => {
  await call('/setup', { binary: false });
  await call('/seed-history', { count: 10000 });
  let result = await call('/maintenance');
  assert.ok(result.indexed <= 128);
  assert.equal(result.ready, false);
  let steps = 1, maximumReads = result.usage.reads;
  while (!result.ready && steps < 100) {
    const previous = result.indexed;
    if (steps % 7 === 0) await call('/restart');
    result = await call('/maintenance');
    assert.ok(result.indexed - previous <= 128);
    maximumReads = Math.max(maximumReads, result.usage.reads);
    steps++;
  }
  assert.equal(result.ready, true);
  assert.equal(result.indexed, 10000);
  assert.ok(maximumReads < 1000, "One128-record preparation batch must not scan10000 retained journals");
  assert.ok(steps > 70 && steps < 100);
  console.log(JSON.stringify({ kind: 'o06-maintenance-backfill', legacyJournals: 10000, steps, maximumReads }));
}));


test('partial v2 maintenance leaves absent v1 available for the actual old constructor', { timeout: 15000 }, () => fixture(async call => {
  await call('/setup', { binary: false }); await call('/seed-history', { count: 1000 });
  const partial = await call('/maintenance'); assert.equal(partial.ready, false); assert.equal(partial.legacy, false);
  const old = await call('/old-maintenance'); assert.equal(old.indexed, 1000);
}));

test('complete v1 maintenance stays rollback-compatible through preparation and stops tracking only after native fence', { timeout: 15000 }, () => fixture(async call => {
  await call('/setup', { binary: false }); await call('/seed-history', { count: 150 });
  assert.equal((await call('/old-maintenance')).indexed, 150);
  const partial = await call('/maintenance'); assert.equal(partial.ready, false); assert.equal(partial.legacyTriggers, 3);
  await call('/seed', { key: 'music/journal/legacy-new', value: { operationId: 'legacy-new', phase: 'UNKNOWN', createdAt: 1000, bytes: 0 } });
  assert.equal((await call('/old-maintenance')).indexed, 151);
  await call('/native-maintenance-fence');
  const fenced = await call('/maintenance'); assert.equal(fenced.legacy, true); assert.equal(fenced.legacyTriggers, 0);
}));


test('media storage diagnostics are read-only and distinguish uninitialized counters from measured zero', {timeout:15000},()=>fixture(async call=>{
  await call('/setup',{binary:false});const before=await call('/usage');
  const status=await call('/storage-status');const after=await call('/usage');
  assert.equal(after.writes-before.writes,0);
  for(const kind of ['image','music'])assert.deepEqual(status[kind],{binaryWritesEnabled:false,metadata:{stage:'UNINITIALIZED',indexedCount:null,indexedReservedBytes:null,indexedBusy:null}});
  assert.deepEqual((await call('/stats')).catalog,[]);
}));


test('orphaned nonzero metadata parts block preparation before and after index initialization without rewriting evidence', {timeout:15000},()=>fixture(async call=>{
  await call('/setup',{binary:false});
  const key='music/journal/bad-parts',value={operationId:'bad-parts',workspaceId:'media-w',epoch:1,bindingRevision:1,tabInstanceId:'media-tab',requestDigest:'synthetic',phase:'UNKNOWN',createdAt:1000,bytes:0};
  await call('/corrupt-parts',{key,value});
  await assert.rejects(call('/prepare'),/SQLITE_RECORD_CORRUPT/);
  assert.deepEqual(await call('/parts',{key}),{parts:[1]});
  await call('/delete',{key}); await call('/prepare');
  await call('/corrupt-parts',{key,value});
  await assert.rejects(call('/prepare'),/SQLITE_RECORD_CORRUPT/);
  assert.equal((await call('/storage-status')).music.metadata.stage,'PREPARE');
  await call('/maintenance');
  await assert.rejects(call('/maintenance'),/SQLITE_RECORD_CORRUPT/);
  assert.deepEqual(await call('/parts',{key}),{parts:[1]});
}));

test('a native image manifest without its exact expiry fails closed and retains its payload', {timeout:15000},()=>fixture(async call=>{
  await call('/setup',{binary:true});const reference=await image(call,bytesOf(24));
  const manifest=(await call('/stats')).image;delete manifest.expiresAt;
  await call('/seed',{key:'image/manifest/image-op/0',value:manifest});
  await assert.rejects(call('/read-image',{reference}),/SQLITE_RECORD_CORRUPT/);
  assert.equal((await call('/stats')).binary.count,1);
}));
