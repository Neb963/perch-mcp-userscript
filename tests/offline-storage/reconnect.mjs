import assert from 'node:assert/strict';
import { BoundObjectStore, resolveBindingStorage } from '../../apps/userscript/src/binding-storage.ts';
import { MemoryStore } from '../../apps/userscript/src/storage.ts';
import { VirtualFileSystem } from '../../apps/userscript/src/vfs.ts';

const store = new MemoryStore();
const binding = {
  workspaceId: 'f06-ws', installationId: 'f06-inst', assignmentGeneration: 1,
  bindingGeneration: 2, epoch: 3, generatorId: 'f06-gen', draftId: '',
};
const assertCurrent = () => undefined;
const source = new TextEncoder().encode(JSON.stringify({
  version: 1, files: { 'scratch/example': 'AAECAw==' }, lastHash: '', generation: 1,
}));
const old = new BoundObjectStore(store, await resolveBindingStorage(binding, assertCurrent), 64 * 1024 * 1024);
await old.put('local', source);
const before = (await store.list()).length;
await VirtualFileSystem.openBound({}, store, { ...binding, epoch: 4 }, { assertCurrent });
const after = (await store.list()).length;
console.log(JSON.stringify({ before, after, extraRecords: after - before }));
assert.equal(after, before, 'unchanged reconnect must not allocate durable records');
