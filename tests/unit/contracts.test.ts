import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  approvalRequiredForTool, assertNoPathCollisions, canonicalPath, defaultPermissions, developmentPermissions,
  helperToolNames, parseEnvelopeJson, permissionsForTool, sha256, toolByName,
  ToolError, toolDefinitions, toolResultSchema, validateEnvelope, validateGlob, validateToolCall,
  type JsonSchema,
} from '../../packages/contracts/src/index.js';

const rejects = (name: string, input: unknown) => assert.throws(() => validateToolCall(name, input), (error: unknown) => error instanceof ToolError && error.code === 'INVALID_INPUT');
function assertStrictObjects(schema: JsonSchema): void {
  if (schema.type === 'object') {
    assert.equal(schema.additionalProperties, false);
    for (const value of Object.values(schema.properties as Record<string, JsonSchema>)) assertStrictObjects(value);
  }
  if (schema.items) assertStrictObjects(schema.items as JsonSchema);
}

test('catalog covers all 22 mandatory helper capabilities and the documented product additions', async () => {
  assert.equal(helperToolNames.length, 22);
  const names = new Set(toolDefinitions.map(definition => definition.name));
  assert.equal(names.size, toolDefinitions.length);
  assert.equal(names.has('platform_bug_report'), false);
  for (const name of helperToolNames) assert(names.has(name), name);
  const doc = await readFile(new URL('../../docs/TOOLS.md', import.meta.url), 'utf8');
  const productNames = ['workspace_status', 'workspace_snapshot', 'put_files', 'save_b64_file', 'read_b64_file', 'capture_page_image', 'list_files', 'rename_file', 'delete_file', 'checkpoint_create', 'checkpoint_list', 'checkpoint_restore', 'save_generator', 'generator_info', 'create_generator', 'rename_generator', 'duplicate_generator', 'set_listing', 'delete_generator', 'list_skills', 'list_workflows', 'get_workflow', 'get_instructions', 'search_documentation', 'read_documentation', 'operation_status', 'cancel_operation', 'editor_undo', 'editor_redo', 'preview_diagnostics'];
  for (const name of productNames) { assert(doc.includes(name)); assert(names.has(name), name); }
});

for (const definition of toolDefinitions) {
  test(`${definition.name}: representative input passes; routing overrides and unknown fields reject`, () => {
    assert.doesNotThrow(() => validateToolCall(definition.name, definition.example));
    rejects(definition.name, { ...definition.example, workspaceId: 'another-workspace' });
    rejects(definition.name, { ...definition.example, agentId: 'another-agent' });
    rejects(definition.name, { ...definition.example, confirm: true });
    rejects(definition.name, null);
    rejects(definition.name, []);
    assertStrictObjects(definition.inputSchema);
    assert(definition.description.includes('Permissions:'));
    assert(definition.description.includes('Output:'));
    assert(definition.description.includes('Failure:'));
    assert(definition.description.includes('Recovery:'));
    assert(definition.description.includes('Example:'));
  });
}

test('exclusive inputs enforce both zero-input and multi-input branches', () => {
  rejects('page_eval', {});
  rejects('page_eval', { js: 'return 1', path: 'scratch/eval.js' });
  assert.deepEqual(validateToolCall('page_eval', { js: 'return 1' }), { js: 'return 1', reload: false, timeoutMs: 120000 });
  assert.equal(validateToolCall('page_eval', { path: 'scratch/eval.js' }).path, 'scratch/eval.js');
  rejects('upload_file', {});
  rejects('upload_file', { text: 'x', path: 'scratch/x.txt' });
  assert.equal(validateToolCall('upload_file', { text: '' }).text, '');
  assert.deepEqual(validateToolCall('upload_server_plugin_state', {}), {});
  rejects('upload_server_plugin_state', { path: 'scratch/state.bin', recoverReplaced: 'backup-id' });
});

test('boundary values and inverse branches reject before effects', () => {
  rejects('read', { path: 'main.pjs', offset: 0 });
  rejects('read', { path: 'main.pjs', limit: 2001 });
  rejects('read', { path: 'main.pjs', limit: 1.5 });
  rejects('glob', { pattern: '*', limit: 101 });
  rejects('edit', { path: 'main.pjs', oldString: 'x', newString: 'x' });
  rejects('edit', { path: 'main.pjs', oldString: '', newString: 'x' });
  rejects('copy_lines', { sourcePath: 'main.pjs', sourceStartLine: 2, sourceEndLine: 1, targetPath: 'scratch/x' });
  rejects('page_eval', { js: 'return 1', timeoutMs: 500001 });
  rejects('execute_js', { js: 'return 1', timeoutMs: 3600001 });
  rejects('generate_music', { style: 'quiet', isInstrumental: true, outputPath: 'scratch/x.mp3', userRequestedSeconds: 29 });
  rejects('generate_music', { style: 'quiet', isInstrumental: true, outputPath: 'scratch/x.mp3', userRequestedSeconds: 301 });
  rejects('set_viewport_size', { width: 199, height: 150 });
  rejects('set_viewport_size', { width: 200, height: 149 });
  rejects('set_viewport_size', { width: 131073, height: 150 });
  rejects('save_generator', {});
  rejects('checkpoint_restore', { id: 'checkpoint' });
  rejects('put_files', { files: [] });
  rejects('write', { path: 'scratch/file', content: 'a'.repeat(262145) });
  rejects('fetch_url', { url: 'http://example.com', path: 'scratch/x' });
  rejects('fetch_url', { url: 'https://user:password@example.com', path: 'scratch/x' });
  rejects('fetch_url', { url: 'https://example.com', path: 'scratch/x', method: 'GET', body: 'x' });
});

test('paths deny traversal, absolute names, ambiguity, imports writes and case collisions', () => {
  for (const path of ['../secret', '/main.pjs', 'scratch/../main.pjs', 'scratch//x', 'scratch/x/', 'scratch\\x', 'scratch/.hidden', 'scratch/%2e%2e/x', 'scratch/é', 'scratch/\0x', 'src', 'SRC/x']) assert.throws(() => canonicalPath(path), ToolError, path);
  assert.equal(canonicalPath('main.pjs', { write: true }), 'main.pjs');
  assert.equal(canonicalPath('index.html'), 'index.html');
  assert.equal(canonicalPath('', { directory: true }), '');
  assert.equal(canonicalPath('src', { directory: true }), 'src');
  assert.equal(canonicalPath('imports/pinned/file.js'), 'imports/pinned/file.js');
  assert.throws(() => canonicalPath('imports/pinned/file.js', { write: true }), ToolError);
  assert.throws(() => assertNoPathCollisions(['src/A.js', 'src/a.js']), ToolError);
  assert.throws(() => assertNoPathCollisions(['src/a.js', 'src/a.js']), ToolError);
  assert.doesNotThrow(() => assertNoPathCollisions(['src/a.js', 'src/b.js']));
  for (const pattern of ['/etc/*', '../*', 'src/../*', 'src\\*', 'src/\0*']) assert.throws(() => validateGlob(pattern), ToolError);
});

test('binary and batch validation preserves empty bytes and refuses partial or ambiguous payloads', () => {
  assert.equal(validateToolCall('save_b64_file', { path: 'scratch/empty.bin', data: '' }).data, '');
  rejects('save_b64_file', { path: 'scratch/a', data: 'AP8' });
  rejects('save_b64_file', { path: 'scratch/a', data: '!!!!' });
  rejects('save_b64_file', { path: 'scratch/a', data: 'AAAA'.repeat(87382) });
  rejects('put_files', { expectedRevision: 'r', files: [{ path: 'scratch/a', encoding: 'base64', content: 'invalid' }] });
  rejects('put_files', { expectedRevision: 'r', files: [{ path: 'scratch/a', encoding: 'utf8', content: 'a' }, { path: 'scratch/A', encoding: 'utf8', content: 'b' }] });
  rejects('put_files', { expectedRevision: 'r', files: [{ path: 'scratch/a', encoding: 'utf8', content: 'é'.repeat(131073) }] });
  rejects('put_files', { expectedRevision: 'r', files: [{ path: 'scratch/a', encoding: 'utf8', content: 'a', secret: 'x' }] });
});

test('dynamic permission intersection covers child writes, POST, preview seeds and file reads', () => {
  assert(permissionsForTool('fetch_url', { method: 'POST' }).includes('FETCH_POST'));
  assert(!permissionsForTool('fetch_url', { method: 'GET' }).includes('FETCH_POST'));
  assert(permissionsForTool('page_eval', { path: 'scratch/x.js', resultPath: 'scratch/x.png' }).includes('WRITE_SOURCE'));
  assert(permissionsForTool('page_eval', { path: 'scratch/x.js' }).includes('READ_SOURCE'));
  assert(permissionsForTool('page_refresh', { preambleJs: 'window.test=true' }).includes('PREVIEW_EXECUTE'));
  assert(permissionsForTool('upload_file', { path: 'scratch/x' }).includes('READ_SOURCE'));
  assert(permissionsForTool('download_server_plugin_state', { seedEmulator: true }).includes('PREVIEW_EXECUTE'));
  assert(!defaultPermissions.includes('SAVE'));
  assert(!defaultPermissions.includes('PREVIEW_EXECUTE'));
  assert(developmentPermissions.includes('SAVE'));
  assert(toolByName.get('set_listing')?.requiresApproval);
  assert(toolByName.get('delete_generator')?.requiresApproval);
  assert.deepEqual(permissionsForTool('upload_server_plugin_state', {}), ['PRODUCTION_READ']);
  assert.equal(approvalRequiredForTool('upload_server_plugin_state', {}), false);
  assert.equal(approvalRequiredForTool('upload_server_plugin_state', { path: 'scratch/backup' }), true);
});

test('compute imports require explicit integrity-pinned module mappings and READ_SOURCE', () => {
  const module = { specifier: 'fixture-math@1.2.3', path: 'scratch/modules/math.js', sha256: 'a'.repeat(64) };
  const args = validateToolCall('execute_js', { js: 'return (await import("fixture-math@1.2.3")).twice(2)', modules: [module] });
  assert.deepEqual(args.modules, [module]);
  assert(permissionsForTool('execute_js', args).includes('READ_SOURCE'));
  assert(!permissionsForTool('execute_js', validateToolCall('execute_js', { js: 'return 1' })).includes('READ_SOURCE'));
  assert(!permissionsForTool('execute_js', validateToolCall('execute_js', { js: 'return 1', modules: [] })).includes('READ_SOURCE'));
  assert.doesNotThrow(() => validateToolCall('execute_js', { js: 'return 1', modules: [{ ...module, specifier: '@fixture/math@1.0.0', path: 'imports/approved/math.js' }] }));
  for (const specifier of ['fixture-math@latest', 'fixture-math@^1.2.3', 'fixture-math@~1.2.3', 'fixture-math@1.2', 'fixture-math@01.2.3', 'fixture-math@1.2.3-beta', '../fixture@1.2.3', 'https://example.com/module@1.2.3', 'fixture/name@1.2.3']) rejects('execute_js', { js: 'return 1', modules: [{ ...module, specifier }] });
  for (const pin of ['a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'z'.repeat(64), 'sha256:' + 'a'.repeat(64)]) rejects('execute_js', { js: 'return 1', modules: [{ ...module, sha256: pin }] });
  for (const path of ['/tmp/math.js', 'scratch/../math.js', 'scratch//math.js', '../math.js']) rejects('execute_js', { js: 'return 1', modules: [{ ...module, path }] });
  rejects('execute_js', { js: 'return 1', modules: [{ ...module, url: 'https://example.com/math.js' }] });
  rejects('execute_js', { js: 'return 1', modules: [{ ...module, workspaceId: 'another-workspace' }] });
  rejects('execute_js', { js: 'return 1', modules: [{ specifier: module.specifier, path: module.path }] });
  rejects('execute_js', { js: 'return 1', modules: 'fixture-math@1.2.3' });
});

test('compute imports bound count and reject duplicate specifiers or case-aliased file identities', () => {
  const module = { specifier: 'fixture-math@1.2.3', path: 'scratch/modules/math.js', sha256: 'a'.repeat(64) };
  rejects('execute_js', { js: 'return 1', modules: [module, { ...module, path: 'scratch/modules/other.js' }] });
  rejects('execute_js', { js: 'return 1', modules: [module, { ...module, specifier: 'other@1.0.0' }] });
  rejects('execute_js', { js: 'return 1', modules: [module, { ...module, specifier: 'other@1.0.0', path: 'scratch/modules/Math.js' }] });
  const sixteen = Array.from({ length: 16 }, (_, index) => ({ ...module, specifier: `module-${index}@1.0.0`, path: `scratch/modules/module-${index}.js` }));
  assert.doesNotThrow(() => validateToolCall('execute_js', { js: 'return 1', modules: sixteen }));
  rejects('execute_js', { js: 'return 1', modules: [...sixteen, { ...module, specifier: 'extra@1.0.0' }] });
});

test('envelope validates routing identity, freshness, version, deadline and nested tool input', () => {
  const now = 10000;
  const envelope = { version: 1, operationId: 'op', workspaceId: 'workspace', epoch: 1, bindingRevision: 1, tabInstanceId: 'tab', deadlineMs: now + 30000, tool: 'read', args: { path: 'main.pjs' }, permissions: ['READ_SOURCE'], traceId: 'trace' };
  assert.equal(validateEnvelope(envelope, now).args.limit, 2000);
  for (const change of [{ version: 2 }, { epoch: 0 }, { bindingRevision: 0 }, { deadlineMs: now }, { deadlineMs: now + 3600001 }, { tool: 'unknown' }, { permissions: undefined }, { permissions: ['ADMIN'] }, { args: { path: 'main.pjs', workspaceId: 'evil' } }]) assert.throws(() => validateEnvelope({ ...envelope, ...change }, now), ToolError);
  assert.throws(() => parseEnvelopeJson('{', now), ToolError);
  assert.throws(() => parseEnvelopeJson(' '.repeat(512 * 1024 + 1), now), ToolError);
  assert.equal(parseEnvelopeJson(JSON.stringify(envelope), now).operationId, 'op');
});

test('terminal results distinguish verified, no effect, partial and unknown without retry claims', () => {
  const error = new ToolError('EFFECT_UNKNOWN', 'Native receipt lost', 'Reconcile only', true).toJSON();
  assert.equal(error.retryable, false);
  assert(toolResultSchema.safeParse({ operationId: 'op', status: 'UNKNOWN', effectState: 'POSSIBLE', error }).success);
  assert(!toolResultSchema.safeParse({ operationId: 'op', status: 'UNKNOWN', effectState: 'VERIFIED', error }).success);
  assert(!toolResultSchema.safeParse({ operationId: 'op', status: 'SUCCEEDED', effectState: 'VERIFIED', error }).success);
  assert(!toolResultSchema.safeParse({ operationId: 'op', status: 'CANCELLED', effectState: 'POSSIBLE', error }).success);
  assert(!toolResultSchema.safeParse({ operationId: 'op', status: 'REJECTED', effectState: 'NONE' }).success);
  for (const code of ['FILE_NOT_FOUND', 'PARSE_ERROR', 'STORAGE_CORRUPT'] as const) {
    assert(toolResultSchema.safeParse({ operationId: 'op', status: 'REJECTED', effectState: 'NONE', error: new ToolError(code, 'Native adapter rejected this read').toJSON() }).success);
  }
});

test('SHA-256 hashes exact bytes, including empty and binary values', async () => {
  assert.equal(await sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(await sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.notEqual(await sha256(new Uint8Array([0, 255])), await sha256(new Uint8Array([0, 254])));
});
