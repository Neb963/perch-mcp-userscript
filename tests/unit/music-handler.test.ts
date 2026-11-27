import test from 'node:test';
import assert from 'node:assert/strict';
import { MusicHandler, MUSIC_CHUNK_BYTES, type MusicLease, type MusicOperation, type MusicRecordStore } from '../../apps/gateway/src/media/handler.ts';
import { MusicProviderError, type MusicOutput } from '../../apps/gateway/src/media/elevenlabs.ts';

class MemoryRecords implements MusicRecordStore {
  records = new Map<string, unknown>();
  get<T>(key: string, fallback?: T): T { return structuredClone(this.records.has(key) ? this.records.get(key) : fallback) as T }
  put(key: string, value: unknown) { this.records.set(key, structuredClone(value)) }
  delete(key: string) { this.records.delete(key) }
  keys(prefix: string) { return [...this.records.keys()].filter(key => key.startsWith(prefix)).sort() }
  transaction<T>(fn: () => T): T { const before = structuredClone(this.records); try { return fn() } catch (error) { this.records = before; throw error } }
}
const ids = { workspaceId: 'work-a', epoch: 1, tabInstanceId: 'tab-a' };
const env = { PAID_MEDIA_ENABLED: 'true', ELEVENLABS_API_KEY: 'synthetic-key-not-real' };
function setup() {
  const db = new MemoryRecords(); let calls = 0, authorization = true;
  let lease: MusicLease | undefined = { ...ids, bindingRevision: 1, permissions: ['MEDIA', 'WRITE_SOURCE'], expiresAt: Date.now() + 180000 };
  const operation: MusicOperation = { ...ids, operationId: 'op-a', bindingRevision: 1, deadlineMs: Date.now() + 600000, tool: 'generate_music', args: { style: 'Original synthetic style', isInstrumental: true, userRequestedSeconds: 30, outputPath: 'scratch/test.mp3' }, permissions: ['MEDIA', 'WRITE_SOURCE'], phase: 'RUNNING', props: { grantId: 'grant-a' }, agentId: 'agent-a' };
  db.put('operation/op-a', operation);
  const audio = new Uint8Array(MUSIC_CHUNK_BYTES + 20); audio[0] = 255;
  const output: MusicOutput = { bytes: audio, provider: 'elevenlabs', model: 'music_v2_5', contentType: 'audio/mpeg', requestedSeconds: 30, actualSeconds: 30, warnings: [], validation: { framing: true, playback: 'UNVERIFIED', lyrics: 'UNVERIFIED' } };
  const deps = { getLease: () => lease, authorize: async () => { if (!authorization) throw new Error('revoked') }, generate: async () => { calls++; assert.equal(db.get<{ phase: string }>('music/journal/op-a').phase, 'INTENT'); return output } };
  return { db, operation, deps, output, body: { ...ids, operationId: 'op-a' }, handler: new MusicHandler(db, env, deps), calls: () => calls, revoke: () => { authorization = false }, setLease: (value: MusicLease | undefined) => { lease = value } };
}
const code = (value: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === value;

test('paid music admission uses stored exact args, durable intent precedes one call, repeat returns retained manifest', async () => {
  const s = setup();
  const result = await s.handler.handle('/api/v1/tab/music', s.body, s.deps.getLease()!);
  assert.equal(result.status, 'READY'); assert.equal(result.bytes, s.output.bytes.length); assert.match(String(result.sha256), /^[0-9a-f]{64}$/);
  const repeated = await s.handler.handle('/api/v1/tab/music', s.body, s.deps.getLease()!);
  assert.equal(repeated.sha256, result.sha256); assert.equal(s.calls(), 1);
  await assert.rejects(s.handler.handle('/api/v1/tab/music', { ...s.body, args: { style: 'override' } }, s.deps.getLease()!), code('INVALID_INPUT'));
  assert.equal(s.calls(), 1);
});

test('chunk transfer is scoped, aligned, bounded and explicitly consumed only by complete hash acknowledgement', async () => {
  const s = setup(); const result = await s.handler.handle('/api/v1/tab/music', s.body, s.deps.getLease()!);
  const first = await s.handler.handle('/api/v1/tab/music-result', { ...s.body, offset: 0 }, s.deps.getLease()!);
  assert.equal(Buffer.from(String(first.base64), 'base64').length, MUSIC_CHUNK_BYTES); assert.equal(first.done, false);
  const second = await s.handler.handle('/api/v1/tab/music-result', { ...s.body, offset: MUSIC_CHUNK_BYTES }, s.deps.getLease()!);
  assert.equal(Buffer.from(String(second.base64), 'base64').length, 20); assert.equal(second.done, true); assert.equal(second.nextOffset, result.bytes);
  await assert.rejects(s.handler.handle('/api/v1/tab/music-result', { ...s.body, offset: 1 }, s.deps.getLease()!), code('INVALID_INPUT'));
  await assert.rejects(s.handler.handle('/api/v1/tab/music-result', { ...s.body, offset: result.bytes, ackSha256: 'wrong' }, s.deps.getLease()!), code('INVALID_INPUT'));
  assert.ok(s.db.keys('music/chunk/op-a/').length);
  const ack = await s.handler.handle('/api/v1/tab/music-result', { ...s.body, offset: result.bytes, ackSha256: result.sha256 }, s.deps.getLease()!);
  assert.equal(ack.status, 'DELIVERED'); assert.equal(s.db.keys('music/chunk/op-a/').length, 0);
  await assert.rejects(s.handler.handle('/api/v1/tab/music', s.body, s.deps.getLease()!), code('RESULT_EXPIRED')); assert.equal(s.calls(), 1);
});

test('cross-tab/workspace/epoch and unrelated operation cannot access music or dispatch a provider', async () => {
  const s = setup();
  for (const body of [{ ...s.body, workspaceId: 'work-b' }, { ...s.body, tabInstanceId: 'tab-b' }, { ...s.body, epoch: 2 }, { ...s.body, operationId: 'op-b' }]) await assert.rejects(s.handler.handle('/api/v1/tab/music', body, s.deps.getLease()!), code('STALE_EPOCH'));
  const operation = s.db.get<MusicOperation>('operation/op-a'); operation.tool = 'page_eval'; s.db.put('operation/op-a', operation);
  await assert.rejects(s.handler.handle('/api/v1/tab/music', s.body, s.deps.getLease()!), code('STALE_EPOCH')); assert.equal(s.calls(), 0);
});

test('default spend deny, revoked Grant and missing source permission fail before external intent', async () => {
  const s = setup(); const disabled = new MusicHandler(s.db, {}, s.deps);
  await assert.rejects(disabled.handle('/api/v1/tab/music', s.body, s.deps.getLease()!), code('APPROVAL_REQUIRED')); assert.equal(s.db.keys('music/journal/').length, 0);
  const operation = s.db.get<MusicOperation>('operation/op-a'); operation.permissions = ['MEDIA']; s.db.put('operation/op-a', operation);
  await assert.rejects(s.handler.handle('/api/v1/tab/music', s.body, s.deps.getLease()!), code('SCOPE_DENIED')); assert.equal(s.calls(), 0);
});

test('revocation or lease change while Registry authorization awaits prevents dispatch', async () => {
  const s = setup(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve });
  const handler = new MusicHandler(s.db, env, { ...s.deps, authorize: () => gate });
  const attempt = handler.handle('/api/v1/tab/music', s.body, s.deps.getLease()!);
  s.setLease(undefined); release(); await assert.rejects(attempt, code('STALE_EPOCH')); assert.equal(s.calls(), 0);
});

test('in-flight duplicate and restarted DO never issue another paid call', async () => {
  const s = setup(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve }); let calls = 0;
  const deps = { ...s.deps, generate: async () => { calls++; await gate; return s.output } };
  const handler = new MusicHandler(s.db, env, deps), attempt = handler.handle('/api/v1/tab/music', s.body, s.deps.getLease()!);
  for (let n = 0; n < 50 && !calls; n++) await new Promise(resolve => setImmediate(resolve));
  const duplicate = await handler.handle('/api/v1/tab/music', s.body, s.deps.getLease()!); assert.equal(duplicate.status, 'RUNNING'); assert.equal(calls, 1);
  const restarted = new MusicHandler(s.db, env, deps);
  await assert.rejects(restarted.handle('/api/v1/tab/music', s.body, s.deps.getLease()!), code('EFFECT_UNKNOWN')); assert.equal(s.db.get<MusicOperation>('operation/op-a').phase, 'UNKNOWN'); assert.equal(calls, 1);
  release(); await assert.rejects(attempt, code('EFFECT_UNKNOWN')); assert.equal(calls, 1);
});

test('provider ambiguity makes the parent UNKNOWN; no request can regenerate it', async () => {
  const s = setup(); let calls = 0;
  const handler = new MusicHandler(s.db, env, { ...s.deps, generate: async () => { calls++; throw new MusicProviderError('EFFECT_UNKNOWN', 'synthetic failure', 'UNKNOWN') } });
  await assert.rejects(handler.handle('/api/v1/tab/music', s.body, s.deps.getLease()!), code('EFFECT_UNKNOWN'));
  assert.equal(s.db.get<MusicOperation>('operation/op-a').phase, 'UNKNOWN');
  await assert.rejects(handler.handle('/api/v1/tab/music', s.body, s.deps.getLease()!), code('STALE_EPOCH')); assert.equal(calls, 1);
});

test('completed audio cannot leak after Grant revocation or artifact expiration', async () => {
  const s = setup(); await s.handler.handle('/api/v1/tab/music', s.body, s.deps.getLease()!); s.revoke();
  await assert.rejects(s.handler.handle('/api/v1/tab/music-result', { ...s.body, offset: 0 }, s.deps.getLease()!)); assert.equal(s.calls(), 1);
  const t = setup(); await t.handler.handle('/api/v1/tab/music', t.body, t.deps.getLease()!);
  const journal = t.db.get<{ expiresAt: number }>('music/journal/op-a'); journal.expiresAt = Date.now() - 1; t.db.put('music/journal/op-a', journal);
  await assert.rejects(t.handler.handle('/api/v1/tab/music-result', { ...t.body, offset: 0 }, t.deps.getLease()!), code('RESULT_EXPIRED')); assert.equal(t.db.keys('music/chunk/op-a/').length, 0);
});

test('Workspace artifact budget refuses another generation until prior result is consumed', async () => {
  const s = setup(); await s.handler.handle('/api/v1/tab/music', s.body, s.deps.getLease()!);
  const second = { ...s.operation, operationId: 'op-b' }; s.db.put('operation/op-b', second);
  await assert.rejects(s.handler.handle('/api/v1/tab/music', { ...s.body, operationId: 'op-b' }, s.deps.getLease()!), code('QUOTA_EXCEEDED')); assert.equal(s.calls(), 1);
});

test('Registry Grant rejection is checked before every start and every chunk', async () => {
  const s = setup(); s.revoke();
  await assert.rejects(s.handler.handle('/api/v1/tab/music', s.body, s.deps.getLease()!));
  assert.equal(s.calls(), 0); assert.equal(s.db.keys('music/journal/').length, 0);
});

test('revocation after successful paid generation retains evidence and holds the parent UNKNOWN', async () => {
  const s = setup(); let authorized = 0;
  const handler = new MusicHandler(s.db, env, { ...s.deps, authorize: async () => { if (++authorized > 1) throw new Error('revoked') } });
  await assert.rejects(handler.handle('/api/v1/tab/music', s.body, s.deps.getLease()!), code('EFFECT_UNKNOWN'));
  assert.equal(s.calls(), 1); assert.equal(s.db.get<MusicOperation>('operation/op-a').phase, 'UNKNOWN');
  assert.ok(s.db.keys('music/chunk/op-a/').length); // No cross-Grant delivery despite retained exact bytes.
});

test('pre-dispatch provider input rejection does not falsely make the durable parent uncertain', async () => {
  const s = setup();
  const handler = new MusicHandler(s.db, env, { ...s.deps, generate: async () => { throw new MusicProviderError('UNSUPPORTED_CONTROL', 'known no effect', 'NONE') } });
  await assert.rejects(handler.handle('/api/v1/tab/music', s.body, s.deps.getLease()!), code('UNSUPPORTED_CONTROL'));
  assert.equal(s.db.get<MusicOperation>('operation/op-a').phase, 'RUNNING');
  assert.equal(s.db.get<{ phase: string }>('music/journal/op-a').phase, 'REJECTED');
});


test('idle music expiry physically removes chunks while retaining operation evidence', async () => {
  const s = setup();
  const result = await s.handler.handle('/api/v1/tab/music', s.body, s.deps.getLease()!);
  assert.equal(s.handler.nextExpiry(), result.expiresAt);
  const previous = Date.now;
  try {
    Date.now = () => Number(result.expiresAt);
    s.handler.expire();
    assert.equal(s.db.keys('music/chunk/').length, 0);
    assert.equal(s.handler.nextExpiry(), undefined);
    assert.equal(s.db.get<{phase:string}>('music/journal/op-a').phase, 'EXPIRED');
    assert.equal(s.db.get<MusicOperation>('operation/op-a').operationId, 'op-a');
  } finally { Date.now = previous; }
});

test('Music canonical operation callbacks preserve extensions and never mutate stale legacy operation rows', async () => {
  const s = setup();
  const canonical = new Map([['op-a', { ...s.operation, sequence: 91, argsDigest: 'immutable-digest', extension: { nullable: null, original: true } }]]);
  const handler = new MusicHandler(s.db, env, {
    ...s.deps,
    getOperation: id => structuredClone(canonical.get(id)),
    putOperation: operation => { canonical.set(operation.operationId, structuredClone(operation)); },
    generate: async () => { throw new MusicProviderError('EFFECT_UNKNOWN', 'synthetic uncertain generation', 'UNKNOWN'); },
  });
  await assert.rejects(handler.handle('/api/v1/tab/music', s.body, s.deps.getLease()!), code('EFFECT_UNKNOWN'));
  assert.equal(canonical.get('op-a')!.phase, 'UNKNOWN');
  assert.equal(canonical.get('op-a')!.sequence, 91);
  assert.equal(canonical.get('op-a')!.argsDigest, 'immutable-digest');
  assert.deepEqual(canonical.get('op-a')!.extension, { nullable: null, original: true });
  assert.equal(s.db.get<MusicOperation>('operation/op-a').phase, 'RUNNING');
});


test('missing paid media expiry fails closed without regenerating or discarding retained bytes', async () => {
  const s=setup();await s.handler.handle('/api/v1/tab/music',s.body,s.deps.getLease()!);
  const journal=s.db.get<Record<string,unknown>>('music/journal/op-a');delete journal.expiresAt;s.db.put('music/journal/op-a',journal);
  await assert.rejects(s.handler.handle('/api/v1/tab/music-result',{...s.body,offset:0},s.deps.getLease()!),/SQLITE_RECORD_CORRUPT/);
  assert.equal(s.calls(),1);assert.ok(s.db.keys('music/chunk/op-a/').length>0);
});
