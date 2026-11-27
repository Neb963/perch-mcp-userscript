import {SqlRecords} from "./sql.js";
type Kind="retired"|"image"|"music";
type Row={key:string;kind:string;due:number};
const PREFIXES=["retired/","image/manifest/","music/journal/"] as const;
const tracked=(row:string)=>"("+PREFIXES.map(p=>`${row}.key LIKE '${p}%'`).join(" OR ")+")";
const WEEK=7*86400000;
function finite(n:unknown):n is number{return typeof n==="number"&&Number.isFinite(n);}
export class MaintenanceIndex {
  constructor(private db:SqlRecords){
    if(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='workspace_maintenance_version_v1'").length)return;
    db.transaction(()=>{
      db.query("CREATE TABLE workspace_maintenance_v1 (key TEXT PRIMARY KEY,kind TEXT NOT NULL,due INTEGER) WITHOUT ROWID");
      db.query("CREATE INDEX workspace_maintenance_due_v1 ON workspace_maintenance_v1(due) WHERE due IS NOT NULL");
      db.query("CREATE TABLE workspace_maintenance_dirty_v1 (key TEXT PRIMARY KEY) WITHOUT ROWID");
      for(const [event,row] of [["INSERT","NEW"],["DELETE","OLD"]] as const)
        db.query(`CREATE TRIGGER workspace_maintenance_dirty_${event.toLowerCase()}_v1 AFTER ${event} ON records WHEN ${tracked(row)} BEGIN INSERT OR IGNORE INTO workspace_maintenance_dirty_v1 VALUES(${row}.key); END`);
      db.query(`CREATE TRIGGER workspace_maintenance_dirty_update_v1 AFTER UPDATE ON records BEGIN INSERT OR IGNORE INTO workspace_maintenance_dirty_v1 SELECT OLD.key WHERE ${tracked("OLD")}; INSERT OR IGNORE INTO workspace_maintenance_dirty_v1 SELECT NEW.key WHERE ${tracked("NEW")}; END`);
      for(const prefix of PREFIXES)db.query("INSERT OR IGNORE INTO workspace_maintenance_dirty_v1 SELECT DISTINCT key FROM records WHERE key>=? AND key<?",prefix,prefix+"\uffff");
      db.query("CREATE TABLE workspace_maintenance_version_v1 (version INTEGER PRIMARY KEY)");
      db.query("INSERT INTO workspace_maintenance_version_v1 VALUES(1)");
    });
  }
  private sync():void{
    this.db.transaction(()=>{
      for(const {key} of this.db.query<{key:string}>("SELECT key FROM workspace_maintenance_dirty_v1 ORDER BY key")){
        const v=this.db.get<Record<string,unknown>>(key);
        if(v===undefined)this.db.query("DELETE FROM workspace_maintenance_v1 WHERE key=?",key);
        else {
          if(!v||typeof v!=="object")throw new Error("SQLITE_RECORD_CORRUPT");
          const kind=key.split("/")[0] as Kind;
          let due:number|null=null;
          if(kind==="retired"||kind==="image"){
            if(!finite(v.expiresAt))throw new Error("SQLITE_RECORD_CORRUPT");
            due=v.expiresAt+(kind==="retired"?86400001:0);
          }else{
            const deadlines:number[]=[];
            if(typeof v.bytes==="number"&&v.bytes>0&&finite(v.expiresAt))deadlines.push(v.expiresAt);
            if(["DELIVERED","EXPIRED","REJECTED"].includes(String(v.phase))&&finite(v.createdAt))deadlines.push(v.createdAt+WEEK);
            due=deadlines.length?Math.min(...deadlines):null;
          }
          this.db.query("INSERT INTO workspace_maintenance_v1 VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET kind=excluded.kind,due=excluded.due",key,kind,due);
        }
        this.db.query("DELETE FROM workspace_maintenance_dirty_v1 WHERE key=?",key);
      }
    });
  }
  due(now:number):Row[]{this.sync();return this.db.query<Row>("SELECT key,kind,due FROM workspace_maintenance_v1 WHERE due IS NOT NULL AND due<=? ORDER BY due LIMIT 128",now);}
  nextDue():number|undefined{this.sync();return this.db.query<{due:number}>("SELECT due FROM workspace_maintenance_v1 WHERE due IS NOT NULL ORDER BY due LIMIT 1")[0]?.due;}
}
