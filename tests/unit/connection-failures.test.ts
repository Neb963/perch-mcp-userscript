import test from 'node:test';
import assert from 'node:assert/strict';
import { isRetryableGatewayFailure } from '../../apps/userscript/src/connection-failures.js';

test('gateway-wide HTTP 500/503 and transport errors recover; ownership/security failures do not',()=>{
  for(const code of ['INTERNAL_ERROR','GATEWAY_DEGRADED','GATEWAY_TIMEOUT',
    'GATEWAY_UNAVAILABLE','HTTP_500','HTTP_503','HTTP_502','HTTP_504'])
    assert.equal(isRetryableGatewayFailure(code),true,code);
  for(const code of ['EFFECT_UNKNOWN','BINDING_MISMATCH','SCOPE_DENIED',
    'PAUSED','REVOKED','TAB_BUSY','INVALID_INPUT','STORAGE_CORRUPT'])
    assert.equal(isRetryableGatewayFailure(code),false,code);
});
