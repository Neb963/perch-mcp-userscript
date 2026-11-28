import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorizeSyntheticOfflineAccess, refreshSyntheticSession, settleSyntheticOAuthTasks } from '../fixtures/oauth-refresh-client.js';
import { createCapacityHarness } from './gateway-capacity-harness.js';
const admin='/api/v1/admin';
const base='https://capacity.test';

for (const ttl of [900,1800,3600,7200,86400,604800,2592000,31536000,24*86400,315360000]) {
  test('F16 actual SDK persistent v2 consent, KV expiry and revocation: '+ttl+' seconds', {timeout:30_000}, async()=>{
    const h=await createCapacityHarness(0,{DEVELOPMENT_CONTRACT_V2_ENABLED:'true',DEVELOPMENT_CONTRACT_V2_EXECUTION_ENABLED:'true',
      OAUTH_ACCESS_TOKEN_TTL_SECONDS:String(ttl),REGISTRY_GRANT_BUDGET:'1'},{entryPoint:'tests/fixtures/oauth-refresh-runtime.ts'});
    try {
      const connector=await h.request(admin+'/connectors',{expectedRevision:(await h.get(admin+'/state')).revision,label:'Persistent Connector'});
      const fixture={agentId:String(connector.id),workspaceId:'',binding:{},lease:{},props:{},permissions:[]};
      const start=Math.floor(Date.now()/1000);
      let session=await authorizeSyntheticOfflineAccess(h,fixture);
      await settleSyntheticOAuthTasks(h);
      assert.equal(session.expiresIn,ttl);
      const oauth=await h.mf.getKVNamespace('OAUTH_KV');
      const clients=(await oauth.list({prefix:'client:'})).keys;
      const sdkGrants=(await oauth.list({prefix:'grant:'})).keys;
      const tokens=(await oauth.list({prefix:'token:'})).keys;
      assert.equal(clients.length,1);
      assert.equal(sdkGrants.length,1);
      assert.equal(tokens.length,1);
      assert.equal(clients[0]!.expiration,undefined);
      assert.equal(sdkGrants[0]!.expiration,undefined);
      assert.ok(Number(tokens[0]!.expiration)>=start+ttl && Number(tokens[0]!.expiration)<=Math.floor(Date.now()/1000)+ttl+1);
      const grants=(await h.get(admin+'/grants')).items as Record<string,unknown>[];
      const grant=grants[0]!;
      assert.equal(grant.expiresAt,null);
      assert.equal(grant.state,'active');
      const invoke=(token:string)=>h.mf.dispatchFetch(String(connector.endpoint),{
        method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25'},
        body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});
      assert.equal((await invoke(session.accessToken)).status,200);
      const suspended=await h.update(admin+'/connectors/'+connector.id,{expectedRevision:connector.revision,suspended:true});
      session=await refreshSyntheticSession(h,session);
      assert.equal(session.expiresIn,ttl);
      assert.equal((await invoke(session.accessToken)).status,403);
      await h.update(admin+'/connectors/'+connector.id,{expectedRevision:suspended.revision,suspended:false});
      assert.equal((await invoke(session.accessToken)).status,200);
      await h.request(admin+'/grants/'+grant.id+'/revoke',{expectedRevision:grant.revision});
      assert.equal((await invoke(session.accessToken)).status,403);
      const denied=await h.mf.dispatchFetch(base+'/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
        body:new URLSearchParams({grant_type:'refresh_token',client_id:session.clientId,refresh_token:session.refreshToken,resource:session.resource})});
      assert.equal(denied.status,400);
      assert.equal((await denied.json() as {error:string}).error,'invalid_grant');
      const next=await authorizeSyntheticOfflineAccess(h,fixture);
      assert.equal((await invoke(next.accessToken)).status,200);
    }finally{await h.close();}
  });
}
