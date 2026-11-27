import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundObjectStore, hasQuarantinedWorkspaceData, resolveBindingStorage } from '../../apps/userscript/src/binding-storage.js';
import { MemoryStore } from '../../apps/userscript/src/storage.js';
import { bytesToBase64 } from '../../apps/userscript/src/native-types.js';
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
