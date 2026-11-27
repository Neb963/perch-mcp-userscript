import {test} from 'node:test';
import assert from 'node:assert/strict';
import {IngressAdmission,validateIngress,OAuthAuditAdmission} from '../../apps/gateway/src/ingress.js';
const request=(path:string,method='GET',headers:Record<string,string>={})=>new Request('https://fixture.test'+path,{method,headers});
test('cheap ingress denies unknown paths/actions, methods and credential/body shapes',()=>{
  for(const path of ['/favicon.ico','/scanner','/api/v1/tab/unknown','/mcp/a/b','/api/v1/tab/socket'])
    assert.throws(()=>validateIngress(request(path),{}));
  assert.throws(()=>validateIngress(request('/health','POST'),{}));
  assert.throws(()=>validateIngress(request('/api/v1/tab/poll','POST',{'Content-Type':'application/json'}),{}));
  assert.throws(()=>validateIngress(request('/api/v1/admin/state'),{}));
  assert.throws(()=>validateIngress(request('/api/v1/tab/poll','POST',{Authorization:'Bearer '+'x'.repeat(64),'Content-Type':'application/json','Content-Length':'9999999'}),{}));
});
test('OAuth auxiliary RPC sampling has fixed bounds and preserves meaningful transition categories',()=>{
  const gate=new OAuthAuditAdmission();
  assert.equal(gate.allow('authorize','GET','same',200,'PENDING_OR_INFO',60000),false);
  assert.equal(gate.allow('authorize_complete','POST','other',403,'SCOPE_DENIED',60000),true);
  for(let n=0;n<10000;n++)assert.equal(gate.allow('authorize_complete','POST','other',403,'SCOPE_DENIED',60001),false);
  assert.equal(gate.allow('authorize_complete','POST','null',302,'CALLBACK_REDIRECT_ISSUED',60002),true);
  assert.equal(gate.allow('token','POST','chatgpt',200,'TOKEN_EXCHANGE_SUCCEEDED',60003),true);
  assert.equal(gate.allow('token','POST','chatgpt',200,'TOKEN_EXCHANGE_SUCCEEDED',0),false);
  assert.equal(gate.allow('token','POST','chatgpt',200,'TOKEN_EXCHANGE_SUCCEEDED',120000),true);
});
test('standard metadata, recovery, OAuth and authenticated legacy HTTP paths retain compatibility',()=>{
  for(const path of ['/live','/health','/setup','/.well-known/oauth-authorization-server','/.well-known/oauth-protected-resource/mcp/a','/mcp/a'])
    assert.doesNotThrow(()=>validateIngress(request(path),{}));
  for(const path of ['/register','/token','/revoke'])assert.doesNotThrow(()=>validateIngress(request(path,'POST'),{}));
  assert.doesNotThrow(()=>validateIngress(request('/api/v1/admin/recover','POST',{'Content-Type':'application/json'}),{}));
  assert.doesNotThrow(()=>validateIngress(request('/api/v1/tab/poll','POST',{Authorization:'Bearer '+'x'.repeat(64),'Content-Type':'application/json'}),{}));
  assert.doesNotThrow(()=>validateIngress(request('/api/v1/tab/socket'),{PUSH_NOTIFICATIONS_ENABLED:'true'}));
});
test('local allocation limiter is bounded, clock-safe and cannot policy-starve terminal or recovery',()=>{
  const gate=new IngressAdmission(),socket=request('/api/v1/tab/socket');
  for(let n=0;n<120;n++)gate.check(socket,120000);
  assert.throws(()=>gate.check(socket,120001));
  assert.throws(()=>gate.check(socket,60000));
  for(let n=0;n<1000;n++)for(const path of ['/api/v1/tab/reply','/api/v1/tab/heartbeat','/api/v1/admin/recover','/mcp/a'])
    assert.doesNotThrow(()=>gate.check(request(path,'POST'),120001));
  assert.doesNotThrow(()=>gate.check(socket,180000));
});
