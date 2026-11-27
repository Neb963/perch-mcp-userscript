import type { DurableObjectStorage } from "@cloudflare/workers-types";
/** SQLite-backed chunked records; every mutation runs within transactionSync. */
export class SqlRecords {
  constructor(private storage: DurableObjectStorage) {
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS records (key TEXT NOT NULL, part INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(key, part))",
    );
  }
  get<T>(key: string, fallback?: T): T {
    const rows = this.storage.sql
      .exec<{
        value: string;
      }>("SELECT value FROM records WHERE key=? ORDER BY part", key)
      .toArray();
    if (!rows.length) return fallback as T;
    try {
      return JSON.parse(rows.map((r) => r.value).join("")) as T;
    } catch {
      // Never silently default corrupted identity, Grant, or operation state.
      // The gateway incident log records the classification; no record data escapes.
      throw new Error('SQLITE_RECORD_CORRUPT');
    }
  }
  put(key: string, value: unknown): void {
    const s = JSON.stringify(value);
    this.storage.sql.exec("DELETE FROM records WHERE key=?", key);
    let offset = 0,
      part = 0;
    while (offset < s.length) {
      let end = Math.min(s.length, offset + 32000);
      // SQLite UTF-8 serialization must never split a UTF-16 surrogate pair.
      const last = s.charCodeAt(end - 1);
      if (end < s.length && last >= 0xd800 && last <= 0xdbff) end--;
      this.storage.sql.exec(
        "INSERT INTO records(key,part,value) VALUES(?,?,?)",
        key,
        part++,
        s.slice(offset, end),
      );
      offset = end;
    }
  }

  delete(key: string): void {
    this.storage.sql.exec("DELETE FROM records WHERE key=?", key);
  }
  keys(prefix: string): string[] {
    return this.storage.sql
      .exec<{ key: string }>(
        "SELECT DISTINCT key FROM records WHERE key>=? AND key<? ORDER BY key",
        prefix,
        prefix + "\uffff",
      )
      .toArray()
      .map((r) => r.key);
  }
  transaction<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }
}
