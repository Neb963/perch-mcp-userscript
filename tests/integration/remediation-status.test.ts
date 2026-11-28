import assert from 'node:assert/strict';
import test from 'node:test';
import { createCapacityHarness } from './gateway-capacity-harness.js';
import { encodeTarget } from '../../packages/contracts/src/target.js';

const admin='/api/v1/admin';
test('F10 v2 workspace_status is scope-safe and distinguishes heartbeat from source verification',async()=>{
 const h=await createCapacityHarness(0,{DEVELOPMENT_CONTRACT_V2_ENABLED:'true'});
 try {
  const state=await h.get(admin+'/state');
  const connector=await h.request(admin+'/connectors',{expectedRevision:state.revision,
    label:'Read-only Connector',permissionCeiling:['READ_SOURCE']});
  const workspace=await h.request(admin+'/workspaces',{label:'Status Workspace',contractVersion:2,
    connectorId:connector.id,expectedConnectorRevision:connector.revision,permissions:['READ_SOURCE']});
  const pending=await h.internal(h.registry,'/internal/oauth/pending',{
    request:{resource:connector.endpoint,clientId:'scope-test',redirectUri:'https://client.test/callback',scope:['mcp']}});
  const list=await h.get(admin+'/approvals');
  const approval=(list.items as Record<string,unknown>[]).find(row=>row.id===pending.id)!;
  await h.request(admin+'/approvals/'+pending.id+'/decision',{expectedRevision:approval.revision,
    digest:approval.digest,decision:'approve'});
  const issued=await h.internal(h.registry,'/internal/oauth/consume',{id:pending.id,handle:pending.handle});
  const props=issued.props;
  const status=(args:Record<string,unknown>)=>h.internal(h.registry,'/internal/v2/discover',
    {agentId:connector.id,props,args});
  const discovered=await status({});
  const entries=discovered.workspaces as Record<string,unknown>[];
  assert.equal(entries.length,1);
  assert.equal(entries[0]!.target,null);
  const binding={generatorId:'status-example',slug:'status-example',draftId:'',
    browserInstallationId:'capacity-browser'};
  const proof=await h.executionRequest('/api/v1/tab/rebind-proof',{
    workspaceId:workspace.id,expectedRevision:workspace.revision,binding,
    tabInstanceId:'status-fixture',adapterVersion:'2'});
  const bound=await h.request(admin+'/workspaces/'+workspace.id+'/rebind',{
    expectedRevision:workspace.revision,expectedConnectorRevision:connector.revision,binding,bindingProof:proof.proof});
  const target=encodeTarget({workspaceId:String(bound.id),
    assignmentGeneration:Number(bound.assignmentGeneration),bindingGeneration:Number(bound.bindingGeneration)});
  const detailed=await status({target,detail:true});
  for(const key of ['sourceRevision','localRevision','previewRevision','savedRevision']) {
    const r=detailed[key] as Record<string,unknown>;
    assert.equal(r.verified,false,key);
    assert.equal(r.value,null,key);
    assert.equal(typeof r.reason,'string',key);
  }
  assert.equal(detailed.readinessReason,'NO_OBSERVATION');
  assert.equal(detailed.dirty,null);
  assert.equal(detailed.freshness,'UNKNOWN');
  assert.equal((detailed.capabilities as Record<string,Record<string,unknown>>).sourceWrite?.permitted,false);
  assert.equal((detailed.capabilities as Record<string,Record<string,unknown>>).capture?.availability,'UNSUPPORTED_INTERFACE');
  assert.deepEqual((detailed.diagnostics as Record<string,unknown>).blockers,['NO_OBSERVATION']);
  assert.equal((detailed.negotiatedLimits as Record<string,unknown>).maxBatchActions,32);
  await assert.rejects(status({target,verifySource:true}),/UPGRADE_REQUIRED/);
 }finally {await h.close();}
});

test('F23 gateway management state safely reports v2 rollout gates and preserves persisted contract when execution is disabled',async()=>{
 const h=await createCapacityHarness(0,{DEVELOPMENT_CONTRACT_V2_ENABLED:'true',
   DEVELOPMENT_CONTRACT_V2_EXECUTION_ENABLED:'false',BINARY_PAYLOADS_ENABLED:'true',
   CANONICAL_STORAGE_MODE:'legacy',ADMISSION_BUDGET_ENABLED:'false'});
 try {
  const initial=await h.get(admin+'/state');
  assert.equal(initial.assignmentContractVersion,1);
  assert.equal((initial.rollout as Record<string,unknown>).developmentContractV2ExecutionEnabled,false);
  const connector=await h.request(admin+'/connectors',{
    expectedRevision:initial.revision,label:'Rollout-capability Connector'});
  const current=await h.get(admin+'/state');
  assert.equal(current.assignmentContractVersion,2);
  const rollout=current.rollout as Record<string,unknown>;
  assert.equal(rollout.developmentContractV2Enabled,true);
  assert.equal(rollout.developmentContractV2ExecutionEnabled,false);
  assert.equal(rollout.binaryPayloadsEnabled,true);
  assert.equal(rollout.canonicalStorageMode,'legacy');
  assert.equal(rollout.actualPixelCapture,'UNSUPPORTED_INTERFACE');
  assert.equal(rollout.accountQuotaKnown,false);
  assert.equal(rollout.oauthGrantPersistence,'UNTIL_REVOKED');
  assert.equal(rollout.oauthAccessTokenTtlSeconds,24*86400);
  assert.equal(rollout.oauthAccessTokenQualification,'DEFAULT_BROWSER_TIMER_SAFE');
  assert.deepEqual(Object.keys(rollout).filter(k=>/secret|token|credential|password/i.test(k)).sort(),
    ['oauthAccessTokenQualification','oauthAccessTokenTtlSeconds'],
    'Only explicitly allowlisted non-secret token lifetime metadata may appear in rollout status.');
  assert.equal(connector.contractVersion,2);
 }finally{await h.close();}
});
