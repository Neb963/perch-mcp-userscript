import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SqlRecords } from "../../apps/gateway/src/sql.js";
import { Registry } from "../../apps/gateway/src/registry.js";
import { Workspace } from "../../apps/gateway/src/workspace.js";
import type {
  DurableObjectStorage,
  DurableObjectState,
} from "@cloudflare/workers-types";
import type { Env } from "../../apps/gateway/src/common.js";
function fixture() {
  const db = new DatabaseSync(":memory:");
  const storage = {
    sql: {
      exec(sql: string, ...args: (string | number)[]) {
        const statement = db.prepare(sql);
        const rows = sql.trim().startsWith("SELECT")
          ? statement.all(...args)
          : (statement.run(...args), []);
        return { toArray: () => rows };
      },
    },
    transactionSync<T>(fn: () => T) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as DurableObjectStorage;
  return { db, storage, state: { storage } as DurableObjectState };
}
test("SQLite chunks preserve Unicode at boundaries and rollback atomically", () => {
  const f = fixture();
  try {
    const records = new SqlRecords(f.storage);
    const value = {
      body: "a".repeat(31990) + "😀".repeat(40000),
      empty: "",
      bytes: [0, 255, 1, 128, 10],
    };
    records.transaction(() => records.put("resource", value));
    assert.deepEqual(records.get("resource"), value);
    assert.throws(() =>
      records.transaction(() => {
        records.put("resource", { body: "changed" });
        records.put("other", true);
        throw new Error("fixture rollback");
      }),
    );
    assert.deepEqual(records.get("resource"), value);
    assert.deepEqual(records.keys("other"), []);
  } finally {
    f.db.close();
  }
});
test("newer Registry/Workspace schemas reject downgrade without rewriting data", async () => {
  const f = fixture();
  try {
    const records = new SqlRecords(f.storage);
    records.put("core", { schemaVersion: 2, revision: 1 });
    const registry = new Registry(f.state, {} as Env);
    const response = await registry.fetch(
      new Request("https://internal/internal/health"),
    );
    assert.equal(response.status, 409);
    assert.equal(
      (records.get("core") as { schemaVersion: number }).schemaVersion,
      2,
    );
    records.put("schema", 2);
    assert.throws(() => new Workspace(f.state, {} as Env), /schema is newer/);
    assert.equal(records.get("schema"), 2);
  } finally {
    f.db.close();
  }
});
