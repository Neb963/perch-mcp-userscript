import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { trackSql, type SqlUsage } from "./sql-meter.js";
export type { SqlUsage } from "./sql-meter.js";
export const WORKSPACE_JOURNAL_IDLE_KEY = "workspace-journal-idle/v1";
/** SQLite-backed chunked records; every mutation runs within transactionSync. */
export class SqlRecords {
  private depth = 0;
  // Cache canonical JSON only inside one synchronous SQLite transaction. Do not
  // cache across RPC awaits, requests, transaction boundaries, or mutations.
  private transactionReads: Map<string, unknown> | undefined;
  private transactionReadChars = 0;
  get inTransaction():boolean {return this.depth>0;}
  private usage: SqlUsage = { reads: 0, writes: 0, statements: 0, unmetered: 0 };
  constructor(private storage: DurableObjectStorage) {
    this.query(
      "CREATE TABLE IF NOT EXISTS records (key TEXT NOT NULL, part INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(key, part)) WITHOUT ROWID",
    );
  }
  /** All statements consume their cursor before reading Cloudflare's counters. */
  query<T extends Record<string, string | number | null | ArrayBuffer> = Record<string, string | number | null | ArrayBuffer>>(sql: string, ...args: (string | number | null | ArrayBuffer)[]): T[] {
    // Invalidate *before* every non-read-only SQL statement. This also covers
    // external schema writes, triggers, and statements that later throw.
    // Conservatively treating an unfamiliar statement as a write is safe.
    if (this.transactionReads && !/^\s*(?:SELECT|EXPLAIN)\b/i.test(sql)) {
      this.transactionReads.clear();
      this.transactionReadChars = 0;
    }
    this.usage.statements++;
    let cursor;
    try {cursor = this.storage.sql.exec<T>(sql,...args);}
    catch(error){this.usage.unmetered++;trackSql(sql,{reads:0,writes:0,statements:1,unmetered:1},args);throw error;}
    try { return cursor.toArray(); }
    finally {
      const metered=typeof cursor.rowsRead==="number"&&typeof cursor.rowsWritten==="number";
      const sample={reads:metered?cursor.rowsRead:0,writes:metered?cursor.rowsWritten:0,statements:1,unmetered:metered?0:1};
      this.usage.reads+=sample.reads;this.usage.writes+=sample.writes;this.usage.unmetered+=sample.unmetered;
      trackSql(sql,sample,args);
    }
  }
  snapshotUsage(): SqlUsage { return { ...this.usage }; }
  get<T>(key: string, fallback?: T): T {
    // A caller may mutate the returned object before an explicit put(). Never
    // let such unsaved edits taint subsequent reads of canonical storage.
    const cache = this.transactionReads;
    if (cache?.has(key)) {
      const cached = cache.get(key);
      return cached === undefined ? fallback as T : structuredClone(cached) as T;
    }
    const rows = this.query<{ part: number; value: string }>("SELECT part,value FROM records WHERE key=? ORDER BY part", key);
    if (!rows.length) {
      if (cache && cache.size < 32) cache.set(key, undefined);
      return fallback as T;
    }
    try {
      // A syntactically valid JSON body does not establish record integrity.
      // Refuse gaps, orphaned first parts and noncanonical part numbers.
      if (rows.some((r, i) => r.part !== i || typeof r.value !== "string" || r.value.length > 32000))
        throw new Error("Invalid record parts");
      const encoded = rows.map((r) => r.value).join("");
      const decoded = JSON.parse(encoded) as T;
      // Each synchronous transaction retains at most 32 small records and
      // 64 Ki UTF-16 units. Large source, image or archive bodies bypass cache.
      if (cache && cache.size < 32 && encoded.length <= 16_384 &&
          this.transactionReadChars + encoded.length <= 65_536) {
        cache.set(key, structuredClone(decoded));
        this.transactionReadChars += encoded.length;
      }
      return decoded;
    } catch {
      // Never silently default corrupted identity, Grant, or operation state.
      // The gateway incident log records the classification; no record data escapes.
      throw new Error('SQLITE_RECORD_CORRUPT');
    }
  }
  put(key: string, value: unknown): void {
    // A chunked logical record is atomic even when its caller has no transaction.
    this.transaction(() => this.write(key, value));
  }
  private write(key: string, value: unknown): void {
    const s = JSON.stringify(value);
    let offset = 0,
      part = 0;
    while (offset < s.length) {
      let end = Math.min(s.length, offset + 32000);
      // SQLite UTF-8 serialization must never split a UTF-16 surrogate pair.
      const last = s.charCodeAt(end - 1);
      if (end < s.length && last >= 0xd800 && last <= 0xdbff) end--;
      this.query(
        "INSERT INTO records(key,part,value) VALUES(?,?,?) ON CONFLICT(key,part) DO UPDATE SET value=excluded.value WHERE records.value<>excluded.value",
        key,
        part++,
        s.slice(offset, end),
      );
      offset = end;
    }
    this.query("DELETE FROM records WHERE key=? AND part>=?",key,part);
  }

  enableJournalIdleInvalidation(): void {
    // Persist in SQLite, so even previous binaries or direct SQL writes invalidate the hint.
    for (const [event, row] of [["INSERT", "NEW"], ["DELETE", "OLD"], ["UPDATE", "NEW"]] as const) {
      this.query(`CREATE TRIGGER IF NOT EXISTS journal_idle_${event.toLowerCase()} AFTER ${event} ON records
        WHEN ${row}.key LIKE 'operation/%'${event === "UPDATE" ? " OR OLD.key LIKE 'operation/%'" : ""}
        BEGIN DELETE FROM records WHERE key='workspace-journal-idle/v1'; END`);
    }
  }
  delete(key: string): void {
    this.query("DELETE FROM records WHERE key=?", key);
  }
  keys(prefix: string): string[] {
    return this.query<{ key: string }>(
      "SELECT DISTINCT key FROM records WHERE key>=? AND key<? ORDER BY key",
      prefix, prefix + "\uffff").map(r => r.key);
  }
  transaction<T>(fn: () => T): T {
    if (this.depth) return fn();
    return this.storage.transactionSync(() => {
      this.depth++;
      this.transactionReads = new Map();
      this.transactionReadChars = 0;
      try { return fn(); }
      finally { this.transactionReads = undefined; this.transactionReadChars = 0; this.depth--; }
    });
  }
}
