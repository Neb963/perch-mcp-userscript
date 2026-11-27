import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { DurableObjectState, DurableObjectStorage } from '@cloudflare/workers-types';
import { SqlRecords } from '../../apps/gateway/src/sql.js';
import { Workspace } from '../../apps/gateway/src/workspace.js';
import { digest, type Env } from '../../apps/gateway/src/common.js';

function fixture(onRpc: (path: string) => Promise<Response> = async () => Response.json({ ok: true })) {
  const sqlite = new DatabaseSync(':memory:');
  let alarm: number | null = null;
  const queries: string[] = [];
  const storage = {
    sql: { exec(sql: string, ...args: (string | number | null)[]) {
      queries.push(sql);
      const q = sqlite.prepare(sql);
      const result = /^\s*(?:SELECT|EXPLAIN)/i.test(sql) ? q.all(...args) : (q.run(...args), []);
      return { toArray: () => result, rowsRead: result.length, rowsWritten: 0 };
    } },
    transactionSync<T>(fn: () => T) {
      sqlite.exec('BEGIN');
      try { const value = fn(); sqlite.exec('COMMIT'); return value; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
    getAlarm: async () => alarm,
    setAlarm: async (value: number) => { alarm = value; },
    deleteAlarm: async () => { alarm = null; },
  } as unknown as DurableObjectStorage;
  const state = { storage } as DurableObjectState;
  const env = { REGISTRY: { idFromName: () => 'installation', get: () => ({ fetch: (request: Request) => onRpc(new URL(request.url).pathname) }) } } as unknown as Env;
  const records = new SqlRecords(storage);
  return { records, queries, env, state, close: () => sqlite.close() };
}
function operation(operationId: string, phase = 'ADMITTED', deadline = Date.now() + 30000) {
  return { operationId, sequence: 1, argsDigest: 'a'.repeat(64), workspaceId: 'workspace-fixture', epoch: 1,
    bindingRevision: 1, tabInstanceId: 'tab-fixture', deadlineMs: deadline, tool: 'read', args: { path: 'main.pjs' },
    permissions: ['READ_SOURCE'], requiredPermissions: ['READ_SOURCE'], mutating: false,
    props: { grantId: 'grant-fixture', workspaceId: 'workspace-fixture', agentId: 'agent-fixture', bindingRevision: 1 },
    agentId: 'agent-fixture', traceId: 'trace-fixture', phase, createdAt: Date.now() - 100 };
}
function request(path: string, body: Record<string, unknown>, token = '') {
  return new Request('https://internal' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
}
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
async function lease(records: SqlRecords, token: string) {
  records.put('lease', { workspaceId: 'workspace-fixture', epoch: 1, bindingRevision: 1, tabInstanceId: 'tab-fixture',
    secretHash: await digest(token), claimedAt: Date.now(), expiresAt: Date.now() + 180000, credentialEpoch: 1, permissions: ['READ_SOURCE'] });
}

test('targeted status does not expire or materialize unrelated operations', async () => {
  const f = fixture();
  try {
    f.records.put('operation/current', operation('current', 'RUNNING'));
    f.records.put('operation/unrelated', operation('unrelated', 'RUNNING', Date.now() - 1));
    const workspace = new Workspace(f.state, f.env);
    f.queries.length = 0;
    const response = await workspace.fetch(request('/internal/status', { workspaceId: 'workspace-fixture', operationId: 'current' }));
    assert.equal(response.status, 200);
    assert.equal(f.records.get<{phase:string}>('operation/unrelated').phase, 'RUNNING');
    assert.equal(f.queries.filter(q => q.includes('operation_dirty_v1')).length, 0);
  } finally { f.close(); }
});

test('late failed dispatch authorization never overwrites a concurrently cancelled operation', async () => {
  const reached = deferred(), gate = deferred();
  const f = fixture(async (path) => {
    if (path === '/internal/dispatch') { reached.release(); await gate.promise; return Response.json({ code: 'REVOKED', message: 'Fixture revocation' }, { status: 403 }); }
    return Response.json({ ok: true });
  });
  try {
    const token = 'fixture-lease-token'.padEnd(64, 'x'); await lease(f.records, token);
    f.records.put('operation/current', operation('current'));
    const workspace = new Workspace(f.state, f.env);
    const poll = workspace.fetch(request('/api/v1/tab/poll', { workspaceId: 'workspace-fixture', epoch: 1, tabInstanceId: 'tab-fixture' }, token));
    await reached.promise;
    const cancelled = await workspace.fetch(request('/internal/cancel', { workspaceId: 'workspace-fixture', operationId: 'current' }));
    assert.equal(cancelled.status, 200);
    gate.release(); await poll;
    assert.equal(f.records.get<{phase:string}>('operation/current').phase, 'CANCELLED');
  } finally { gate.release(); f.close(); }
});

test('heartbeat cannot revive a lease which expired while Registry validation awaited', async () => {
  const reached = deferred(), gate = deferred();
  const f = fixture(async (path) => {
    if (path === '/internal/lease-check') { reached.release(); await gate.promise; return Response.json({ permissions: ['READ_SOURCE'] }); }
    return Response.json({ ok: true });
  });
  try {
    const token = 'fixture-lease-token'.padEnd(64, 'x'); await lease(f.records, token);
    const workspace = new Workspace(f.state, f.env);
    const pending = workspace.fetch(request('/api/v1/tab/heartbeat', { workspaceId: 'workspace-fixture', epoch: 1, tabInstanceId: 'tab-fixture' }, token));
    await reached.promise;
    const current = f.records.get<Record<string, unknown>>('lease');
    f.records.put('lease', { ...current, expiresAt: Date.now() - 1 });
    gate.release(); const response = await pending;
    assert.equal(response.status, 409);
    assert.ok(f.records.get<{expiresAt:number}>('lease').expiresAt < Date.now());
  } finally { gate.release(); f.close(); }
});
