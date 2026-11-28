import assert from 'node:assert/strict';
import test from 'node:test';
import { createSourceArchive, inspectSourceArchive } from '../../apps/userscript/src/operator-backup.js';
import { OperatorPrivateFiles } from '../../apps/userscript/src/operator-private-files.js';
import { bytesToBase64, digest, snapshotRevision } from '../../apps/userscript/src/native-types.js';
import { MemoryStore } from '../../apps/userscript/src/storage.js';

const identity = {generatorId:'synthetic-generator', slug:'fixture', draftId:''};
const scope = {installationId:'installation', workspaceId:'workspace', assignmentGeneration:1,
  bindingGeneration:2, epoch:3, generatorId:identity.generatorId, draftId:identity.draftId};
const encoder = new TextEncoder();

test('F07 exact v2 archive authenticates private provenance across Epochs and source-only strips foreign private bytes', async () => {
  const store = new MemoryStore();
  const bytes = {
    'main.pjs': encoder.encode('output = fixture'), 'index.html': new Uint8Array(),
    'scratch/private.txt': encoder.encode('private'), 'imports/fixture/main.pjs': encoder.encode('cache'),
  };
  const files = Object.fromEntries(Object.entries(bytes).map(([path, value])=>[path, bytesToBase64(value)]));
  const revision = '2:' + await snapshotRevision(identity, bytes);
  const archive = await createSourceArchive(store, identity, revision, files, scope);
  const current = {...scope, epoch:4};
  const restored = await inspectSourceArchive(store, archive, 'exact-binding', current);
  assert.deepEqual(restored.files['scratch/private.txt'], bytes['scratch/private.txt']);
  assert.equal(restored.files['imports/fixture/main.pjs'], undefined);
  await assert.rejects(inspectSourceArchive(store, archive, 'exact-binding', {...current, assignmentGeneration:2}),
    {code:'BINDING_MISMATCH'});
  await assert.rejects(inspectSourceArchive(new MemoryStore(), archive, 'exact-binding', current), {code:'BINDING_MISMATCH'});
  const sourceOnly = await inspectSourceArchive(store, archive, 'source-only', {...current, assignmentGeneration:2});
  assert.deepEqual(Object.keys(sourceOnly.files).sort(), ['index.html','main.pjs']);
  assert.equal(sourceOnly.files['index.html']!.length, 0);

  const legacy = {version:1, identity, revision, files, sha256:await digest(JSON.stringify(files))};
  assert.deepEqual(Object.keys((await inspectSourceArchive(store, legacy, 'source-only')).files).sort(),
    ['index.html','main.pjs']);
  await assert.rejects(inspectSourceArchive(store, legacy, 'exact-binding', current), {code:'BINDING_MISMATCH'});
});

test('F07 private file staging is durable, isolates Bound Assignment scope and retains an exact terminal receipt', async () => {
  const store = new MemoryStore();
  const stages = new OperatorPrivateFiles(store, scope.installationId);
  await assert.rejects(stages.stage('src/private.bin', Uint8Array.of(1), null), {code:'PATH_DENIED'});
  const binary = Uint8Array.of(0, 255, 42);
  const staged = await stages.stage('scratch/private.bin', binary, scope);
  const reloaded = new OperatorPrivateFiles(store, scope.installationId);
  assert.deepEqual(await reloaded.list(), [staged]);
  const row = await reloaded.read(staged.id);
  await assert.rejects(reloaded.verifiedContent(row, {...scope, bindingGeneration:3}), {code:'BINDING_MISMATCH'});
  assert.deepEqual(await reloaded.verifiedContent(row, {...scope, epoch:4}), binary);
  const intent = await reloaded.begin(row, scope, 'first-revision');
  await assert.rejects(reloaded.verifiedContent(await reloaded.read(staged.id), scope), {code:'EFFECT_UNKNOWN'});
  await reloaded.finish(intent, 'second-revision');
  const retained = await reloaded.read(staged.id);
  assert.equal(retained.state, 'IMPORTED');
  assert.equal(retained.content, undefined);
  assert.equal(retained.expectedLocalRevision, 'first-revision');
  assert.equal(retained.resultRevision, 'second-revision');
});
