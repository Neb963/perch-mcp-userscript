import { encodeTarget, nextGeneration, parseTarget, validGeneration, v2Permissions } from '../../../packages/contracts/src/target.js';
import { ApiError } from './common.js';
import type { WorkspaceRecord } from './registry.js';
import type { SqlRecords } from './sql.js';

export interface AssignmentFields {
  contractVersion: 2;
  connectorId: string | null;
  assignmentGeneration: number;
  bindingGeneration: number;
}

export type AssignedWorkspace = WorkspaceRecord & AssignmentFields;
interface AssignmentIndex {
  revision: number;
  ids: string[];
}

export function permissionCeiling(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > v2Permissions.length ||
      new Set(value).size !== value.length ||
      !value.every((item) => typeof item === 'string' && v2Permissions.some((permission) => permission === item)))
    throw new ApiError('INVALID_INPUT', 'Invalid v2 permission ceiling.');
  return [...value].sort();
}

export function requireAssignment(workspace: WorkspaceRecord): AssignedWorkspace {
  if (workspace.contractVersion !== 2 ||
      !validGeneration(workspace.assignmentGeneration) ||
      !validGeneration(workspace.bindingGeneration) ||
      workspace.bindingRevision !== workspace.bindingGeneration ||
      !(workspace.connectorId === null ||
        (typeof workspace.connectorId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(workspace.connectorId))))
    throw new Error('SQLITE_RECORD_CORRUPT');
  return workspace as AssignedWorkspace;
}

const indexKey = (connectorId: string) => 'assignment-index/v2/' + connectorId;

export function initializeAssignments(db: SqlRecords, connectorId: string): void {
  if (db.get(indexKey(connectorId)) !== undefined)
    throw new Error('SQLITE_RECORD_CORRUPT');
  db.put(indexKey(connectorId), { revision: 1, ids: [] });
}

function assignmentIndex(db: SqlRecords, connectorId: string): AssignmentIndex {
  const index = db.get<AssignmentIndex | undefined>(indexKey(connectorId));
  if (!index || !validGeneration(index.revision) || !Array.isArray(index.ids) ||
      index.ids.length > 50 || !index.ids.every((id, i) => typeof id === 'string' &&
        /^[A-Za-z0-9_-]{1,128}$/.test(id) && (i === 0 || index.ids[i - 1]! < id)))
    throw new Error('SQLITE_RECORD_CORRUPT');
  return index;
}

export function changeAssignmentIndex(db: SqlRecords, connectorId: string, workspaceId: string, add: boolean): void {
  if (!db.inTransaction) throw new Error('Assignment publication requires a transaction.');
  const index = assignmentIndex(db, connectorId);
  const has = index.ids.includes(workspaceId);
  if (has === add) throw new Error('SQLITE_RECORD_CORRUPT');
  if (add && index.ids.length === 50)
    throw new ApiError('QUOTA_EXCEEDED', 'Connector assignment limit reached.', 429);
  const ids = add ? [...index.ids, workspaceId].sort() : index.ids.filter((id) => id !== workspaceId);
  db.put(indexKey(connectorId), { revision: nextGeneration(index.revision), ids });
}

export function assignmentCount(db: SqlRecords, connectorId: string): number {
  return assignmentIndex(db, connectorId).ids.length;
}

export function resolveTarget(db: SqlRecords, connectorId: string, raw: unknown): AssignedWorkspace {
  const target = parseTarget(raw);
  const workspace = db.get<WorkspaceRecord | undefined>('workspace/' + target.workspaceId);
  if (!workspace || workspace.contractVersion !== 2 || workspace.connectorId !== connectorId)
    throw new ApiError('TARGET_NOT_FOUND', 'Target is unavailable to this Connector.', 404);
  const assigned = requireAssignment(workspace);
  if (!assigned.binding || assigned.assignmentGeneration !== target.assignmentGeneration ||
      assigned.bindingGeneration !== target.bindingGeneration)
    throw new ApiError('STALE_TARGET', 'Workspace Target changed. Confirm the intended Binding.', 409);
  return assigned;
}

export function projectAssignment(workspace: AssignedWorkspace, ceiling: readonly string[]) {
  const effective = ceiling.filter((permission) => workspace.permissions.includes(permission));
  const readable = effective.includes('READ_SOURCE');
  const binding = workspace.binding;
  return {
    label: workspace.label,
    target: binding ? encodeTarget({
      workspaceId: workspace.id,
      assignmentGeneration: workspace.assignmentGeneration,
      bindingGeneration: workspace.bindingGeneration,
    }) : null,
    slug: readable ? binding?.slug ?? null : null,
    identity: readable && binding ? { generatorId: binding.generatorId, draftId: binding.draftId } : null,
    connection: binding ? 'UNKNOWN' : 'UNBOUND',
    paused: workspace.paused,
    dirty: null,
    observedAt: null,
    freshness: 'UNKNOWN',
    permissions: effective,
  };
}

export function discoverAssignments(db: SqlRecords, connectorId: string, ceiling: readonly string[], limit: number, cursor?: string) {
  const index = assignmentIndex(db, connectorId);
  let start = 0;
  if (cursor !== undefined) {
    const parts = cursor.split('.');
    const last = parts[4];
    if (parts.length !== 5 || parts[0] !== 'c2' || parts[1] !== connectorId ||
        parts[2] !== String(index.revision) || parts[3] !== String(limit) ||
        !last || !index.ids.includes(last))
      throw new ApiError('STALE_CURSOR', 'Assignment page changed. Restart discovery.', 409);
    start = index.ids.indexOf(last) + 1;
  }
  const selected = index.ids.slice(start, start + limit);
  const workspaces = selected.map((workspaceId) => {
    const workspace = db.get<WorkspaceRecord | undefined>('workspace/' + workspaceId);
    if (!workspace || workspace.connectorId !== connectorId) throw new Error('SQLITE_RECORD_CORRUPT');
    return projectAssignment(requireAssignment(workspace), ceiling);
  });
  const nextCursor = start + selected.length < index.ids.length
    ? ['c2', connectorId, index.revision, limit, selected.at(-1)].join('.')
    : null;
  return { workspaces, nextCursor };
}
