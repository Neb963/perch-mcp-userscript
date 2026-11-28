import { validGeneration } from '../../../packages/contracts/src/target.js';
import { boundEpochChunkKeys, inspectBoundStage, resolveBindingStorage, type BindingStorageIdentity } from './binding-storage.js';
import { BrowserError, canonicalPath, digest, utf8, type KeyValueStore } from './native-types.js';

const opaqueId = /^[A-Za-z0-9_-]{1,128}$/;
const sha256 = /^[a-f0-9]{64}$/;
const scopeKey = /^perch:binding-v2:([A-Za-z0-9_-]{1,128}):([A-Za-z0-9_-]{1,128}):(0|[1-9][0-9]{0,15}):(0|[1-9][0-9]{0,15}):([a-f0-9]{64}):epoch:([1-9][0-9]{0,15}):(.+)$/;
const maxScopeRecords = 4096;
const unresolvedStates = new Set(['INTENT', 'DISPATCHED', 'PARTIAL', 'UNKNOWN']);
const knownStates = new Set([...unresolvedStates, 'SUCCEEDED', 'REJECTED']);

export interface HistoricalRecoveryScope {
  id: string;
  installationId: string;
  workspaceId: string;
  assignmentGeneration: number;
  bindingGeneration: number;
  epoch: number;
  nativeIdentityDigest: string;
  journalCount: number;
  stageCount: number;
  checkpointCount: number;
}
export interface HistoricalRecoveryRecord {
  id: string;
  kind: 'JOURNAL' | 'STAGE' | 'QUARANTINED';
  state: string;
  createdAt?: number;
  gatewayOperationId?: string;
  baseRevision: string | null;
  paths: Array<{path: string; expectedDigest?: string | null; observedDigest?: string | null}>;
  expectedDigest?: string | null;
  observedDigest?: string | null;
  acknowledgement: string | null;
  reason?: string;
}
export interface HistoricalRecoveryInspection {
  scope: HistoricalRecoveryScope;
  revision: string | null;
  sourceError?: string;
  records: HistoricalRecoveryRecord[];
}
export interface HistoricalScopeRecords {
  scope: HistoricalRecoveryScope;
  prefix: string;
  journalKeys: string[];
  stageKeys: string[];
  keys: string[];
}

interface ScopeRow {
  identity: Omit<HistoricalRecoveryScope, 'id' | 'journalCount' | 'stageCount' | 'checkpointCount'>;
  prefix: string;
  journalKeys: string[];
  stageKeys: string[];
  checkpointCount: number;
  keys: string[];
}
export interface HistoricalJournal {
  id: string;
  state: string;
  kind?: string;
  paths: string[];
  baseRevision: string;
  createdAt?: number;
  plannedHash?: string;
  plannedPaths?: Record<string, string | null>;
  gatewayOperationId?: string;
  resolvedByReadback?: boolean;
  resolvedByOperator?: boolean;
  [key: string]: unknown;
}
interface EpochFence {
  version: 1;
  supersedingEpoch: number;
}

export async function nativeRecoveryDigest(generatorId: string, draftId: string): Promise<string> {
  return digest(JSON.stringify([generatorId, draftId]));
}
async function indexedScopes(store: KeyValueStore): Promise<ScopeRow[]> {
  const installationId = await store.get('perch:installation-id');
  if (installationId === undefined) return [];
  if (typeof installationId !== 'string' || !opaqueId.test(installationId))
    throw new BrowserError('STORAGE_CORRUPT', 'The local installation record is malformed.');
  const start = 'perch:binding-v2:' + installationId + ':';
  const scopes = new Map<string, ScopeRow>();
  for (const key of await store.list()) {
    if (!key.startsWith(start)) continue;
    const match = scopeKey.exec(key);
    if (!match) continue; // Unproven data is retained and never adopted.
    const [, , workspaceId, assignment, binding, nativeIdentityDigest, epochText, suffix] = match;
    const assignmentGeneration = Number(assignment);
    const bindingGeneration = Number(binding);
    const epoch = Number(epochText);
    if (![assignmentGeneration, bindingGeneration, epoch].every(validGeneration)) continue;
    const prefix = key.slice(0, -(suffix!.length + 1));
    let row = scopes.get(prefix);
    if (!row) {
      row = {identity: {installationId, workspaceId: workspaceId!, assignmentGeneration, bindingGeneration,
        nativeIdentityDigest: nativeIdentityDigest!, epoch}, prefix, journalKeys: [], stageKeys: [], checkpointCount: 0, keys: []};
      scopes.set(prefix, row);
    }
    row.keys.push(key);
    if (suffix!.startsWith('journal:')) row.journalKeys.push(key);
    else if (suffix!.startsWith('stage:')) row.stageKeys.push(key);
    else if (suffix!.startsWith('root:checkpoint:')) row.checkpointCount++;
  }
  return [...scopes.values()].filter(row => row.journalKeys.length || row.stageKeys.length || row.checkpointCount || row.keys.some(key => key.endsWith(':root:local')))
    .sort((a, b) => a.identity.workspaceId.localeCompare(b.identity.workspaceId) ||
      b.identity.assignmentGeneration - a.identity.assignmentGeneration ||
      b.identity.bindingGeneration - a.identity.bindingGeneration || b.identity.epoch - a.identity.epoch);
}
async function describe(row: ScopeRow): Promise<HistoricalRecoveryScope> {
  return {id: await digest(row.prefix), ...row.identity, journalCount: row.journalKeys.length,
    stageCount: row.stageKeys.length, checkpointCount: row.checkpointCount};
}
export async function listHistoricalRecoveryScopes(store: KeyValueStore): Promise<HistoricalRecoveryScope[]> {
  const indexed = await indexedScopes(store);
  return Promise.all(indexed.map(describe));
}
export async function requireHistoricalRecoveryScope(store: KeyValueStore, scopeId: string): Promise<HistoricalScopeRecords> {
  if (!sha256.test(scopeId)) throw new BrowserError('INVALID_INPUT', 'An exact local recovery scope is required.');
  for (const row of await indexedScopes(store)) {
    const scope = await describe(row);
    if (scope.id !== scopeId) continue;
    if (row.keys.length > maxScopeRecords)
      throw new BrowserError('LIMIT_EXCEEDED', 'The exact local recovery scope exceeds its record limit.');
    return {scope, prefix: row.prefix, keys: row.keys.sort(), journalKeys: row.journalKeys.sort(), stageKeys: row.stageKeys.sort()};
  }
  throw new BrowserError('FILE_NOT_FOUND', 'The selected local recovery scope is no longer available.');
}
export function readHistoricalJournal(value: unknown, id: string): HistoricalJournal | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !opaqueId.test(id)) return;
  const row = value as HistoricalJournal;
  if (row.id !== id || !knownStates.has(row.state) || !Array.isArray(row.paths) ||
      row.paths.length > 1000 || typeof row.baseRevision !== 'string' || row.baseRevision.length > 256 ||
      (row.createdAt !== undefined && (!validGeneration(row.createdAt) || row.createdAt === 0)) ||
      (row.plannedHash !== undefined && (typeof row.plannedHash !== 'string' || !sha256.test(row.plannedHash))) ||
      (row.gatewayOperationId !== undefined && (typeof row.gatewayOperationId !== 'string' || !opaqueId.test(row.gatewayOperationId)))) return;
  try {
    for (const path of row.paths) canonicalPath(path);
    if (row.plannedPaths !== undefined) {
      if (!row.plannedPaths || typeof row.plannedPaths !== 'object' || Array.isArray(row.plannedPaths)) return;
      const planned = Object.entries(row.plannedPaths);
      if (planned.length > 1000) return;
      for (const [path, hash] of planned) {
        canonicalPath(path);
        if (hash !== null && (typeof hash !== 'string' || !sha256.test(hash))) return;
      }
    }
  } catch {
    return;
  }
  return row;
}
export function historicalJournalPending(row: HistoricalJournal): boolean {
  return unresolvedStates.has(row.state) && row.resolvedByOperator !== true && row.resolvedByReadback !== true;
}
export async function hasHistoricalEpochFence(store: KeyValueStore, prefix: string, epoch: number): Promise<boolean> {
  const fence = await store.get<EpochFence>(prefix + ':superseded');
  if (fence === undefined) return false;
  if (fence?.version !== 1 || !validGeneration(fence.supersedingEpoch) || fence.supersedingEpoch <= epoch)
    throw new BrowserError('STORAGE_CORRUPT', 'Historical Epoch fence is malformed.');
  return true;
}
export async function fenceHistoricalRecoveryEpochs(store: KeyValueStore, identity: BindingStorageIdentity): Promise<void> {
  const current = await resolveBindingStorage(identity, () => undefined, true);
  const start = current.bindingPrefix + ':epoch:';
  const keys = (await store.list()).filter(key => key.startsWith(start));
  if (keys.length > maxScopeRecords) throw new BrowserError('LIMIT_EXCEEDED', 'Binding exceeds its recovery record limit.');
  const candidates = new Map<string, number>();
  for (const key of keys) {
    const match = scopeKey.exec(key);
    if (!match) continue;
    const epoch = Number(match[6]);
    const suffix = match[7]!;
    if (!validGeneration(epoch) || epoch >= identity.epoch) continue;
    const prefix = key.slice(0, -(suffix.length + 1));
    if (candidates.has(prefix)) continue;
    if (suffix.startsWith('journal:')) {
      const row = readHistoricalJournal(await store.get(key), suffix.slice('journal:'.length));
      if (row && historicalJournalPending(row)) candidates.set(prefix, epoch);
    } else if (suffix.startsWith('stage:')) {
      candidates.set(prefix, epoch);
    }
  }
  for (const [prefix, epoch] of candidates) {
    if (await hasHistoricalEpochFence(store, prefix, epoch)) continue;
    const key = prefix + ':superseded';
    let error: unknown;
    try { await store.set<EpochFence>(key, {version: 1, supersedingEpoch: identity.epoch}); }
    catch (failure) { error = failure; }
    if (!await hasHistoricalEpochFence(store, prefix, epoch))
      throw error ?? new BrowserError('STORAGE_UNAVAILABLE', 'Historical Epoch fence was not persisted.');
  }
}

type StagedBindingInspection = Awaited<ReturnType<typeof inspectBoundStage>>;
type SettledStageState = 'STAGED_ROOT' | 'PREVIOUS_ROOT' | 'MISSING_ROOT' | 'DIVERGED';
interface StageAck {
  version: 1;
  stageDigest: string;
  observedRootDigest: string | null;
  objectName: string;
  observedState: SettledStageState;
  evidence: string;
  recordedAt: number;
}
const objectNamePattern = /^(?:local|checkpoint:[a-f0-9-]{36})$/;
const isSettledStageState = (value: unknown): value is SettledStageState =>
  value === 'STAGED_ROOT' || value === 'PREVIOUS_ROOT' || value === 'MISSING_ROOT' || value === 'DIVERGED';

export function historicalStageVerifiable(stage: StagedBindingInspection): boolean {
  if (!stage.objectName || !objectNamePattern.test(stage.objectName)) return false;
  if (stage.observedState === 'MISSING_ROOT') return stage.previousSourceHash === null;
  if (!stage.observedRootDigest || !sha256.test(stage.observedRootDigest)) return false;
  return stage.observedState === 'STAGED_ROOT' || stage.observedState === 'PREVIOUS_ROOT' ||
    (stage.observedState === 'DIVERGED' && stage.objectName === 'local');
}
export async function acknowledgeHistoricalStage(store: KeyValueStore, prefix: string, stage: StagedBindingInspection, evidence: string): Promise<void> {
  if (!opaqueId.test(stage.id) || !stage.objectName || !isSettledStageState(stage.observedState) ||
      !historicalStageVerifiable(stage))
    throw new BrowserError('EFFECT_UNKNOWN', 'The exact staged pointer is not verifiable.');
  const key = prefix + ':stage-ack:' + stage.id;
  const ack: StageAck = {version:1, stageDigest:stage.stageDigest, observedRootDigest:stage.observedRootDigest,
    objectName:stage.objectName, observedState:stage.observedState, evidence, recordedAt:Date.now()};
  let error: unknown;
  try { await store.set(key, ack); } catch (failure) { error = failure; }
  const remaining = await unresolvedHistoricalStages(store, prefix, [prefix + ':stage:' + stage.id]);
  if (remaining.length)
    throw error ?? new BrowserError('EFFECT_UNKNOWN', 'The historical stage acknowledgement could not be verified.');
}
export async function unresolvedHistoricalStages(store: KeyValueStore, prefix: string, keys: readonly string[]): Promise<string[]> {
  const stagePrefix = prefix + ':stage:';
  const unresolved: string[] = [];
  for (const key of keys) {
    if (!key.startsWith(stagePrefix)) continue;
    const id = key.slice(stagePrefix.length);
    const ack = await store.get<StageAck>(prefix + ':stage-ack:' + id);
    if (!ack || ack.version !== 1 || !isSettledStageState(ack.observedState) ||
        typeof ack.objectName !== 'string' || !objectNamePattern.test(ack.objectName) ||
        (ack.observedState === 'DIVERGED' && ack.objectName !== 'local')) {
      unresolved.push(key);
      continue;
    }
    const stage = await store.get<{previousEpoch?: unknown}>(key);
    if (!stage || ack.stageDigest !== await digest(JSON.stringify(stage))) {
      unresolved.push(key);
      continue;
    }
    let current = await store.get(prefix + ':root:' + ack.objectName);
    const separator = prefix.lastIndexOf(':epoch:');
    const epoch = Number(prefix.slice(separator + ':epoch:'.length));
    if (current === undefined && ack.objectName === 'local' && validGeneration(stage.previousEpoch) &&
        stage.previousEpoch > 0 && stage.previousEpoch < epoch) {
      current = await store.get(prefix.slice(0, separator) + ':epoch:' + stage.previousEpoch + ':root:local');
    }
    const matches = ack.observedState === 'MISSING_ROOT'
      ? current === undefined && ack.observedRootDigest === null
      : current !== undefined && ack.observedRootDigest === await digest(JSON.stringify(current));
    if (!matches) unresolved.push(key);
  }
  return unresolved;
}
export async function exportHistoricalRecovery(store: KeyValueStore, scopeId: string): Promise<string> {
  const selected = await requireHistoricalRecoveryScope(store, scopeId);
  let referenced: string[] = [];
  let metadataWarning: string | undefined;
  try { referenced = await boundEpochChunkKeys(store, selected.prefix, selected.keys); }
  catch (error) {
    if (!(error instanceof BrowserError) || error.code !== 'STORAGE_CORRUPT') throw error;
    metadataWarning = 'Some historical references could not be parsed. Raw records from the selected Epoch were retained.';
  }
  const keys = [...new Set([...selected.keys, ...referenced])].sort();
  if (keys.length > maxScopeRecords) throw new BrowserError('LIMIT_EXCEEDED', 'Exact historical archive exceeds its record limit.');
  let bytes = 0;
  const entries: string[] = [];
  for (const key of keys) {
    const row = await store.get(key);
    if (row === undefined) throw new BrowserError('STORAGE_CORRUPT', 'The exact historical archive changed during export.');
    const encoded = JSON.stringify({key, row});
    bytes += utf8.encode(encoded).length;
    if (bytes > 64 * 1024 * 1024) throw new BrowserError('LIMIT_EXCEEDED', 'Exact historical archive exceeds 64 MiB.');
    entries.push(encoded);
  }
  const header = JSON.stringify({format:'perch-exact-historical-evidence-v1', scope:selected.scope, metadataWarning});
  return header.slice(0, -1) + ',"records":[' + entries.join(',') + ']}\n';
}
