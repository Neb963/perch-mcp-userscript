import assert from 'node:assert/strict';
import test from 'node:test';
import { boundEpochChunkKeys, BoundObjectStore, exportWorkspaceEvidence, hasQuarantinedWorkspaceData, inspectBoundStage,
  readBoundCheckpoint, resolveBindingStorage } from '../../apps/userscript/src/binding-storage.js';
import { MemoryStore } from '../../apps/userscript/src/storage.js';
import { bytesToBase64, digest } from '../../apps/userscript/src/native-types.js';
import { VirtualFileSystem } from '../../apps/userscript/src/vfs.js';
import type { NativeAdapter } from '../../apps/userscript/src/adapter.js';

const tuple = { workspaceId: 'workspace-1', installationId: 'inst-1', assignmentGeneration: 1,
  bindingGeneration: 2, epoch: 3, generatorId: 'id-1', draftId: '' };
const encoder = new TextEncoder();
const payload = (files: Record<string, string>, label = 'snapshot') =>
  encoder.encode(JSON.stringify({version: 1, files, label}));
const fixtureBytes = Uint8Array.from([0, 255, 128, 17, 0]);
const checkpoint1 = 'checkpoint:11111111-1111-4111-8111-111111111111';
const checkpoint2 = 'checkpoint:22222222-2222-4222-8222-222222222222';

test('Binding objects deduplicate unchanged binary chunks and preserve bytes, including empty files', async () => {
  const store = new MemoryStore();
  const scope = await resolveBindingStorage(tuple, () => undefined);
  const objects = new BoundObjectStore(store, scope, 4 * 1024 * 1024);
  const files = {'scratch/fixture.bin': bytesToBase64(fixtureBytes), 'scratch/empty.txt': ''};
  const local = payload(files);
  await objects.put('local', local);
  await objects.put(checkpoint1, local);
  const next = payload({...files, 'scratch/change.txt': 'dGV4dA=='}, 'next checkpoint');
  await objects.put(checkpoint2, next);
  assert.deepEqual(await objects.get('local'), local);
  assert.deepEqual(await objects.get(checkpoint2), next);
  const view = await objects.localView();
  assert.equal(view.files.length, 2);
  assert.deepEqual(await view.read('scratch/fixture.bin'), fixtureBytes);
  assert.equal((await view.read('scratch/empty.txt')).length, 0);
  assert.equal((await store.list()).filter((key) => key.includes(':chunk:')).length, 2);
  await objects.delete(checkpoint2);
  assert.equal(await objects.collectOrphans(), 1);
  assert.deepEqual(await objects.get(checkpoint1), local);
});

test('Epoch adoption verifies the old local snapshot and refuses uncertainty without crossing a Binding', async () => {
  const store = new MemoryStore();
  const scope = await resolveBindingStorage(tuple, () => undefined);
  const old = new BoundObjectStore(store, scope, 256 * 1024);
  await old.put('local', payload({'scratch/fixture.bin': bytesToBase64(fixtureBytes)}));
  await store.set('perch:workspace:workspace-1:journal:legacy', {id: 'legacy'});
  assert.equal(await hasQuarantinedWorkspaceData(store, tuple.workspaceId), true);
  const adapter = {} as NativeAdapter; // Adoption requires no native or network access.
  const next = await VirtualFileSystem.openBound(adapter, store, {...tuple, epoch: 4}, {assertCurrent: () => undefined});
  assert.deepEqual(await (await next.localView()).read('scratch/fixture.bin'), fixtureBytes);
  await store.set(scope.epochPrefix + ':journal:held', {
    id: 'held', state: 'UNKNOWN', paths: ['scratch/fixture.bin'], baseRevision: 'opaque',
  });
  await assert.rejects(VirtualFileSystem.openBound(adapter, store, {...tuple, epoch: 5}, {assertCurrent: () => undefined}),
    /Earlier Epoch has unresolved/);
  const replaced = await VirtualFileSystem.openBound(adapter, store, {...tuple, assignmentGeneration: 2, epoch: 5}, {assertCurrent: () => undefined});
  assert.deepEqual((await replaced.localView()).files, []);
  assert.equal(await hasQuarantinedWorkspaceData(store, tuple.workspaceId), true);
});

test('F06 repeated verified reconnects retain 5 and 20 MiB without new writes or records', async (context) => {
  class CountedStore extends MemoryStore {
    writes = 0;
    override async set<T>(key: string, value: T): Promise<void> {
      this.writes++;
      await super.set(key, value);
    }
    override async delete(key: string): Promise<void> {
      this.writes++;
      await super.delete(key);
    }
  }
  for (const sizeMiB of [5, 20]) {
    const store = new CountedStore();
    const scope = await resolveBindingStorage(tuple, () => undefined);
    const initial = new BoundObjectStore(store, scope, 64 * 1024 * 1024);
    const files: Record<string, string> = {};
    for (let file = 0; file < sizeMiB / 5; file++) {
      const bytes = new Uint8Array(5 * 1024 * 1024);
      // Unique chunks avoid accidentally benchmarking a repeated fill string.
      for (let offset = 0; offset < bytes.length; offset += 192 * 1024) {
        bytes[offset] = file;
        bytes[offset + 1] = offset / (192 * 1024);
      }
      files[`scratch/fixture-${file}.bin`] = bytesToBase64(bytes);
    }
    await initial.put('local', payload(files));
    const keys = await store.list();
    const writes = store.writes;
    const physicalBytes = (await Promise.all(keys.map(async key =>
      encoder.encode(key).length + encoder.encode(JSON.stringify(await store.get(key))).length)))
      .reduce((total, bytes) => total + bytes, 0);
    for (const epoch of [4, 5, 6, 7, 8, 33]) {
      const next = await VirtualFileSystem.openBound({} as NativeAdapter, store, {...tuple, epoch}, {assertCurrent: () => undefined});
      const view = await next.localView();
      assert.equal(view.files.reduce((total, file) => total + file.bytes, 0), sizeMiB * 1024 * 1024);
      assert.equal(await digest(await view.read('scratch/fixture-0.bin')), view.files[0]!.sha256);
      assert.deepEqual(await store.list(), keys, 'reconnect creates neither copied chunks nor duplicate root metadata');
      assert.equal(store.writes, writes, 'read-only adoption performs no GM-style set/delete');
    }
    context.diagnostic(`${sizeMiB} MiB decoded: ${keys.length} keys, ${physicalBytes} serialized bytes, unchanged over 6 reconnects`);
  }
});

test('F06 successor publishes unchanged historical bytes by reference and old GC preserves adopted bytes', async () => {
  const store = new MemoryStore();
  const oldScope = await resolveBindingStorage(tuple, () => undefined);
  const old = new BoundObjectStore(store, oldScope, 4 * 1024 * 1024);
  const original = {'scratch/fixture.bin': bytesToBase64(fixtureBytes)};
  await old.put('local', payload(original));
  await old.put(checkpoint1, payload(original));

  const nextScope = await resolveBindingStorage({...tuple, epoch:4}, () => undefined);
  const next = new BoundObjectStore(store, nextScope, 4 * 1024 * 1024);
  assert.equal(await next.adoptLocal(old), true);
  const originalKeys = (await store.list()).filter(key => key.includes(':chunk:'));

  await old.put('local', payload({'scratch/replacement.txt': 'cmVwbGFjZW1lbnQ='}));
  await old.delete(checkpoint1);
  assert.equal(await old.collectOrphans(), 0, 'ever-adoptable source cannot be swept by its former writer');

  await next.put('local', payload({...original, 'scratch/new.txt': 'bmV3'}));
  await next.put(checkpoint2, payload(original));
  assert.deepEqual(await (await next.localView()).read('scratch/fixture.bin'), fixtureBytes);
  const nextChunks = (await store.list()).filter(key => key.startsWith(nextScope.epochPrefix + ':chunk:'));
  assert.equal(nextChunks.length, 1, 'one changed file produces one current-Epoch chunk');
  const checkpointRoot = `${nextScope.epochPrefix}:root:${checkpoint2}`;
  assert.deepEqual(await boundEpochChunkKeys(store, nextScope.epochPrefix, [checkpointRoot]), originalKeys);
  assert.deepEqual(await readBoundCheckpoint(store, nextScope.epochPrefix, checkpoint2.slice('checkpoint:'.length)), payload(original));
  const foreign = await resolveBindingStorage({...tuple, assignmentGeneration:2, epoch:4}, () => undefined);
  await assert.rejects(new BoundObjectStore(store, foreign, 4 * 1024 * 1024).adoptLocal(old), /exact Binding/);
});

test('F06 keeps exact old v2 roots readable and rejects forged v3 future-Epoch refs', async () => {
  const store = new MemoryStore();
  const scope = await resolveBindingStorage(tuple, () => undefined);
  const path = 'scratch/fixture.bin';
  const sha256 = await digest(fixtureBytes);
  const encoded = bytesToBase64(fixtureBytes);
  const data = payload({[path]:encoded});
  const oldRoot = {version:2, sourceHash:await digest(data), sourceBytes:data.length,
    fields:{version:1, files:null, label:'snapshot'},
    files:{[path]:{sha256, bytes:fixtureBytes.length, chunks:[{sha256, bytes:fixtureBytes.length}]}}};
  const key = scope.epochPrefix + ':root:local';
  await store.set(key, oldRoot);
  await store.set(`${scope.epochPrefix}:chunk:${sha256}:${fixtureBytes.length}`, encoded);
  const old = new BoundObjectStore(store, scope, 4 * 1024 * 1024);
  assert.deepEqual(await old.get('local'), data);
  const next = new BoundObjectStore(store, await resolveBindingStorage({...tuple, epoch:4}, () => undefined), 4 * 1024 * 1024);
  assert.equal(await next.adoptLocal(old), true);
  assert.deepEqual(await (await next.localView()).read(path), fixtureBytes);

  await store.set(key, {...oldRoot, version:3, files:{[path]:{...oldRoot.files[path], chunks:[{sha256, bytes:fixtureBytes.length, epoch:4}]}}});
  await assert.rejects(old.get('local'), /chunk reference/);
});

test('F06 lost publication receipt preserves exact typed stage and prior inherited bytes', async () => {
  let loseAck = false;
  class LostAckStore extends MemoryStore {
    override async set<T>(key: string, value: T): Promise<void> {
      if (loseAck && key.endsWith(':epoch:4:root:local')) throw new Error('synthetic store outage before root write');
      await super.set(key, value);
    }
  }
  const store = new LostAckStore();
  const oldScope = await resolveBindingStorage(tuple, () => undefined);
  const nextScope = await resolveBindingStorage({...tuple, epoch:4}, () => undefined);
  const prior = new BoundObjectStore(store, oldScope, 4 * 1024 * 1024);
  const next = new BoundObjectStore(store, nextScope, 4 * 1024 * 1024);
  await prior.put('local', payload({'scratch/fixture.bin': bytesToBase64(fixtureBytes)}));
  assert.equal(await next.adoptLocal(prior), true);
  loseAck = true;
  await assert.rejects(next.put('local', payload({'scratch/replacement.txt': 'cmVwbGFjZW1lbnQ='})), /requires exact readback/);
  const allKeys = await store.list();
  const stageKey = allKeys.find(key => key.startsWith(nextScope.epochPrefix + ':stage:'))!;
  assert.ok(stageKey);
  const observed = await inspectBoundStage(store, nextScope.epochPrefix, stageKey.split(':').at(-1)!);
  assert.equal(observed.objectName, 'local');
  assert.equal(observed.observedState, 'PREVIOUS_ROOT');
  assert.notEqual(observed.previousSourceHash, observed.stagedSourceHash);
  const protectedKeys = await boundEpochChunkKeys(store, nextScope.epochPrefix, [stageKey]);
  assert.equal(protectedKeys.length, 2);
  assert.ok(protectedKeys.every(key => allKeys.includes(key)));
  assert.equal(await next.collectOrphans(), 0);
});

test('F06 admission counts encoded historical bytes and reserves the exact transient key peak', async () => {
  const store = new MemoryStore();
  const scope = await resolveBindingStorage(tuple, () => undefined);
  const prior = new BoundObjectStore(store, scope, 512 * 1024);
  const file = Uint8Array.from({length:192 * 1024}, (_, offset) => offset % 251);
  await prior.put('local', payload({'scratch/fixture.bin':bytesToBase64(file)}));
  const nextScope = await resolveBindingStorage({...tuple, epoch:4}, () => undefined);
  const next = new BoundObjectStore(store, nextScope, 225 * 1024);
  // Decoded source fits this cap, but its already-retained encoding does not.
  await assert.rejects(next.assertStorageRoom(0), /physical storage/);
  assert.equal(await next.adoptLocal(prior), true);
  assert.deepEqual(await (await next.localView()).read('scratch/fixture.bin'), file);

  const roomy = new BoundObjectStore(store, nextScope, 64 * 1024 * 1024);
  const initial = (await store.list()).length;
  for (let i = initial; i < 4095; i++) await store.set(`${scope.epochPrefix}:operation:fixture-${i}`, 'retained');
  await roomy.assertStorageRoom(0);
  await assert.rejects(roomy.put(checkpoint2, payload({})), /physical storage/);
  assert.equal((await store.list()).length, 4095, 'stage plus checkpoint must fit before either is written');
  assert.equal(await roomy.get(checkpoint2), undefined);
});

test('Invalidated Epoch cannot publish; lost pointer acknowledgement verifies without repeating the effect', async () => {
  let valid = true;
  let writeAfterCommit = false;
  class FaultStore extends MemoryStore {
    override async set<T>(key: string, value: T): Promise<void> {
      await super.set(key, value);
      if (key.includes(':chunk:') && !writeAfterCommit) valid = false;
      if (key.endsWith(':root:local') && writeAfterCommit) throw new Error('synthetic lost acknowledgement');
    }
  }
  const store = new FaultStore();
  const scope = await resolveBindingStorage(tuple, () => {
    if (!valid) throw new Error('synthetic stale epoch');
  });
  const objects = new BoundObjectStore(store, scope, 256 * 1024);
  const source = payload({'scratch/fixture.bin': bytesToBase64(fixtureBytes)});
  await assert.rejects(objects.put('local', source), /stale epoch/);
  assert.equal(await objects.get('local'), undefined);
  writeAfterCommit = true;
  valid = true;
  await objects.put('local', source);
  assert.deepEqual(await objects.get('local'), source);
  assert.ok((await store.list()).every((key) => !key.includes(':stage:')));
  const constrained = new BoundObjectStore(new MemoryStore(), scope, 100);
  await assert.rejects(constrained.put('local', source), /physical storage/);
});

test('GC deletes at most 32 orphan chunks and retains unknown publication evidence', async () => {
  const store = new MemoryStore();
  const scope = await resolveBindingStorage(tuple, () => undefined);
  const objects = new BoundObjectStore(store, scope, 4 * 1024 * 1024);
  const files = Object.fromEntries(Array.from({length: 35}, (_, i) => [
    'scratch/file-' + i, bytesToBase64(Uint8Array.of(i)),
  ]));
  await objects.put(checkpoint1, payload(files));
  const root = await store.get(scope.epochPrefix + ':root:' + checkpoint1);
  await store.set(scope.epochPrefix + ':stage:unknown', {root});
  await objects.delete(checkpoint1);
  assert.equal(await objects.collectOrphans(), 0);
  await store.delete(scope.epochPrefix + ':stage:unknown'); // Operator reconciled this synthetic intent.
  assert.equal(await objects.collectOrphans(), 32);
  assert.equal(await objects.collectOrphans(), 3);
});

test('operator Workspace export includes retained scopes and excludes foreign records and pairing',async()=>{
  const store=new MemoryStore();
  const scope=await resolveBindingStorage(tuple,()=>undefined);
  await store.set('perch:pairing',{adminCredential:'private-credential'});
  await store.set('perch:workspace:workspace-1:journal:old',{id:'held-legacy'});
  await store.set('perch:workspace:workspace-10:journal:foreign',{id:'foreign'});
  await store.set(scope.epochPrefix+':journal:held',{id:'held-current'});
  const output=await exportWorkspaceEvidence(store,tuple.workspaceId);
  const records=JSON.parse(output).records as unknown[];
  assert.equal(records.length,2);
  assert.match(output,/held-legacy/);
  assert.match(output,/held-current/);
  assert.doesNotMatch(output,/foreign|private-credential/);
});
