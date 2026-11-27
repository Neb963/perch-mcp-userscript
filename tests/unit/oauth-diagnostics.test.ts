import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { SqlRecords } from "../../apps/gateway/src/sql.js";
import { appendOAuthDiagnostic, readOAuthDiagnostics } from "../../apps/gateway/src/oauth-diagnostics.js";

const DAY = 86400000, NOW = 42 * DAY + 3600000;
function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  let writes = 0, fault: ((sql: string) => boolean) | undefined;
  const storage = {
    sql: { exec(sql: string, ...args: (string | number | null)[]) {
      if (fault?.(sql)) throw new Error("synthetic storage outage with private fixture text");
      const statement = sqlite.prepare(sql);
      if (/^(SELECT|EXPLAIN)/.test(sql)) {
        const rows = statement.all(...args);
        return { toArray: () => rows, rowsRead: rows.length, rowsWritten: 0 };
      }
      writes++;
      statement.run(...args);
      return { toArray: () => [], rowsRead: 0, rowsWritten: 0 };
    } },
    transactionSync<T>(fn: () => T) {
      sqlite.exec("BEGIN IMMEDIATE");
      try { const value = fn(); sqlite.exec("COMMIT"); return value; }
      catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  } as unknown as DurableObjectStorage;
  return { db: new SqlRecords(storage), storage, sqlite,
    writeCount: () => writes, fail: (value?: (sql: string) => boolean) => { fault = value; },
    close: () => sqlite.close() };
}
function event(n: number) {
  return { route: "authorize_complete", method: "POST", originClass: "null", status: 302,
    code: "CALLBACK_REDIRECT_ISSUED", traceId: n.toString(16).padStart(8, "0") + "-0000-4000-8000-000000000000" };
}
const budget = (db: SqlRecords) => ({ ...db.query<{ day: number; count: number; next_seq: number; row_count: number }>(
  "SELECT day,count,next_seq,row_count FROM oauth_diagnostic_budget_v1 WHERE id=1")[0]! });

test("OAuth diagnostics enforce exact durable 256/day across restart and keep only 100 canonical rows", () => {
  const f = fixture();
  try {
    let db = f.db;
    for (let n = 0; n < 256; n++) {
      if (n % 17 === 0) db = new SqlRecords(f.storage);
      assert.equal(appendOAuthDiagnostic(db, event(n), NOW + n), true);
    }
    assert.deepEqual(budget(db), { day: 42, count: 256, next_seq: 256, row_count: 100 });
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS count FROM oauth_diagnostic_event_v1").get()!.count, 100);
    const before = f.writeCount();
    for (let n = 256; n < 1256; n++) assert.equal(appendOAuthDiagnostic(new SqlRecords(f.storage), event(n), NOW + n), false);
    // New SqlRecords constructors use CREATE IF NOT EXISTS; compare only append
    // calls below to establish the no-write saturation behavior itself.
    const saturated = f.writeCount();
    for (let n = 1256; n < 1356; n++) assert.equal(appendOAuthDiagnostic(db, event(n), NOW + n), false);
    assert.equal(f.writeCount(), saturated);
    assert.ok(saturated >= before);
    const visible = readOAuthDiagnostics(db, NOW + 2000);
    assert.equal(visible.length, 100);
    assert.equal(visible[0]!.traceId, event(156).traceId);
    assert.equal(visible.at(-1)!.traceId, event(255).traceId);
  } finally { f.close(); }
});

test("diagnostic GET never initializes, prunes, rolls over, or writes a counter", () => {
  const f = fixture();
  try {
    let before = f.writeCount();
    assert.deepEqual(readOAuthDiagnostics(f.db, NOW), []);
    assert.equal(f.writeCount(), before);
    assert.equal(f.db.query("SELECT name FROM sqlite_master WHERE name='oauth_diagnostic_budget_v1'").length, 0);
    assert.equal(appendOAuthDiagnostic(f.db, event(1), NOW), true);
    const snapshot = budget(f.db);
    before = f.writeCount();
    assert.equal(readOAuthDiagnostics(f.db, NOW + 8 * DAY).length, 0);
    assert.deepEqual(budget(f.db), snapshot);
    assert.equal(f.writeCount(), before);
  } finally { f.close(); }
});

test("UTC midnight refills only a forward day and rollback never refills consumed allowance", () => {
  const f = fixture();
  try {
    for (let n = 0; n < 256; n++) assert.equal(appendOAuthDiagnostic(f.db, event(n), 43 * DAY - 1), true);
    assert.equal(appendOAuthDiagnostic(f.db, event(256), 43 * DAY), true);
    assert.deepEqual(budget(f.db), { day: 43, count: 1, next_seq: 257, row_count: 100 });
    let before = f.writeCount();
    assert.equal(appendOAuthDiagnostic(f.db, event(257), 42 * DAY + 1000), false);
    assert.equal(f.writeCount(), before);
    assert.equal(appendOAuthDiagnostic(f.db, event(258), 43 * DAY + 3000), true);
    assert.equal(appendOAuthDiagnostic(f.db, event(259), 43 * DAY + 2000), true);
    assert.equal(budget(f.db).count, 3, "same-day backwards time does not reset accounting");
    before = f.writeCount();
    assert.equal(appendOAuthDiagnostic(f.db, event(259), 43 * DAY + 2001), false);
    assert.equal(f.writeCount(), before, "same trace does not spend allowance or rewrite rows");
    assert.equal(budget(f.db).count, 3);
  } finally { f.close(); }
});

test("legacy minute accounting conservatively suppresses the unknown current day and preserves history", () => {
  const f = fixture();
  try {
    const historical = { at: NOW - 100, ...event(1), providerToken: "private-legacy-token", rawUrl: "https://example.invalid/?secret=private" };
    f.db.put("diagnostic-budget", { minute: Math.floor(NOW / 60000), count: 2 });
    f.db.put("diagnostic-events", [historical]);
    assert.equal(appendOAuthDiagnostic(f.db, event(2), NOW), false);
    assert.equal(budget(f.db).count, 256);
    assert.deepEqual(readOAuthDiagnostics(f.db, NOW), [{ at: historical.at, ...event(1) }]);
    assert.deepEqual(f.db.get("diagnostic-events"), [historical], "legacy history remains unchanged");
    assert.equal(appendOAuthDiagnostic(new SqlRecords(f.storage), event(3), 43 * DAY), true);
    assert.equal(budget(f.db).count, 1);
    assert.equal(readOAuthDiagnostics(f.db, 43 * DAY).length, 2);
  } finally { f.close(); }
});

test("prior-day legacy budgets allow the new day while future and missing accounting stay conservative", () => {
  for (const [old, allowed] of [
    [{ minute: Math.floor((NOW - DAY) / 60000), count: 120 }, true],
    [{ minute: Math.floor((NOW + DAY) / 60000), count: 1 }, false],
    [{ minute: "malformed", count: 0 }, false],
  ] as const) {
    const f = fixture();
    try {
      f.db.put("diagnostic-budget", old);
      assert.equal(appendOAuthDiagnostic(f.db, event(1), NOW), allowed);
    } finally { f.close(); }
  }
  const f = fixture();
  try {
    f.db.put("diagnostic-events", [{ at: NOW - 1, ...event(1) }]);
    assert.equal(appendOAuthDiagnostic(f.db, event(2), NOW), false);
    assert.equal(budget(f.db).count, 256);
  } finally { f.close(); }
});

test("append failure rolls back both rows and budget and never throws into OAuth", () => {
  const f = fixture();
  try {
    assert.equal(appendOAuthDiagnostic(f.db, event(0), NOW), true);
    const snapshot = budget(f.db);
    f.fail(sql => sql.startsWith("UPDATE oauth_diagnostic_budget_v1"));
    assert.doesNotThrow(() => assert.equal(appendOAuthDiagnostic(f.db, event(1), NOW + 1), false));
    f.fail();
    assert.deepEqual(budget(f.db), snapshot);
    assert.equal(readOAuthDiagnostics(f.db, NOW + 2).length, 1);
    assert.equal(appendOAuthDiagnostic(f.db, event(1), NOW + 3), true);
    assert.equal(budget(f.db).count, 2);
    f.fail(() => true);
    assert.doesNotThrow(() => assert.equal(appendOAuthDiagnostic(f.db, event(2), NOW + 4), false));
  } finally { f.fail(); f.close(); }
});

test("diagnostic append cannot partially mutate an enclosing authorization transaction", () => {
  const f = fixture();
  try {
    f.db.transaction(() => {
      f.db.put("grant/fixture", { state: "active" });
      assert.equal(appendOAuthDiagnostic(f.db, event(1), NOW), false);
    });
    assert.deepEqual(f.db.get("grant/fixture"), { state: "active" });
    assert.equal(f.db.query("SELECT name FROM sqlite_master WHERE name='oauth_diagnostic_budget_v1'").length, 0);
  } finally { f.close(); }
});

test("fixed-field projection rejects credentials, source, arbitrary codes and hostile values", () => {
  const f = fixture();
  try {
    const secret = "private-auth-token-and-generator-source";
    for (const invalid of [
      { ...event(1), token: secret }, { ...event(1), code: secret },
      { ...event(1), route: "/authorize?token=" + secret }, { ...event(1), originClass: secret },
      { ...event(1), traceId: secret }, { ...event(1), status: 199 },
      { ...event(1), method: { toString: "POST" } }, { ...event(1), at: NOW },
    ]) assert.equal(appendOAuthDiagnostic(f.db, invalid, NOW), false);
    assert.equal(f.db.query("SELECT name FROM sqlite_master WHERE name='oauth_diagnostic_budget_v1'").length, 0);
    const hostile = new Proxy({}, { ownKeys() { throw new Error(secret); } });
    assert.doesNotThrow(() => assert.equal(appendOAuthDiagnostic(f.db, hostile, NOW), false));
    f.db.put("diagnostic-events", [{ at: NOW - 1, ...event(3), code: secret, raw: secret }]);
    const safe = readOAuthDiagnostics(f.db, NOW);
    assert.equal(safe[0]!.code, "UNCLASSIFIED");
    assert.ok(!JSON.stringify(safe).includes(secret));
  } finally { f.close(); }
});

test("seven-day visibility is exact and merged canonical/legacy traces are deduplicated", () => {
  const f = fixture();
  try {
    assert.equal(appendOAuthDiagnostic(f.db, event(1), NOW), true);
    assert.equal(readOAuthDiagnostics(f.db, NOW + 7 * DAY - 1).length, 1);
    assert.equal(readOAuthDiagnostics(f.db, NOW + 7 * DAY).length, 0);
    f.db.put("diagnostic-events", [{ at: NOW - 1, ...event(1) }, { at: NOW - 2, ...event(2) }]);
    const rows = readOAuthDiagnostics(f.db, NOW);
    assert.deepEqual(rows.map(row => row.traceId), [event(2).traceId, event(1).traceId]);
    assert.equal(rows[1]!.at, NOW, "canonical trace wins over its retained legacy copy");
  } finally { f.close(); }
});

test("unknown or corrupt durable counters never grant a fresh diagnostic allowance", () => {
  const f = fixture();
  try {
    appendOAuthDiagnostic(f.db, event(1), NOW);
    f.db.query("UPDATE oauth_diagnostic_budget_v1 SET version=99");
    const before = f.writeCount();
    assert.equal(appendOAuthDiagnostic(f.db, event(2), NOW), false);
    assert.equal(f.writeCount(), before);
    assert.throws(() => readOAuthDiagnostics(f.db, NOW), /OAUTH_DIAGNOSTIC_STORAGE_UNAVAILABLE/);
  } finally { f.close(); }
});
