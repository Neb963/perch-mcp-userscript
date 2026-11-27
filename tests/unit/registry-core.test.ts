import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateRegistryCore, type RegistryCore } from '../../apps/gateway/src/registry-core.js';
import { ApiError } from '../../apps/gateway/src/common.js';

const hash = (label: string) => createHash('sha256').update(label).digest('hex');
const unpaired = (): RegistryCore => ({ schemaVersion: 1, revision: 1, policyRevision: 1, credentialEpoch: 1,
  paused: false, paired: false, issuer: null });
const paired = (): RegistryCore => ({ ...unpaired(), paired: true, issuer: 'https://gateway.fixture',
  adminHash: hash('synthetic management credential'), executionHash: hash('synthetic execution credential'), browserInstallationId: 'synthetic-browser_1' });
const corrupt = (error: unknown) => error instanceof Error && error.message === 'SQLITE_RECORD_CORRUPT';

test('strict core validation preserves valid unpaired setup and both compatible persisted versions', () => {
  for (const schemaVersion of [1,2] as const) {
    for (const source of [unpaired(), paired(), { ...paired(), issuer: null }, { ...paired(), paused: true, recoveryHash: hash('synthetic recovery credential') }]) {
      const value = Object.freeze({ ...source, schemaVersion });
      const before = JSON.stringify(value);
      assert.doesNotThrow(() => validateRegistryCore(value));
      assert.equal(JSON.stringify(value),before);
    }
  }
  const additive = { ...paired(), futureOptionalMetadata: { retained: true } };
  validateRegistryCore(additive);
  assert.deepEqual(additive.futureOptionalMetadata,{retained:true});
});

test('strict core validation accepts exactly the existing origin and installation conventions', () => {
  for (const issuer of ['https://gateway.fixture','https://gateway.fixture:8443','http://localhost:8787','http://127.0.0.1:8787','http://[::1]:8787'])
    assert.doesNotThrow(() => validateRegistryCore({ ...paired(), issuer }));
  for (const issuer of [undefined,'','https://gateway.fixture/','https://GATEWAY.fixture','https://gateway.fixture:443','https://gateway.fixture/path','https://gateway.fixture?code=private','https://user:secret@gateway.fixture','http://gateway.fixture','https://gateway.fixture#private','not an origin',true,42])
    assert.throws(() => validateRegistryCore({ ...paired(), issuer }),corrupt);
  for (const browserInstallationId of ['a','ABC_def-123','a'.repeat(128)])
    assert.doesNotThrow(() => validateRegistryCore({ ...paired(), browserInstallationId }));
  for (const browserInstallationId of ['',null,true,42,'a'.repeat(129),'a/b','with space','é'])
    assert.throws(() => validateRegistryCore({ ...paired(), browserInstallationId }),corrupt);
});

test('strict core validation rejects missing/null/coerced counters and booleans without defaults', () => {
  for (const source of [undefined,null,0,'core',[],new Date(),{}]) assert.throws(() => validateRegistryCore(source),corrupt);
  for (const field of ['revision','policyRevision','credentialEpoch']) {
    for (const value of [undefined,null,'1',0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]) {
      const source = { ...paired(), [field]: value };
      const before = JSON.stringify(source);
      assert.throws(() => validateRegistryCore(source),corrupt);
      assert.equal(JSON.stringify(source),before);
    }
  }
  for (const field of ['paired','paused']) for (const value of [undefined,null,0,1,'true','false',{},[]])
    assert.throws(() => validateRegistryCore({ ...paired(), [field]: value }),corrupt);
});

test('strict core validation requires real digest shapes for paired credentials and validates optional known fields', () => {
  for (const field of ['adminHash','executionHash','browserInstallationId']) {
    const source: Record<string,unknown> = { ...paired() }; delete source[field];
    assert.throws(() => validateRegistryCore(source),corrupt);
  }
  for (const field of ['adminHash','executionHash','recoveryHash']) for (const value of [null,'fixture','',42,true,'a'.repeat(63),'a'.repeat(65),'A'.repeat(64),'z'.repeat(64)])
    assert.throws(() => validateRegistryCore({ ...unpaired(), [field]: value }),corrupt);
  assert.doesNotThrow(() => validateRegistryCore({ ...unpaired(), adminHash: undefined, executionHash: undefined, recoveryHash: undefined, browserInstallationId: undefined }));
});

test('strict core validation distinguishes unsupported schema from corrupt fields and never exposes values', () => {
  assert.throws(() => validateRegistryCore({ ...paired(), schemaVersion: 3 }),error => error instanceof ApiError && error.code==='INCOMPATIBLE_VERSION' && error.status===409);
  for (const schemaVersion of [undefined,null,0,-1,1.5,'1',NaN,Infinity])
    assert.throws(() => validateRegistryCore({ ...paired(), schemaVersion }),corrupt);
  for (const source of [{ ...paired(), adminHash: 'SECRET-DO-NOT-RETURN' },{ ...paired(), issuer: 'https://secret.example/path?token=PRIVATE' }]) {
    assert.throws(() => validateRegistryCore(source),error => {
      assert.doesNotMatch(String(error),/SECRET|PRIVATE|secret\.example/);
      return corrupt(error);
    });
  }
});
