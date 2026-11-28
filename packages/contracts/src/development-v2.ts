import { z } from 'zod/v4';
import { base64Length, filesystemV2Schemas, filesystemInlineWriteSchema, filesystemV2Permissions, preflightBatchMutation, type FilesystemToolV2 } from './filesystem-v2.js';
import { cancelOperationV2Schema, deliveryFields, operationKeySchema, operationStatusV2Schema, targetV2Schema } from './operations-v2.js';
import { assertNoFilePathConflicts, assertNoPathCollisions, canonicalPath } from './paths.js';
import { LIMITS } from './envelopes.js';
import { parsePublicFetchDestination } from './public-fetch.js';
import { ToolError } from './errors.js';
import { moduleSpecifierPattern } from './compute.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const computeModule = z.strictObject({
  specifier: z.string().max(200).regex(moduleSpecifierPattern),
  path: z.string().min(1).max(512).refine((path) => {
    try { return canonicalPath(path) === path; } catch { return false; }
  }),
  sha256: hash,
});
const file = z.string().min(1).max(512).refine((path) => {
  try { canonicalPath(path); return true; } catch { return false; }
});
const scratch = file.refine(path => path.startsWith('scratch/'));
const effectDestination = file.refine(path => path.startsWith('scratch/') || path.startsWith('src/'));
const script = z.string().min(1).max(131_072);
const ms = z.number().int().min(1).max(3_600_000).optional();
const browserMs = z.number().int().min(1).max(120_000).optional();
const positive = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,119}$/);
const boundedPath = z.string().min(1).max(512).refine((value) => {
  try {
    if (value.endsWith('/')) return canonicalPath(value.slice(0, -1), {directory: true}) !== '';
    return !!canonicalPath(value);
  } catch { return false; }
});

const getRequest = z.strictObject({method: z.literal('GET').optional(), url: z.string().min(1).max(2048),
  path: scratch, ifAbsent: z.literal(true).optional(), ifSha256: hash.optional()})
  .refine(r => (r.ifAbsent !== undefined) !== (r.ifSha256 !== undefined));
const postRequest = z.strictObject({method: z.literal('POST'), url: z.string().min(1).max(2048),
  path: scratch, body: z.string().max(262_144), ifAbsent: z.literal(true).optional(), ifSha256: hash.optional()})
  .refine(r => (r.ifAbsent !== undefined) !== (r.ifSha256 !== undefined));
export const browserToolSchemas = {
  ...filesystemV2Schemas,
  page_eval: z.strictObject({js: script.optional(), path: file.optional(), timeoutMs: browserMs,
    requireFresh: z.boolean().optional(), resultPath: effectDestination.optional()})
    .refine(value => (value.js !== undefined) !== (value.path !== undefined)),
  page_refresh: z.strictObject({preambleJs: script.optional(), intendedSourceRevision: hash.optional(), timeoutMs: browserMs}),
  preview_diagnostics: z.strictObject({cursor: z.strictObject({previewEpoch: positive, lastSequence: z.number().int().min(0)}).optional(),
    previewEpoch: positive.optional(), limit: z.number().int().min(1).max(100).optional()}),
  set_viewport_size: z.union([z.strictObject({reset: z.literal(true), timeoutMs: browserMs}),
    z.strictObject({width: z.number().int().min(200).max(4096), height: z.number().int().min(150).max(4096), timeoutMs: browserMs})]),
  capture_page_image: z.strictObject({format: z.enum(['png','jpeg','webp']).optional(),
    quality: z.number().min(0.1).max(1).optional(), maxWidth: z.number().int().min(1).max(2048).optional(),
    maxHeight: z.number().int().min(1).max(2048).optional(), expectedPreviewRevision: hash.optional()}),
  execute_js: z.strictObject({js: script, timeoutMs: ms, access: z.strictObject({
    read: z.array(boundedPath).max(64).optional(), write: z.array(boundedPath).max(64).optional(),
    maxReads: z.number().int().min(0).max(256).optional(), maxWrites: z.number().int().min(0).max(64).optional(),
    maxBytes: z.number().int().min(1).max(16 * 1024 * 1024).optional(),
  }), modules: z.array(computeModule).max(16).optional()})
    .refine(({access, modules = []}) => {
      const uniqueSpecifiers = new Set(modules.map(module => module.specifier)).size === modules.length;
      const uniquePaths = new Set(modules.map(module => module.path.toLowerCase())).size === modules.length;
      return uniqueSpecifiers && uniquePaths && modules.length <= (access.maxReads ?? 256)
        && !access.write?.some(path => path.startsWith('imports/'));
    }),
  fetch_url: z.strictObject({requests: z.union([z.array(getRequest).min(1).max(8), z.tuple([postRequest])]), timeoutMs: ms}),
  fetch_generator: z.strictObject({generators: z.array(z.strictObject({
    slug, paths: z.array(file).min(1).max(64).optional(),
  })).min(1).max(8), timeoutMs: ms}),
  generator_info: z.strictObject({verifySaved: z.boolean().optional()}),
  save_generator: z.strictObject({intendedSourceRevision: hash, expectedSavedRevision: hash, timeoutMs: ms}),
};
export type BrowserToolV2 = keyof typeof browserToolSchemas;
export type BrowserToolArgs<N extends BrowserToolV2> = z.infer<(typeof browserToolSchemas)[N]>;

const actionFields = {
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
};
function action<N extends string, T extends z.ZodType>(tool: N, args: T) {
  return z.strictObject({...actionFields, tool: z.literal(tool), args});
}
const batchArguments = z.strictObject({
  actions: z.array(z.discriminatedUnion('tool', [
    action('read', browserToolSchemas.read), action('write', filesystemInlineWriteSchema.extend({base:z.literal('previous').optional()})),
    action('delete', browserToolSchemas.delete.extend({base:z.literal('previous').optional()})),
    action('rename', browserToolSchemas.rename.extend({base:z.literal('previous').optional()})),
    action('list_files', browserToolSchemas.list_files), action('page_eval', browserToolSchemas.page_eval),
    action('page_refresh', browserToolSchemas.page_refresh), action('preview_diagnostics', browserToolSchemas.preview_diagnostics),
    action('set_viewport_size', browserToolSchemas.set_viewport_size), action('capture_page_image', browserToolSchemas.capture_page_image),
    action('execute_js', browserToolSchemas.execute_js),
    action('fetch_url', z.strictObject({requests: z.array(getRequest).min(1).max(8), timeoutMs: ms})),
    action('fetch_generator', browserToolSchemas.fetch_generator), action('generator_info', browserToolSchemas.generator_info),
  ])).min(1).max(32).refine(actions => {
    const ids = actions.flatMap(step => step.id ? [step.id] : []);
    return ids.length === new Set(ids).size && actions.filter(step=>step.tool==='capture_page_image').length <= 4 &&
      actions.every((step,index)=>!('base' in step.args) || step.args.base===undefined ||
        (index>0 && ['write','delete','rename'].includes(actions[index-1]!.tool)));
  }),
  timeoutMs: ms,
});
export type BatchArgumentsV2 = z.infer<typeof batchArguments>;

export const discoveryV2Schema = z.strictObject({target: targetV2Schema.optional(), limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().max(300).optional(), detail: z.boolean().optional(), verifySource: z.boolean().optional()})
  .refine(a => a.target !== undefined ? a.limit === undefined && a.cursor === undefined :
    a.detail === undefined && a.verifySource === undefined);
const special = {
  workspace_status: discoveryV2Schema,
  operation_status: operationStatusV2Schema,
  cancel_operation: cancelOperationV2Schema,
};
export const developmentToolArgs = {...browserToolSchemas, batch: batchArguments};
export const developmentToolNames = [...Object.keys(developmentToolArgs), ...Object.keys(special)] as
  (keyof typeof developmentToolArgs | keyof typeof special)[];
export type DevelopmentTool = typeof developmentToolNames[number];

export function requiredPermissionsV2(name: keyof typeof developmentToolArgs, args: Record<string, unknown>): string[] {
  if (Object.hasOwn(filesystemV2Schemas, name)) return filesystemV2Permissions(name as FilesystemToolV2, args);
  switch (name) {
    case 'batch':
      return [...new Set((args.actions as BatchArgumentsV2['actions']).flatMap(step => requiredPermissionsV2(step.tool, step.args)))];
    case 'page_eval': return ['PREVIEW_EXECUTE',
      ...(args.path || typeof args.resultPath === 'string' && args.resultPath.startsWith('src/') ? ['READ_SOURCE'] : []),
      ...(args.resultPath ? ['WRITE_SOURCE'] : [])];
    case 'page_refresh': return ['PREVIEW_CONTROL', ...(args.preambleJs ? ['PREVIEW_EXECUTE'] : [])];
    case 'preview_diagnostics': case 'set_viewport_size': return ['PREVIEW_CONTROL'];
    case 'capture_page_image': return ['PREVIEW_CONTROL','CAPTURE_PREVIEW'];
    case 'execute_js': {
      const access = args.access as BrowserToolArgs<'execute_js'>['access'];
      return ['COMPUTE', ...(access.read?.length || (args.modules as unknown[])?.length ? ['READ_SOURCE'] : []),
        ...(access.write?.length ? ['WRITE_SOURCE'] : [])];
    }
    case 'fetch_url': return ['FETCH_PUBLIC','WRITE_SOURCE',
      ...((args.requests as {method?: string}[]).some(request => request.method === 'POST') ? ['FETCH_POST'] : [])];
    case 'fetch_generator': return ['FETCH_PUBLIC','WRITE_SOURCE'];
    case 'save_generator': return ['READ_SOURCE','SAVE'];
    case 'generator_info': return ['READ_SOURCE'];
    default: throw new ToolError('INVALID_INPUT','Unknown development tool.');
  }
}
export function hasEffectV2(name: keyof typeof developmentToolArgs, args: Record<string, unknown>): boolean {
  if (name === 'batch')
    return (args.actions as BatchArgumentsV2['actions']).some(step => hasEffectV2(step.tool, step.args));
  if (name === 'execute_js') return !!(args.access as BrowserToolArgs<'execute_js'>['access']).write?.length;
  return !['read','list_files','preview_diagnostics','generator_info','capture_page_image'].includes(name);
}

const utf8 = new TextEncoder();
const batchEnvelopeReserve = 4096;
export const batchResultBudget = 192 * 1024;
const batchLedgerBaseBytes = 16 * 1024;

/** Reject non-scalar Unicode before an MCP request can admit or authorize an
 * effect. TextEncoder otherwise silently replaces isolated UTF-16 surrogates.
 * Keep valid supplementary code points (including emoji) intact. */
function stringifyWellFormed(value: unknown): string {
  return JSON.stringify(value, (_key, field: unknown) => {
    if (typeof field === 'string' && /[\uD800-\uDFFF]/u.test(field))
      throw new ToolError('INVALID_INPUT', 'Development input contains unpaired Unicode surrogates.');
    return field;
  });
}

/** Bound object traversal *before* Zod parsing or Registry/Workspace effects.
 * Network MCP input is JSON, so repeated object references are non-canonical. */
const maxInputDepth = 16;
const maxInputNodes = 16_384;
function assertBoundedInputTree(root: unknown): void {
  const stack: {value: unknown; depth: number}[] = [{value:root,depth:0}];
  const visited = new WeakSet<object>();
  let nodes = 0;
  while (stack.length) {
    const {value,depth} = stack.pop()!;
    if (++nodes > maxInputNodes || depth > maxInputDepth)
      throw new ToolError('LIMIT_EXCEEDED','Development input exceeds structural depth or node limits.');
    if (!value || typeof value !== 'object') continue;
    if (visited.has(value))
      throw new ToolError('INVALID_INPUT','Development input contains repeated object references.');
    visited.add(value);
    const children = Array.isArray(value) ? value : Object.values(value);
    for (const child of children) stack.push({value:child,depth:depth+1});
  }
}

function receiptPaths(step: BatchArgumentsV2['actions'][number]): string[] {
  switch (step.tool) {
    case 'read': case 'write': return step.args.files.map(file => file.path);
    case 'delete': return step.args.paths.map(item => item.path);
    case 'rename': return step.args.moves.flatMap(move => [move.from, move.to]);
    default: return [];
  }
}

/** Reserve space for path outcomes and digest-pinned read continuations. */
export function batchEvidenceReserve(batch: BatchArgumentsV2): number {
  return batch.actions.reduce((size, step) => size + receiptPaths(step).reduce(
    (bytes, path) => bytes + utf8.encode(JSON.stringify(path)).byteLength + (step.tool === 'read' ? 400 : 96), 0),
  batchLedgerBaseBytes);
}

/**
 * Pure checks for an already decoded batch. Callers supply approved hosts only
 * at the trusted browser boundary, where the Operator's policy is stored.
 */
export function preflightDevelopmentBatch(batch: BatchArgumentsV2, approvedHosts?: readonly string[]): void {
  const serialized = stringifyWellFormed(batch);
  if (utf8.encode(serialized).byteLength > LIMITS.transportBytes - batchEnvelopeReserve) {
    throw new ToolError('LIMIT_EXCEEDED', 'Batch exceeds the serialized browser envelope budget.');
  }
  if (batchEvidenceReserve(batch) > batchResultBudget) {
    throw new ToolError('LIMIT_EXCEEDED', 'Batch cannot retain bounded step and file continuation evidence.');
  }
  let decodedWriteBytes = 0;
  // Only adjacent mutations stage against one known file set. Other actions
  // can publish independently, so their content must be checked at runtime.
  const declaredFiles = new Set<string>();
  const declaredMissing = new Set<string>();
  const requireStagedState = (path: string, shouldExist: boolean) => {
    if (shouldExist ? declaredMissing.has(path) : declaredFiles.has(path)) {
      throw new ToolError('INVALID_INPUT', 'A mutation contradicts an earlier path outcome in the same publication segment.');
    }
  };
  const stagePath = (path: string, exists: boolean) => {
    if (exists) {
      declaredFiles.add(path);
      declaredMissing.delete(path);
    } else {
      declaredMissing.add(path);
      declaredFiles.delete(path);
    }
  };
  for (const step of batch.actions) {
    if (step.tool === 'write' || step.tool === 'delete' || step.tool === 'rename') {
      decodedWriteBytes += preflightBatchMutation(step);
      if (step.tool === 'write') {
        for (const file of step.args.files) {
          requireStagedState(file.path, !file.ifAbsent);
          stagePath(file.path, true);
        }
      } else if (step.tool === 'delete') {
        for (const item of step.args.paths) {
          requireStagedState(item.path, true);
          stagePath(item.path, false);
        }
      } else {
        for (const move of step.args.moves) {
          requireStagedState(move.from, true);
          requireStagedState(move.to, false);
          stagePath(move.from, false);
          stagePath(move.to, true);
        }
      }
      assertNoFilePathConflicts([...declaredFiles]);
      continue;
    }
    declaredFiles.clear();
    declaredMissing.clear();
    switch (step.tool) {
      case 'read':
        assertNoPathCollisions(step.args.files.map(file => file.path));
        break;
      case 'fetch_url':
        assertNoFilePathConflicts(step.args.requests.map(request => request.path));
        for (const request of step.args.requests) parsePublicFetchDestination(request.url, approvedHosts);
        break;
      case 'fetch_generator':
        if (new Set(step.args.generators.map(generator => generator.slug)).size !== step.args.generators.length) {
          throw new ToolError('INVALID_INPUT', 'Duplicate public generator.');
        }
        for (const generator of step.args.generators) {
          if (!generator.paths) continue;
          assertNoFilePathConflicts(generator.paths);
          if (generator.paths.some(path => path.startsWith('scratch/') || path.startsWith('imports/'))) {
            throw new ToolError('PATH_DENIED', 'Public generators contain only native source files.');
          }
        }
        break;
    }
  }
  if (decodedWriteBytes > LIMITS.transportBytes - batchEnvelopeReserve) {
    throw new ToolError('LIMIT_EXCEEDED', 'Batch inline writes exceed the decoded byte budget.');
  }
}

export function parseDevelopmentCall(name: string, raw: unknown) {
  if (!developmentToolNames.includes(name as DevelopmentTool))
    throw new ToolError('INVALID_INPUT', 'Unknown development tool.');
  assertBoundedInputTree(raw);
  if (Object.hasOwn(special, name)) {
    const parsed = special[name as keyof typeof special].safeParse(raw);
    if (!parsed.success) throw new ToolError('INVALID_INPUT', 'Invalid operation scope or status arguments.');
    stringifyWellFormed(parsed.data);
    return {name: name as DevelopmentTool, args: parsed.data as Record<string, unknown>};
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new ToolError('INVALID_INPUT', 'Tool arguments must be an object.');
  const {target, operationKey, waitMs, ...args} = raw as Record<string, unknown>;
  const delivery = z.strictObject({...deliveryFields, operationKey: operationKeySchema.optional()}).safeParse({target, operationKey, waitMs});
  if (!delivery.success) throw new ToolError('INVALID_INPUT', 'A canonical Target and valid delivery options are required.');
  const tool = name as keyof typeof developmentToolArgs;
  const parsed = developmentToolArgs[tool].safeParse(args);
  if (!parsed.success) throw new ToolError('INVALID_INPUT', 'Invalid development tool arguments.');
  if (tool === 'batch') preflightDevelopmentBatch(parsed.data as BatchArgumentsV2);
  else {
    const serialized = stringifyWellFormed(parsed.data);
    if (utf8.encode(serialized).byteLength > LIMITS.transportBytes - batchEnvelopeReserve)
      throw new ToolError('LIMIT_EXCEEDED','Development input exceeds serialized envelope byte budget.');
    // Public admission rejects invalid bytes, conflicting paths and missing
    // mutation preconditions before the operation is durably recorded.
    // Browser execution independently revalidates current file state.
    if (tool === 'write') {
      const args = parsed.data as z.infer<typeof filesystemV2Schemas.write>;
      if ('files' in args) preflightBatchMutation({tool:'write',args});
      else if (args.mode === 'chunk') base64Length(args.data);
    } else if (tool === 'delete') {
      preflightBatchMutation({tool:'delete',args:parsed.data as z.infer<typeof filesystemV2Schemas.delete>});
    } else if (tool === 'rename') {
      preflightBatchMutation({tool:'rename',args:parsed.data as z.infer<typeof filesystemV2Schemas.rename>});
    }
  }
  if (hasEffectV2(tool, parsed.data as Record<string, unknown>) && operationKey === undefined)
    throw new ToolError('INVALID_INPUT', 'This tool requires an operationKey.');
  return {name: name as DevelopmentTool, args: parsed.data as Record<string, unknown>, delivery: delivery.data};
}

function toolInputSchema(name: DevelopmentTool): Record<string, unknown> {
  if (Object.hasOwn(special, name))
    return z.toJSONSchema(special[name as keyof typeof special], {target:'draft-7',io:'input'});
  const tool = name as keyof typeof developmentToolArgs;
  const generated = z.toJSONSchema(developmentToolArgs[tool], {target:'draft-7',io:'input'});
  const base = z.toJSONSchema(z.strictObject({...deliveryFields, operationKey: operationKeySchema.optional()}),
    {target:'draft-7',io:'input'});
  const extend = (shape: Record<string, unknown>) => {
    const required = ['target', ...shape.required as string[] ?? []];
    if (!['read','list_files','preview_diagnostics','generator_info','capture_page_image','execute_js','batch'].includes(name))
      required.push('operationKey');
    return {...shape, type:'object', properties: {...shape.properties as object, ...base.properties}, required, additionalProperties:false};
  };
  if (generated.anyOf) return {...generated, type:'object', anyOf: generated.anyOf.map(shape=> extend(shape))};
  return extend(generated);
}

const descriptions: Record<DevelopmentTool, string> = {
  workspace_status:'Discover assigned Workspaces or inspect one canonical Target.',
  read:'Read exact selected files with bounded continuations.', write:'Apply guarded source or scratch writes, or stage a binary transfer.',
  delete:'Delete exact src or scratch files.', rename:'Move files without overwriting an existing destination.',
  list_files:'List selected metadata without reading content.', page_eval:'Run JavaScript in the scoped preview.',
  page_refresh:'Refresh the preview of the intended native source.', preview_diagnostics:'Read bounded diagnostics for one preview epoch.',
  set_viewport_size:'Resize or reset preview layout.', capture_page_image:'Capture actual verified preview pixels. This userscript build has no supported exact preview-surface interface and returns UNSUPPORTED_INTERFACE.',
  execute_js:'Run isolated QuickJS with declared file access and staged writes.',
  fetch_url:'Retrieve bounded public HTTPS responses into governed scratch paths.',
  fetch_generator:'Import verified public generator revisions.', generator_info:'Inspect identity and optionally read independently persisted source.',
  save_generator:'Save the exact native revision under an independently verified saved base.',
  operation_status:'Inspect an operation under its original Grant and Target.',
  cancel_operation:'Stop future steps of an admitted operation when possible.',
  batch:'Run one bounded ordered action plan on one Target.',
};
export const developmentToolDefinitions = developmentToolNames.map(name => ({
  name, description: descriptions[name], inputSchema: toolInputSchema(name),
  annotations: {
    readOnlyHint: ['workspace_status','read','list_files','preview_diagnostics','generator_info','operation_status','capture_page_image'].includes(name),
    destructiveHint: !['workspace_status','read','list_files','preview_diagnostics','generator_info','operation_status','capture_page_image'].includes(name),
    openWorldHint: ['page_eval','page_refresh','fetch_url','fetch_generator','save_generator','batch'].includes(name),
  },
}));
