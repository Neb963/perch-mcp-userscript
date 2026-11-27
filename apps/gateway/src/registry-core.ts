import { ApiError, origin } from './common.js';

/** Persisted authority shape used by the baseline and the compatible canonical-storage reader. */
export interface RegistryCore {
  schemaVersion: 1 | 2;
  revision: number;
  policyRevision: number;
  paused: boolean;
  issuer: string | null;
  paired: boolean;
  adminHash?: string;
  executionHash?: string;
  browserInstallationId?: string;
  recoveryHash?: string;
  credentialEpoch: number;
}
const DIGEST = /^[0-9a-f]{64}$/;
const INSTALLATION = /^[a-zA-Z0-9_-]{1,128}$/;
function corrupt(): never { throw new Error('SQLITE_RECORD_CORRUPT'); }

/**
 * Validate only known authority fields, without cloning, defaults, coercion,
 * rewriting issuer/credentials, consulting deployment defaults, or logging data.
 * Unknown additive fields remain untouched. This performs no storage operation.
 */
export function validateRegistryCore(value: unknown): asserts value is RegistryCore {
  if (!value || typeof value !== 'object' || Array.isArray(value)) corrupt();
  const core = value as Record<string, unknown>;
  if (!Number.isSafeInteger(core.schemaVersion) || Number(core.schemaVersion) < 1) corrupt();
  if (core.schemaVersion !== 1 && core.schemaVersion !== 2)
    throw new ApiError('INCOMPATIBLE_VERSION', 'Registry storage schema is incompatible with this Worker; restore a compatible version.', 409);
  for (const field of ['revision', 'policyRevision', 'credentialEpoch'] as const)
    if (typeof core[field] !== 'number' || !Number.isSafeInteger(core[field]) || core[field] < 1) corrupt();
  if (typeof core.paused !== 'boolean' || typeof core.paired !== 'boolean') corrupt();
  if (core.issuer !== null) {
    if (typeof core.issuer !== 'string') corrupt();
    try { if (origin(core.issuer) !== core.issuer) corrupt(); }
    catch { corrupt(); }
  }
  for (const field of ['adminHash', 'executionHash', 'recoveryHash'] as const)
    if (core[field] !== undefined && (typeof core[field] !== 'string' || !DIGEST.test(core[field]))) corrupt();
  if (core.browserInstallationId !== undefined &&
      (typeof core.browserInstallationId !== 'string' || !INSTALLATION.test(core.browserInstallationId))) corrupt();
  if (core.paired && (core.adminHash === undefined || core.executionHash === undefined || core.browserInstallationId === undefined)) corrupt();
}
