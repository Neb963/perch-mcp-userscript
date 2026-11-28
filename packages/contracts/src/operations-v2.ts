import { z } from 'zod/v4';
import { encodeTarget, parseTarget, v2Permissions } from './target.js';
import { ToolError } from './errors.js';

export const maxNewOperationAgeMs = 15 * 60 * 1000;
export const maxFutureOperationMs = 60 * 1000;
const keyPattern = /^k2\.(0|[1-9][0-9]{0,15})\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
export function issuedAt(key: string): number {
  const match = keyPattern.exec(key);
  const time = Number(match?.[1]);
  if (!match || !Number.isSafeInteger(time) || match[0] !== key)
    throw new ToolError('INVALID_INPUT', 'A canonical operationKey is required.');
  return time;
}
export const operationKeySchema = z.string().max(56).regex(keyPattern).refine((key) => {
  try { issuedAt(key); return true; } catch { return false; }
});
export const targetV2Schema = z.string().max(180).refine((value) => {
  try { return encodeTarget(parseTarget(value)) === value; } catch { return false; }
});
export const deliveryFields = {
  target: targetV2Schema,
  waitMs: z.number().int().min(0).max(10_000).optional(),
};
const locate = {operationId: z.string().uuid().optional(), operationKey: operationKeySchema.optional()};
export const operationStatusV2Schema = z.strictObject({...deliveryFields, ...locate})
  .refine((args) => (args.operationId !== undefined) !== (args.operationKey !== undefined));
export const cancelOperationV2Schema = z.strictObject({target: targetV2Schema, ...locate})
  .refine((args) => (args.operationId !== undefined) !== (args.operationKey !== undefined));

const opaqueId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const generation = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const browserEnvelopeV2 = z.strictObject({
  version: z.literal(2),
  target: targetV2Schema,
  workspaceId: opaqueId,
  bindingRevision: generation,
  assignmentGeneration: generation,
  bindingGeneration: generation,
  connectorId: opaqueId,
  grantId: opaqueId,
  epoch: generation,
  tabInstanceId: opaqueId,
  operationId: opaqueId,
  operationKey: operationKeySchema,
  transferRecoveryOnly: z.literal(true).optional(),
  policyRevision: generation,
  permissionRevision: generation,
  deadlineMs: generation,
  tool: z.string().min(1).max(100),
  args: z.record(z.string(), z.unknown()),
  permissions: z.array(z.enum(v2Permissions)).max(v2Permissions.length),
  traceId: opaqueId,
});
export type BrowserEnvelopeV2 = z.infer<typeof browserEnvelopeV2>;
export const segmentRequestSchema = z.strictObject({
  sequence: z.number().int().min(0).max(127),
  kind: z.enum(['read-view', 'source-publication', 'preview-effect', 'public-get', 'public-post', 'save', 'capture']),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type SegmentRequest = z.infer<typeof segmentRequestSchema>;
