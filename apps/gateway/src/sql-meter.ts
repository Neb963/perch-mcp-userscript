import { AsyncLocalStorage } from "node:async_hooks";
export interface SqlUsage { reads:number; writes:number; statements:number; unmetered:number }
type Area="registry"|"workspace";
type QuerySample={verb:string;table:string;keyKind:string;fingerprint:string;usage:SqlUsage};
type SqlScope={usage:SqlUsage;categories:Record<string,SqlUsage>;queries?:Map<string,QuerySample>};
const scope=new AsyncLocalStorage<SqlScope>();
/** The profile contains only SQL operation/table names, a query-shape fingerprint,
 * and an allowlisted canonical key kind. It never contains SQL arguments,
 * credential values, source files, identity strings or raw statement text.
 * This is explicitly opt-in diagnostic telemetry, not production tracing. */
const SAFE_KEYS=new Set(['core','grant','agent','workspace','approval','permit',
  'terminal-notice','operation','lease','resolution','idempotency','activity',
  'schema','binding-transition','reservation','outbox-retry-at','policy',
  'operation-key','registration-budget','journal','usage','media']);
function queryShape(sql:string,params:readonly unknown[]):{verb:string;table:string;keyKind:string;fingerprint:string} {
  const normalized=sql.replace(/\s+/g,' ').trim();
  const verb=/^([a-z]+)/i.exec(normalized)?.[1]?.toUpperCase() ?? 'OTHER';
  const table=/\b(?:FROM|INTO|UPDATE|TABLE|JOIN)\s+([a-z_][a-z_0-9]*)\b/i.exec(normalized)?.[1]?.toLowerCase() ?? 'other';
  let fingerprint=2166136261;
  for(let i=0;i<normalized.length;i++){
    fingerprint=Math.imul(fingerprint^normalized.charCodeAt(i),16777619)>>>0;
  }
  const first=typeof params[0]==='string'?params[0]:undefined;
  const keyKind=first?first.split('/')[0]!.split(':')[0]!:'none';
  return {verb,table,keyKind:SAFE_KEYS.has(keyKind)?keyKind:'other',
    fingerprint:fingerprint.toString(16).padStart(8,'0')};
}

export function emptyUsage():SqlUsage {return {reads:0,writes:0,statements:0,unmetered:0};}
function add(to:SqlUsage,from:SqlUsage):void {to.reads+=from.reads;to.writes+=from.writes;to.statements+=from.statements;to.unmetered+=from.unmetered;}
export function trackSql(sql:string,usage:SqlUsage,params:readonly unknown[]=[]):void {
  const current=scope.getStore();if(!current)return;
  const category=/^CREATE\b|sqlite_master/.test(sql)?"schema":/operation_(?:index|dirty)/.test(sql)?"operation-index":/operation_(?:native|args|result|migration)/.test(sql)?"operation-canonical":/canonical_activity/.test(sql)?"activity-canonical":/resource_(?:storage|header|current|revision|content|assignment|legacy|source)/.test(sql)?"resource-canonical":/oauth_diagnostic/.test(sql)?"oauth-diagnostics":/binary_payload|media_catalog/.test(sql)?"media-canonical":/workspace_maintenance/.test(sql)?"maintenance-index":/registry_activity/.test(sql)?"activity-index":/registry_(?:entity|dirty|counts|index)/.test(sql)?"registry-index":/FROM records|INTO records|UPDATE records/.test(sql)?"canonical":"other";
  add(current.usage,usage);add(current.categories[category]??=emptyUsage(),usage);
  if(current.queries){
    const parts=queryShape(sql,params),key=[parts.verb,parts.table,parts.keyKind,parts.fingerprint].join(':');
    const before=current.queries.get(key);
    if(before)add(before.usage,usage);
    else if(current.queries.size<63)current.queries.set(key,{...parts,usage:{...usage}});
    else add(current.queries.get('overflow')?.usage??(()=>{const row:QuerySample={
      verb:'OTHER',table:'other',keyKind:'none',fingerprint:'overflow',usage:emptyUsage()};
      current.queries!.set('overflow',row);return row.usage;})(),usage);
  }
}
function safeRoute(path:string):string {
  if(path==="alarm")return path;
  const exact=new Set(["health","config","authorize","dispatch","terminal","admit","status","cancel","resolve","recovery","claim","epoch","lease-check","diagnostic-event","registration-budget","poll","heartbeat","reply","release","permit","image","music","music-result","sql-usage","ticket","socket","migration","resource-tool"]);
  const internal=/^\/internal\/([a-z-]+)$/.exec(path);
  if(internal&&exact.has(internal[1]!))return "internal/"+internal[1];
  if(/^\/internal\/oauth\/(pending|consume|redirect-commit|abort-completion)$/.test(path))return path.slice(1);
  const tab=/^\/api\/v1\/tab\/([a-z-]+)$/.exec(path);
  if(tab&&exact.has(tab[1]!))return "tab/"+tab[1];
  const admin=/^\/api\/v1\/admin\/(workspaces|agents|grants|approvals|resources|state|activity|diagnostics|storage|pair|recover|pause)(?:\/|$)/.exec(path);
  return admin?"admin/"+admin[1]:"other";
}
// Explicit measurement mode is still bounded per isolate. Other isolates and
// account log billing are outside this local sample budget.
let minute=-1,lastNow=0,emitted=0,suppressed=0;
function emit(sample:unknown):void {
  try {
    lastNow=Math.max(lastNow,Date.now());
    const current=Math.floor(lastNow/60000);
    if(current!==minute){minute=current;emitted=0;}
    if(emitted>=120){suppressed++;return;}
    emitted++;
    const skipped=suppressed;suppressed=0;
    console.log(JSON.stringify({...sample as Record<string,unknown>,suppressedSamples:skipped}));
  } catch { /* Telemetry cannot change an acknowledged canonical outcome. */ }
}
export async function withSqlUsage<T>(enabled:boolean,area:Area,path:string,fn:()=>Promise<T>,
  detail=false):Promise<T>{
  if(!enabled)return fn();
  const current:SqlScope={usage:emptyUsage(),categories:{},
    ...(detail?{queries:new Map<string,QuerySample>()}:{})},started=Date.now();
  return scope.run(current,async()=>{
    let failed=false;
    try{return await fn();}catch(error){failed=true;throw error;}
    finally{emit({kind:"perch-mcp-sql-usage",area,route:safeRoute(path),
      durationMs:Math.max(0,Date.now()-started),failed,usage:current.usage,
      categories:current.categories,
      ...(current.queries?{queryProfile:[...current.queries.values()].sort(
        (a,b)=>(b.usage.reads+b.usage.writes)-(a.usage.reads+a.usage.writes))}:{})});}
  });
}
