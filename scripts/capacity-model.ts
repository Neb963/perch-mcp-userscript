/** Offline projection. Input is the measured gateway benchmark; never calls a provider. */
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

type Vector=Record<string,number>;
interface Sample {path:string;history:number;wallMs:number;usage:Record<string,Vector>}
interface RefreshBenchmark {source:string;sourceDirty?:boolean;samples:{wallMs:number;usage:Record<string,Vector>}[];auditCoefficient?:{accepted:boolean;usage:Record<string,Vector>}}
interface Benchmark {source:string;sourceDirty?:boolean;runtime:string;fixture:string;startup:Record<string,Vector>;oauth:Record<string,Vector>;rows:Sample[]}
export interface CapacityAssumptions {
  transport:'http'|'push'; pollSeconds:number; recentPollSeconds:number; recentWindowSeconds:number; heartbeatSeconds:number;
  reconnectionsPerEditorHour:number; retryFraction:number; unrelatedReserveFraction:number;
  heartbeat:Vector; cleanupPerOperation:Vector; reconnect:Vector; oauthRefresh:Vector;
  refreshMinutes:number; routineLogsPerOperation:number; doMemoryGiB:number;
  mediaPerWireChunk:Vector; migration?:Vector; additionalStatusCalls:number; additionalStatus:Vector;
}
const empty=():Vector=>({workerRequests:0,doRequests:0,sqlReads:0,sqlWrites:0,kvReads:0,kvWrites:0,kvLists:0,
  alarmGet:0,alarmSet:0,alarmDelete:0,alarmInvocations:0,doWallMsProxy:0,responseBytes:0,
  logs:0,wsIncomingRaw:0,wsOutgoingRaw:0});
function sum(...values:Vector[]):Vector {
  const out=empty();
  for(const value of values)for(const [key,n] of Object.entries(value)) {
    if(!Number.isFinite(n)||n<0) throw new Error('Model coefficients must be finite nonnegative numbers.');
    out[key]=(out[key]??0)+n;
  }
  return out;
}
const scale=(value:Vector,n:number):Vector=>Object.fromEntries(Object.entries(value).map(([key,v])=>[key,v*n]));
const measuredKeys=Object.keys(empty()).filter(key=>!['logs','wsIncomingRaw','wsOutgoingRaw'].includes(key));
function measured(areas:Record<string,Vector>):Vector {
  const required=['requests','sqlReads','sqlWrites','kvGet','kvPut','kvDelete','kvList','alarmGet','alarmSet','alarmDelete','alarmInvocations','sqlFailures','wallMs','responseBytes'];
  for(const name of ['worker','registry','workspace']) {
    const area=areas[name];
    if(!area||required.some(key=>typeof area[key]!=='number'||!Number.isFinite(area[key])||area[key]!<0))
      throw new Error('Benchmark accounting dimension is absent or invalid: '+name);
  }
  const out=Object.fromEntries(measuredKeys.map(key=>[key,0]));
  out.workerRequests=areas.worker?.requests??0;
  for(const [name,m] of Object.entries(areas)) {
    if(name!=='worker') {out.doRequests!+=(m.requests??0)+(m.alarmInvocations??0);out.doWallMsProxy!+=m.wallMs??0;}
    out.sqlReads!+=m.sqlReads??0; out.sqlWrites!+=m.sqlWrites??0;
    out.kvReads!+=m.kvGet??0;out.kvWrites!+=(m.kvPut??0)+(m.kvDelete??0);out.kvLists!+=m.kvList??0;
    out.alarmGet!+=m.alarmGet??0;out.alarmSet!+=m.alarmSet??0;out.alarmDelete!+=m.alarmDelete??0;
    out.alarmInvocations!+=m.alarmInvocations??0;
    out.responseBytes!+=m.responseBytes??0;
  }
  // Harness failure counts do not become free successful zero-cost work.
  if(Object.values(areas).some(value=>(value.sqlFailures??0)>0))throw new Error('Cannot project a failed SQL sample as successful capacity.');
  return out;
}
function quantile(values:number[],q:number):number {return [...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*q)-1)]!;}
function coefficient(samples:Sample[]) {
  if(!samples.length)throw new Error('Required measured benchmark path is absent.');
  const values=samples.map(row=>measured(row.usage)),keys=measuredKeys;
  const distribution=Object.fromEntries(keys.map(key=>[key,{
    median:quantile(values.map(value=>value[key]??0),0.5),p95:quantile(values.map(value=>value[key]??0),0.95),max:Math.max(...values.map(value=>value[key]??0)),
  }]));
  return {samples:samples.length,histories:[...new Set(samples.map(row=>row.history))],distribution,
    projection:Object.fromEntries(Object.entries(distribution).map(([key,value])=>[key,value.max]))};
}
export const defaultCapacityAssumptions:CapacityAssumptions={
  transport:'http',pollSeconds:15,recentPollSeconds:5,recentWindowSeconds:120,heartbeatSeconds:60,reconnectionsPerEditorHour:0.25,
  retryFraction:0.02,unrelatedReserveFraction:0.2,
  heartbeat:{workerRequests:1,doRequests:2,sqlReads:16,sqlWrites:4,doWallMsProxy:4,logs:0},
  cleanupPerOperation:{doRequests:0.25,sqlReads:8,sqlWrites:8,alarmGet:1,alarmSet:0.25,alarmInvocations:0.25,doWallMsProxy:2},
  reconnect:{workerRequests:2,doRequests:2,sqlReads:8,sqlWrites:2,doWallMsProxy:4,wsIncomingRaw:1,wsOutgoingRaw:1},
  oauthRefresh:{workerRequests:1,doRequests:1,sqlReads:8,sqlWrites:2,kvReads:4,kvWrites:2,doWallMsProxy:3},
  refreshMinutes:15,routineLogsPerOperation:4,doMemoryGiB:0.125,
  mediaPerWireChunk:{workerRequests:2,doRequests:4,sqlReads:16,sqlWrites:12,doWallMsProxy:4},
  additionalStatusCalls:0,additionalStatus:{workerRequests:1,doRequests:2,sqlReads:12,sqlWrites:0,kvReads:4,doWallMsProxy:3},
};
const limits={workerRequests:100_000,doRequests:100_000,sqlReads:5_000_000,sqlWrites:100_000,
  kvReads:100_000,kvWrites:1000,durationGBsProxy:13_000,storageBytesEstimate:5_000_000_000};
/** No log quota is invented; logs and physical DO duration remain separately unresolved. */
export function capacityModel(input:Benchmark,overrides:Partial<CapacityAssumptions>={},refresh?:RefreshBenchmark) {
  const immediateRefresh=refresh?coefficient(refresh.samples.map(row=>({...row,path:'oauth-refresh',history:0}))):undefined;
  const acceptedAudit=refresh?.auditCoefficient?.accepted?measured(refresh.auditCoefficient.usage):undefined;
  const refreshCoefficient=immediateRefresh?{...immediateRefresh,immediateProjection:immediateRefresh.projection,
    acceptedAuditProjection:acceptedAudit??{doRequests:1,sqlReads:16,sqlWrites:8,doWallMsProxy:3},
    auditBasis:acceptedAudit?'separately measured accepted append at full 100-event ring':'conservative assumed append; measurement absent',
    projection:sum(immediateRefresh.projection,acceptedAudit??{doRequests:1,sqlReads:16,sqlWrites:8,doWallMsProxy:3})}:undefined;
  const assumptions={...defaultCapacityAssumptions,...overrides,
    ...(refreshCoefficient?{oauthRefresh:refreshCoefficient.projection}:{})};
  if(!['http','push'].includes(assumptions.transport)||
    ['pollSeconds','recentPollSeconds','recentWindowSeconds','heartbeatSeconds','refreshMinutes','doMemoryGiB'].some(key=>!Number.isFinite(assumptions[key as keyof CapacityAssumptions])||Number(assumptions[key as keyof CapacityAssumptions])<=0)||
    ['reconnectionsPerEditorHour','retryFraction','routineLogsPerOperation','additionalStatusCalls','unrelatedReserveFraction'].some(key=>!Number.isFinite(assumptions[key as keyof CapacityAssumptions])||Number(assumptions[key as keyof CapacityAssumptions])<0)||
    assumptions.unrelatedReserveFraction>=1)
    throw new Error('Invalid capacity assumptions.');
  const lifecycle=coefficient(input.rows.filter(row=>row.path==='full-mcp-lifecycle')),
    idle=coefficient(input.rows.filter(row=>row.path==='http-idle'));
  const cases=[
    {name:'one-editor-8h-idle',editors:1,hours:8,callsEach:0,images:0,music:0},
    {name:'one-editor-8h-200',editors:1,hours:8,callsEach:200,images:0,music:0},
    {name:'one-editor-24h-1000',editors:1,hours:24,callsEach:1000,images:0,music:0},
    ...[5,10,20,50].map(editors=>({name:`${editors}-editors-8h-200-each`,editors,hours:8,callsEach:200,images:0,music:0})),
    {name:'one-editor-media-heavy',editors:1,hours:8,callsEach:50,images:50,music:5},
  ];
  const projections=cases.map(workload=>{
    const ordinary=workload.editors*workload.callsEach,allOperations=ordinary+workload.images+workload.music;
    const totalSeconds=workload.hours*3600;
    // Uniform ordinary workload assumption; recent windows reset after work.
    const recentSeconds=Math.min(totalSeconds,Math.max(assumptions.recentWindowSeconds,
      allOperations/workload.editors*assumptions.recentWindowSeconds));
    const polls=assumptions.transport==='http'?Math.ceil(recentSeconds/assumptions.recentPollSeconds+
      (totalSeconds-recentSeconds)/assumptions.pollSeconds)*workload.editors:0;
    const heartbeats=Math.ceil(workload.hours*3600/assumptions.heartbeatSeconds)*workload.editors;
    const reconnects=Math.ceil(workload.hours*assumptions.reconnectionsPerEditorHour)*workload.editors;
    const refreshes=Math.ceil(workload.hours*60/assumptions.refreshMinutes)*workload.editors;
    const wireChunks=workload.images*Math.ceil(1024**2/(192*1024))+workload.music*Math.ceil(8*1024**2/(192*1024));
    const ordinaryUsage=scale(lifecycle.projection,allOperations);
    const background=sum(scale(idle.projection,polls),scale(assumptions.heartbeat,heartbeats),scale(assumptions.reconnect,reconnects),scale(assumptions.oauthRefresh,refreshes));
    const deferredCleanup=scale(assumptions.cleanupPerOperation,allOperations);
    const media=scale(assumptions.mediaPerWireChunk,wireChunks);
    const additionalStatus=scale(assumptions.additionalStatus,assumptions.additionalStatusCalls*allOperations);
    const logs={logs:allOperations*assumptions.routineLogsPerOperation};
    const beforeRetry=sum(ordinaryUsage,background,deferredCleanup,media,additionalStatus,logs,assumptions.migration??{});
    const retry=scale(beforeRetry,assumptions.retryFraction);
    const total=sum(beforeRetry,retry);
    // Physical storage is an explicit retention/size assumption, not a SQL gauge.
    const retained=Math.min(1000,workload.callsEach*7);
    total.storageBytesEstimate=1024**2+workload.editors*(64*1024+retained*2048+
      Math.min(8,Math.ceil(allOperations/workload.editors/(workload.hours*6)))*1024);
    total.durationGBsProxy=total.doWallMsProxy!/1000*assumptions.doMemoryGiB;
    total.wsBillableMessageEquivalent=total.wsIncomingRaw!/20;
    const utilization=Object.fromEntries(Object.entries(limits).map(([key,limit])=>[key,{
      modeledFraction:(total[key]??0)/limit,unrelatedReserveFraction:assumptions.unrelatedReserveFraction,
      fractionIncludingReserve:(total[key]??0)/limit+assumptions.unrelatedReserveFraction,
    }]));
    const limiting=Object.entries(utilization).sort((a,b)=>b[1].modeledFraction-a[1].modeledFraction)[0]!;
    return {workload,counts:{ordinary,allOperations,polls,heartbeats,reconnects,refreshes,wireChunks},
      measuredCoefficientPortion:ordinaryUsage,modeledComponents:{background,deferredCleanup,media,additionalStatus,retry},
      coefficientSources:{baseLifecycle:'measured ordinary read path',idlePoll:'measured empty HTTP poll',heartbeat:'assumed',
        oauthRefresh:refreshCoefficient?'measured SDK rotation':'assumed',reconnect:'assumed',cleanup:'assumed',media:'assumed incremental chunks',
        counts:'scenario and explicit cadence assumptions'},
      modeledSubtotal:total,utilization,limitingModeledDimension:limiting[0],
      migrationIncluded:assumptions.migration!==undefined,
      capacityClaim:'ESTIMATE_ONLY_NOT_ACCOUNT_HEADROOM',stressOnly:workload.editors===50};
  });
  return {schemaVersion:1,source:input.source,sourceDirty:input.sourceDirty??'UNKNOWN',runtime:input.runtime,fixture:input.fixture,
    measuredCoefficients:{lifecycle,idle,oauthIssuanceOneTime:measured(input.oauth),installationSetupOneTime:measured(input.startup),...(refreshCoefficient?{oauthRefresh:{...refreshCoefficient,source:refresh!.source,sourceDirty:refresh!.sourceDirty??'UNKNOWN'}}:{}),notMeasured:['logs','WebSocket messages','provider duration GB-s','CPU','physical storage']},
    assumptions,storageAssumptions:{registryBytes:1024**2,workspaceBaseBytes:64*1024,retainedOrdinaryMetadataBytes:2048,activeResultBytes:1024,retainedOrdinaryMaximum:1000,note:'Does not measure user-library bodies, held/late-observation maxima or migration duplication.'},assumedProviderLimits:{asOf:'2026-11-27 handoff; operator must recheck',daily:limits},
    missingEvidence:[
      ...(assumptions.migration?[]:['Migration coefficients not supplied; subtotal omits migration, not assumed free.']),
      refreshCoefficient?'Heartbeat/cleanup/retry/media coefficients remain assumptions; OAuth refresh uses supplied measured coefficients.':'Heartbeat/refresh/cleanup/retry/media coefficients are explicit assumptions until separately measured.',
      'DO duration uses local wall time and assumed 128 MiB, not Cloudflare billed duration or hibernation evidence.',
      'Refresh projection adds one accepted audit per refresh. This overestimates append writes after the Registry 256/day cap rather than assuming denied audit probes are free.',
      'KV mutation estimate combines put+delete conservatively against 1000; KV list count is separate and its limit must be rechecked.',
      'Logs, external account consumption, actual browser suspension and provider billing remain DEFERRED_LIVE.',
      'Raw incoming WS count is modeled separately; one-per 20 billing equivalent is not an exact invoice rounding claim.',
      'Push model assumes healthy opted-in notification; HTTP uses measured empty polls at actual5s recent/15s stable cadence, zero jitter, uniformly distributed ordinary work.',
      'An admission budget bounds modeled reservations only; defaults disabled. Its 750-write KV envelope reserves 256 for one measured 192-write/day refresh stream plus margin; additional clients require operator configuration. SQL/request envelopes remain 20% and conservative enabled SQL allocation admits about 30 ordinary operations/day before retained-cleanup reserve, not 200.',
    ],projections};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  if(!process.argv[2])throw new Error('Usage: capacity-model.ts benchmark.json output.json [assumptions.json or -] [oauth-refresh.json]');
  const input=JSON.parse(await readFile(process.argv[2],'utf8')) as Benchmark;
  const overrides=process.argv[4]&&process.argv[4]!=='-'?JSON.parse(await readFile(process.argv[4],'utf8')) as Partial<CapacityAssumptions>:{};
  const refresh=process.argv[5]?JSON.parse(await readFile(process.argv[5],'utf8')) as RefreshBenchmark:undefined;
  const output=JSON.stringify(capacityModel(input,overrides,refresh),null,2)+'\n';
  if(process.argv[3])await writeFile(process.argv[3],output);else process.stdout.write(output);
}
