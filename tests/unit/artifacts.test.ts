import test from 'node:test'; import assert from 'node:assert/strict';
import { ArtifactStore } from '../../apps/userscript/src/artifacts.js'; import { MemoryStore } from '../../apps/userscript/src/storage.js';
test('artifacts capture exact immutable bytes and enforce binding scope', async () => {
 const store = new ArtifactStore(new MemoryStore()); const bytes = new Uint8Array([0,255,1,128,10]); const a = await store.create('w',1,'private.bin',bytes); bytes[0]=50;
 assert.deepEqual((await store.read(a.id,'w',1)).bytes,new Uint8Array([0,255,1,128,10]));
 await assert.rejects(store.read(a.id,'other',1)); await assert.rejects(store.read(a.id,'w',2));
 assert.equal(JSON.stringify(await store.list()).includes('data'),false);
});
