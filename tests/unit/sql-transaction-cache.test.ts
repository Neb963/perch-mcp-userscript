import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SqlRecords } from '../../apps/gateway/src/sql.js';

/** A real SQLite engine verifies aliasing/rollback/SQL invalidation. The
 * adapter implements the small Cloudflare storage surface used by SqlRecords;
 * Cloudflare row billing is separately measured by the pinned workerd suite. */
function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  let selects = 0;
  const storage = {
    sql: {
      exec<T>(sql: string, ...args: unknown[]) {
        const statement = sqlite.prepare(sql);
        if (/^\s*(?:SELECT|EXPLAIN)\b/i.test(sql)) {
          if (/\bFROM records\b/.test(sql)) selects++;
          const rows = statement.all(...args as (string | number | null)[]) as T[];
          return { toArray: () => rows, rowsRead: rows.length, rowsWritten: 0 };
        }
        const result = statement.run(...args as (string | number | null)[]);
        return { toArray: () => [] as T[], rowsRead: 0, rowsWritten: Number(result.changes) };
      },
    },
    transactionSync<T>(fn: () => T): T {
      sqlite.exec('BEGIN');
      try { const value = fn(); sqlite.exec('COMMIT'); return value; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  return { db: new SqlRecords(storage as never), sqlite, selects: () => selects };
}

test('transaction-scoped canonical reads do not leak object mutations or cross transactions', () => {
  const { db, sqlite, selects } = fixture();
  try {
    db.put('workspace/a', { revision: 1, nested: { paused: false } });
    const baseline = selects();
    db.transaction(() => {
      const first = db.get<{ revision: number; nested: { paused: boolean } }>('workspace/a');
      first.revision = 77; first.nested.paused = true;
      assert.deepEqual(db.get('workspace/a'), { revision: 1, nested: { paused: false } });
      db.transaction(() => assert.deepEqual(db.get('workspace/a'), { revision: 1, nested: { paused: false } }));
      assert.equal(selects() - baseline, 1, 'same-transaction reads share one canonical SQL snapshot');
    });
    assert.deepEqual(db.get('workspace/a'), { revision: 1, nested: { paused: false } });
    assert.equal(selects() - baseline, 2, 'new transaction or standalone read rechecks SQLite');
  } finally { sqlite.close(); }
});

test('all SQL writes invalidate both positive and negative transaction entries', () => {
  const { db, sqlite } = fixture();
  try {
    db.put('core', { revision: 1 });
    db.transaction(() => {
      assert.deepEqual(db.get('core'), { revision: 1 });
      assert.equal(db.get('absent'), undefined);
      // A direct SQL statement, including DDL, bypasses put() but not query().
      db.query("UPDATE records SET value=? WHERE key=? AND part=0", '{"revision":2}', 'core');
      assert.deepEqual(db.get('core'), { revision: 2 });
      db.query('INSERT INTO records(key,part,value) VALUES(?,?,?)', 'absent', 0, '{"created":true}');
      assert.deepEqual(db.get('absent'), { created: true });
      db.put('core', { revision: 3 });
      assert.deepEqual(db.get('core'), { revision: 3 });
      db.delete('core');
      assert.equal(db.get('core'), undefined);
    });
  } finally { sqlite.close(); }
});

test('failed or rolled-back transactions never publish speculative cached authority', () => {
  const { db, sqlite } = fixture();
  try {
    db.put('grant/g', { active: true });
    assert.throws(() => db.transaction(() => {
      assert.deepEqual(db.get('grant/g'), { active: true });
      db.put('grant/g', { active: false });
      assert.deepEqual(db.get('grant/g'), { active: false });
      throw new Error('ROLLBACK');
    }), /ROLLBACK/);
    assert.deepEqual(db.get('grant/g'), { active: true });
    assert.throws(() => db.transaction(() => {
      assert.deepEqual(db.get('grant/g'), { active: true });
      db.query('INSERT INTO no_such_table VALUES(1)');
    }));
    assert.deepEqual(db.get('grant/g'), { active: true });
  } finally { sqlite.close(); }
});

test('corrupt parts remain fail closed and do not poison a later transaction', () => {
  const { db, sqlite } = fixture();
  try {
    db.put('grant/g', { active: true });
    db.query('INSERT INTO records(key,part,value) VALUES(?,?,?)', 'grant/g', 2, 'null');
    assert.throws(() => db.transaction(() => db.get('grant/g')), /SQLITE_RECORD_CORRUPT/);
    db.query('DELETE FROM records WHERE key=? AND part=2', 'grant/g');
    assert.deepEqual(db.transaction(() => db.get('grant/g')), { active: true });
  } finally { sqlite.close(); }
});

test('bounded caching bypasses large payloads and excess entries without affecting reads', () => {
  const { db, sqlite, selects } = fixture();
  try {
    const large = { body: 'x'.repeat(20_000) };
    db.put('library', large);
    db.transaction(() => {
      const start = selects();
      assert.deepEqual(db.get('library'), large);
      assert.deepEqual(db.get('library'), large);
      assert.equal(selects() - start, 2, 'large records are never cached');
      for (let i = 0; i < 33; i++) assert.equal(db.get('missing/'+i), undefined);
      const afterMiss = selects();
      assert.equal(db.get('missing/0'), undefined);
      assert.equal(selects(), afterMiss, 'first 32 misses remain cached');
      assert.equal(db.get('missing/32'), undefined);
      assert.equal(selects(), afterMiss + 1, '33rd entry is not cached');
    });
  } finally { sqlite.close(); }
});
