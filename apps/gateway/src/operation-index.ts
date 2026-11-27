import { SqlRecords } from "./sql.js";
import { blocksNewLease, blocksNewMutation, isTerminalViewportEffect } from "../../../packages/contracts/src/effect-policy.js";

/** Canonical operation JSON is unchanged. This index is a rebuildable projection, never authorization. */
interface IndexedOperation {
  phase: string; tool: string; sequence: number; createdAt: number; deadlineMs: number;
  terminalAt?: number; terminalNotified?: boolean; resolution?: unknown; result?: unknown;
  terminalErrorCode?: string; args?: unknown;
}
type Key = { key: string };
type ProjectionStats = { eligible: number; resultSize: number };
const RETENTION_MS = 7 * 86400000;
const RESULT_MS = 600000;
export class OperationIndex<T extends IndexedOperation> {
  constructor(private db: SqlRecords) {
    // Cold starts after successful migration must not execute the DDL repeatedly.
    if (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='operation_index_state_v1'").length &&
        db.query("SELECT id FROM operation_index_state_v1 WHERE id=1").length) return;
    db.transaction(() => {
      db.query("CREATE TABLE IF NOT EXISTS operation_index_v1 (key TEXT PRIMARY KEY, sequence INTEGER NOT NULL, created INTEGER NOT NULL, terminal INTEGER NOT NULL, phase TEXT NOT NULL, active INTEGER NOT NULL, pending INTEGER NOT NULL, hold INTEGER NOT NULL, leaseBlock INTEGER NOT NULL, retention INTEGER, due INTEGER, argSize INTEGER NOT NULL, resultSize INTEGER NOT NULL) WITHOUT ROWID");
      db.query("CREATE TABLE IF NOT EXISTS operation_dirty_v1 (key TEXT PRIMARY KEY) WITHOUT ROWID");
      db.query("CREATE TABLE IF NOT EXISTS operation_index_state_v1 (id INTEGER PRIMARY KEY, eligible INTEGER NOT NULL, resultSize INTEGER NOT NULL)");
      db.query("CREATE INDEX IF NOT EXISTS op_active_v1 ON operation_index_v1(active,sequence) WHERE active=1");
      db.query("CREATE INDEX IF NOT EXISTS op_pending_v1 ON operation_index_v1(pending,created) WHERE pending=1");
      db.query("CREATE INDEX IF NOT EXISTS op_hold_v1 ON operation_index_v1(hold,created) WHERE hold=1");
      db.query("CREATE INDEX IF NOT EXISTS op_lease_v1 ON operation_index_v1(leaseBlock,created) WHERE leaseBlock=1");
      db.query("CREATE INDEX IF NOT EXISTS op_due_v1 ON operation_index_v1(due) WHERE due IS NOT NULL");
      db.query("CREATE INDEX IF NOT EXISTS op_retention_v1 ON operation_index_v1(retention) WHERE retention IS NOT NULL");
      db.query("CREATE INDEX IF NOT EXISTS op_terminal_v1 ON operation_index_v1(terminal DESC)");
      // These triggers survive binary rollback. Old writers cannot leave a falsely clean projection.
      for (const [event,row] of [["INSERT","NEW"],["DELETE","OLD"]] as const) {
        db.query(`CREATE TRIGGER IF NOT EXISTS op_dirty_${event.toLowerCase()}_v1 AFTER ${event} ON records WHEN ${row}.key LIKE 'operation/%' BEGIN INSERT OR IGNORE INTO operation_dirty_v1(key) VALUES(${row}.key); END`);
      }
      db.query("CREATE TRIGGER IF NOT EXISTS op_dirty_update_v1 AFTER UPDATE ON records BEGIN INSERT OR IGNORE INTO operation_dirty_v1(key) SELECT OLD.key WHERE OLD.key LIKE 'operation/%'; INSERT OR IGNORE INTO operation_dirty_v1(key) SELECT NEW.key WHERE NEW.key LIKE 'operation/%'; END");
      // One atomic initialization; an interruption rolls back all derived state.
      if (!db.query("SELECT id FROM operation_index_state_v1 WHERE id=1").length) {
        db.query("DELETE FROM operation_index_v1");
        db.query("INSERT INTO operation_index_state_v1 VALUES(1,0,0)");
        db.query("INSERT OR IGNORE INTO operation_dirty_v1 SELECT DISTINCT key FROM records WHERE key>=? AND key<?", "operation/", "operation/\uffff");
      }
      db.query("CREATE TRIGGER IF NOT EXISTS op_stats_insert_v1 AFTER INSERT ON operation_index_v1 BEGIN UPDATE operation_index_state_v1 SET eligible=eligible+(NEW.retention IS NOT NULL), resultSize=resultSize+NEW.resultSize WHERE id=1; END");
      db.query("CREATE TRIGGER IF NOT EXISTS op_stats_delete_v1 AFTER DELETE ON operation_index_v1 BEGIN UPDATE operation_index_state_v1 SET eligible=eligible-(OLD.retention IS NOT NULL), resultSize=resultSize-OLD.resultSize WHERE id=1; END");
      db.query("CREATE TRIGGER IF NOT EXISTS op_stats_update_v1 AFTER UPDATE ON operation_index_v1 WHEN OLD.resultSize<>NEW.resultSize OR (OLD.retention IS NULL)<>(NEW.retention IS NULL) BEGIN UPDATE operation_index_state_v1 SET eligible=eligible+(NEW.retention IS NOT NULL)-(OLD.retention IS NOT NULL), resultSize=resultSize+NEW.resultSize-OLD.resultSize WHERE id=1; END");
    });
  }
  /** Reconcile only changed canonical keys. All queries see the same committed generation. */
  private sync(): void {
    this.db.transaction(() => {
      const dirty = this.db.query<Key>("SELECT key FROM operation_dirty_v1 ORDER BY key");
      for (const {key} of dirty) {
        const o = this.db.get<T>(key);
        if (o===undefined) this.db.query("DELETE FROM operation_index_v1 WHERE key=?", key);
        else {
          if(!o||typeof o!=="object"||!["ADMITTED","DISPATCHED","RUNNING","SUCCEEDED","REJECTED","UNKNOWN","PARTIAL","CANCELLED"].includes(o.phase)||
             typeof o.tool!=="string"||!Number.isFinite(o.sequence)||!Number.isFinite(o.createdAt)||!Number.isFinite(o.deadlineMs)||
             (o.terminalAt!==undefined&&!Number.isFinite(o.terminalAt)))
            throw new Error("SQLITE_RECORD_CORRUPT");
          const terminal = o.terminalAt || 0;
          const active = terminal ? 0 : 1;
          const pending = terminal && !o.terminalNotified ? 1 : 0;
          const retention = terminal && o.terminalNotified &&
            (!["UNKNOWN","PARTIAL"].includes(o.phase) || o.resolution || isTerminalViewportEffect(o))
            ? o.createdAt + RETENTION_MS : null;
          const error = (o.result as { error?: { code?: unknown } } | undefined)?.error?.code;
          const normalize = terminal && !o.terminalErrorCode && typeof error === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(error);
          const deadlines: number[] = [];
          if (active) deadlines.push(o.deadlineMs);
          if (terminal && o.result !== undefined) deadlines.push(terminal + RESULT_MS);
          if (normalize) deadlines.push(0);
          if (retention !== null) deadlines.push(retention);
          this.db.query("INSERT INTO operation_index_v1 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET sequence=excluded.sequence, created=excluded.created, terminal=excluded.terminal, phase=excluded.phase, active=excluded.active, pending=excluded.pending, hold=excluded.hold, leaseBlock=excluded.leaseBlock, retention=excluded.retention, due=excluded.due, argSize=excluded.argSize, resultSize=excluded.resultSize",
            key, o.sequence, o.createdAt, terminal, o.phase, active, pending, Number(blocksNewMutation(o)), Number(blocksNewLease(o)), retention,
            deadlines.length ? Math.min(...deadlines) : null, JSON.stringify(o.args ?? {}).length, JSON.stringify(o.result ?? null).length);
        }
        this.db.query("DELETE FROM operation_dirty_v1 WHERE key=?", key);
      }
    });
  }
  private select(sql: string, ...args: number[]): Key[] { this.sync(); return this.db.query<Key>(sql,...args); }
  private load(rows: Key[]): T[] { return rows.map(({key}) => { const o=this.db.get<T>(key); if(!o)throw new Error("SQLITE_RECORD_CORRUPT"); return o; }); }
  activeStats(): {argSize:number}[] {this.sync();return this.db.query<{argSize:number}>("SELECT argSize FROM operation_index_v1 WHERE active=1 ORDER BY sequence LIMIT 9");}
  running():boolean {return this.select("SELECT key FROM operation_index_v1 WHERE active=1 AND phase IN ('DISPATCHED','RUNNING') ORDER BY sequence LIMIT 1").length>0;}
  nextAdmitted():T|undefined {return this.load(this.select("SELECT key FROM operation_index_v1 WHERE active=1 AND phase='ADMITTED' ORDER BY sequence LIMIT 1"))[0];}
  pendingKeys():Key[] {return this.select("SELECT key FROM operation_index_v1 WHERE pending=1 ORDER BY created LIMIT 32");}
  pendingExists(): boolean { return this.select("SELECT key FROM operation_index_v1 WHERE pending=1 ORDER BY created LIMIT 1").length>0; }
  pendingFull(): boolean { return this.select("SELECT key FROM operation_index_v1 WHERE pending=1 ORDER BY created LIMIT 1 OFFSET 127").length>0; }
  holds(): boolean { return this.select("SELECT key FROM operation_index_v1 WHERE hold=1 ORDER BY created LIMIT 1").length>0; }
  holdsFull(): boolean { return this.select("SELECT key FROM operation_index_v1 WHERE hold=1 ORDER BY created LIMIT 1 OFFSET 127").length>0; }
  leaseBlocked(): boolean { return this.select("SELECT key FROM operation_index_v1 WHERE leaseBlock=1 ORDER BY created LIMIT 1").length>0; }
  leaseBlockers(): T[] { return this.load(this.select("SELECT key FROM operation_index_v1 WHERE leaseBlock=1 ORDER BY created LIMIT 128")); }
  due(now: number): T[] {
    // Never let a historical retention backlog delay expiration of an active operation.
    return this.load(this.select("SELECT key FROM operation_index_v1 WHERE active=1 AND due<=? ORDER BY sequence LIMIT 9",now))
      .concat(this.load(this.select("SELECT key FROM operation_index_v1 WHERE active=0 AND due IS NOT NULL AND due<=? ORDER BY due LIMIT 128",now)));
  }
  nextDue(): number | undefined { this.sync(); return this.db.query<{due:number}>("SELECT due FROM operation_index_v1 WHERE due IS NOT NULL ORDER BY due LIMIT 1")[0]?.due; }
  lastActivityAt(): number { this.sync(); return this.db.query<{terminal:number}>("SELECT terminal FROM operation_index_v1 ORDER BY terminal DESC LIMIT 1")[0]?.terminal ?? 0; }
  stats(): ProjectionStats { this.sync(); return this.db.query<ProjectionStats>("SELECT eligible,resultSize FROM operation_index_state_v1 WHERE id=1")[0]!; }
  excessRetention(): Key[] { const excess=Math.max(0,this.stats().eligible-1000); return excess ? this.select("SELECT key FROM operation_index_v1 WHERE retention IS NOT NULL ORDER BY retention LIMIT ?",Math.min(excess,128)) : []; }
}
