import { z } from 'zod/v4';
import { canonicalPath } from './paths.js';

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
