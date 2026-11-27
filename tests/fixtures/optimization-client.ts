import assert from 'node:assert/strict';
import type { createCapacityHarness, CapacityFixture } from '../integration/gateway-capacity-harness.js';
export type Harness=Awaited<ReturnType<typeof createCapacityHarness>>;
const base='https://capacity.test';
/** Real local SDK DCR + PKCE + operator approval + code/token exchange. */
export async function issueSyntheticToken(h:Harness,f:CapacityFixture):Promise<string> {
  const registration=await h.mf.dispatchFetch(base+'/register',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({client_name:'Synthetic benchmark',
      redirect_uris:['https://client.test/callback'],token_endpoint_auth_method:'none'})});
  assert.equal(registration.status,201);
  const client=await registration.json() as {client_id:string};
  const verifier='synthetic-verifier-'.padEnd(64,'v');
  const challenge=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))).toString('base64url');
  const params=new URLSearchParams({client_id:client.client_id,redirect_uri:'https://client.test/callback',
    response_type:'code',scope:'mcp',state:'synthetic-state',code_challenge:challenge,
    code_challenge_method:'S256',resource:base+'/mcp/'+f.agentId});
  const authorization=await h.mf.dispatchFetch(base+'/authorize?'+params);
  assert.equal(authorization.status,200);
  const html=await authorization.text(),id=/name="id" value="([^"]+)"/.exec(html)?.[1],
    handle=/name="handle" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(id&&handle);
  const approvals=await h.get('/api/v1/admin/approvals');
  const approval=(approvals.items as Record<string,unknown>[]).find(row=>row.id===id)!;
  await h.request('/api/v1/admin/approvals/'+id+'/decision',{
    expectedRevision:approval.revision,digest:approval.digest,decision:'approve'});
  const completion=await h.mf.dispatchFetch(base+'/authorize/complete',{method:'POST',redirect:'manual',
    headers:{'Content-Type':'application/x-www-form-urlencoded',Origin:base},body:new URLSearchParams({id,handle})});
  assert.equal(completion.status,302);
  const callback=new URL(completion.headers.get('location')!);
  const exchange=await h.mf.dispatchFetch(base+'/token',{method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({
      grant_type:'authorization_code',client_id:client.client_id,redirect_uri:'https://client.test/callback',
      code:callback.searchParams.get('code')!,code_verifier:verifier,resource:base+'/mcp/'+f.agentId})});
  assert.equal(exchange.status,200);
  return (await exchange.json() as {access_token:string}).access_token;
}
export async function syntheticMcp(h:Harness,f:CapacityFixture,token:string,name:string,args:Record<string,unknown>={}) {
  const r=await h.mf.dispatchFetch(base+'/mcp/'+f.agentId,{method:'POST',headers:{
    Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json, text/event-stream',
    'MCP-Protocol-Version':'2025-11-25'},body:JSON.stringify({jsonrpc:'2.0',id:crypto.randomUUID(),method:'tools/call',params:{name,arguments:args}})});
  assert.equal(r.status,200);
  const body=await r.json() as {result:{structuredContent:Record<string,unknown>;isError:boolean}};
  assert.equal(body.result.isError,false,JSON.stringify(body.result.structuredContent));
  return body.result.structuredContent;
}
export async function fixtureSnapshot(h:Harness,f:CapacityFixture) {
  const registry=await h.registry.fetch('https://internal/__fixture_metrics');
  const workspace=await h.wns.get(h.wns.idFromName(f.workspaceId)).fetch('https://internal/__fixture_metrics');
  const worker=await h.mf.dispatchFetch(base+'/__fixture_metrics');
  return {worker:await worker.json(),registry:await registry.json(),workspace:await workspace.json()} as Record<string,Record<string,number>>;
}
export function metricDelta(before:Record<string,Record<string,number>>,after:Record<string,Record<string,number>>) {
  return Object.fromEntries(Object.keys(after).map(area=>[area,Object.fromEntries(Object.entries(after[area]!).map(([key,value])=>[key,value-(before[area]?.[key]??0)]))]));
}
