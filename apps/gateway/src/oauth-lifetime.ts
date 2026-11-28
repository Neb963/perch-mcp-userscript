import { ApiError } from './common.js';

/** Bounded finite access-token candidates; persistent consent is independent. */
export const MAX_ACCESS_TOKEN_TTL_SECONDS = 10 * 365 * 86400;
/** Single browser timers overflow above 2^31-1 ms; reserve an additional
 * scheduling margin. This bounds the default, not revocable consent. */
export const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 24 * 86400;
export const MAX_SINGLE_TIMER_MS = 2_147_483_647;
export function persistentAccessTokenTTL(raw: string | undefined): number {
  // The pinned SDK accepted ten-year tokens, but Chromium clamps timers beyond
  // 2^31-1 milliseconds to near-zero. A client that schedules its refresh by
  // expires_in * 1000 can loop and exhaust OAuth KV. Use the longest whole-day
  // timer-safe default (24 days); keep explicit longer TTLs an opt-in awaiting
  // OWNER-02 real-client evidence. Permanent refresh consent is independent.
  if (raw === undefined) return DEFAULT_ACCESS_TOKEN_TTL_SECONDS;
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
