import { SqlRecords } from "./sql.js";
type Event = Record<string,unknown>;
type Key = { key: string };
type Kind = "approval"|"grant"|"permit"|"terminal-notice"|"idempotency"|"workspace"|"agent"|"library";
const PREFIXES = ["approval/","grant/","permit/","terminal-notice/","idempotency/","workspace/","agent/"] as const;
const TRACKED = (row:string) => `(${PREFIXES.map(p=>`${row}.key LIKE '${p}%'`).join(" OR ")} OR ${row}.key IN ('activity','library'))`;
const RETENTION = 7*86400000;
const UNCERTAIN = ["UNKNOWN","PARTIAL"];
function num(v:unknown):number|null { return typeof v==="number" && Number.isFinite(v) ? v : null; }
function keyOf(e:Event):string { return String(e.workspaceId)+"/"+String(e.operationId); }
function eventsByKey(events:Event[]):Map<string,Event> { return new Map(events.map(e=>[keyOf(e),e])); }
/** Derived metadata only; the existing chunked records remain canonical. */
export class RegistryIndex {
  constructor(private db:SqlRecords) {
    if (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='registry_index_version_v1'").length) return;
    db.transaction(()=>{
      db.query("CREATE TABLE registry_entity_v1 (key TEXT PRIMARY KEY, kind TEXT NOT NULL, due INTEGER, expires INTEGER, workspace TEXT NOT NULL, state TEXT NOT NULL, hold INTEGER NOT NULL, revision INTEGER, endpoint TEXT)");
      db.query("CREATE INDEX registry_kind_v1 ON registry_entity_v1(kind,key)");
      db.query("CREATE INDEX registry_due_v1 ON registry_entity_v1(kind,due) WHERE due IS NOT NULL");
      db.query("CREATE INDEX registry_workspace_v1 ON registry_entity_v1(kind,workspace,state,hold)");
      db.query("CREATE INDEX registry_approval_v1 ON registry_entity_v1(kind,expires,key) WHERE kind='approval'");
      db.query("CREATE TABLE registry_dirty_v1 (key TEXT PRIMARY KEY)");
      db.query("CREATE TABLE registry_counts_v1 (kind TEXT PRIMARY KEY, count INTEGER NOT NULL)");
      db.query("CREATE TRIGGER registry_count_insert_v1 AFTER INSERT ON registry_entity_v1 BEGIN INSERT INTO registry_counts_v1 VALUES(NEW.kind,1) ON CONFLICT(kind) DO UPDATE SET count=count+1; END");
      db.query("CREATE TRIGGER registry_count_delete_v1 AFTER DELETE ON registry_entity_v1 BEGIN UPDATE registry_counts_v1 SET count=count-1 WHERE kind=OLD.kind; END");
      db.query("CREATE TABLE registry_activity_v1 (key TEXT PRIMARY KEY, base TEXT, notice TEXT, workspace TEXT NOT NULL, phase TEXT NOT NULL, held INTEGER NOT NULL, updated INTEGER NOT NULL)");
      db.query("CREATE INDEX registry_activity_order_v1 ON registry_activity_v1(held DESC,updated DESC,key)");
      db.query("CREATE INDEX registry_activity_workspace_v1 ON registry_activity_v1(workspace,held DESC,updated DESC,key)");
      db.query("CREATE INDEX registry_activity_phase_v1 ON registry_activity_v1(phase,held DESC,updated DESC,key)");
      db.query("CREATE INDEX registry_activity_both_v1 ON registry_activity_v1(workspace,phase,held DESC,updated DESC,key)");
      for(const [event,row] of [["INSERT","NEW"],["DELETE","OLD"]] as const)
        db.query(`CREATE TRIGGER registry_dirty_${event.toLowerCase()}_v1 AFTER ${event} ON records WHEN ${TRACKED(row)} BEGIN INSERT OR IGNORE INTO registry_dirty_v1 VALUES(${row}.key); END`);
      db.query(`CREATE TRIGGER registry_dirty_update_v1 AFTER UPDATE ON records BEGIN INSERT OR IGNORE INTO registry_dirty_v1 SELECT OLD.key WHERE ${TRACKED("OLD")}; INSERT OR IGNORE INTO registry_dirty_v1 SELECT NEW.key WHERE ${TRACKED("NEW")}; END`);
      for(const prefix of PREFIXES) db.query("INSERT OR IGNORE INTO registry_dirty_v1 SELECT DISTINCT key FROM records WHERE key>=? AND key<?",prefix,prefix+"\uffff");
      db.query("INSERT OR IGNORE INTO registry_dirty_v1 SELECT DISTINCT key FROM records WHERE key IN ('activity','library')");
      db.query("CREATE TABLE registry_index_version_v1 (version INTEGER PRIMARY KEY)");
      db.query("INSERT INTO registry_index_version_v1 VALUES(1)");
    });
  }
  private setActivity(key:string, side:"base"|"notice", value:Event|null):void {
    const old = this.db.query<{base:string|null;notice:string|null}>("SELECT base,notice FROM registry_activity_v1 WHERE key=?",key)[0];
    const encoded=value?JSON.stringify(value):null;
    if((old?.[side]??null)===encoded)return;
    const base=side==="base"?encoded:old?.base??null, notice=side==="notice"?encoded:old?.notice??null;
    const effective=notice??base;
    if(effective===null){this.db.query("DELETE FROM registry_activity_v1 WHERE key=?",key);return;}
    const e=JSON.parse(effective) as Event;
    const updated=Math.max(num(e.timestamp)??0,num((e.resolution as {timestamp?:unknown}|undefined)?.timestamp)??0);
    this.db.query("INSERT INTO registry_activity_v1 VALUES(?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET base=excluded.base,notice=excluded.notice,workspace=excluded.workspace,phase=excluded.phase,held=excluded.held,updated=excluded.updated",key,base,notice,String(e.workspaceId),String(e.phase),Number(UNCERTAIN.includes(String(e.phase))&&!e.resolution),updated);
  }
  private rebuildActivity():void {
    const events=eventsByKey(this.db.get<Event[]>("activity",[]));
    for(const {key} of this.db.query<Key>("SELECT key FROM registry_activity_v1 WHERE base IS NOT NULL"))if(!events.has(key))this.setActivity(key,"base",null);
    for(const [key,event] of events)this.setActivity(key,"base",event);
  }
  private sync():void {
    this.db.transaction(()=>{
      for(const {key} of this.db.query<Key>("SELECT key FROM registry_dirty_v1 ORDER BY key")){
        if(key==="activity") this.rebuildActivity();
        else {
          const v=this.db.get<Event>(key);
          const kind=(key==="library"?"library":key.split("/")[0]) as Kind;
          if(!v){
            this.db.query("DELETE FROM registry_entity_v1 WHERE key=?",key);
            if(kind==="terminal-notice")this.setActivity(key.slice("terminal-notice/".length),"notice",null);
          }else {
            let due:number|null=null, expires:number|null=null, hold=0;
            const event=v.event as Event|undefined;
            if(kind==="approval"||kind==="grant"){due=expires=num(v.expiresAt);}
            else if(kind==="idempotency")due=num(v.expires);
            else if(kind==="permit"&&v.state==="terminal"&&num(v.createdAt)!==null)due=Number(v.createdAt)+RETENTION;
            else if(kind==="terminal-notice"){
              const uncertain=UNCERTAIN.includes(String(v.phase));
              hold=Number(uncertain&&!event?.resolution&&event?.tool!=="set_viewport_size");
              if(!hold)due=num(v.expires);
              this.setActivity(key.slice("terminal-notice/".length),"notice",uncertain&&event?event:null);
            }
            const workspace=kind==="terminal-notice"?key.split("/")[1]??"":String(v.workspaceId??"");
            const state=kind==="agent"?(v.suspended?"suspended":"active"):String(v.state??v.phase??"");
            this.db.query("INSERT INTO registry_entity_v1 VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET due=excluded.due,expires=excluded.expires,workspace=excluded.workspace,state=excluded.state,hold=excluded.hold,revision=excluded.revision,endpoint=excluded.endpoint",
              key,kind,due,expires,workspace,state,hold,kind==="library"?num(v.revision):null,kind==="agent"&&typeof v.endpoint==="string"?v.endpoint:null);
          }
        }
        this.db.query("DELETE FROM registry_dirty_v1 WHERE key=?",key);
      }
    });
  }
  /** Current binary writes known Activity changes atomically; only legacy writes rebuild. */
  putActivity(previous:Event[],next:Event[]):void {
    this.db.transaction(()=>{
      this.sync();
      const old=eventsByKey(previous), upcoming=eventsByKey(next);
      for(const key of old.keys())if(!upcoming.has(key))this.setActivity(key,"base",null);
      for(const [key,event] of upcoming)if(JSON.stringify(old.get(key))!==JSON.stringify(event))this.setActivity(key,"base",event);
      this.db.put("activity",next);
      this.db.query("DELETE FROM registry_dirty_v1 WHERE key='activity'");
    });
  }
  due(kind:Kind,now:number):string[]{this.sync();return this.db.query<Key>("SELECT key FROM registry_entity_v1 WHERE kind=? AND due IS NOT NULL AND due<? ORDER BY due LIMIT 128",kind,now).map(r=>r.key);}
  nextDue():number|undefined {this.sync();const times=(["approval","grant","permit","terminal-notice","idempotency"] as const).map(kind=>this.db.query<{due:number}>("SELECT due FROM registry_entity_v1 WHERE kind=? AND due IS NOT NULL ORDER BY due LIMIT 1",kind)[0]?.due).filter((n):n is number=>n!==undefined);return times.length?Math.min(...times):undefined;}
  count(kind:Kind):number {this.sync();return this.db.query<{count:number}>("SELECT count FROM registry_counts_v1 WHERE kind=?",kind)[0]?.count??0;}
  approvalFull(now:number):boolean {this.sync();return this.db.query("SELECT key FROM registry_entity_v1 WHERE kind='approval' AND expires>? ORDER BY expires LIMIT 1 OFFSET 99",now).length>0;}
  page(kind:Kind,offset:number,now:number):string[]{this.sync();return (kind==="approval"?this.db.query<Key>("SELECT key FROM registry_entity_v1 WHERE kind=? AND expires>? ORDER BY key LIMIT 100 OFFSET ?",kind,now,offset):this.db.query<Key>("SELECT key FROM registry_entity_v1 WHERE kind=? ORDER BY key LIMIT 100 OFFSET ?",kind,offset)).map(r=>r.key);}
  grants(workspace:string):string[]{this.sync();return this.db.query<Key>("SELECT key FROM registry_entity_v1 WHERE kind='grant' AND workspace=? AND state='active'",workspace).map(r=>r.key);}
  bindingBlocked(workspace:string):boolean {this.sync();return !!(this.db.query("SELECT key FROM registry_entity_v1 WHERE kind='permit' AND workspace=? AND state='consumed' LIMIT 1",workspace).length||this.db.query("SELECT key FROM registry_entity_v1 WHERE kind='terminal-notice' AND workspace=? AND hold=1 LIMIT 1",workspace).length);}
  libraryRevision():number {this.sync();return this.db.query<{revision:number|null}>("SELECT revision FROM registry_entity_v1 WHERE key='library'")[0]?.revision??0;}
  activity(offset:number,status:string|null,workspace:string|null):Event[] {
    this.sync();
    const where:string[]=[], args:(string|number)[]=[];
    if(workspace){where.push("workspace=?");args.push(workspace);}
    if(status){where.push("phase=?");args.push(status);}
    args.push(offset);
    return this.db.query<{base:string|null;notice:string|null}>("SELECT base,notice FROM registry_activity_v1"+(where.length?" WHERE "+where.join(" AND "):"")+" ORDER BY held DESC,updated DESC,key LIMIT 101 OFFSET ?",...args).map(r=>JSON.parse((r.notice??r.base)!) as Event);
  }
}
