import { z } from 'zod/v4';
import { assertNoFilePathConflicts, canonicalPath } from './paths.js';
import { ToolError } from './errors.js';

const filePath = z.string().min(1).max(512).refine((path) => {
  try { return canonicalPath(path) === path; } catch { return false; }
}, 'Canonical file path required.');
const mutationPath = filePath.refine((path) => !path.startsWith('imports/'), 'Imports are read-only.');
const assetPath = mutationPath.refine((path) => path.startsWith('src/') || path.startsWith('scratch/'), 'File under src or scratch required.');
const directoryPath = z.string().max(512).refine((path) => {
  try { return canonicalPath(path, {directory: true}) === path; } catch { return false; }
}, 'Canonical directory path required.');
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const revisionFields = {
  expectedSourceRevision: sha256.optional(),
  expectedLocalRevision: z.string().regex(/^(?:0|[1-9][0-9]{0,15}):[a-f0-9]{64}$/).optional(),
};
const filePreconditions = { ifSha256: sha256.optional(), ifAbsent: z.literal(true).optional() };
const range = z.discriminatedUnion('unit', [
  z.strictObject({unit: z.literal('bytes'), offset: z.number().int().min(0).max(16 * 1024 * 1024), length: z.number().int().min(1).max(192 * 1024)}),
  z.strictObject({unit: z.literal('lines'), start: z.number().int().min(1).max(16 * 1024 * 1024), count: z.number().int().min(1).max(2000)}),
]);
const inline = z.strictObject({
  mode: z.literal('inline').optional(),
  files: z.array(z.strictObject({path: mutationPath, encoding: z.enum(['utf8', 'base64']),
    content: z.string().max(512 * 1024), ...filePreconditions})).min(1).max(64),
  ...revisionFields,
});
const transferId = z.string().uuid();
export const filesystemV2Schemas = {
  read: z.strictObject({
    files: z.array(z.strictObject({path: filePath, encoding: z.enum(['utf8', 'base64']).optional(),
      range: range.optional(), ifSha256: sha256.optional()})).min(1).max(64),
    ...revisionFields,
  }),
  write: z.union([
    inline,
    z.strictObject({mode: z.literal('start'), path: mutationPath, totalBytes: z.number().int().min(0).max(16 * 1024 * 1024),
      sha256, encoding: z.enum(['utf8', 'base64']), ...filePreconditions, ...revisionFields}),
    z.strictObject({mode: z.literal('chunk'), transferId, offset: z.number().int().min(0).max(16 * 1024 * 1024),
      data: z.string().min(4).max(256 * 1024)}),
    z.strictObject({mode: z.literal('commit'), transferId}),
    z.strictObject({mode: z.literal('abort'), transferId}),
  ]),
  delete: z.strictObject({
    paths: z.array(z.strictObject({path: assetPath, ifSha256: sha256.optional()})).min(1).max(64),
    ...revisionFields,
  }),
  rename: z.strictObject({
    moves: z.array(z.strictObject({from: assetPath, to: assetPath, ifSha256: sha256.optional(),
      destination: z.literal('absent')})).min(1).max(64),
    ...revisionFields,
  }),
  list_files: z.strictObject({
    directories: z.array(directoryPath).max(16).optional(), recursive: z.boolean().optional(),
    prefix: z.string().max(512).optional(),
    extensions: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,24}$/)).max(16).optional(),
    filter: z.string().regex(/^[A-Za-z0-9_./*?-]{1,128}$/).refine((value) =>
      !value.includes('..') && !value.startsWith('/') && (value.match(/[?*]/g)?.length ?? 0) <= 4).optional(),
    limit: z.number().int().min(1).max(100).optional(), cursor: z.string().min(1).max(800).optional(),
  }),
};
export type FilesystemToolV2 = keyof typeof filesystemV2Schemas;
export type FilesystemArgs<N extends FilesystemToolV2> = z.infer<(typeof filesystemV2Schemas)[N]>;
export const filesystemV2JsonSchemas = Object.fromEntries(Object.entries(filesystemV2Schemas).map(([name, schema]) => [
  name, z.toJSONSchema(schema, {target: 'draft-7', io: 'input'}),
]));
export const filesystemInlineWriteSchema = inline;
export function filesystemV2Permissions(name: FilesystemToolV2, args: Record<string, unknown>): string[] {
  if (name === 'read' || name === 'list_files') return ['READ_SOURCE'];
  if (name === 'write' && ['start', 'chunk', 'abort'].includes(String(args.mode))) return ['WRITE_SOURCE'];
  return ['READ_SOURCE', 'WRITE_SOURCE'];
}

const encoder = new TextEncoder();
const base64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Count decoded bytes and reject noncanonical padding without materializing binary input. */
function base64Length(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const bodyEnd = value.length - padding;
  const tail = base64Alphabet.indexOf(value.charAt(bodyEnd - 1));
  if (value.length % 4 || /[^A-Za-z0-9+/]/.test(value.slice(0, bodyEnd))
      || padding && (tail < 0 || tail % (padding === 2 ? 16 : 4))) {
    throw new ToolError('INVALID_INPUT', 'Invalid canonical base64.');
  }
  return value.length / 4 * 3 - padding;
}

type BatchMutation =
  | { tool: 'write'; args: z.infer<typeof inline> & { base?: 'previous' } }
  | { tool: 'delete'; args: FilesystemArgs<'delete'> & { base?: 'previous' } }
  | { tool: 'rename'; args: FilesystemArgs<'rename'> & { base?: 'previous' } };

export function preflightBatchMutation({ tool, args }: BatchMutation): number {
  if (args.base && (args.expectedSourceRevision || args.expectedLocalRevision)) {
    throw new ToolError('INVALID_INPUT', 'The previous batch base cannot be combined with an explicit revision.');
  }
  const revision = (path: string) => path.startsWith('scratch/') ? args.expectedLocalRevision : args.expectedSourceRevision;
  const requirePrecondition = (path: string, ifSha256: string | undefined, ifAbsent?: true) => {
    if (ifAbsent && ifSha256) {
      throw new ToolError('INVALID_INPUT', 'A file cannot require both absence and an existing digest.');
    }
    if (ifAbsent && (path === 'main.pjs' || path === 'index.html')) {
      throw new ToolError('INVALID_INPUT', 'A fixed native panel can only be replaced.');
    }
    if (!ifAbsent && !ifSha256 && !revision(path) && !args.base) {
      throw new ToolError('INVALID_INPUT', 'A matching file digest, verified revision or explicit absence is required.');
    }
  };
  if (tool === 'delete') {
    assertNoFilePathConflicts(args.paths.map(item => item.path));
    for (const item of args.paths) requirePrecondition(item.path, item.ifSha256);
    return 0;
  }
  if (tool === 'rename') {
    assertNoFilePathConflicts(args.moves.flatMap(move => [move.from, move.to]));
    for (const move of args.moves) {
      if (move.from.split('/')[0] !== move.to.split('/')[0]) {
        throw new ToolError('PATH_DENIED', 'Rename must stay within one writable namespace.');
      }
      requirePrecondition(move.from, move.ifSha256);
    }
    return 0;
  }
  assertNoFilePathConflicts(args.files.map(file => file.path));
  let bytes = 0;
  for (const file of args.files) {
    requirePrecondition(file.path, file.ifSha256, file.ifAbsent);
    bytes += file.encoding === 'base64' ? base64Length(file.content) : encoder.encode(file.content).byteLength;
    if (file.encoding === 'base64' && (file.path === 'main.pjs' || file.path === 'index.html')) {
      try {
        new TextDecoder('utf-8', {fatal:true}).decode(Uint8Array.from(atob(file.content), char => char.charCodeAt(0)));
      } catch {
        throw new ToolError('INVALID_INPUT', 'A fixed native panel requires valid UTF-8 bytes.');
      }
    }
  }
  return bytes;
}
