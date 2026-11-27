import { z } from 'zod';
import { ToolError } from './errors.js';

export const v2Permissions = [
  'READ_SOURCE', 'WRITE_SOURCE', 'PREVIEW_CONTROL', 'PREVIEW_EXECUTE',
  'COMPUTE', 'FETCH_PUBLIC', 'FETCH_POST', 'CAPTURE_PREVIEW', 'SAVE',
] as const;
export type V2Permission = typeof v2Permissions[number];
export const v2DefaultPermissions = v2Permissions.slice(0, 3);

const opaqueId = /^[A-Za-z0-9_-]{1,128}$/;
const targetPattern = /^w2\.([A-Za-z0-9_-]{1,128})\.(0|[1-9][0-9]{0,15})\.(0|[1-9][0-9]{0,15})$/;

export interface Target {
  workspaceId: string;
  assignmentGeneration: number;
  bindingGeneration: number;
}

export function validGeneration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function encodeTarget(target: Target): string {
  const { workspaceId, assignmentGeneration, bindingGeneration } = target;
  if (!opaqueId.test(workspaceId) || !validGeneration(assignmentGeneration) || !validGeneration(bindingGeneration))
    throw new ToolError('INVALID_INPUT', 'Invalid Workspace Target.');
  return `w2.${workspaceId}.${assignmentGeneration}.${bindingGeneration}`;
}

export function parseTarget(value: unknown): Target {
  if (typeof value !== 'string' || value.length > 180)
    throw new ToolError('INVALID_INPUT', 'A canonical Workspace Target is required.');
  const match = targetPattern.exec(value);
  if (!match)
    throw new ToolError('INVALID_INPUT', 'Invalid Workspace Target.');
  const result = {
    workspaceId: match[1]!,
    assignmentGeneration: Number(match[2]),
    bindingGeneration: Number(match[3]),
  };
  if (encodeTarget(result) !== value)
    throw new ToolError('INVALID_INPUT', 'Invalid Workspace Target.');
  return result;
}

export function nextGeneration(current: number): number {
  if (!validGeneration(current) || current === Number.MAX_SAFE_INTEGER)
    throw new ToolError('LIMIT_EXCEEDED', 'Workspace generation cannot advance.');
  return current + 1;
}

export const workspaceStatusV2Schema = z.object({
  target: z.string().max(180).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(300).optional(),
  detail: z.boolean().optional(),
  verifySource: z.boolean().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.target !== undefined) {
    try { parseTarget(value.target); }
    catch { ctx.addIssue({ code: 'custom', path: ['target'], message: 'Invalid Workspace Target.' }); }
    if (value.limit !== undefined || value.cursor !== undefined)
      ctx.addIssue({ code: 'custom', message: 'Pagination is only available for discovery.' });
  } else if (value.detail !== undefined || value.verifySource !== undefined) {
    ctx.addIssue({ code: 'custom', message: 'Detailed or verified status requires a Target.' });
  }
});
