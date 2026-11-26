import { z } from 'zod';
import { errorCodes, ToolError } from './errors.js';
import { permissions, validateToolCall } from './tools.js';

export const PROTOCOL_VERSION = 1;
export const APP_VERSION = '0.1.9';
export const LIMITS = Object.freeze({
  transportBytes: 512 * 1024,
  inlineTextBytes: 256 * 1024,
  chunkBytes: 256 * 1024,
  inlineImageBytes: 1024 * 1024,
  queueLength: 8,
  interactiveDeadlineMs: 30000,
  maximumDeadlineMs: 3600000,
  leaseMs: 180000,
  pollMs: 25000,
  checkpointBytes: 64 * 1024 * 1024,
  resourceArchiveBytes: 16 * 1024 * 1024,
  resourceArchiveFiles: 500,
  computeModules: 16,
  computeModuleBytes: 256 * 1024,
  computeModuleTotalBytes: 512 * 1024,
});
const opaqueId = z.string().min(1).max(128);
const sourceRevision = z.string().min(1).max(256);
export const operationPhases = ['ADMITTED', 'DISPATCHED', 'RUNNING', 'SUCCEEDED', 'REJECTED', 'PARTIAL', 'UNKNOWN', 'CANCELLED'] as const;
export const terminalStatuses = ['SUCCEEDED', 'REJECTED', 'PARTIAL', 'UNKNOWN', 'CANCELLED'] as const;
export type OperationPhase = typeof operationPhases[number];
export type TerminalStatus = typeof terminalStatuses[number];

export const identitySchema = z.object({
  generatorId: z.string().min(1).max(256),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,119}$/),
  publicId: z.string().max(256).optional(),
  // The native default Draft ID is legitimately the empty string.
  draftId: z.string().max(256),
}).strict();
export type Identity = z.infer<typeof identitySchema>;

export const requestEnvelopeSchema = z.object({
  version: z.literal(PROTOCOL_VERSION),
  operationId: opaqueId,
  workspaceId: opaqueId,
  epoch: z.number().int().positive(),
  bindingRevision: z.number().int().positive(),
  tabInstanceId: opaqueId,
  deadlineMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  tool: z.string().min(1).max(128),
  args: z.record(z.unknown()),
  // Server-authorized ceiling for parent and all child calls, never a model argument.
  permissions: z.array(z.enum(permissions)).max(permissions.length),
  expectedRevision: sourceRevision.optional(),
  traceId: opaqueId,
}).strict();
export type Envelope = z.infer<typeof requestEnvelopeSchema>;
export type RequestEnvelope = Envelope;
export const RequestEnvelopeSchema = requestEnvelopeSchema;
export const OperationRequestSchema = requestEnvelopeSchema;

export const toolErrorSchema = z.object({
  code: z.enum(errorCodes),
  message: z.string().max(4096),
  retryable: z.boolean(),
  recovery: z.string().max(4096),
}).strict();

export const toolResultSchema = z.object({
  operationId: opaqueId,
  status: z.enum(terminalStatuses),
  revision: sourceRevision.optional(),
  effectState: z.enum(['NONE', 'POSSIBLE', 'VERIFIED', 'PARTIAL']),
  data: z.unknown().optional(),
  error: toolErrorSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.status === 'SUCCEEDED' && value.error !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Successful results cannot contain an error.' });
  if (value.status !== 'SUCCEEDED' && value.error === undefined) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Non-success results require a structured error.' });
  if (value.status === 'UNKNOWN' && value.effectState !== 'POSSIBLE') context.addIssue({ code: z.ZodIssueCode.custom, message: 'UNKNOWN requires a possible effect.' });
  if (value.status === 'PARTIAL' && value.effectState !== 'PARTIAL') context.addIssue({ code: z.ZodIssueCode.custom, message: 'PARTIAL requires enumerated partial effects.' });
  if ((value.status === 'REJECTED' || value.status === 'CANCELLED') && value.effectState !== 'NONE') context.addIssue({ code: z.ZodIssueCode.custom, message: 'REJECTED/CANCELLED must prove no effect.' });
  if (value.status === 'UNKNOWN' && value.error?.retryable) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Unknown effects cannot be retried.' });
});
export type ToolResult = z.infer<typeof toolResultSchema>;

export const replyEnvelopeSchema = z.object({
  version: z.literal(PROTOCOL_VERSION),
  operationId: opaqueId,
  epoch: z.number().int().positive(),
  tabInstanceId: opaqueId,
  status: z.enum(['ACK', ...terminalStatuses]),
  result: toolResultSchema.optional(),
  error: toolErrorSchema.optional(),
  revision: sourceRevision.optional(),
  effectState: z.enum(['NONE', 'POSSIBLE', 'VERIFIED', 'PARTIAL']),
}).strict().superRefine((value, context) => {
  if (value.status === 'ACK' && value.result) context.addIssue({ code: z.ZodIssueCode.custom, message: 'ACK cannot contain a terminal result.' });
  if (value.result && (value.result.operationId !== value.operationId || value.result.status !== value.status || value.result.effectState !== value.effectState)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Nested terminal result must match the envelope operation and phase.' });
});
export type ReplyEnvelope = z.infer<typeof replyEnvelopeSchema>;
export const ReplyEnvelopeSchema = replyEnvelopeSchema;
export const OperationReplySchema = replyEnvelopeSchema;

export function validateEnvelope(value: unknown, now = Date.now()): Envelope {
  const parsed = requestEnvelopeSchema.safeParse(value);
  if (!parsed.success) throw new ToolError('INVALID_INPUT', 'Invalid operation envelope.');
  if (parsed.data.deadlineMs <= now) throw new ToolError('TIMEOUT', 'Operation deadline expired before execution.');
  if (parsed.data.deadlineMs - now > LIMITS.maximumDeadlineMs) throw new ToolError('LIMIT_EXCEEDED', 'Operation deadline exceeds one hour.');
  parsed.data.args = validateToolCall(parsed.data.tool, parsed.data.args);
  return parsed.data;
}

/** Object serialization is bounded before parsing untrusted wire content. */
export function parseEnvelopeJson(json: string, now = Date.now()): Envelope {
  if (new TextEncoder().encode(json).byteLength > LIMITS.transportBytes) throw new ToolError('LIMIT_EXCEEDED', 'Operation exceeds transport byte budget.');
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw new ToolError('INVALID_INPUT', 'Malformed operation JSON.'); }
  return validateEnvelope(value, now);
}
