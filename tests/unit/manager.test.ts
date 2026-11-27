import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountManager, exportSafeSettings, renderResourcePreview, lineDiff, type ManagerClient } from '../../apps/userscript/src/manager';
import { managerStyles } from '../../apps/userscript/src/manager.css';
function fixture(overrides: Partial<ManagerClient> = {}, synthetic = true) {
    const dom = new JSDOM('<!doctype html><html><body><input id="native-editor" value="untouched"></body></html>', { url: 'https://perchance.org/synthetic#edit', pretendToBeVisual: true });
    const requests: {
        method: string;
        path: string;
        body: any;
    }[] = [], copies: string[] = [], downloads: {
        name: string;
        data: string | Uint8Array;
        mime: string;
    }[] = [];
    const resource = { id: 'test-skill', title: 'Test skill', kind: 'skill', description: 'Synthetic original', body: '# Existing\nunchanged', files: { 'reference.txt': 'safe' }, revision: 1, enabled: true, dependencies: [], provenance: 'Synthetic', license: 'MIT' };
    const drafts = new Map<string, string>();
    const w = { id: 'workspace-1', label: '<img src=x onerror=alert(1)>', revision: 1, bindingRevision: 1, binding: null, permissions: ['READ_SOURCE'], paused: false };
    const a = { id: 'agent/one', label: '<script>bad()</script>', workspaceId: 'workspace-1', revision: 1, endpoint: 'https://attacker.example/?token=should-not-be-used' };
    const client: ManagerClient = {
        configuration: () => ({ origin: 'https://gateway.example.workers.dev', paired: true, browserInstallationId: 'installation-1' }),
        request: async (method, path, body) => {
            requests.push({ method, path, body });
            if (path.endsWith('/state'))
                return { revision: 1, policyRevision: 2, paused: false, version: '0.1.0', schemaVersion: 1 };
            if (path.endsWith('/workspaces'))
                return { items: [w], revision: 1 };
            if (path.endsWith('/agents'))
                return { items: [a], revision: 1 };
            if (path.endsWith('/resources/test-skill/history'))
                return { items: [resource], revision: 1 };
            if (path.endsWith('/resources/test-skill'))
                return resource;
            if (path.endsWith('/resources'))
                return { items: [resource], revision: 3 };
            return { items: [], revision: 1 };
        },
        health: async () => ({ version: '0.1.0', compatible: true }), pair: async () => { }, currentIdentity: async () => ({ generatorId: 'generator-1', slug: 'synthetic', draftId: '', browserInstallationId: 'installation-1' }),
        copy: async (text) => { copies.push(text); }, download: (name, data, mime) => { downloads.push({ name, data, mime }); }, drafts: { get: async (key) => drafts.get(key), set: async (key, v) => { drafts.set(key, v); }, delete: async (key) => { drafts.delete(key); } }, ...overrides,
    };
    let captured: ShadowRoot | undefined;
    const attachShadow = dom.window.Element.prototype.attachShadow;
    dom.window.Element.prototype.attachShadow = function (options) { const shadow = attachShadow.call(this, options); captured = shadow; return shadow; };
    const handle = mountManager({ document: dom.window.document, version: '0.1.0', client, ...(synthetic ? { synthetic: true as const } : {}) });
    const root = dom.window.document.querySelector('[data-perch-mcp-manager]')!.shadowRoot ?? captured!;
    return { dom, handle, client, root, requests, copies, downloads, drafts, resource };
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
async function until(predicate: () => boolean) { for (let i = 0; i < 100; i++) {
    if (predicate())
        return;
    await tick();
} assert.fail('Expected UI condition did not arrive'); }
function click(root: ShadowRoot, label: string) { const b = [...root.querySelectorAll('button')].find(b => b.textContent === label); assert.ok(b, `button ${label}`); b.click(); }
test('manager uses scoped one-scroll layout and closes without changing native editor', async () => {
    const f = fixture();
    await f.handle.open();
    assert.match(managerStyles, /\.body\{overflow:auto/);
    assert.match(managerStyles, /dialog\{[^}]*overflow:hidden/);
    assert.doesNotMatch(managerStyles, /overflow:auto[^}]*textarea/);
    assert.equal(f.dom.window.document.querySelector<HTMLInputElement>('#native-editor')!.value, 'untouched');
    const dialog = f.root.querySelector('dialog')!;
    assert.ok(dialog.hasAttribute('open'));
    dialog.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(dialog.hasAttribute('open'), false);
    assert.equal(f.dom.window.document.documentElement.style.overflow, '');
    f.handle.destroy();
    assert.equal(f.dom.window.document.querySelector('[data-perch-mcp-manager]'), null);
});
test('hostile labels stay text and connector copies use configured origin and encoded Agent ID', async () => {
    const f = fixture();
    await f.handle.open('Agents');
    assert.equal(f.root.querySelector('script'), null);
    assert.equal(f.root.querySelector('img'), null);
    click(f.root, 'Copy URL');
    await until(() => f.copies.length === 1);
    assert.equal(f.copies[0], 'https://gateway.example.workers.dev/mcp/agent%2Fone');
    assert.doesNotMatch(f.root.textContent ?? '', /should-not-be-used/);
    assert.match(f.root.textContent ?? '', /<script>bad\(\)<\/script>/);
});
test('setup validates origin before isolated credential prompt and never renders a bootstrap secret', async () => {
    let attempted = 0, prompts = 0;
    const f = fixture({ configuration: () => ({ origin: '', paired: false }), promptSecret: async purpose => { assert.equal(purpose, 'bootstrap'); prompts++; return 'x'.repeat(44); }, pair: async (_origin, secret) => { assert.equal(secret, 'x'.repeat(44)); assert.equal(f.root.querySelector('input[type=password]'), null); attempted++; throw new Error('Pair failed'); } });
    await f.handle.open('Settings');
    const origin = f.root.querySelector<HTMLInputElement>('[aria-label="Gateway HTTPS origin"]')!;
    assert.equal(f.root.querySelector('input[type=password]'), null);
    origin.value = 'https://gateway.example.workers.dev/path';
    click(f.root, 'Pair installation'); await tick();
    assert.equal(attempted, 0); assert.equal(prompts, 0); assert.match(f.root.textContent ?? '', /without a path/);
    origin.value = 'https://gateway.example.workers.dev';
    click(f.root, 'Pair installation'); await until(() => attempted === 1);
    assert.equal(prompts, 1); assert.doesNotMatch(f.root.innerHTML, /x{44}/);
});
test('failed Resource publish preserves edited text and durable local draft', async () => {
    const f = fixture();
    const delegate = f.client.request;
    f.client.request = async (method, path, body) => { if (method === 'PUT')
        throw new Error('Stale Resource revision'); return delegate(method, path, body); };
    await f.handle.open('Library');
    click(f.root, 'Test skill');
    await until(() => !!f.root.querySelector('textarea'));
    const area = f.root.querySelector('textarea')!;
    area.value = '# Pending\nOperator draft';
    area.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
    await tick();
    click(f.root, 'Publish revision');
    await until(() => /Stale Resource/.test(f.root.textContent ?? ''));
    assert.equal(f.root.querySelector('textarea')!.value, '# Pending\nOperator draft');
    assert.match(f.drafts.get('resource:test-skill') ?? '', /Operator draft/);
    assert.doesNotMatch(f.root.innerHTML, /Authorization|adminCredential/);
});
test('Resource history uses canonical restore contract and preserves metadata on publish', async () => {
    const f = fixture();
    await f.handle.open('Library');
    click(f.root, 'Test skill');
    await until(() => !!f.root.querySelector('textarea'));
    click(f.root, 'Publish revision');
    await until(() => f.requests.some(r => r.method === 'PUT'));
    const request = f.requests.find(r => r.method === 'PUT')!;
    assert.equal(request.body.expectedRevision, 1);
    assert.equal(request.body.resource.provenance, 'Synthetic');
    assert.equal(request.body.resource.license, 'MIT');
    assert.deepEqual(request.body.resource.dependencies, []);
    await until(() => !!f.root.querySelector('textarea'));
    click(f.root, 'Revision history');
    await until(() => f.requests.some(r => r.path.endsWith('/history')));
    await until(() => [...f.root.querySelectorAll('button')].some(b => b.textContent === 'Restore as new revision'));
    click(f.root, 'Restore as new revision');
    click(f.root, 'Confirm');
    await until(() => f.requests.some(r => r.path.endsWith('/restore')));
    assert.deepEqual(f.requests.find(r => r.path.endsWith('/restore'))!.body, { expectedRevision: 1, historicalRevision: 1 });
});
test('Settings remains available offline and local stop never claims dispatched effects cancelled', async () => {
    let stopped = 0;
    const f = fixture({ request: async () => { throw new Error('Gateway unavailable'); }, pauseLocal: async () => { stopped++; } });
    await f.handle.open('Settings');
    assert.ok(f.root.querySelector('[aria-label="Gateway HTTPS origin"]'));
    assert.match(f.root.textContent ?? '', /Gateway unavailable/);
    click(f.root, 'Stop this document immediately');
    await until(() => stopped === 1);
    assert.match(f.root.textContent ?? '', /Previously dispatched effects may still complete/);
});
test('settings exports have an explicit allowlist and require fresh pairing/rebind', () => {
    const exported = JSON.parse(exportSafeSettings({ origin: 'https://gateway.example', paired: true, ...{ adminCredential: 'secret', executionCredential: 'secret2', browserInstallationId: 'private' } } as any, '0.1.0'));
    assert.deepEqual(Object.keys(exported).sort(), ['gatewayOrigin', 'requiresPairing', 'requiresRebind', 'schemaVersion', 'version']);
    assert.equal(exported.requiresPairing, true);
    assert.equal(exported.requiresRebind, true);
    assert.doesNotMatch(JSON.stringify(exported), /secret|private/);
});
test('Resource preview never parses active markup and line diff bounds output', () => {
    const dom = new JSDOM();
    const node = renderResourcePreview(dom.window.document, '# Title\n<img src=x onerror=alert(1)>\n<script>alert(1)</script>');
    assert.equal(node.querySelector('img,script'), null);
    assert.match(node.textContent ?? '', /<script>/);
    assert.deepEqual(lineDiff('a\nb', 'a\nc'), [{ kind: 'same', text: 'a' }, { kind: 'remove', text: 'b' }, { kind: 'add', text: 'c' }]);
    assert.equal(lineDiff('', Array(6000).fill('x').join('\n')).length, 2000);
});
test('Workspace pagination loads later pages and rejects inconsistent snapshots', async () => {
    const f = fixture();
    const delegate = f.client.request;
    let revision = 7;
    f.client.request = async (method, path, body) => { if (path === '/api/v1/admin/workspaces')
        return { items: [{ id: 'w-first', label: 'First page', revision: 1 }], revision: 7, cursor: '100' }; if (path === '/api/v1/admin/workspaces?cursor=100')
        return { items: [{ id: 'w-second', label: 'Second page', revision: 1 }], revision, cursor: null }; return delegate(method, path, body); };
    await f.handle.open('Workspaces');
    assert.match(f.root.textContent ?? '', /Second page/);
    revision = 8;
    await f.handle.refresh();
    assert.match(f.root.textContent ?? '', /Registry changed while paging/);
});
test('late Resource loads cannot replace the newer selected Resource', async () => {
    const f = fixture();
    const delegate = f.client.request;
    let finishOld: ((value: unknown) => void) | undefined;
    f.client.request = async (method, path, body) => { if (path.endsWith('/resources'))
        return { items: [f.resource, { ...f.resource, id: 'new-skill', title: 'New skill' }], revision: 1 }; if (path.endsWith('/resources/test-skill'))
        return new Promise(resolve => { finishOld = resolve; }); if (path.endsWith('/resources/new-skill'))
        return { ...f.resource, id: 'new-skill', title: 'New skill', body: 'newest content' }; return delegate(method, path, body); };
    await f.handle.open('Library');
    click(f.root, 'Test skill');
    await until(() => !!finishOld);
    click(f.root, 'New skill');
    await until(() => f.root.querySelector('textarea')?.value === 'newest content');
    finishOld!(f.resource);
    await tick();
    assert.equal(f.root.querySelector('textarea')!.value, 'newest content');
});
test('uncertain-operation recovery requires evidence and explicit acknowledgement without replay', async () => {
    const resolutions: Record<string, unknown>[] = [];
    const f = fixture({ reconcileOperation: async (record) => { resolutions.push(record); } });
    const delegate = f.client.request;
    f.client.request = async (method, path, body) => path.endsWith('/activity') ? { items: [{ operationId: 'operation-uncertain', workspaceId: 'workspace-1', epoch: 3, bindingRevision: 2, tool: 'write', phase: 'UNKNOWN', timestamp: 1 }], revision: 1 } : delegate(method, path, body);
    await f.handle.open('Activity');
    click(f.root, 'Resolve uncertain operation…');
    click(f.root, 'Record operator resolution');
    await tick();
    assert.equal(resolutions.length, 0);
    assert.match(f.root.textContent ?? '', /explicit uncertainty acknowledgement/);
    f.root.querySelector<HTMLInputElement>('[aria-label="Inspection evidence (required)"]')!.value = 'Inspected current draft and independent provider source.';
    f.root.querySelector<HTMLInputElement>('.confirm input[type=checkbox]')!.checked = true;
    click(f.root, 'Record operator resolution');
    await until(() => resolutions.length === 1);
    assert.equal(resolutions[0]!.operationId, 'operation-uncertain');
    assert.equal(resolutions[0]!.phase, 'UNKNOWN');
    assert.match(String(resolutions[0]!.operatorEvidence), /Inspected current draft/);
    assert.equal(f.requests.some(r => /\/admit|\/reply|save_generator/.test(r.path)), false);
});

test('Operator host editor preserves prior allowlist on invalid input and saves validated exact hosts', async () => {
    let approved = ['perchance.org', 'user.uploads.dev'];
    const writes: string[][] = [];
    const f = fixture({ fetchHosts: async () => approved, setFetchHosts: async hosts => { writes.push(hosts); approved = hosts; } });
    await f.handle.open('Settings');
    await until(() => !f.root.querySelector<HTMLTextAreaElement>('[aria-label="Exact approved public hostnames"]')!.disabled);
    const area = f.root.querySelector<HTMLTextAreaElement>('[aria-label="Exact approved public hostnames"]')!;
    assert.match(f.root.textContent ?? '', /cannot independently attest DNS addresses/);
    for (const invalid of ['*.trusted.net', '127.0.0.1', 'localhost', 'service.internal', 'https://trusted.net/path', 'trusted.net:443', 'trusted.net/path', 'user@trusted.net']) {
        area.value = invalid;
        click(f.root, 'Save approved fetch hosts');
        await tick();
        assert.deepEqual(approved, ['perchance.org', 'user.uploads.dev']);
        assert.equal(writes.length, 0);
    }
    area.value = 'PERCHANCE.ORG\nuser.uploads.dev\nassets.trusted.net\nassets.trusted.net';
    click(f.root, 'Save approved fetch hosts');
    await until(() => writes.length === 1);
    assert.deepEqual(approved, ['perchance.org', 'user.uploads.dev', 'assets.trusted.net']);
    assert.match(f.root.textContent ?? '', /Existing permissions still apply/);
});

test('credential recovery requires specific revocation approval and keeps prompted secret outside DOM', async () => {
    let attempts = 0, prompts = 0;
    const f = fixture({ configuration: () => ({ origin: 'https://gateway.example.workers.dev', paired: false }), promptSecret: async purpose => { assert.equal(purpose, 'recovery'); prompts++; return 'R'.repeat(43); }, recover: async (_origin, secret) => { attempts++; assert.equal(f.root.querySelector('input[type=password]'), null); assert.doesNotMatch(f.root.innerHTML, /R{43}/); assert.equal(secret, 'R'.repeat(43)); throw new Error('Recovery rejected'); } });
    await f.handle.open('Settings');
    const approval = f.root.querySelector<HTMLInputElement>('[aria-label="Approve recovery revocation"]')!;
    assert.match(f.root.textContent ?? '', /First rotate RECOVERY_SECRET/);
    assert.equal(f.root.querySelector('input[type=password]'), null);
    click(f.root, 'Confirm credential recovery'); await tick();
    assert.equal(attempts, 0); assert.equal(prompts, 0);
    approval.checked = true; click(f.root, 'Confirm credential recovery'); await until(() => attempts === 1);
    assert.equal(prompts, 1); assert.equal(approval.checked, false);
    assert.match(f.root.textContent ?? '', /Recovery rejected/); assert.doesNotMatch(f.root.innerHTML, /R{43}/);
});
test('cancelled isolated credential prompts never call pairing or recovery', async () => {
    let pairs = 0, recoveries = 0;
    const f = fixture({ configuration: () => ({ origin: 'https://gateway.example.workers.dev', paired: false }), promptSecret: async () => null, pair: async () => { pairs++; }, recover: async () => { recoveries++; } });
    await f.handle.open('Settings');
    click(f.root, 'Pair installation'); await tick();
    assert.equal(pairs, 0); assert.match(f.root.textContent ?? '', /Pairing cancelled/);
    f.root.querySelector<HTMLInputElement>('[aria-label="Approve recovery revocation"]')!.checked = true;
    click(f.root, 'Confirm credential recovery'); await tick();
    assert.equal(recoveries, 0); assert.match(f.root.textContent ?? '', /Recovery cancelled/);
    assert.equal(f.root.querySelector('input[type=password]'), null);
});

test('production manager closes its ShadowRoot and refuses page-created UI events', async () => {
    let prompts = 0, pairs = 0;
    const f = fixture({ configuration: () => ({ origin: 'https://gateway.example.workers.dev', paired: false }), promptSecret: async () => { prompts++; return 'x'.repeat(43); }, pair: async () => { pairs++; } }, false);
    assert.equal(f.dom.window.document.querySelector('[data-perch-mcp-manager]')!.shadowRoot, null);
    // Test instrumentation captured the closed root; page-created events still have no authority.
    click(f.root, 'Perch MCP · unpaired');
    await tick();
    assert.equal(f.root.querySelector('dialog')!.hasAttribute('open'), false);
    assert.equal(f.requests.length, 0);
    await f.handle.open('Settings'); // Only an internal controller/menu invocation may open programmatically.
    click(f.root, 'Pair installation');
    f.root.querySelector('nav')!.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    await tick();
    assert.equal(prompts, 0); assert.equal(pairs, 0); assert.equal(f.requests.length, 0);
    assert.equal(f.root.querySelector('[aria-selected=true]')!.textContent, 'Settings');
    assert.equal(f.root.querySelector('input[type=password]'), null);
});

test('unpublished Resource drafts export separately without replacing settings or canonical Library', async () => {
    const retained = { schemaVersion: 1, documents: [{ documentId: 'document-one', resourceId: 'skill-one', revision: 2, body: 'First unpublished operator text' }, { documentId: 'document-two', resourceId: 'skill-one', revision: 2, body: 'Concurrent unpublished operator text' }] };
    const f = fixture({ localDrafts: async () => retained });
    await f.handle.open('Settings');
    click(f.root, 'Export unpublished Resource drafts');
    await until(() => f.downloads.length === 1);
    assert.equal(f.downloads[0]!.name, 'perch-mcp-resource-drafts.json');
    assert.equal(f.downloads[0]!.mime, 'application/json');
    assert.deepEqual(JSON.parse(String(f.downloads[0]!.data)), retained);
    assert.equal(f.requests.some(r => r.method !== 'GET'), false);
    assert.match(f.root.textContent ?? '', /Published Resources and settings are unchanged/);
});

test('Recovery presents a single human-readable action, no unexplained evidence input, and preserves running holds',async()=>{
 const resolutions:Record<string,unknown>[]=[];
 const f=fixture({reconcileOperation:async op=>{resolutions.push(op);}});
 const delegate=f.client.request;
 f.client.request=async(method,path,body)=>path.endsWith('/recovery')?{
   schemaVersion:1,workspaceId:'workspace-1',activeLease:null,pendingClaimUntil:null,
   action:'RECONCILE',blockingOperations:[
     {operationId:'running-1',tool:'page_eval',phase:'RUNNING',epoch:4,bindingRevision:2,
       deadlineMs:Date.now()+30000,resolvable:false},
     {operationId:'unknown-1',tool:'save_generator',phase:'UNKNOWN',epoch:3,bindingRevision:2,
       deadlineMs:Date.now()-1000,resolvable:true}
   ]
 }:delegate(method,path,body);
 await f.handle.open('Recovery');
 assert.match(f.root.textContent??'',/Review needed/);
 assert.match(f.root.textContent??'',/running-1/);
 assert.match(f.root.textContent??'',/unknown-1/);
 assert.equal(f.root.querySelectorAll('input[type=text]').length,0);
 assert.equal(f.root.querySelectorAll('input[type=checkbox]').length,0);
 assert.equal([...f.root.querySelectorAll('button')].filter(b=>b.textContent==='I checked the result — continue').length,1);
 click(f.root,'I checked the result — continue');
 await until(()=>resolutions.length===1);
 assert.equal(resolutions[0]!.operationId,'unknown-1');
 assert.equal(resolutions[0]!.epoch,3);
 assert.equal(resolutions[0]!.bindingRevision,2);
 assert.match(String(resolutions[0]!.operatorEvidence),/acknowledged uncertain/);
 assert.equal(f.requests.some(x=>x.method!=='GET'),false);
});

test('Blocked Reconnect opens Recovery instead of stranding the operator at TAB_BUSY',async()=>{
 const identity={generatorId:'generator-1',slug:'synthetic',draftId:'',browserInstallationId:'installation-1'};
 const w={id:'workspace-1',label:'Synthetic',revision:1,bindingRevision:1,binding:identity,
   permissions:['READ_SOURCE'],paused:false};
 const f=fixture({probe:async()=>({ready:true,identity}),
   attach:async()=>{throw Object.assign(new Error('Active lease'),{code:'TAB_BUSY'});}});
 const delegate=f.client.request;
 f.client.request=async(method,path,body)=>{
   if(path.endsWith('/recovery'))return{
     workspaceId:'workspace-1',activeLease:{epoch:8,expiresAt:Date.now()+180000},
     pendingClaimUntil:null,action:'WAIT_FOR_LEASE',blockingOperations:[],
   };
   if(path.endsWith('/workspaces'))return{items:[w],revision:1};
   if(path.endsWith('/workspaces/workspace-1'))return w;
   return delegate(method,path,body);
 };
 await f.handle.open('Workspaces');
 click(f.root,'Reconnect');
 await until(()=>/Another editor has the lease/.test(f.root.textContent??''));
 assert.match(f.root.textContent??'',/Recovery/);
 assert.match(f.root.textContent??'',/Connection held \(TAB_BUSY\)/);
});
test('Recovery explains pending storage preparation without claiming empty holds or offering reconnect',async()=>{
 const f=fixture(),delegate=f.client.request;
 f.client.request=async(method,path,body)=>path.endsWith('/recovery')?{
  schemaVersion:1,workspaceId:'workspace-1',action:'WAIT_FOR_STORAGE',storagePreparing:true,
  blockingOperationsKnown:false,leaseClaimAvailable:false,blockingOperations:[],activeLease:null,
 }:delegate(method,path,body);
 await f.handle.open('Recovery');
 assert.match(f.root.textContent??'',/Storage preparation pending/);
 assert.match(f.root.textContent??'',/Preserve pending results/);
 assert.ok([...f.root.querySelectorAll('button')].some(b=>b.textContent==='Check again'));
 assert.equal([...f.root.querySelectorAll('button')].some(b=>b.textContent==='Connect now'),false);
 assert.equal(f.requests.some(row=>row.method!=='GET'),false);
});

test('Recovery acknowledges one local journal and never clears peers',async()=>{
 const acknowledgments:string[]=[];
 const f=fixture({
  localRecovery:async()=>({revision:'9:'+'b'.repeat(64),holds:[
   {id:'journal-a',kind:'SOURCE',state:'UNKNOWN',createdAt:1,paths:['main.pjs'],baseRevision:'old'},
   {id:'journal-b',kind:'IMPORT',state:'PARTIAL',createdAt:2,paths:['imports/x/main.pjs'],baseRevision:'old'}]}),
  resolveLocalHold:async(_workspace,journal,revision,evidence)=>{
   assert.equal(revision,'9:'+'b'.repeat(64));assert.match(evidence,/acknowledged/);
   acknowledgments.push(journal);
  },
 });
 const delegate=f.client.request;
 f.client.request=async(method,path,body)=>path.endsWith('/recovery')?{
   workspaceId:'workspace-1',activeLease:null,pendingClaimUntil:null,
   action:'RECONNECT',blockingOperations:[]
 }:delegate(method,path,body);
 await f.handle.open('Recovery');
 assert.match(f.root.textContent??'',/journal-a/);
 assert.match(f.root.textContent??'',/journal-b/);
 assert.equal(f.root.querySelectorAll('input[type=text]').length,0);
 assert.equal(f.root.querySelectorAll('input[type=checkbox]').length,0);
 click(f.root,'I checked these files — continue');
 await until(()=>acknowledgments.length===1);
 assert.deepEqual(acknowledgments,['journal-a']);
});

test('paused editor with exact native binding has one primary Connect action, no diagnostics wizard',async()=>{
 const identity={generatorId:'generator-1',slug:'synthetic',draftId:'',browserInstallationId:'installation-1'};
 const w={id:'workspace-1',label:'Current generator',revision:3,bindingRevision:2,
   binding:identity,permissions:['READ_SOURCE'],paused:false};
 const attached:unknown[]=[];
 const f=fixture({
  probe:async()=>({ready:true,identity}),
  attach:async target=>{attached.push(target);f.handle.setStatus({connection:'connected',workspace:'workspace-1'});},
 });
 const old=f.client.request;
 f.client.request=async(method,path,body)=>{
  if(path.endsWith('/workspaces'))return {items:[w],revision:3};
  if(path.endsWith('/workspaces/workspace-1'))return w;
  return old(method,path,body);
 };
 f.handle.setStatus({connection:'paused'});
 await f.handle.open('Workspaces');
 assert.match(f.root.textContent??'',/Connect the current editor/);
 assert.ok([...f.root.querySelectorAll('button')].some(b=>b.textContent==='Connect this editor'));
 click(f.root,'Connect this editor');
 await until(()=>attached.length===1);
 await until(()=>/Editor connected/.test(f.root.textContent??''));
 assert.equal((attached[0] as {id:string}).id,'workspace-1');
 assert.doesNotMatch(f.root.innerHTML,/Inspection evidence \(required\)/);
});

test('Connect explicitly resumes a paused Workspace and does not replay a lost PATCH acknowledgement',async()=>{
 const identity={generatorId:'generator-1',slug:'synthetic',draftId:'',browserInstallationId:'installation-1'};
 let paused=true,patchCount=0,attached=0;
 const w={id:'workspace-1',label:'Paused generator',revision:3,bindingRevision:2,
   binding:identity,permissions:['READ_SOURCE']};
 const f=fixture({probe:async()=>({ready:true,identity}),attach:async()=>{attached++;}});
 const old=f.client.request;
 f.client.request=async(method,path,body)=>{
  if(path.endsWith('/workspaces'))return {items:[{...w,paused}],revision:3};
  if(path.endsWith('/workspaces/workspace-1')&&method==='GET')return {...w,paused,revision:paused?3:4};
  if(path.endsWith('/workspaces/workspace-1')&&method==='PATCH'){
   patchCount++;assert.deepEqual(body,{expectedRevision:3,paused:false});
   paused=false;throw new Error('Lost response after committed pause change');
  }
  return old(method,path,body);
 };
 await f.handle.open('Workspaces');
 click(f.root,'Resume Workspace and connect');
 await until(()=>attached===1);
 assert.equal(patchCount,1,'a lost acknowledgement must cause GET reconciliation, not a second write');
 assert.equal(paused,false);
});

test('matching native Generator with changed installation ID offers explicit Rebind, not a bad lease claim',async()=>{
 const identity={generatorId:'generator-1',slug:'synthetic',draftId:'',browserInstallationId:'old-browser'};
 const w={id:'workspace-1',label:'Reinstalled browser',revision:7,bindingRevision:4,
   binding:identity,permissions:['READ_SOURCE'],paused:false};
 let attachCount=0;
 const f=fixture({probe:async()=>({ready:true,identity}),attach:async()=>{attachCount++;}});
 const old=f.client.request;
 f.client.request=async(method,path,body)=>{
  if(path.endsWith('/workspaces'))return {items:[w],revision:7};
  return old(method,path,body);
 };
 await f.handle.open('Workspaces');
 assert.match(f.root.textContent??'',/saved browser installation differs/);
 assert.ok([...f.root.querySelectorAll('button')].some(b=>b.textContent==='Rebind this editor'));
 assert.equal(attachCount,0);
});
