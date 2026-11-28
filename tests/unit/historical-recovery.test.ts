import assert from 'node:assert/strict';
import test from 'node:test';
import type { NativeAdapter } from '../../apps/userscript/src/adapter.js';
import { BoundObjectStore, resolveBindingStorage } from '../../apps/userscript/src/binding-storage.js';
import { BrowserController } from '../../apps/userscript/src/controller.js';
import { bytesToBase64, digest, snapshotRevision, utf8 } from '../../apps/userscript/src/native-types.js';
import { MemoryStore } from '../../apps/userscript/src/storage.js';
import type { GatewayTransport } from '../../apps/userscript/src/transport.js';
import { VirtualFileSystem } from '../../apps/userscript/src/vfs.js';

const tuple = {workspaceId:'workspace-recovery', installationId:'install-recovery',
  assignmentGeneration:1, bindingGeneration:1, epoch:1, generatorId:'generator-recovery', draftId:''};
const identity = {generatorId:tuple.generatorId, draftId:tuple.draftId, slug:'recovery'};
const workspace = {id:tuple.workspaceId, contractVersion:2, assignmentGeneration:1, bindingGeneration:1,
  binding:{...identity, browserInstallationId:tuple.installationId}};

class RecoveryStore extends MemoryStore {
  loseResolutionAcknowledgement = false;
  loseStageAcknowledgement = false;
  override async set<T>(key: string, value: T): Promise<void> {
    await super.set(key, value);
    if (this.loseResolutionAcknowledgement && key.includes(':journal:') &&
        (value as {resolvedByOperator?: unknown})?.resolvedByOperator === true) {
      this.loseResolutionAcknowledgement = false;
      throw new Error('Synthetic lost acknowledgement after durable journal write.');
    }
    if (this.loseStageAcknowledgement && key.includes(':stage-ack:')) {
      this.loseStageAcknowledgement = false;
      throw new Error('Synthetic lost acknowledgement after durable stage receipt.');
    }
  }
}

async function fixture() {
  const store = new RecoveryStore();
  await store.set('perch:installation-id', tuple.installationId);
  let nativeSource = 'initial native draft';
  const adapter = {
    bind() {},
    identity: async () => identity,
    assertIdentity: async () => identity,
    probe: async () => ({identity,ready:true,sourceRead:true,sourceWriteBlocked:[]}),
    async snapshot() {
      const files = {'main.pjs':utf8.encode(nativeSource), 'index.html':utf8.encode('<main>fixture</main>')};
      return {identity, files, revision:await snapshotRevision(identity,files), dirty:true, saveState:'unsaved'};
    },
  } as unknown as NativeAdapter;
  const paths: string[] = [];
  let offline = false;
  const controller = new BrowserController(adapter,store,{
    configuration:() => ({origin:'https://fixture.invalid',paired:true}),
    installationId:async () => tuple.installationId,
    async request() {
      paths.push('management-request');
      throw new Error('No management transport is expected in the historical recovery fixture.');
    },
    async tab(path: string, body: Record<string, unknown>) {
      paths.push(path);
      if (offline) throw new Error('All transport is unavailable.');
      if (path === '/api/v1/tab/release') return {};
      assert.equal(path, '/api/v1/tab/claim');
      return {contractVersion:2, ...tuple, epoch:2, expiresAt:Date.now()+120000,
        tabInstanceId:body.tabInstanceId, leaseCredential:'fixture-secret-not-evidence', permissions:[]};
    },
  } as unknown as GatewayTransport);
  const scoped = await resolveBindingStorage(tuple, () => undefined);
  const objects = new BoundObjectStore(store, scoped, 32 * 1024 * 1024);
  const oldSource = {'scratch/known.txt':bytesToBase64(utf8.encode('unchanged scratch'))};
  await objects.put('local',utf8.encode(JSON.stringify({version:1, files:oldSource,lastHash:'',generation:1})));
  return {store,adapter,controller,scope:scoped, paths, offline:() => { offline = true; },
    edit: (source: string) => { nativeSource = source; }};
}

test('F03 rejected adoption fences the old Epoch and exact offline resolution preserves original outcome', async () => {
  const f = await fixture();
  const key = f.scope.epochPrefix + ':journal:retained';
  await f.store.set(key,{id:'retained', state:'UNKNOWN',kind:'SOURCE',paths:['main.pjs'],
    baseRevision:'1:'+'c'.repeat(64), plannedPaths:{'main.pjs':await digest('intended')},createdAt:Date.now()-1000});

  await assert.rejects(f.controller.attach(workspace), /Earlier Epoch has unresolved/);
  assert.deepEqual(f.paths,['/api/v1/tab/claim','/api/v1/tab/release']);
  f.offline();

  const scopes = await f.controller.localRecoveryScopes();
  assert.equal(scopes.length,1);
  const scope = scopes[0]!;
  assert.equal(scope.epoch,1);
  assert.equal(scope.assignmentGeneration,1);
  assert.equal(scope.bindingGeneration,1);
  const inspection = await f.controller.inspectLocalRecovery(scope.id);
  const record = inspection.records[0]!;
  assert.equal(record.id,'journal-retained');
  assert.equal(record.state,'UNKNOWN');
  assert.equal(record.paths[0]?.expectedDigest,await digest('intended'));
  assert.equal(record.paths[0]?.observedDigest,await digest('initial native draft'));
  assert.ok(record.acknowledgement);

  f.edit('next native draft');
  await assert.rejects(f.controller.resolveRetainedLocalHold(scope.id, record.id, record.acknowledgement, 'Review matched.'), /changed or is not eligible/);
  let next = (await f.controller.inspectLocalRecovery(scope.id)).records[0]!;
  assert.ok(next.acknowledgement);
  assert.equal(next.paths[0]?.observedDigest,await digest('next native draft'));
  f.store.loseResolutionAcknowledgement = true;
  await f.controller.resolveRetainedLocalHold(scope.id, next.id, next.acknowledgement, 'Verified current draft after old effect.');
  assert.equal(f.store.loseResolutionAcknowledgement,false);
  const recovered = await f.store.get<Record<string, unknown>>(key);
  assert.equal(recovered?.state,'UNKNOWN');
  assert.equal(recovered?.resolvedByOperator,true);
  assert.equal(recovered?.operatorEvidence,'Verified current draft after old effect.');
  next = (await f.controller.inspectLocalRecovery(scope.id)).records[0]!;
  assert.equal(next.acknowledgement,null);

  const newEpoch = await VirtualFileSystem.openBound(f.adapter, f.store, {...tuple,epoch:3}, {assertCurrent:() => undefined});
  assert.equal(new TextDecoder().decode(await (await newEpoch.localView()).read('scratch/known.txt')), 'unchanged scratch');
  assert.deepEqual(f.paths,['/api/v1/tab/claim','/api/v1/tab/release']);
});

test('F03 offline archive isolates the exact local Epoch and quarantines malformed evidence', async () => {
  const f = await fixture();
  f.offline();
  const foreign = await resolveBindingStorage({...tuple,installationId:'foreign-install'},() => undefined);
  const oldAssignment = await resolveBindingStorage({...tuple,assignmentGeneration:2},() => undefined);
  await f.store.set(foreign.epochPrefix+':journal:foreign',{id:'foreign'});
  await f.store.set(oldAssignment.epochPrefix+':journal:other-assignment',{id:'other-assignment'});
  await f.store.set(f.scope.epochPrefix+':journal:malformed',{id:'different-id'});
  await f.store.set(f.scope.epochPrefix+':journal:blocked',{id:'blocked',state:'UNKNOWN',paths:[],baseRevision:'base'});
  await f.store.set(f.scope.epochPrefix+':journal:remote',{id:'remote',state:'UNKNOWN',paths:[],baseRevision:'base',gatewayOperationId:'operation-remote'});
  await f.store.set(f.scope.epochPrefix+':stage:malformed',{bad:'malformed-staged-pointer'});
  await f.store.set('perch:pairing',{adminCredential:'fixture-admin-not-evidence'});
  const scopes = await f.controller.localRecoveryScopes();
  assert.equal(scopes.length,2);
  assert.ok(scopes.every(row => row.installationId === tuple.installationId));
  const selected = scopes.find(row => row.assignmentGeneration === 1)!;
  const inspection = await f.controller.inspectLocalRecovery(selected.id);
  assert.equal(inspection.records.find(row => row.id === 'journal-malformed')?.kind,'QUARANTINED');
  assert.equal(inspection.records.find(row => row.id === 'stage-malformed')?.kind,'QUARANTINED');
  assert.match(inspection.records.find(row => row.id === 'journal-blocked')?.reason ?? '',/has not fenced/);
  assert.match(inspection.records.find(row => row.id === 'journal-remote')?.reason ?? '',/Gateway-correlated/);
  assert.ok(inspection.records.every(row => row.acknowledgement === null));
  const archive = await f.controller.exportLocalRecovery(selected.id);
  assert.match(archive,/perch-exact-historical-evidence-v1/);
  assert.match(archive,/different-id/);
  assert.match(archive,/malformed-staged-pointer/);
  assert.match(archive,/historical references could not be parsed/);
  assert.doesNotMatch(archive,/foreign|other-assignment|fixture-admin-not-evidence/);
  assert.deepEqual(f.paths,[]);
});

test('F03 a stage-only lost acknowledgement is resolved offline without rewriting the current pointer', async () => {
  const f = await fixture();
  const epochPrefix = f.scope.epochPrefix;
  const rootKey = epochPrefix + ':root:local';
  const stageId = 'abcd1234-1111-4111-8111-111111111111';
  const stageKey = epochPrefix + ':stage:' + stageId;
  const root = await f.store.get(rootKey);
  await f.store.set(stageKey,{root}); // Retained pre-amendment stage, with a positively matching pointer.
  await assert.rejects(f.controller.attach(workspace), /Earlier Epoch has unresolved/);
  f.offline();
  const scope = (await f.controller.localRecoveryScopes())[0]!;
  const stage = (await f.controller.inspectLocalRecovery(scope.id)).records.find(row => row.id === 'stage-' + stageId);
  assert.equal(stage?.state,'STAGED_ROOT');
  assert.ok(stage?.acknowledgement);
  await f.controller.resolveRetainedLocalHold(scope.id,stage.id,stage.acknowledgement,'Exact existing pointer inspected.');
  assert.deepEqual(await f.store.get(rootKey),root);
  assert.deepEqual(await f.store.get(stageKey),{root});
  const adopted = await VirtualFileSystem.openBound(f.adapter, f.store, {...tuple,epoch:3}, {assertCurrent:() => undefined});
  assert.equal(new TextDecoder().decode(await (await adopted.localView()).read('scratch/known.txt')), 'unchanged scratch');
  await f.store.set(rootKey, {...root as object, sourceHash:'0'.repeat(64)});
  await assert.rejects(VirtualFileSystem.openBound(f.adapter, f.store, {...tuple,epoch:4}, {assertCurrent:() => undefined}),
    /Earlier Epoch has unresolved/);
  assert.deepEqual(f.paths,['/api/v1/tab/claim','/api/v1/tab/release']);
});

test('F03 changed prior local pointer requires renewed inspection and retains the original uncertain stage', async () => {
  const f = await fixture();
  const prefix = f.scope.epochPrefix;
  const stageId = 'abcd2345-1111-4111-8111-111111111111';
  const rootKey = prefix + ':root:local';
  const stageKey = prefix + ':stage:' + stageId;
  const original = {objectName:'local', root:await f.store.get(rootKey)};
  await f.store.set(stageKey,original);
  await assert.rejects(f.controller.attach(workspace), /Earlier Epoch has unresolved/);
  f.offline();
  const scope = (await f.controller.localRecoveryScopes())[0]!;
  const displayed = (await f.controller.inspectLocalRecovery(scope.id)).records[0]!;
  assert.equal(displayed.state,'STAGED_ROOT');
  assert.ok(displayed.acknowledgement);

  // Fault injection supplies a different but valid exact local pointer.
  const objects = new BoundObjectStore(f.store,f.scope,32 * 1024 * 1024);
  const updated = utf8.encode(JSON.stringify({version:1, generation:2, lastHash:'',
    files:{'scratch/reviewed.txt':bytesToBase64(utf8.encode('reviewed private bytes'))}}));
  await objects.put('local',updated);
  await assert.rejects(f.controller.resolveRetainedLocalHold(scope.id,displayed.id,displayed.acknowledgement,
    'Old display acknowledged.'), /changed or is not eligible/);
  assert.equal(await f.store.get(prefix + ':stage-ack:' + stageId),undefined);

  const rechecked = (await f.controller.inspectLocalRecovery(scope.id)).records[0]!;
  assert.equal(rechecked.state,'DIVERGED');
  assert.ok(rechecked.acknowledgement);
  f.store.loseStageAcknowledgement = true;
  await f.controller.resolveRetainedLocalHold(scope.id,rechecked.id,rechecked.acknowledgement,
    'Accept the separately verified current private manifest. The prior effect is uncertain.');
  assert.equal(f.store.loseStageAcknowledgement,false);
  assert.deepEqual(await f.store.get(stageKey),original);
  assert.deepEqual(await objects.get('local'),updated);
  const adopted = await VirtualFileSystem.openBound(f.adapter, f.store,{...tuple,epoch:3},{assertCurrent:() => undefined});
  assert.deepEqual(await (await adopted.localView()).read('scratch/reviewed.txt'),utf8.encode('reviewed private bytes'));
  assert.deepEqual(f.paths,['/api/v1/tab/claim','/api/v1/tab/release']);
});
