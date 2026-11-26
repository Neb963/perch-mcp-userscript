import test from 'node:test';
import assert from 'node:assert/strict';
import { GatewayTransport, gatewayOrigin } from '../../apps/userscript/src/transport.js';
import { MemoryStore } from '../../apps/userscript/src/storage.js';
test('gateway origins reject token URLs, redirects and local addresses', () => {
  for (const url of ['http://x.workers.dev','https://user:secret@x.workers.dev','https://x.workers.dev/mcp','https://x.workers.dev/?token=x','https://127.0.0.1','https://[::1]','https://localhost']) assert.throws(() => gatewayOrigin(url));
  assert.equal(gatewayOrigin('https://perch.example.workers.dev/'),'https://perch.example.workers.dev');
});
test('authenticated transport uses separate credentials and never follows redirects', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string | URL | Request, init: RequestInit) => { calls.push({ url: String(url), init }); return Response.json(calls.length === 1 ? { adminCredential: 'admin-secret', executionCredential: 'exec-secret' } : { ok: true }); }) as typeof fetch;
  const transport = new GatewayTransport(new MemoryStore(), fetcher);
  await transport.pair('https://perch.example.workers.dev', 'a'.repeat(64));
  await transport.request('GET','/api/v1/admin/state'); await transport.tab('/api/v1/tab/claim',{});
  assert.equal(new Headers(calls[1]!.init.headers).get('Authorization'),'Bearer admin-secret');
  assert.equal(new Headers(calls[2]!.init.headers).get('Authorization'),'Bearer exec-secret');
  for (const c of calls) { assert.equal(c.init.redirect,'error'); assert.equal(c.init.credentials,'omit'); assert.ok(!c.url.includes('secret')); }
  await assert.rejects(transport.request('GET','//attacker.example/admin'));
});
test('network and hostile gateway errors do not leak credentials/provider messages', async () => {
  const store = new MemoryStore();
  await store.set('perch:pairing',{schemaVersion:1,origin:'https://x.workers.dev',adminCredential:'secret',executionCredential:'exec',browserInstallationId:'b'});
  const transport = new GatewayTransport(store, (async () => Response.json({code:'REVOKED',message:'secret-private-source'},{status:403})) as typeof fetch);
  await transport.initialize();
  await assert.rejects(transport.request('GET','/api/v1/admin/state'),e => e instanceof Error && !e.message.includes('secret-private-source') && e.message.includes('REVOKED'));
});
