import { readMediaMetadata } from "./binary-payloads.js";
import { SqlRecords } from "./sql.js";
type Kind = "retired" | "image" | "music";
type Row = { key: string; kind: string; due: number };
const PREFIXES = ["retired/", "image/manifest/", "music/journal/"] as const;
const tracked = (row: string) => "(" + PREFIXES.map(p => `${row}.key LIKE '${p}%'`).join(" OR ") + ")";
const WEEK = 7 * 86400000;
function finite(n: unknown): n is number { return typeof n === "number" && Number.isFinite(n); }
/** Rebuildable scheduling projection. Canonical records remain authoritative throughout preparation. */
export class MaintenanceIndex {
  private legacyTrackingRemoved = false;
  private preparationComplete = false;
  constructor(private db: SqlRecords, private now: () => number = () => Date.now(), private nativeFence?: () => boolean) {
    db.transaction(() => {
      if (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='workspace_maintenance_version_v2'").length) {
        const versions = db.query<{ version: number }>("SELECT version FROM workspace_maintenance_version_v2");
        if (versions.length !== 1 || versions[0]?.version !== 2) throw new Error("SQLITE_SCHEMA_INCOMPATIBLE");
        return;
      }
      db.query("CREATE TABLE workspace_maintenance_v2 (key TEXT PRIMARY KEY,kind TEXT NOT NULL,due INTEGER) WITHOUT ROWID");
      db.query("CREATE INDEX workspace_maintenance_due_v2 ON workspace_maintenance_v2(due) WHERE due IS NOT NULL");
      db.query("CREATE TABLE workspace_maintenance_dirty_v2 (key TEXT PRIMARY KEY) WITHOUT ROWID");
      for (const [event, row] of [["INSERT", "NEW"], ["DELETE", "OLD"]] as const)
        db.query(`CREATE TRIGGER workspace_maintenance_dirty_${event.toLowerCase()}_v2 AFTER ${event} ON records WHEN ${tracked(row)} BEGIN INSERT INTO workspace_maintenance_dirty_v2 VALUES(${row}.key) ON CONFLICT(key) DO NOTHING; END`);
      db.query(`CREATE TRIGGER workspace_maintenance_dirty_update_v2 AFTER UPDATE ON records BEGIN INSERT INTO workspace_maintenance_dirty_v2 SELECT OLD.key WHERE ${tracked("OLD")} ON CONFLICT(key) DO NOTHING; INSERT INTO workspace_maintenance_dirty_v2 SELECT NEW.key WHERE ${tracked("NEW")} ON CONFLICT(key) DO NOTHING; END`);
      db.query("CREATE TABLE workspace_maintenance_prepare_v2 (prefix TEXT PRIMARY KEY,cursor TEXT NOT NULL,complete INTEGER NOT NULL CHECK(complete IN (0,1))) WITHOUT ROWID");
      db.query("CREATE INDEX workspace_maintenance_pending_v2 ON workspace_maintenance_prepare_v2(prefix) WHERE complete=0");
      for (const prefix of PREFIXES) db.query("INSERT INTO workspace_maintenance_prepare_v2 VALUES(?,'',0)", prefix);
      db.query("CREATE TABLE workspace_maintenance_version_v2 (version INTEGER PRIMARY KEY CHECK(version=2))");
      db.query("INSERT INTO workspace_maintenance_version_v2 VALUES(2)");
    });
    this.disableLegacyTracking();
  }
  private disableLegacyTracking(): void {
    if (this.legacyTrackingRemoved || !this.nativeFence?.()) return;
    // v1 stays complete or absent during LEGACY/PREPARE. Schema2 rejects the old binary.
    this.db.transaction(() => {
      for (const event of ["insert", "delete", "update"]) this.db.query(`DROP TRIGGER IF EXISTS workspace_maintenance_dirty_${event}_v1`);
    });
    this.legacyTrackingRemoved = !this.db.inTransaction;
  }
  private prepareBatch(): boolean {
    if (this.preparationComplete) return true;
    const state = this.db.query<{ prefix: string; cursor: string }>("SELECT prefix,cursor FROM workspace_maintenance_prepare_v2 WHERE complete=0 ORDER BY prefix LIMIT 1")[0];
    if (!state) return true;
    if (!(PREFIXES as readonly string[]).includes(state.prefix) || (state.cursor !== "" && !state.cursor.startsWith(state.prefix))) throw new Error("SQLITE_RECORD_CORRUPT");
    // Do not supply competing lower bounds: SQLite may choose the empty cursor and scan earlier domains.
    const rows = state.cursor === ""
      ? this.db.query<{ key: string }>("SELECT DISTINCT key FROM records WHERE key>=? AND key<? ORDER BY key LIMIT 128", state.prefix, state.prefix + "\uffff")
      : this.db.query<{ key: string }>("SELECT DISTINCT key FROM records WHERE key>? AND key<? ORDER BY key LIMIT 128", state.cursor, state.prefix + "\uffff");
    for (const { key } of rows) this.db.query("INSERT OR IGNORE INTO workspace_maintenance_dirty_v2 VALUES(?)", key);
    this.db.query("UPDATE workspace_maintenance_prepare_v2 SET cursor=?,complete=? WHERE prefix=?", rows.at(-1)?.key ?? state.cursor, rows.length < 128 ? 1 : 0, state.prefix);
    return rows.length < 128 && !this.db.query("SELECT 1 FROM workspace_maintenance_prepare_v2 WHERE complete=0 LIMIT 1").length;
  }
  private sync(): boolean {
    this.disableLegacyTracking();
    let prepared = false;
    const ready = this.db.transaction(() => {
      prepared = this.prepareBatch();
      const dirty = this.db.query<{ key: string }>("SELECT key FROM workspace_maintenance_dirty_v2 ORDER BY key LIMIT 128");
      for (const { key } of dirty) {
        const v = readMediaMetadata<Record<string, unknown>>(this.db, key);
        if (v === undefined) this.db.query("DELETE FROM workspace_maintenance_v2 WHERE key=?", key);
        else {
          if (!v || typeof v !== "object") throw new Error("SQLITE_RECORD_CORRUPT");
          const kind = key.split("/")[0] as Kind;
          let due: number | null = null;
          if (kind === "retired" || kind === "image") {
            if (!finite(v.expiresAt)) throw new Error("SQLITE_RECORD_CORRUPT");
            due = v.expiresAt + (kind === "retired" ? 86400001 : 0);
          } else {
            const deadlines: number[] = [];
            if (typeof v.bytes === "number" && v.bytes > 0 && finite(v.expiresAt)) deadlines.push(v.expiresAt);
            if (["DELIVERED", "EXPIRED", "REJECTED"].includes(String(v.phase)) && finite(v.createdAt)) deadlines.push(v.createdAt + WEEK);
            due = deadlines.length ? Math.min(...deadlines) : null;
          }
          this.db.query("INSERT INTO workspace_maintenance_v2 VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET kind=excluded.kind,due=excluded.due WHERE workspace_maintenance_v2.kind<>excluded.kind OR workspace_maintenance_v2.due IS NOT excluded.due", key, kind, due);
        }
        this.db.query("DELETE FROM workspace_maintenance_dirty_v2 WHERE key=?", key);
      }
      // No await or canonical mutation occurs in this loop; a short batch drained all dirty keys.
      return prepared && (dirty.length < 128 || !this.db.query("SELECT 1 FROM workspace_maintenance_dirty_v2 LIMIT 1").length);
    });
    if (prepared && !this.db.inTransaction) this.preparationComplete = true;
    return ready;
  }
  idleReady(): boolean {
    const prepared = this.preparationComplete || !this.db.query("SELECT 1 FROM workspace_maintenance_prepare_v2 WHERE complete=0 LIMIT 1").length;
    if (prepared && !this.db.inTransaction) this.preparationComplete = true;
    return prepared && !this.db.query("SELECT 1 FROM workspace_maintenance_dirty_v2 LIMIT 1").length;
  }
  due(now: number): Row[] { this.sync(); return this.db.query<Row>("SELECT key,kind,due FROM workspace_maintenance_v2 WHERE due IS NOT NULL AND due<=? ORDER BY due LIMIT 128", now); }
  nextDue(): number | undefined {
    const ready = this.sync();
    const due = this.db.query<{ due: number }>("SELECT due FROM workspace_maintenance_v2 WHERE due IS NOT NULL ORDER BY due LIMIT 1")[0]?.due;
    return ready ? due : Math.min(due ?? Infinity, this.now() + 1000);
  }
}
