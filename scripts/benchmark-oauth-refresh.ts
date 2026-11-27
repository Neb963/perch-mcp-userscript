/** Actual local OAuth SDK coefficient. No real accounts, tokens or provider requests. */
import {writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {createCapacityHarness} from '../tests/integration/gateway-capacity-harness.js';
import {activateSyntheticNative,fixtureSnapshot,metricDelta,syntheticMcp} from '../tests/fixtures/optimization-client.js';
import {authorizeSyntheticOfflineAccess,refreshSyntheticSession,settleSyntheticOAuthTasks} from '../tests/fixtures/oauth-refresh-client.js';
const native=process.env.OAUTH_BENCHMARK_NATIVE==='true';
const h=await createCapacityHarness(1,native?{CANONICAL_STORAGE_MODE:'native',BINARY_PAYLOADS_ENABLED:'true'}:{},
  {entryPoint:'tests/fixtures/oauth-refresh-runtime.ts'});
try {
  const f=h.fixtures[0]!;
  if(native)await activateSyntheticNative(h,f);
  const before=await fixtureSnapshot(h,f),started=performance.now();
  let current=await authorizeSyntheticOfflineAccess(h,f);
  await settleSyntheticOAuthTasks(h);
  const issuance=metricDelta(before,await fixtureSnapshot(h,f));
  const samples:unknown[]=[];
  for(let iteration=0;iteration<5;iteration++) {
    const at=await fixtureSnapshot(h,f),begin=performance.now();
    current=await refreshSyntheticSession(h,current);await settleSyntheticOAuthTasks(h);
    const usage=metricDelta(at,await fixtureSnapshot(h,f));
    assert.ok(usage.worker!.kvGet!>0);assert.ok(usage.worker!.kvPut!>0);
    assert.equal(usage.registry!.sqlFailures,0);assert.equal(usage.workspace!.sqlFailures,0);
    samples.push({iteration,wallMs:performance.now()-begin,usage});
  }
  // Immediate same-minute token success audits are intentionally coalesced.
  // Measure accepted Registry append separately, including the full 100-row ring.
  async function acceptedAudit() {
    const traceId=crypto.randomUUID(),before=await fixtureSnapshot(h,f),begin=performance.now();
    await h.internal(h.registry,'/internal/diagnostic-event',{route:'token',method:'POST',originClass:'missing',
      status:200,code:'TOKEN_EXCHANGE_SUCCEEDED',traceId});
    const usage=metricDelta(before,await fixtureSnapshot(h,f));
    const diagnostics=await h.get('/api/v1/admin/diagnostics');
    assert.ok((diagnostics.events as {traceId:string}[]).some(row=>row.traceId===traceId),'Audit coefficient requires a verified accepted append.');
    return {accepted:true,wallMs:performance.now()-begin,usage};
  }
  const auditBelowCapacity=await acceptedAudit();
  const diagnostics=await h.get('/api/v1/admin/diagnostics');
  for(let row=(diagnostics.events as unknown[]).length;row<100;row++)
    await h.internal(h.registry,'/internal/diagnostic-event',{route:'token',method:'POST',originClass:'missing',
      status:200,code:'TOKEN_EXCHANGE_SUCCEEDED',traceId:crypto.randomUUID()});
  const auditAtCapacity=await acceptedAudit();
  // The refreshed token still authorizes the original exact Agent/Workspace.
  await syntheticMcp(h,f,current.accessToken,'list_skills',{});await settleSyntheticOAuthTasks(h);
  const report={schemaVersion:1,source:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    sourceDirty:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim().length>0,
    mode:native?'native':'legacy',runtime:'Miniflare4.20260730.0/workerd1.20260730.1',
    oauthLibrary:'@cloudflare/workers-oauth-provider@1.4.0',accessTokenTTLSeconds:current.expiresIn,
    issuer:'https://capacity.test',issuance,samples,auditCoefficient:auditAtCapacity,auditBelowCapacity,
    refreshBasis:'Immediate rotations are sampled by the Worker within one minute; 15-minute projection adds one separately measured accepted Registry audit, using full 100-event ring cost. Registry durable cap 256/day may suppress later appends.',wallMs:performance.now()-started,
    boundary:'Actual SDK DCR/PKCE/offline_access issuance and 5 successful refresh rotations. Real local KV counters include get/put/delete/list; waitUntil audit barrier prevents omitted diagnostic work. All outbound network denied.',
    caveat:'Immediate rotations measure storage coefficients, not elapsed 15 minute token expiry, distributed KV consistency, account billing or production interoperability. Those remain DEFERRED_LIVE.',
    privacy:'No access token, refresh token, authorization code, client identifier or Grant identifier exported.'};
  const path=process.argv[2]??'/tmp/perch-oauth-refresh.json';
  await writeFile(path,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({output:path,samples:samples.length,ttlSeconds:current.expiresIn}));
} finally {await h.close();}
