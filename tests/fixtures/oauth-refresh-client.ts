import assert from 'node:assert/strict';
import type {Harness} from './optimization-client.js';
import type {CapacityFixture} from '../integration/gateway-capacity-harness.js';
const base='https://capacity.test';
export interface SyntheticOAuthSession {
  clientId:string;resource:string;accessToken:string;refreshToken:string;expiresIn:number;
}
async function session(response:{status:number;json():Promise<unknown>},clientId:string,resource:string):Promise<SyntheticOAuthSession> {
  assert.equal(response.status,200,'Synthetic OAuth exchange must succeed.');
  const body=await response.json() as {access_token:string;refresh_token:string;expires_in:number;token_type:string};
  assert.equal(body.token_type,'bearer');assert.ok(body.access_token);assert.ok(body.refresh_token);
  assert.ok(Number.isSafeInteger(body.expires_in) && body.expires_in >= 60);
  return {clientId,resource,accessToken:body.access_token,refreshToken:body.refresh_token,expiresIn:body.expires_in};
}
/** Actual pinned SDK DCR, S256 PKCE, exact operator approval and offline_access exchange. */
export async function authorizeSyntheticOfflineAccess(h:Harness,f:CapacityFixture):Promise<SyntheticOAuthSession> {
  const registration=await h.mf.dispatchFetch(base+'/register',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({client_name:'Offline refresh benchmark',redirect_uris:['https://client.test/callback'],token_endpoint_auth_method:'none'})});
  assert.equal(registration.status,201);
  const client=await registration.json() as {client_id:string};
  const verifier='synthetic-refresh-verifier-'.padEnd(64,'v');
  const challenge=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))).toString('base64url');
  const resource=base+'/mcp/'+f.agentId;
  const authorize=await h.mf.dispatchFetch(base+'/authorize?'+new URLSearchParams({client_id:client.client_id,
    redirect_uri:'https://client.test/callback',response_type:'code',scope:'mcp offline_access',state:'synthetic-state',
    code_challenge:challenge,code_challenge_method:'S256',resource}));
  assert.equal(authorize.status,200);
  const html=await authorize.text(),id=/name="id" value="([^"]+)"/.exec(html)?.[1],handle=/name="handle" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(id&&handle);
  const pending=await h.get('/api/v1/admin/approvals');
  const approval=(pending.items as Record<string,unknown>[]).find(row=>row.id===id)!;
  await h.request('/api/v1/admin/approvals/'+id+'/decision',{expectedRevision:approval.revision,digest:approval.digest,decision:'approve'});
  const completed=await h.mf.dispatchFetch(base+'/authorize/complete',{method:'POST',redirect:'manual',
    headers:{'Content-Type':'application/x-www-form-urlencoded',Origin:base},body:new URLSearchParams({id,handle})});
  assert.equal(completed.status,302);
  const callback=new URL(completed.headers.get('location')!);
  assert.equal(callback.origin,'https://client.test');
  return session(await h.mf.dispatchFetch(base+'/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({grant_type:'authorization_code',client_id:client.client_id,redirect_uri:'https://client.test/callback',
      code:callback.searchParams.get('code')!,code_verifier:verifier,resource})}),client.client_id,resource);
}
export async function refreshSyntheticSession(h:Harness,current:SyntheticOAuthSession):Promise<SyntheticOAuthSession> {
  const next=await session(await h.mf.dispatchFetch(base+'/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({grant_type:'refresh_token',client_id:current.clientId,refresh_token:current.refreshToken,resource:current.resource})}),current.clientId,current.resource);
  assert.ok(next.accessToken!==current.accessToken,'Access token must rotate.');assert.ok(next.refreshToken!==current.refreshToken,'Refresh token must rotate.');
  return next;
}
/** Requires oauth-refresh-runtime.ts, includes best-effort audit work in cost samples. */
export async function settleSyntheticOAuthTasks(h:Harness):Promise<void> {
  const response=await h.mf.dispatchFetch(base+'/__fixture_flush');assert.equal(response.status,200);
  assert.equal((await response.json() as {settled:boolean}).settled,true);
}
