const q=new URLSearchParams(location.search), mode=window.__fixtureMode||q.get('mode')||'v2';
const now=Date.now(), perm=['READ_SOURCE','WRITE_SOURCE','PREVIEW_CONTROL','PREVIEW_EXECUTE','COMPUTE','SAVE'];
const names=['Image studio','Story generator','Usage analytics','Game studio','Dashboard','Text lab','Prompt composer','Music lab','Map viewer','Asset library','Character workshop','Notebook'];
const identity={generatorId:'generator-new',slug:'new-image-workshop',draftId:'draft-2026',browserInstallationId:'fixture-install'};
const w=Array.from({length:30},(_,i)=>({id:`w-${i+1}`,label:`${String(i+1).padStart(2,'0')} · ${names[i%12]}`,revision:1,bindingRevision:7,bindingGeneration:7,assignmentGeneration:2,contractVersion:2,connectorId:i===5?null:`c-${i%12+1}`,permissions:perm,epoch:3,paused:i===3,binding:i===5?null:{generatorId:`generator-${i+1}`,slug:`${names[i%12].toLowerCase().replaceAll(' ','-')}-${i+1}`,draftId:'draft-1',browserInstallationId:'fixture-install'},observation:i===2?undefined:{epoch:3,dirty:i===1?true:i===4?null:false,observedAt:now-(i===4?120000:5000)},...(i===6?{transition:{id:'transition-fixture'}}:{})}));
const a=Array.from({length:12},(_,i)=>({id:`c-${i+1}`,label:`ChatGPT ${String(i+1).padStart(2,'0')}`,revision:1,contractVersion:2,assignmentCount:w.filter(x=>x.connectorId===`c-${i+1}`).length,permissionCeiling:perm,endpoint:`https://fixture.invalid/mcp/c-${i+1}`,suspended:i===4}));
const g=a.map((x,i)=>({id:`g-${i+1}`,agentId:x.id,workspaceId:'',clientId:'fixture-client-'+(i+1),state:i===2?'revoked':'active',expiresAt:null,...(i===2?{revokedAt:now-60000}:{}),revision:1,contractVersion:2}));
const approvals=[{id:'approval-1',kind:'oauth',code:'4821',digest:'c'.repeat(64),agentId:'c-1',workspaceId:'',clientId:'fixture-client-new',redirectUri:'https://fixture.invalid/oauth/callback',scope:['mcp','offline_access'],expiresAt:now+300000,state:'pending',revision:1,permissionSnapshot:perm,audience:'https://fixture.invalid/mcp/c-1'}];
const ops=Array.from({length:20},(_,i)=>({operationId:`op-${i+1}`,workspaceId:`w-${i%12+1}`,agentId:`c-${i%12+1}`,tool:i%2?'read':'batch',phase:i===0?'UNKNOWN':i===1?'PARTIAL':i===2?'RUNNING':'SUCCEEDED',timestamp:now-i*60000,createdAt:now-i*60000,deadlineMs:now+60000,epoch:3,bindingRevision:7,resolvable:i===0,durationMs:1250}));
window.fixture={w,a,g,approvals,ops,requests:[],copied:[],attached:[],delay:0,mode};
const receipts=new Map();
const pathid=p=>p.split('/').at(-1);
const client={transitionReceipts:{list:async()=>[...receipts.values()],retain:async r=>receipts.set(r.key,r),retire:async key=>receipts.delete(key)},configuration:()=>({origin:'https://fixture.invalid',paired:mode!=='unpaired',browserInstallationId:'fixture-install'}),currentIdentity:async()=>identity,probe:async()=>({ready:true,identity,dirty:false}),health:async()=>({ok:mode!=='outage',version:'0.3.0',paired:true}),diagnostics:()=>({fixture:true}),fetchHosts:async()=>['perchance.org','assets.trusted.net'],setFetchHosts:async()=>{},pair:async()=>{},recover:async()=>{},promptSecret:async()=>null,copy:async(t)=>fixture.copied.push(t),download:()=>{},pauseLocal:()=>{},attach:async(w)=>fixture.attached.push(w.id),bindingProof:async()=>({proof:'a'.repeat(64)}),exportResources:async()=>new Uint8Array(),exportWorkspaceEvidence:async()=>'{"fixture":true}',sourceBackup:async()=>({fixture:true}),restoreSourceBackup:async()=>{},localDrafts:async()=>({}),localArtifacts:async()=>[],downloadArtifact:async()=>{},reconcileOperation:async()=>{},resolveLocalHold:async()=>{},localRecovery:async()=>({revision:'1:'+ 'b'.repeat(64),holds:[{id:'local-hold-1',kind:'SOURCE',state:'UNKNOWN',createdAt:now-120000,paths:['src/editor.js'],baseRevision:'1:'+'b'.repeat(64)}]}),request:async(method,path,body,options)=>{
 fixture.requests.push({method,path,body,key:options?.idempotencyKey}); if(fixture.delay)await new Promise(r=>setTimeout(r,fixture.delay));
 if(fixture.mode==='outage')throw Object.assign(new Error('Daily Durable Object SQL allowance exhausted.'),{code:'GATEWAY_DEGRADED'});
 const p=path.split('?')[0]; if(method==='GET'){
 if(p.endsWith('/state'))return {revision:1,policyRevision:1,paused:false,version:'0.3.0',schemaVersion:1,assignmentContractVersion:mode==='v1'?undefined:2};
 if(p.endsWith('/workspaces'))return {items:w,revision:1}; if(p.endsWith('/connectors')||p.endsWith('/agents'))return {items:a,revision:1}; if(p.endsWith('/approvals'))return {items:approvals,revision:1}; if(p.endsWith('/grants'))return {items:g,revision:1}; if(p.endsWith('/activity'))return {items:ops,revision:1}; if(p.includes('/receipts/')){if(fixture.failReceiptRead)throw new Error('Receipt unavailable');return {result:fixture.committedTransitions?.[pathid(p)]};} if(p.endsWith('/recovery'))return {action:'RECONCILE',blockingOperations:[ops[0]]}; if(p.includes('/workspaces/'))return w.find(x=>x.id===pathid(p))||{}; return {items:[],revision:1}; }
 if(p.endsWith('/rebind')){const x=w.find(x=>x.id===p.split('/').at(-2));Object.assign(x,{binding:body.binding,bindingGeneration:x.bindingGeneration+1,bindingRevision:x.bindingRevision+1,revision:x.revision+1}); if(fixture.loseRebindResponse){(fixture.committedTransitions??={})[options.idempotencyKey]=structuredClone(x);throw new Error('Acknowledgement lost after commit');}return x;}
 if(p.endsWith('/revoke')){const x=g.find(x=>x.id===p.split('/').at(-2));x.state='revoked';return x;}
 return {ok:true};
}};
if (window.__fixtureLocalRecovery) {
  const scope = {id:'fixture-historical-scope', installationId:'fixture-install', workspaceId:'w-local',
    assignmentGeneration:4, bindingGeneration:9, epoch:2, nativeIdentityDigest:'c'.repeat(64),
    journalCount:1, stageCount:0, checkpointCount:1};
  const privateFiles = [];
  fixture.downloads = [];
  fixture.localActions = [];
  client.localRecoveryScopes = async () => [scope];
  client.inspectLocalRecovery = async id => {
    fixture.localActions.push(['inspect', id]);
    return {scope, revision:'1:historical-byte-proof',
      records:[{id:'fixture-hold', kind:'JOURNAL', state:'UNKNOWN', paths:[
        {path:'src/retained.js',expectedDigest:'a'.repeat(64),observedDigest:null}],
        acknowledgement:null, reason:'Historical source matches a different retained revision.'}]};
  };
  client.exportLocalRecovery = async id => {
    fixture.localActions.push(['export', id]);
    return JSON.stringify({scope: id});
  };
  client.listCheckpoints = async id => {
    if(id!==scope.id) throw new Error('Wrong checkpoint scope');
    return [{id:'fixture-checkpoint', label:'Retained before reconnect', revision:'1:retained', createdAt:now, pinned:true}];
  };
  client.exportCheckpoint = async (id, checkpoint) => JSON.stringify({scope:id, checkpoint});
  client.previewSourceRestore = async () => {throw new Error('No fresh Gateway authority');};
  client.stagePrivateFile = async (path, bytes) => {
    const row = {id:'fixture-staged-file', path, bytes:bytes.length, sha256:'b'.repeat(64), state:'QUARANTINED'};
    privateFiles.push(row);
    return row;
  };
  client.listPrivateFiles = async () => privateFiles.slice();
  client.download = (name, data) => fixture.downloads.push({name, data});
}
fixture.mount=()=>{window.auditManager=window.__auditMountManager({synthetic:true,version:'0.3.0',client,onError:e=>console.error('fixture-manager',e)});auditManager.setStatus({connection:mode==='outage'?'degraded':'connected',workspace:'w-1',agent:'c-1',dirty:false,revision:'1:fixture'});return auditManager.open();};
void fixture.mount();
