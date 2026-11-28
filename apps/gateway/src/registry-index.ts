import { SqlRecords } from "./sql.js";
import { ApiError } from "./common.js";
import { CanonicalActivity, type ActivityStorageMode, type ActivityMigrationStatus, type ActivityPage } from "./activity-storage.js";
type Event = Record<string,unknown>;
type Key = { key: string };
type Kind = "approval"|"grant"|"permit"|"terminal-notice"|"idempotency"|"workspace"|"agent"|"library";
/** Only these kinds have hot count reads. Derived counts for all others are
 * computed on demand from indexed rows, avoiding permit/terminal write costs. */
const COUNTED_KINDS=new Set<Kind>(["idempotency","workspace","agent"]);
const PREFIXES = ["approval/","grant/","permit/","terminal-notice/","idempotency/","workspace/","agent/"] as const;
const TRACKED = (row:string) => `(${PREFIXES.map(p=>`${row}.key LIKE '${p}%'`).join(" OR ")} OR ${row}.key IN ('activity','library'))`;
const RETENTION = 7*86400000;
const UNCERTAIN = ["UNKNOWN","PARTIAL"];
function num(v:unknown):number|null { return typeof v==="number" && Number.isFinite(v) ? v : null; }
function keyOf(e:Event):string { return String(e.workspaceId)+"/"+String(e.operationId); }
function eventsByKey(events:Event[]):Map<string,Event> { return new Map(events.map(e=>[keyOf(e),e])); }
/** Derived metadata only; the existing chunked records remain canonical. */
export class RegistryIndex {
  private readonly canonicalActivity?: CanonicalActivity;
  private readonly activityMode: ActivityStorageMode;
  constructor(private db:SqlRecords, options: {activityStorageMode?: string} = {}) {
    const mode = options.activityStorageMode ?? "legacy";
    if (!["legacy", "prepare", "native"].includes(mode)) throw new ApiError("INCOMPATIBLE_VERSION", "Unrecognized canonical storage mode.", 409);
    this.activityMode = mode as ActivityStorageMode;
    const tables = db.query<{name:string}>("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('registry_index_version_v1','canonical_activity_meta_v2','canonical_activity_source_v2','canonical_activity_v2')");
    const canonicalTables=tables.filter(row=>row.name.startsWith("canonical_activity_"));
    if(canonicalTables.length!==0&&canonicalTables.length!==3)throw new Error("SQLITE_RECORD_CORRUPT");
    if (mode !== "legacy" || tables.some(row => row.name === "canonical_activity_meta_v2")) this.canonicalActivity = new CanonicalActivity(db);
    if (tables.some(row => row.name === "registry_index_version_v1")) return;
    db.transaction(()=>{
      db.query("CREATE TABLE registry_entity_v1 (key TEXT PRIMARY KEY, kind TEXT NOT NULL, due INTEGER, expires INTEGER, workspace TEXT NOT NULL, state TEXT NOT NULL, hold INTEGER NOT NULL, revision INTEGER, endpoint TEXT) WITHOUT ROWID");
      // Fresh v1 indexes can use the canonical key prefix for bounded pages.
      // The redundant kind/key index amplified every permit/terminal-notice
      // UPSERT. Already initialized databases retain their old index until a
      // separately authorized compatible migration; this is additive-safe.
      db.query("CREATE INDEX registry_due_v1 ON registry_entity_v1(kind,due) WHERE due IS NOT NULL");
      db.query("CREATE INDEX registry_workspace_v1 ON registry_entity_v1(kind,workspace,state,hold)");
      db.query("CREATE INDEX registry_approval_v1 ON registry_entity_v1(kind,expires,key) WHERE kind='approval'");
      db.query("CREATE TABLE registry_dirty_v1 (key TEXT PRIMARY KEY) WITHOUT ROWID");
      db.query("CREATE TABLE registry_counts_v1 (kind TEXT PRIMARY KEY, count INTEGER NOT NULL) WITHOUT ROWID");
      db.query("CREATE TRIGGER registry_count_insert_v1 AFTER INSERT ON registry_entity_v1 WHEN NEW.kind IN ('idempotency','workspace','agent') BEGIN INSERT INTO registry_counts_v1 VALUES(NEW.kind,1) ON CONFLICT(kind) DO UPDATE SET count=count+1; END");
      db.query("CREATE TRIGGER registry_count_delete_v1 AFTER DELETE ON registry_entity_v1 WHEN OLD.kind IN ('idempotency','workspace','agent') BEGIN UPDATE registry_counts_v1 SET count=count-1 WHERE kind=OLD.kind; END");
      db.query("CREATE TABLE registry_activity_v1 (key TEXT PRIMARY KEY, base TEXT, notice TEXT, workspace TEXT NOT NULL, phase TEXT NOT NULL, held INTEGER NOT NULL, updated INTEGER NOT NULL) WITHOUT ROWID");
      db.query("CREATE INDEX registry_activity_order_v1 ON registry_activity_v1(held DESC,updated DESC,key)");
      db.query("CREATE INDEX registry_activity_workspace_v1 ON registry_activity_v1(workspace,held DESC,updated DESC,key)");
      db.query("CREATE INDEX registry_activity_phase_v1 ON registry_activity_v1(phase,held DESC,updated DESC,key)");
      db.query("CREATE INDEX registry_activity_both_v1 ON registry_activity_v1(workspace,phase,held DESC,updated DESC,key)");
      for(const [event,row] of [["INSERT","NEW"],["DELETE","OLD"]] as const)
        db.query(`CREATE TRIGGER registry_dirty_${event.toLowerCase()}_v1 AFTER ${event} ON records WHEN ${TRACKED(row)} BEGIN INSERT INTO registry_dirty_v1 VALUES(${row}.key) ON CONFLICT(key) DO NOTHING; END`);
      db.query(`CREATE TRIGGER registry_dirty_update_v1 AFTER UPDATE ON records BEGIN INSERT INTO registry_dirty_v1 SELECT OLD.key WHERE ${TRACKED("OLD")} ON CONFLICT(key) DO NOTHING; INSERT INTO registry_dirty_v1 SELECT NEW.key WHERE ${TRACKED("NEW")} ON CONFLICT(key) DO NOTHING; END`);
      for(const prefix of PREFIXES) db.query("INSERT OR IGNORE INTO registry_dirty_v1 SELECT DISTINCT key FROM records WHERE key>=? AND key<?",prefix,prefix+"\uffff");
      db.query("INSERT OR IGNORE INTO registry_dirty_v1 SELECT DISTINCT key FROM records WHERE key IN ('activity','library')");
      db.query("CREATE TABLE registry_index_version_v1 (version INTEGER PRIMARY KEY)");
      db.query("INSERT INTO registry_index_version_v1 VALUES(1)");
    });
  }
  private setActivity(key:string, side:"base"|"notice", value:Event|null):void {
    if (this.canonicalActivity?.isNative()) {
      if (side === "notice") this.canonicalActivity.setNotice(key,value);
      return;
    }
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
  private sync(includeActivity=false,includeLibrary=false):void {
    this.db.transaction(()=>{
      // Monolithic legacy domains are reconciled only by their explicit readers.
      // Cleanup, grant checks and migration never materialize their full bodies.
      const excluded:string[]=[];
      if(!includeActivity)excluded.push("key<>'activity'");
      if(!includeLibrary)excluded.push("key<>'library'");
      for(const {key} of this.db.query<Key>("SELECT key FROM registry_dirty_v1"+(excluded.length?" WHERE "+excluded.join(" AND "):"")+" ORDER BY key")){
        if(key==="activity") {
          if (!this.canonicalActivity?.isNative()) this.rebuildActivity();
        }
        else {
          const v=this.db.get<Event>(key);
          const kind=(key==="library"?"library":key.split("/")[0]) as Kind;
          if(v===undefined){
            this.db.query("DELETE FROM registry_entity_v1 WHERE key=?",key);
            if(kind==="terminal-notice")this.setActivity(key.slice("terminal-notice/".length),"notice",null);
          }else {
            if(!v||typeof v!=="object"||Array.isArray(v))throw new Error("SQLITE_RECORD_CORRUPT");
            let due:number|null=null, expires:number|null=null, hold=0;
            const event=v.event as Event|undefined;
            if(kind==="approval"||kind==="grant"){due=expires=num(v.expiresAt); if(kind==="grant"&&v.state==="revoked"&&num(v.revokedAt)!==null)due=Number(v.revokedAt)+RETENTION;}
            else if(kind==="idempotency")due=num(v.expires);
            else if(kind==="permit"&&v.state==="terminal"&&num(v.createdAt)!==null)due=Number(v.createdAt)+RETENTION;
            else if(kind==="terminal-notice"){
              const uncertain=UNCERTAIN.includes(String(v.phase));
              hold=Number(uncertain&&!event?.resolution&&event?.tool!=="set_viewport_size");
              if(!hold)due=num(v.expires);
              // A known-terminal immutable receipt never had an uncertain
              // overlay. Setting a null notice would re-read canonical Activity
              // metadata and entry without changing them. Retain explicit
              // deletion cleanup and every UNKNOWN/PARTIAL overlay transition.
              if(uncertain&&event)
                this.setActivity(key.slice("terminal-notice/".length),"notice",event);
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
    if (this.canonicalActivity?.isNative()) throw new ApiError("CONFLICT", "Native Activity requires individual canonical writes.",409);
    this.db.transaction(()=>{
      this.sync(true);
      const old=eventsByKey(previous), upcoming=eventsByKey(next);
      for(const key of old.keys())if(!upcoming.has(key))this.setActivity(key,"base",null);
      for(const [key,event] of upcoming)if(old.get(key)!==event)this.setActivity(key,"base",event);
      this.db.put("activity",next);
      this.db.query("DELETE FROM registry_dirty_v1 WHERE key='activity'");
    });
  }
  appendActivity(event:Event):void {
    this.db.transaction(()=>{
      if (this.canonicalActivity?.isNative()) {
        this.sync();
        this.canonicalActivity.append(event);
      } else {
        const previous=this.db.get<Event[]>("activity",[]);
        this.putActivity(previous,[...previous,event].slice(-1000));
      }
    });
  }
  resolveActivity(workspaceId:string,operationId:string,resolution:unknown):void {
    this.db.transaction(()=>{
      if (this.canonicalActivity?.isNative()) {
        this.sync();
        this.canonicalActivity.resolve(workspaceId,operationId,resolution);
      } else {
        const previous=this.db.get<Event[]>("activity",[]);
        this.putActivity(previous,previous.map(event=>event.workspaceId===workspaceId&&event.operationId===operationId?{...event,resolution}:event));
      }
    });
  }
  activityPage(raw:string|null,status:string|null,workspace:string|null,revision:number):ActivityPage {
    if (this.canonicalActivity?.isNative()) {
      this.sync();
      return this.canonicalActivity.page(raw,status,workspace,revision);
    }
    const parts=raw?.split(":"),offset=parts?Number(parts[1]):0;
    if ((parts&&(parts.length!==2||Number(parts[0])!==revision))||!Number.isSafeInteger(offset)||offset<0)
      throw new ApiError("STALE_REVISION","Activity changed; restart the list.",409);
    const all=this.activity(offset,status,workspace),end=offset+Math.min(100,all.length);
    return {items:all.slice(0,100),revision,cursor:all.length>100?revision+":"+end:null};
  }
  activityMigrationStatus():ActivityMigrationStatus {
    return this.canonicalActivity?.status() ?? {version:2,stage:"LEGACY",authority:"legacy",sequence:0,revision:0,rollback:"legacy-compatible"};
  }
  advanceActivityMigration(limit=32):ActivityMigrationStatus {
    const before=this.canonicalActivity?.status().stage;
    const status=this.canonicalActivity?.advance(this.activityMode,limit) ?? this.activityMigrationStatus();
    if(status.stage==="NATIVE"&&before!=="NATIVE")this.db.query("DELETE FROM registry_dirty_v1 WHERE key='activity'");
    return status;
  }
  restartActivityMigration():ActivityMigrationStatus {
    if (!this.canonicalActivity || this.activityMode==="legacy") throw new ApiError("CONFLICT","Enable prepare mode before starting Activity migration.",409);
    return this.canonicalActivity.restart();
  }
  activityMigrationPending():boolean {
    if (!this.canonicalActivity || this.activityMode==="legacy") return false;
    const stage=this.canonicalActivity.status().stage;
    return stage!=="NATIVE"&&stage!=="BLOCKED"&&(stage!=="VERIFIED"||this.activityMode==="native");
  }
  due(kind:Kind,now:number):string[]{this.sync();return this.db.query<Key>("SELECT key FROM registry_entity_v1 WHERE kind=? AND due IS NOT NULL AND due<? ORDER BY due LIMIT 128",kind,now).map(r=>r.key);}
  nextDue():number|undefined {this.sync();const times=(["approval","grant","permit","terminal-notice","idempotency"] as const).map(kind=>this.db.query<{due:number}>("SELECT due FROM registry_entity_v1 WHERE kind=? AND due IS NOT NULL ORDER BY due LIMIT 1",kind)[0]?.due).filter((n):n is number=>n!==undefined);return times.length?Math.min(...times):undefined;}
  count(kind:Kind):number {
    this.sync();
    if(COUNTED_KINDS.has(kind))
      return this.db.query<{count:number}>("SELECT count FROM registry_counts_v1 WHERE kind=?",kind)[0]?.count??0;
    // This non-hot path retains exact counts on both fresh and legacy schemas
    // even if a previous binary tracked additional kinds in the side table.
    return this.db.query<{count:number}>("SELECT count(*) AS count FROM registry_entity_v1 WHERE kind=?",kind)[0]?.count??0;
  }
  activeGrantCount(now:number):number {this.sync();return this.db.query<{count:number}>("SELECT count(*) AS count FROM registry_entity_v1 WHERE kind='grant' AND state='active' AND (expires IS NULL OR expires>?)",now)[0]?.count??0;}
  approvalFull(now:number):boolean {this.sync();return this.db.query("SELECT key FROM registry_entity_v1 WHERE kind='approval' AND expires>? ORDER BY expires LIMIT 1 OFFSET 99",now).length>0;}
  page(kind:Kind,offset:number,now:number):string[]{
    this.sync();
    // Legacy Library is one canonical singleton, not a prefix namespace.
    if(kind==="library"){
      const singleton=this.db.query<{key:string;kind:string}>(
        "SELECT key,kind FROM registry_entity_v1 WHERE key='library' LIMIT 1");
      if(singleton.some(row=>row.kind!=="library"))throw new Error("SQLITE_RECORD_CORRUPT");
      return offset===0?singleton.map(row=>row.key):[];
    }
    const prefix=kind+"/";
    const rows=kind==="approval"?
      this.db.query<{key:string;kind:string}>("SELECT key,kind FROM registry_entity_v1 WHERE key>=? AND key<? AND expires>? ORDER BY key LIMIT 100 OFFSET ?",
        prefix,prefix+"\uffff",now,offset):
      this.db.query<{key:string;kind:string}>("SELECT key,kind FROM registry_entity_v1 WHERE key>=? AND key<? ORDER BY key LIMIT 100 OFFSET ?",
        prefix,prefix+"\uffff",offset);
    // Dirty legacy writes still produce the same derived Kind as canonical
    // key prefix. A corrupted projection never becomes a result list.
    if(rows.some(row=>row.kind!==kind))throw new Error("SQLITE_RECORD_CORRUPT");
    return rows.map(row=>row.key);
  }
  grants(workspace:string):string[]{this.sync();return this.db.query<Key>("SELECT key FROM registry_entity_v1 WHERE kind='grant' AND workspace=? AND state='active'",workspace).map(r=>r.key);}
  bindingBlocked(workspace:string):boolean {this.sync();return !!(this.db.query("SELECT key FROM registry_entity_v1 WHERE kind='permit' AND workspace=? AND state='consumed' LIMIT 1",workspace).length||this.db.query("SELECT key FROM registry_entity_v1 WHERE kind='terminal-notice' AND workspace=? AND hold=1 LIMIT 1",workspace).length);}
  libraryRevision():number {this.sync(false,true);return this.db.query<{revision:number|null}>("SELECT revision FROM registry_entity_v1 WHERE key='library'")[0]?.revision??0;}
  activity(offset:number,status:string|null,workspace:string|null):Event[] {
    if(this.canonicalActivity?.isNative())throw new ApiError("STALE_REVISION","Native Activity requires a keyset cursor; restart the list.",409);
    this.sync(true);
    const where:string[]=[], args:(string|number)[]=[];
    if(workspace){where.push("workspace=?");args.push(workspace);}
    if(status){where.push("phase=?");args.push(status);}
    args.push(offset);
    return this.db.query<{base:string|null;notice:string|null}>("SELECT base,notice FROM registry_activity_v1"+(where.length?" WHERE "+where.join(" AND "):"")+" ORDER BY held DESC,updated DESC,key LIMIT 101 OFFSET ?",...args).map(r=>JSON.parse((r.notice??r.base)!) as Event);
  }
}
