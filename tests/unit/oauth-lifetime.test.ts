import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_ACCESS_TOKEN_TTL_SECONDS, MAX_ACCESS_TOKEN_TTL_SECONDS, MAX_SINGLE_TIMER_MS, grantIsActive, grantCleanupDue, persistentAccessTokenTTL } from '../../apps/gateway/src/oauth-lifetime.js';
test('F16 persistent Grants have no age-based expiry or cleanup; old finite and revoked records fail closed', () => {
  const now = 10 * 365 * 86400000;
  const persistent = {contractVersion:2,state:'active',expiresAt:null};
  assert.equal(grantIsActive(persistent,now),true);
  assert.equal(grantCleanupDue(persistent,now),false);
  assert.equal(grantIsActive({state:'active',expiresAt:null},now),false);
  assert.equal(grantIsActive({...persistent,expiresAt:now-1},now),false);
  assert.equal(grantIsActive({...persistent,state:'revoked'},now),false);
  assert.equal(grantIsActive(undefined,now),false);
  const revoked={...persistent,state:'revoked',revokedAt:now};
  assert.equal(grantCleanupDue(revoked,now+86400000),false);
  assert.equal(grantCleanupDue(revoked,now+8*86400000),true);
});
test('F16 finite access lifetime candidates are explicit and bounded', () => {
  for(const seconds of [900,1800,3600,7200,86400,604800,2592000,31536000,24*86400,315360000])
    assert.equal(persistentAccessTokenTTL(String(seconds)),seconds);
  assert.equal(persistentAccessTokenTTL(undefined),24 * 86400);
  assert.equal(DEFAULT_ACCESS_TOKEN_TTL_SECONDS * 1000 <= MAX_SINGLE_TIMER_MS,true);
  assert.equal((DEFAULT_ACCESS_TOKEN_TTL_SECONDS + 86400) * 1000 > MAX_SINGLE_TIMER_MS,true);
  assert.equal(MAX_ACCESS_TOKEN_TTL_SECONDS,315360000);
  assert.equal(persistentAccessTokenTTL(String(MAX_ACCESS_TOKEN_TTL_SECONDS)),MAX_ACCESS_TOKEN_TTL_SECONDS);
  for(const raw of ['0','-1','Infinity','NaN','1.5','315360001',' 900'])
    assert.throws(()=>persistentAccessTokenTTL(raw));
});
