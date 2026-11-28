import { ApiError } from './common.js';

/** Bounded finite access-token candidates; persistent consent is independent. */
export const MAX_ACCESS_TOKEN_TTL_SECONDS = 10 * 365 * 86400;
export function persistentAccessTokenTTL(raw: string | undefined): number {
  // Ten-year candidate passed the pinned SDK's offline issuance, refresh, expiry and revocation tests.
  // External-client interoperability and real KV behavior remain owner-only acceptance gates.
  if (raw === undefined) return MAX_ACCESS_TOKEN_TTL_SECONDS;
  if (!/^[1-9][0-9]{0,9}$/.test(raw)) throw new ApiError('INVALID_INPUT', 'Invalid access token lifetime.');
  const ttl = Number(raw);
  if (!Number.isSafeInteger(ttl) || ttl < 60 || ttl > MAX_ACCESS_TOKEN_TTL_SECONDS)
    throw new ApiError('INVALID_INPUT', 'Access token lifetime is outside the supported candidate range.');
  return ttl;
}

type GrantLifetime = { contractVersion?: number; state: string; expiresAt: number | null; revokedAt?: number };
export function grantIsActive(grant: GrantLifetime | null | undefined, now = Date.now()): boolean {
  if (!grant || grant.state !== 'active') return false;
  return grant.contractVersion === 2 && grant.expiresAt === null ||
    typeof grant.expiresAt === 'number' && Number.isSafeInteger(grant.expiresAt) && grant.expiresAt > now;
}
export function grantCleanupDue(grant: GrantLifetime, now: number): boolean {
  if (grant.state === 'revoked' && Number.isSafeInteger(grant.revokedAt))
    return grant.revokedAt! + 7 * 86400000 < now;
  return typeof grant.expiresAt === 'number' && Number.isSafeInteger(grant.expiresAt) && grant.expiresAt < now;
}
