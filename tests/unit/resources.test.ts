import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { ResourceLibrary, ResourceError, readSafeZip, type ResourceInput } from '../../packages/resource-library/src/index.ts';
const input = (id: string, body = 'original'): ResourceInput => ({ id, kind: 'skill', body, provenance: 'Original synthetic test', license: 'test' });
const rejects = (code: string) => (error: unknown) => error instanceof ResourceError && error.code === code;

test('default seed, repeat initialization and upstream customization preservation', async () => {
  const lib = new ResourceLibrary();
  assert.deepEqual((await lib.seed([input('one'), input('two')])).added, ['one', 'two']);
  const revision = lib.revision;
  await lib.seed([input('one'), input('two')]); assert.equal(lib.revision, revision);
  await lib.publish(input('one', 'my edit'), 1);
  const update = await lib.seed([input('one', 'upstream'), input('two', 'upstream')]);
  assert.deepEqual(update.preserved, ['one']); assert.equal(lib.get('one').body, 'my edit'); assert.equal(lib.get('two').body, 'upstream');
});

test('immutable revisions, CAS conflicts, restoration creates a new revision', async () => {
  const lib = new ResourceLibrary(); await lib.publish(input('one'), 'absent');
  await assert.rejects(lib.publish(input('one', 'stale'), 'absent'), rejects('RESOURCE_CONFLICT'));
  const next = await lib.publish(input('one', 'changed'), 1); assert.equal(next.revision, 2);
  await assert.rejects(lib.publish(input('one', 'stale'), 1), rejects('RESOURCE_CONFLICT'));
  const restored = await lib.restore('one', 1, 2); assert.equal(restored.revision, 3); assert.equal(restored.body, 'original');
  const history = lib.history('one'); history[0]!.body = 'outside mutation'; assert.equal(lib.history('one')[0]!.body, 'original');
  assert.equal(new ResourceLibrary(lib.snapshot()).get('one').body, 'original');
});

test('concurrent async publishes cannot lose a committed update', async () => {
  const lib = new ResourceLibrary(); await lib.publish(input('one'), 'absent');
  const outcomes = await Promise.allSettled([lib.publish(input('one', 'a'), 1), lib.publish(input('one', 'b'), 1)]);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1); assert.equal(lib.get('one').revision, 2);
});

test('effective assignments are deterministic and unauthorized history stays inaccessible', async () => {
  const lib = new ResourceLibrary(); await lib.publish({ ...input('private'), enabled: false }, 'absent');
  lib.assign('agent', 'agent-a', 'private', true, lib.revision);
  assert.deepEqual(lib.list({ agentId: 'agent-b' }), []);
  assert.equal(lib.get('private', { agentId: 'agent-a' }).id, 'private');
  assert.throws(() => lib.get('private', { agentId: 'agent-b' }, 1), rejects('RESOURCE_NOT_FOUND'));
  lib.assign('global', 'global', 'private', true, lib.revision);
  lib.assign('workspace', 'work-a', 'private', false, lib.revision);
  assert.equal(lib.list({ workspaceId: 'work-a' }).length, 0);
  assert.equal(lib.list({ workspaceId: 'work-a', agentId: 'agent-a' }).length, 1);
});

test('dependencies, cycles, deletion references and disabled dependency errors', async () => {
  const lib = new ResourceLibrary(); await lib.publish(input('base'), 'absent');
  await lib.publish({ ...input('child'), dependencies: ['base'] }, 'absent');
  await assert.rejects(lib.publish({ ...input('base'), dependencies: ['child'] }, 1), rejects('DEPENDENCY_CYCLE'));
  assert.equal(lib.get('base').revision, 1);
  assert.throws(() => lib.remove('base', 1), rejects('RESOURCE_IN_USE'));
  lib.assign('agent', 'a', 'base', false, lib.revision);
  assert.throws(() => lib.list({ agentId: 'a' }), rejects('MISSING_DEPENDENCY'));
});

test('flat ZIP import preview exclusions and atomic conflict review', async () => {
  const lib = new ResourceLibrary(); await lib.publish(input('one'), 'absent');
  const zip = zipSync({ 'one.md': strToU8('new'), 'two.md': strToU8('new two'), 'report.md': strToU8('excluded'), 'opencode.md': strToU8('excluded') });
  const preview = await lib.previewImport(zip); assert.equal(preview.entries.filter(x => x.action === 'excluded').length, 2);
  const revision = lib.revision;
  await assert.rejects(lib.commitImport(preview, {}, revision), rejects('RESOURCE_CONFLICT'));
  assert.equal(lib.revision, revision); assert.equal(lib.list().length, 1);
  await lib.commitImport(preview, { one: { action: 'fork', newId: 'one-fork' } }, revision);
  assert.equal(lib.get('one').body, 'original'); assert.equal(lib.get('one-fork').body, 'new'); assert.equal(lib.get('two').body, 'new two');
});

test('manifest export roundtrip preserves body, references and metadata', async () => {
  const source = new ResourceLibrary();
  await source.publish({ ...input('one', '# Test\n\nUnicode: otter 🦦'), files: { 'examples/basic.md': 'Example' }, description: 'Description' }, 'absent');
  const archive = source.exportZip(), target = new ResourceLibrary(), preview = await target.previewImport(archive);
  await target.commitImport(preview, {}, 0);
  assert.equal(target.get('one').hash, source.get('one').hash);
  assert.deepEqual(target.get('one').files, source.get('one').files);
});

test('ZIP rejects traversal, path aliases, duplicate casing, bombs, binary text and CRC corruption', () => {
  for (const path of ['../evil.md', '/root.md', 'a\\b.md', 'a/../b.md', 'constructor/x.md', 'a%2fb.md']) assert.throws(() => readSafeZip(zipSync({ [path]: strToU8('x') })), error => error instanceof ResourceError);
  assert.throws(() => readSafeZip(zipSync({ 'One.md': strToU8('a'), 'one.md': strToU8('b') })), rejects('INVALID_ARCHIVE'));
  assert.throws(() => readSafeZip(zipSync({ 'one.md': strToU8('x'.repeat(1024 * 1024)) })), rejects('LIMIT_EXCEEDED'));
  assert.throws(() => readSafeZip(zipSync({ 'one.md': new Uint8Array([255, 254]) })), rejects('INVALID_ARCHIVE'));
  const corrupted = zipSync({ 'one.md': [strToU8('not compressed'), { level: 0 }] }); corrupted[40] = corrupted[40]! ^ 1;
  assert.throws(() => readSafeZip(corrupted), rejects('INVALID_ARCHIVE'));
});

test('invalid import dependency graphs and stale/tampered previews commit nothing', async () => {
  const lib = new ResourceLibrary();
  const manifest = { schemaVersion: 1, resources: [{ id: 'child', kind: 'skill', path: 'child.md', metadata: { dependencies: ['missing'] } }] };
  const preview = await lib.previewImport(zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)), 'child.md': strToU8('child') }));
  await assert.rejects(lib.commitImport(preview, {}, 0), rejects('MISSING_DEPENDENCY')); assert.equal(lib.list().length, 0);
  preview.resources[0]!.body = 'tampered';
  await assert.rejects(lib.commitImport(preview, {}, 0), rejects('RESOURCE_CONFLICT'));
});

test('secret-looking unknown metadata is rejected rather than exported', async () => {
  const lib = new ResourceLibrary();
  await assert.rejects(lib.publish({ ...input('test'), token: 'must not persist' } as ResourceInput, 'absent'), rejects('INVALID_RESOURCE'));
  assert.equal(lib.list().length, 0);
});

test('bundled library exposes eleven domain skills without import, all substantive references', async () => {
  const { defaultResources } = await import('../../packages/resources/defaults.ts');
  const lib = new ResourceLibrary(); await lib.seed(defaultResources);
  const skills = lib.list({}, 'skill'); assert.equal(skills.length, 11);
  for (const skill of skills) { assert.ok(skill.body.length > 3000, skill.id); assert.match(skill.body, /Provenance and verification status/); assert.equal(skill.customized, false) }
  assert.equal(lib.list({}, 'workflow').length, 1); assert.equal(lib.list({}, 'instruction').length, 1);
  assert.equal(lib.list({}, 'document').length, 1);
  const restored = new ResourceLibrary(); const preview = await restored.previewImport(lib.exportZip()); await restored.commitImport(preview, {}, 0);
  assert.deepEqual(restored.list().map(r => [r.id, r.hash]), lib.list().map(r => [r.id, r.hash]));
});

test('unsafe persisted state is rejected before it becomes authority', async () => {
  const lib = new ResourceLibrary(); await lib.publish(input('one'), 'absent');
  const state = lib.snapshot(); state.resources.one![0]!.revision = -1;
  assert.throws(() => new ResourceLibrary(state), rejects('INVALID_RESOURCE'));
});

test('ZIP directory entries are accepted when file entries remain canonical', () => {
  const zip = zipSync({ 'skills/': [new Uint8Array(), { level: 0 }], 'skills/one.md': strToU8('original') });
  assert.equal(readSafeZip(zip)['skills/one.md'], 'original');
});

test('revision compare reports exact source and reference changes; duplicate preserves content', async () => {
  const lib = new ResourceLibrary(); await lib.publish({ ...input('one', 'a\nb\nc'), files: { 'refs.md': 'old' } }, 'absent');
  await lib.publish({ ...input('one', 'a\nB\nc'), files: { 'refs.md': 'new' } }, 1);
  assert.deepEqual(lib.diff('one', 1, 2), [{ path: 'body.md', startLine: 2, removed: ['b'], added: ['B'] }, { path: 'refs/refs.md', startLine: 1, removed: ['old'], added: ['new'] }]);
  const copy = await lib.duplicate('one', 'copy'); assert.equal(copy.body, lib.get('one').body); assert.equal(copy.revision, 1);
});


test('unknown prototype-shaped IDs do not access inherited state', () => {
  const lib = new ResourceLibrary();
  for (const id of ['constructor', '__proto__', 'toString']) { assert.deepEqual(lib.history(id), []); assert.throws(() => lib.get(id, {}), rejects('RESOURCE_NOT_FOUND')) }
});
