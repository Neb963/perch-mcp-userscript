import { AsyncLocalStorage } from "node:async_hooks";
export interface SqlUsage { reads:number; writes:number; statements:number; unmetered:number }
type Area="registry"|"workspace";
const scope=new AsyncLocalStorage<{usage:SqlUsage;categories:Record<string,SqlUsage>}>();
export function emptyUsage():SqlUsage {return {reads:0,writes:0,statements:0,unmetered:0};}
function add(to:SqlUsage,from:SqlUsage):void {to.reads+=from.reads;to.writes+=from.writes;to.statements+=from.statements;to.unmetered+=from.unmetered;}
export function trackSql(sql:string,usage:SqlUsage):void {
  const current=scope.getStore();if(!current)return;
  const category=/^CREATE\b|sqlite_master/.test(sql)?"schema":/operation_(?:index|dirty)/.test(sql)?"operation-index":/registry_activity/.test(sql)?"activity-index":/registry_(?:entity|dirty|counts|index)/.test(sql)?"registry-index":/FROM records|INTO records|UPDATE records/.test(sql)?"canonical":"other";
  add(current.usage,usage);add(current.categories[category]??=emptyUsage(),usage);
}
function safeRoute(path:string):string {
  if(path==="alarm")return path;
  const exact=new Set(["health","config","authorize","dispatch","terminal","admit","status","cancel","resolve","recovery","claim","epoch","lease-check","diagnostic-event","registration-budget","poll","heartbeat","reply","release","permit","image","music","music-result","sql-usage","ticket","socket"]);
  const internal=/^\/internal\/([a-z-]+)$/.exec(path);
  if(internal&&exact.has(internal[1]!))return "internal/"+internal[1];
  if(/^\/internal\/oauth\/(pending|consume|redirect-commit|abort-completion)$/.test(path))return path.slice(1);
  const tab=/^\/api\/v1\/tab\/([a-z-]+)$/.exec(path);
  if(tab&&exact.has(tab[1]!))return "tab/"+tab[1];
  const admin=/^\/api\/v1\/admin\/(workspaces|agents|grants|approvals|resources|state|activity|diagnostics|pair|recover|pause)(?:\/|$)/.exec(path);
  return admin?"admin/"+admin[1]:"other";
}
export async function withSqlUsage<T>(enabled:boolean,area:Area,path:string,fn:()=>Promise<T>):Promise<T>{
  if(!enabled)return fn();
  const current={usage:emptyUsage(),categories:{} as Record<string,SqlUsage>}, started=Date.now();
  return scope.run(current,async()=>{try{return await fn();}finally{console.log(JSON.stringify({kind:"perch-mcp-sql-usage",area,route:safeRoute(path),durationMs:Date.now()-started,...current}));}});
}
