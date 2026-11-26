import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { JSDOM } from 'jsdom';
import { mountManager, type ManagerClient } from '../../apps/userscript/src/manager.js';
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 10));
async function until(predicate: () => boolean) { for (let i = 0; i < 1500; i++) {
    if (predicate())
        return;
    await tick();
} assert.fail('Expected manager transition timed out'); }
function click(root: ShadowRoot, text: string) { const button = [...root.querySelectorAll('button')].find(b => b.textContent === text); assert.ok(button, `Missing button: ${text}`); button.click(); }
function input(root: ShadowRoot, label: string): HTMLInputElement { const result = root.querySelector<HTMLInputElement>(`[aria-label="${label}"]`); assert.ok(result, `Missing field: ${label}`); return result; }
function resourceInput(value: Record<string, unknown>): Record<string, unknown> { const out: Record<string, unknown> = {}; for (const key of ['id', 'kind', 'title', 'description', 'body', 'files', 'enabled', 'dependencies', 'provenance', 'license', 'upstreamVersion'])
    if (value[key] !== undefined)
        out[key] = value[key]; return out; }
test('manager journeys execute against real local Worker: pair, attach, Agent, Resource CAS and assignment', { timeout: 60000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'perch-manager-worker-'));
    await build({ entryPoints: ['apps/gateway/src/index.ts'], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', conditions: ['workerd', 'worker', 'browser'], outfile: join(dir, 'gateway.mjs'), external: ['node:*', 'cloudflare:*'], logLevel: 'silent' });
    const issuer = 'https://gateway.example.workers.dev', bootstrap = 'original-synthetic-bootstrap-secret-'.repeat(2);
    const mf = new Miniflare({ modules: true, scriptPath: join(dir, 'gateway.mjs'), modulesRoot: dir, compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'], kvNamespaces: ['OAUTH_KV'], durableObjects: { REGISTRY: { className: 'Registry', useSQLite: true }, WORKSPACES: { className: 'Workspace', useSQLite: true } }, bindings: { BOOTSTRAP_SECRET: bootstrap, ISSUER_URL: issuer } });
    const dom = new JSDOM('<!doctype html><html><body><textarea id="native-source">Original synthetic draft</textarea></body></html>', { url: 'https://perchance.org/synthetic#edit', pretendToBeVisual: true });
    let admin = '', paired = false, attached = 0;
    const drafts = new Map<string, string>();
    const client: ManagerClient = {
        configuration: () => ({ origin: issuer, paired, browserInstallationId: 'synthetic-installation' }),
        request: async (method, path, body) => { const response = await mf.dispatchFetch(issuer + path, { method, headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json', ...(method === 'GET' ? {} : { 'Idempotency-Key': crypto.randomUUID() }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const data = await response.json() as Record<string, unknown>; if (!response.ok)
            throw Object.assign(new Error(String(data.message)), data); return data; },
        health: async () => { const r = await mf.dispatchFetch(issuer + '/health'); return r.json(); },
        pair: async (_origin, secret) => { const r = await mf.dispatchFetch(issuer + '/api/v1/admin/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bootstrapSecret: secret, browserInstallationId: 'synthetic-installation', issuer }) }); const data = await r.json() as {
            adminCredential?: string;
            message?: string;
        }; if (!r.ok)
            throw new Error(data.message); admin = data.adminCredential!; paired = true; },
        currentIdentity: async () => ({ generatorId: 'synthetic-generator', slug: 'synthetic', draftId: '', browserInstallationId: 'synthetic-installation' }), attach: async () => { attached++; }, copy: async () => { }, download: () => { }, drafts: { get: async (k) => drafts.get(k), set: async (k, v) => { drafts.set(k, v); }, delete: async (k) => { drafts.delete(k); } },
    };
    const manager = mountManager({ document: dom.window.document, version: '0.1.0', client });
    const root = dom.window.document.querySelector('[data-perch-mcp-manager]')!.shadowRoot!;
    try {
        await manager.open('Settings');
        input(root, 'Gateway HTTPS origin').value = issuer;
        input(root, 'One-time bootstrap secret').value = bootstrap;
        click(root, 'Pair installation');
        await until(() => paired && !!root.querySelector('[aria-label="Workspace name"]'));
        assert.doesNotMatch(root.innerHTML, new RegExp(admin));
        input(root, 'Workspace name').value = 'Synthetic Workspace';
        click(root, 'Create Workspace');
        await until(() => [...root.querySelectorAll('strong')].some(n => n.textContent === 'Synthetic Workspace'));
        click(root, 'Attach current editor');
        await until(() => attached === 1);
        await until(() => /synthetic · ID/.test(root.textContent ?? ''));
        const w = (await client.request('GET', '/api/v1/admin/workspaces') as {
            items: Record<string, unknown>[];
        }).items[0]!;
        assert.equal((w.binding as any).draftId, '');
        assert.equal((w.binding as any).generatorId, 'synthetic-generator');
        assert.deepEqual(w.permissions, ['READ_SOURCE', 'WRITE_SOURCE', 'PREVIEW_CONTROL', 'READ_RESOURCES']);
        await manager.open('Agents');
        input(root, 'Agent name').value = 'Synthetic Agent';
        click(root, 'Create Agent');
        await until(() => [...root.querySelectorAll('p')].some(n => n.textContent === 'Synthetic Agent'));
        const a = (await client.request('GET', '/api/v1/admin/agents') as {
            items: Record<string, unknown>[];
        }).items[0]!;
        assert.equal(a.workspaceId, w.id);
        assert.equal(input(root, 'MCP connector URL').value, issuer + '/mcp/' + a.id);
        await manager.open('Library');
        const catalog = await client.request('GET', '/api/v1/admin/resources') as {
            items: Record<string, unknown>[];
            revision: number;
        };
        const summary = catalog.items.find(r => r.id === 'perchance-platform')!;
        assert.ok(summary, 'Catalog exposes the seeded platform skill');
        const skill = await client.request('GET', '/api/v1/admin/resources/perchance-platform') as Record<string, unknown>;
        assert.equal(typeof skill.body, 'string');
        assert.equal(typeof skill.license, 'string');
        assert.equal(typeof skill.provenance, 'string');
        click(root, String(summary.title));
        await until(() => !!root.querySelector('textarea'));
        let area = root.querySelector('textarea')!;
        assert.equal(area.value, skill.body, 'Editor loads complete canonical Resource text, not catalog metadata');
        area.value = String(skill.body) + '\nOriginal manager integration fixture.';
        area.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        click(root, 'Publish revision');
        await until(() => /Published new Resource revision/.test(root.textContent ?? ''));
        const published = await client.request('GET', '/api/v1/admin/resources/perchance-platform') as Record<string, unknown>;
        assert.equal(published.revision, Number(skill.revision) + 1);
        assert.equal(published.body, String(skill.body) + '\nOriginal manager integration fixture.');
        for (const key of ['id', 'kind', 'title', 'description', 'license', 'provenance', 'upstreamVersion', 'dependencies', 'files']) {
            assert.deepEqual(published[key], skill[key], `Publish preserves canonical ${key}`);
        }
        click(root, 'Enable Resource at scope');
        await until(() => /Resource assignment updated/.test(root.textContent ?? ''));
        click(root, 'Disable Resource at scope');
        await until(() => /Resource disabled at selected scope/.test(root.textContent ?? ''));
        const assignment = await client.request('GET', '/api/v1/admin/resources/assignments') as {
            items: {
                enabled: boolean;
                resourceId: string;
            }[];
        };
        assert.equal(assignment.items.find(x => x.resourceId === 'perchance-platform')?.enabled, false);
        // A second administrator updates the canonical revision while this manager still edits its older draft.
        const external = { ...resourceInput(published), body: String(published.body) + '\nExternal administrator revision' };
        await client.request('PUT', '/api/v1/admin/resources/perchance-platform', { expectedRevision: published.revision, resource: external });
        area = root.querySelector('textarea')!;
        area.value += '\nPending local draft after conflict';
        area.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        click(root, 'Publish revision');
        await until(() => /RESOURCE_CONFLICT/.test(root.textContent ?? ''));
        assert.match(root.querySelector('textarea')!.value, /Pending local draft after conflict/);
        assert.match(drafts.get('resource:perchance-platform') ?? '', /Pending local draft after conflict/);
        const latest = await client.request('GET', '/api/v1/admin/resources/perchance-platform') as Record<string, unknown>;
        assert.match(String(latest.body), /External administrator revision/);
        assert.doesNotMatch(String(latest.body), /Pending local draft after conflict/);
        manager.close();
        assert.equal(dom.window.document.querySelector<HTMLTextAreaElement>('#native-source')!.value, 'Original synthetic draft');
    }
    catch (error) {
        console.error('Manager error:', root.querySelector('[role=status]')?.textContent);
        throw error;
    }
    finally {
        manager.destroy();
        dom.window.close();
        await mf.dispose();
        await rm(dir, { recursive: true, force: true });
    }
});
