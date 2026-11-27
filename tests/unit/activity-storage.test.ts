import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { DurableObjectStorage, DurableObjectState } from "@cloudflare/workers-types";
import { CanonicalActivity, type ActivityStorageMode, type ActivityEvent } from "../../apps/gateway/src/activity-storage.js";
import { RegistryIndex } from "../../apps/gateway/src/registry-index.js";
import { Registry } from "../../apps/gateway/src/registry.js";
import { digest, type Env } from "../../apps/gateway/src/common.js";
import { SqlRecords } from "../../apps/gateway/src/sql.js";

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  const sql: string[] = [];
  const counts = { activityWholeReads: 0 };
  let fault: ((query: string) => boolean) | undefined;
  const storage = {
    sql: { exec(query: string, ...args: (string | number | null)[]) {
      if (fault?.(query)) throw new Error("synthetic SQL write unavailable");
      sql.push(query);
      if (query === "SELECT value FROM records WHERE key=? ORDER BY part" && args[0] === "activity") counts.activityWholeReads++;
      const statement = sqlite.prepare(query);
      const rows = /^(SELECT|EXPLAIN)/.test(query) ? statement.all(...args) : (statement.run(...args), []);
      return { toArray: () => rows, rowsRead: rows.length, rowsWritten: 0 };
    } },
    transactionSync<T>(fn: () => T) {
      sqlite.exec("BEGIN IMMEDIATE");
      try { const value = fn(); sqlite.exec("COMMIT"); return value; }
      catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  } as unknown as DurableObjectStorage;
  return { sqlite, sql, counts, db: new SqlRecords(storage), storage,
    fail: (predicate?: (query: string) => boolean) => { fault = predicate; },
    close: () => sqlite.close() };
}
const event = (n: number, extra: ActivityEvent = {}): ActivityEvent => ({
  workspaceId: n % 2 ? "workspace-a" : "workspace-b", operationId: "operation-" + String(n).padStart(6, "0"),
  phase: "SUCCEEDED", tool: "read", timestamp: n, durationMs: 1,
  epoch: 1, bindingRevision: 1, traceId: "fixture", ...extra,
});
function complete(store: CanonicalActivity, mode: ActivityStorageMode = "native", limit = 32) {
  let steps = 0;
  while (!((mode === "prepare" && store.status().stage === "VERIFIED") || store.status().stage === "NATIVE")) {
    store.advance(mode, limit);
    assert.ok(++steps < 10000, "bounded migration must converge");
  }
  return steps;
}
function all(store: CanonicalActivity, revision = 1, status: string | null = null, workspace: string | null = null) {
  const events: ActivityEvent[] = [];
  let cursor: string | null = null;
  do {
    const page = store.page(cursor, status, workspace, revision);
    events.push(...page.items); cursor = page.cursor;
  } while (cursor);
  return events;
}

test("default Registry legacy mode creates no new canonical Activity tables", () => {
  const f = fixture();
  try {
    const index = new RegistryIndex(f.db);
    assert.equal(index.activityMigrationStatus().stage, "LEGACY");
    assert.equal(f.db.query("SELECT name FROM sqlite_master WHERE name='canonical_activity_meta_v2'").length, 0);
    index.appendActivity(event(1));
    assert.deepEqual(f.db.get("activity"), [event(1)]);
  } finally { f.close(); }
});

test("canonical Activity streams Unicode and nested legacy chunks, verifies, and requires explicit cutover", () => {
  const f = fixture();
  try {
    const legacy = Array.from({ length: 151 }, (_, n) => event(n, n === 100 ? {
      optional: null, nested: { text: "😀\\\"{[,] }".repeat(8000), empty: "", values: [null, false] },
    } : {}));
    f.db.put("activity", legacy);
    let store = new CanonicalActivity(f.db);
    store.advance("prepare", 4);
    assert.equal(store.status().authority, "legacy");
    // Recreate the storage wrapper and store between every bounded step.
    for (let n = 0; store.status().stage !== "VERIFIED"; n++) {
      assert.ok(n < 1000);
      store = new CanonicalActivity(new SqlRecords(f.storage));
      store.advance("prepare", 4);
    }
    assert.deepEqual(f.db.get("activity"), legacy);
    store.advance("prepare");
    assert.equal(store.status().stage, "VERIFIED");
    store.advance("native");
    assert.deepEqual(all(store), [...legacy].reverse());
    const native = event(999);
    store.append(native);
    assert.deepEqual(all(store)[0], native);
    assert.deepEqual(f.db.get("activity"), legacy, "retained legacy snapshot is untouched after cutover");
    const rollbackBinary = new RegistryIndex(new SqlRecords(f.storage), { activityStorageMode: "legacy" });
    assert.equal(rollbackBinary.activityMigrationStatus().authority, "native");
    assert.deepEqual(rollbackBinary.activityPage(null, null, null, 1).items[0], native);
    assert.throws(() => f.db.put("activity", []), /ACTIVITY_NATIVE_REQUIRES_COMPATIBLE_BINARY/);
    assert.throws(() => store.restart(), /compatible rollback binary/);
  } finally { f.close(); }
});

test("oversized 10k legacy visibility converges to 1000 while uncertain receipts survive indefinitely", () => {
  const f = fixture();
  try {
    const legacy = Array.from({ length: 10000 }, (_, n) => event(n));
    const held = event(0, { phase: "UNKNOWN", tool: "write" });
    const resolved = event(2, { phase: "PARTIAL", resolution: { timestamp: 20000, observedRevision: "fixture" } });
    f.db.put("activity", legacy);
    f.db.put("terminal-notice/" + held.workspaceId + "/" + held.operationId, { phase: held.phase, event: held, expires: 0 });
    f.db.put("terminal-notice/" + resolved.workspaceId + "/" + resolved.operationId, { phase: resolved.phase, event: resolved, expires: 0 });
    const store = new CanonicalActivity(f.db);
    const steps = complete(store);
    assert.ok(steps > 600, "10k inputs require multiple bounded passes");
    const result = all(store);
    assert.equal(result.length, 1002);
    assert.deepEqual(result[0], held);
    assert.deepEqual(result[1], resolved);
    assert.deepEqual(result.slice(2), legacy.slice(-1000).reverse());
    assert.equal(f.db.query("SELECT key FROM canonical_activity_v2 WHERE base IS NOT NULL").length, 1000);
    // The physical source was consumed one bounded chunk at a time.
    assert.equal(f.counts.activityWholeReads, 0);
    assert.equal(f.db.get<unknown[]>("activity").length, 10000, "migration does not erase legacy source");
  } finally { f.close(); }
});

test("native Activity append has constant statement count around capacity and evicts only visibility", () => {
  const f = fixture();
  try {
    const store = new CanonicalActivity(f.db);
    complete(store);
    const statements: Record<number, number> = {};
    for (let n = 0; n <= 1001; n++) {
      const before = f.sql.length;
      store.append(event(n));
      if ([0, 150, 999, 1000, 1001].includes(n)) statements[n] = f.sql.length - before;
    }
    assert.equal(statements[0], statements[150]);
    assert.equal(statements[150], statements[999]);
    assert.equal(statements[1000], statements[1001]);
    assert.ok(statements[1000]! <= statements[0]! + 2, "capacity adds one exact oldest lookup/delete");
    assert.equal(all(store).length, 1000);
    const snapshot = store.status();
    store.append(event(1001));
    assert.deepEqual(store.status(), snapshot, "exact duplicate cannot append or bump Activity revision");
    assert.throws(() => store.append(event(1001, { phase: "UNKNOWN" })), /original outcome/);
  } finally { f.close(); }
});

test("native keyset cursors bind revision and filters and use indexed tuple seeks", () => {
  const f = fixture();
  try {
    const store = new CanonicalActivity(f.db); complete(store);
    for (let n = 0; n < 450; n++) store.append(event(n));
    const first = store.page(null, null, null, 9);
    assert.ok(first.cursor?.startsWith("a2."));
    assert.equal(all(store, 9).length, 450);
    assert.equal(new Set(all(store, 9).map(item => item.operationId)).size, 450);
    assert.equal(all(store, 9, "SUCCEEDED", "workspace-a").length, 225);
    for (const run of [
      () => store.page("9:100", null, null, 9),
      () => store.page(first.cursor, "SUCCEEDED", null, 9),
      () => store.page(first.cursor, null, "workspace-a", 9),
      () => store.page(first.cursor, null, null, 10),
    ]) assert.throws(run, error => (error as { code?: string }).code === "STALE_REVISION");
    store.append(event(451));
    assert.throws(() => store.page(first.cursor, null, null, 9), error => (error as { code?: string }).code === "STALE_REVISION");
    for (const [filter, args] of [["", []], ["workspace=? AND ", ["workspace-a"]], ["phase=? AND ", ["SUCCEEDED"]], ["workspace=? AND phase=? AND ", ["workspace-a", "SUCCEEDED"]]] as const) {
      const plan = f.db.query<{ detail: string }>("EXPLAIN QUERY PLAN SELECT base,notice FROM canonical_activity_v2 WHERE " + filter + "(rank,sort_time,key)>(?,?,?) ORDER BY rank,sort_time,key LIMIT 101", ...args, 1, -200, "workspace-a/operation-000200");
      assert.ok(plan.some(row => row.detail.includes("SEARCH canonical_activity_v2 USING INDEX") && row.detail.includes("(rank,sort_time,key)>(?,?,?)")), JSON.stringify(plan));
    }
  } finally { f.close(); }
});

test("legacy raw writes, updates and deletes invalidate interrupted backfill before cutover", () => {
  const f = fixture();
  try {
    f.db.put("activity", Array.from({ length: 150 }, (_, n) => event(n)));
    const store = new CanonicalActivity(f.db);
    store.advance("prepare", 8); store.advance("prepare", 8);
    f.db.put("activity", [event(501)]);
    complete(store, "prepare", 8);
    // A late old-binary mutation after VERIFY must also invalidate verification.
    f.db.delete("activity");
    store.advance("native", 8);
    assert.notEqual(store.status().stage, "NATIVE");
    complete(store, "native", 8);
    assert.deepEqual(all(store), []);
  } finally { f.close(); }
});

test("migration write failure rolls back its cursor and retries without duplicate entries", () => {
  const f = fixture();
  try {
    const source = Array.from({ length: 100 }, (_, n) => event(n));
    f.db.put("activity", source);
    const store = new CanonicalActivity(f.db);
    store.advance("prepare", 4);
    const before = store.status();
    f.fail(query => query.startsWith("UPDATE canonical_activity_meta_v2"));
    assert.throws(() => store.advance("prepare", 4), /synthetic SQL write unavailable/);
    f.fail();
    assert.deepEqual(store.status(), before);
    assert.equal(f.db.query("SELECT key FROM canonical_activity_v2").length, 0);
    complete(store, "native", 4);
    assert.deepEqual(all(store), [...source].reverse());
  } finally { f.close(); }
});

test("corrupt legacy arrays fail closed and permit explicit repair before native authority", () => {
  for (const body of ['[{"workspaceId":"w","operationId":"op","phase":"SUCCEEDED"},]', '{"not":"array"}', '[{"workspaceId":"w","operationId":"op","phase":"SUCCEEDED"}]\u00a0']) {
    const f = fixture();
    try {
      f.db.query("INSERT INTO records VALUES('activity',0,?)", body);
      const store = new CanonicalActivity(f.db);
      assert.throws(() => complete(store), /SQLITE_RECORD_CORRUPT/);
      assert.equal(store.status().stage, "BLOCKED");
      assert.equal(store.status().authority, "legacy");
      assert.equal(f.db.query<{ value: string }>("SELECT value FROM records WHERE key='activity'")[0]?.value, body);
      f.db.put("activity", [event(1)]);
      store.restart(); complete(store);
      assert.deepEqual(all(store), [event(1)]);
    } finally { f.close(); }
  }
});

test("unresolved overlay, resolution ordering and receipt expiry remain independent of visibility", () => {
  const f = fixture();
  try {
    const store = new CanonicalActivity(f.db); complete(store);
    const held = event(1, { phase: "UNKNOWN", tool: "write" });
    store.append(held); store.setNotice("workspace-a/operation-000001", held);
    for (let n = 2; n < 1003; n++) store.append(event(n));
    assert.deepEqual(all(store)[0], held);
    const resolution = { timestamp: 10000, observedRevision: "inspected", optional: null };
    store.resolve("workspace-a", "operation-000001", resolution);
    assert.deepEqual(all(store)[0], { ...held, resolution });
    store.setNotice("workspace-a/operation-000001", null);
    assert.equal(all(store).length, 1000);
    assert.ok(!all(store).some(row => row.operationId === held.operationId));
  } finally { f.close(); }
});

test("native cutover and the old-binary core fence commit atomically and preserve revisions", () => {
  const f = fixture();
  try {
    const core = { schemaVersion: 1, revision: 17, policyRevision: 9, issuer: null, extra: { preserved: null } };
    f.db.put("core", core);
    const store = new CanonicalActivity(f.db); complete(store, "prepare");
    f.fail(query => query.startsWith("DROP TRIGGER canonical_activity_source_"));
    assert.throws(() => store.advance("native"), /synthetic SQL write unavailable/);
    f.fail();
    assert.equal(store.status().stage, "VERIFIED");
    assert.deepEqual(f.db.get("core"), core, "failed cutover must roll back the downgrade fence too");
    store.advance("native");
    assert.deepEqual(f.db.get("core"), { ...core, schemaVersion: 2 });
  } finally { f.close(); }
});

test("actual Registry terminal, migration, old-client paging and exact receipt dedup use native Activity", async () => {
  const f = fixture();
  try {
    const credential = "synthetic-activity-admin".padEnd(64, "x");
    f.db.put("core", { schemaVersion: 1, revision: 1, policyRevision: 1, paused: false,
      issuer: "https://activity.test", paired: true, adminHash: await digest(credential), credentialEpoch: 1 });
    f.db.put("workspace/workspace", { id: "workspace", label: "Synthetic", revision: 1,
      bindingRevision: 1, permissions: ["READ_SOURCE"], paused: false, binding: null, epoch: 1 });
    const registry = new Registry({ storage: f.storage } as DurableObjectState,
      { CANONICAL_STORAGE_MODE: "native" } as Env);
    const call = async (path: string, body?: unknown) => {
      const response = await registry.fetch(new Request("https://internal" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + credential,
          "Idempotency-Key": crypto.randomUUID() },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }));
      assert.equal(response.status, 200, await response.clone().text());
      return response.json() as Promise<Record<string, unknown>>;
    };
    const terminal = (n: number) => call("/internal/terminal", { workspaceId: "workspace",
      operationId: "operation-" + n, status: "SUCCEEDED", tool: "read", epoch: 1,
      bindingRevision: 1, traceId: "fixture", timestamp: n, durationMs: 1 });
    await terminal(1);
    for (let n = 0; ; n++) {
      assert.ok(n < 100);
      const status = await call("/api/v1/admin/storage");
      if ((status.activity as { stage: string }).stage === "NATIVE") break;
      await call("/api/v1/admin/storage/step", { expectedRevision: status.revision });
    }
    assert.equal(f.db.get<{ schemaVersion: number }>("core").schemaVersion, 2);
    await terminal(2);
    const page = await call("/api/v1/admin/activity");
    assert.deepEqual((page.items as ActivityEvent[]).map(item => item.operationId), ["operation-2", "operation-1"]);
    const revision = page.revision;
    await terminal(2);
    assert.equal((await call("/api/v1/admin/activity")).revision, revision);
    assert.equal(f.db.get<unknown[]>("activity").length, 1, "native terminal never rewrites retained legacy array");
  } finally { f.close(); }
});
