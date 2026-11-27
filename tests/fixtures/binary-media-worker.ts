/** Synthetic-only isolated DO fixture; outbound networking is denied by its Miniflare host. */
import type { DurableObjectState } from '@cloudflare/workers-types';
import { LegacyMaintenanceIndex } from './maintenance-v0112.js';
import { MaintenanceIndex } from '../../apps/gateway/src/maintenance-index.js';
import { SqlRecords } from '../../apps/gateway/src/sql.js';
import { ImageTransferHandler, type ImageLease, type ImageOperation } from '../../apps/gateway/src/image-transfer.js';
import { MusicHandler, type MusicLease, type MusicOperation } from '../../apps/gateway/src/media/handler.js';
export class MediaFixture {
    private db: SqlRecords;
    private now = 1000;
    private binary = false;
    private providerCalls = 0;
    private preparationSignals = 0;
    private maintenance?: MaintenanceIndex;
    private generatedBytes = 8 * 1024 * 1024;
    private authorized = true;
    private lease: ImageLease & MusicLease = { workspaceId: 'media-w', epoch: 1, bindingRevision: 1, tabInstanceId: 'media-tab', expiresAt: 360000000, permissions: ['READ_SOURCE', 'MEDIA', 'WRITE_SOURCE'] };
    private failAt = 0;
    private images!: ImageTransferHandler;
    private music!: MusicHandler;
    constructor(state: DurableObjectState) {
        this.db = new SqlRecords(state.storage);
        const query = this.db.query.bind(this.db);
        this.db.query = ((sql: string, ...args: (string | number | null | ArrayBuffer)[]) => {
            if (this.failAt > 0 && sql.startsWith("INSERT INTO media_payloads_v1") && --this.failAt === 0)
                throw new Error("synthetic SQL write quota");
            return query(sql, ...args);
        }) as SqlRecords["query"];
        this.reset();
    }
    private reset() {
        this.maintenance = undefined;
        this.images = new ImageTransferHandler(this.db, { getLease: () => this.lease, getOperation: id => this.db.get('operation/' + id), authorize: async () => { if (!this.authorized)
                throw new Error('REVOKED'); }, now: () => this.now, binaryPayloadsEnabled: () => this.binary });
        this.music = new MusicHandler(this.db, { BINARY_PAYLOADS_ENABLED: this.binary ? 'true' : 'false', PAID_MEDIA_ENABLED: 'true', ELEVENLABS_API_KEY: 'synthetic-never-used' }, { getLease: () => this.lease, now: () => this.now, onStoragePreparationPending: () => { this.preparationSignals++; }, authorize: async () => { if (!this.authorized)
                throw new Error('REVOKED'); }, generate: async () => { this.providerCalls++; const bytes = new Uint8Array(this.generatedBytes); bytes.fill(37); bytes[0] = 255; return { bytes, provider: 'elevenlabs', model: 'music_v2_5', contentType: 'audio/mpeg', requestedSeconds: 30, actualSeconds: 30, warnings: [], validation: { framing: true, playback: 'UNVERIFIED', lyrics: 'UNVERIFIED' } }; } });
    }
    async fetch(request: Request): Promise<Response> {
        try {
            const path = new URL(request.url).pathname, body = await request.json() as Record<string, unknown>;
            if (path === '/fault') {
                this.failAt = Number(body.after);
                return Response.json({ ok: true });
            }
            if (path === '/old-maintenance') {
                const old = new LegacyMaintenanceIndex(this.db);
                return Response.json({ next: old.nextDue(), indexed: this.db.query('SELECT count(*) count FROM workspace_maintenance_v1')[0]!.count });
            }
            if (path === '/native-maintenance-fence') {
                this.db.put('schema', 2);
                this.maintenance = new MaintenanceIndex(this.db, () => this.now, () => true);
                return Response.json({ ok: true });
            }
            if (path === '/maintenance') {
                const before = this.db.snapshotUsage();
                this.maintenance ??= new MaintenanceIndex(this.db, () => this.now);
                const next = this.maintenance.nextDue(), after = this.db.snapshotUsage();
                const usage = { reads: after.reads-before.reads, writes: after.writes-before.writes, statements: after.statements-before.statements };
                const legacy = this.db.query("SELECT name FROM sqlite_master WHERE name='workspace_maintenance_v1'").length > 0;
                const legacyTriggers = this.db.query("SELECT name FROM sqlite_master WHERE type='trigger' AND name IN ('workspace_maintenance_dirty_insert_v1','workspace_maintenance_dirty_delete_v1','workspace_maintenance_dirty_update_v1')").length;
                return Response.json({ next, usage, legacy, legacyTriggers, ready: this.maintenance.idleReady(), indexed: this.db.query('SELECT count(*) count FROM workspace_maintenance_v2')[0]!.count });
            }
            if (path === '/storage-status') return Response.json({image:this.images.storageStatus(),music:this.music.storageStatus()});
            if (path === '/usage')
                return Response.json(this.db.snapshotUsage());
            if (path === '/setup') {
                this.binary = body.binary === true;
                this.reset();
                const base = { ...this.lease, deadlineMs: this.now + 36000000, agentId: 'media-agent', phase: 'RUNNING', props: { grantId: 'media-grant' } };
                this.db.put('operation/image-op', { ...base, operationId: 'image-op', tool: 'read_image' });
                this.db.put('operation/music-op', { ...base, operationId: 'music-op', tool: 'generate_music', args: { style: 'synthetic', isInstrumental: true, userRequestedSeconds: 30, outputPath: 'scratch/music.mp3' } });
                return Response.json({ ok: true });
            }
            if (path === '/restart') {
                this.reset();
                return Response.json({ ok: true });
            }
            if (path === '/flag') {
                this.binary = body.binary === true;
                this.reset();
                return Response.json({ ok: true });
            }
            if (path === '/advance') {
                this.now = Number(body.now);
                return Response.json({ ok: true });
            }
            if (path === '/revoke') {
                this.authorized = false;
                return Response.json({ ok: true });
            }
            if (path === '/expire') {
                this.images.expire();
                this.music.expire();
                return Response.json({ ok: true });
            }
            if (path === '/prepare')
                return Response.json({ image: this.images.prepareStorage(), music: this.music.prepareStorage() });
            if (path === '/corrupt-parts') {
                const key=String(body.key);
                this.db.transaction(()=>{this.db.delete(key);this.db.query('INSERT INTO records(key,part,value) VALUES(?,1,?)',key,JSON.stringify(body.value));});
                return Response.json({ok:true});
            }
            if (path === '/parts') return Response.json({parts:this.db.query<{part:number}>('SELECT part FROM records WHERE key=? ORDER BY part',String(body.key)).map(row=>row.part)});
            if (path === '/seed') {
                this.db.put(String(body.key), body.value);
                return Response.json({ ok: true });
            }
            if (path === '/delete') {
                this.db.delete(String(body.key));
                return Response.json({ ok: true });
            }
            if (path === '/seed-history') {
                const count = Number(body.count);
                this.db.transaction(() => { for (let i = 0; i < count; i++)
                    this.db.put('music/journal/history-' + String(i).padStart(4, '0'), { operationId: 'history-' + String(i).padStart(4, '0'), workspaceId: this.lease.workspaceId, epoch: 1, bindingRevision: 1, tabInstanceId: this.lease.tabInstanceId, requestDigest: 'history', phase: 'REJECTED', createdAt: 1000, bytes: 0, ...(i === 0 ? { metadata: { unicode: '😀'.repeat(20000) } } : {}) }); });
                return Response.json({ ok: true });
            }
            if (path === '/image')
                return Response.json(await this.images.handle({ workspaceId: this.lease.workspaceId, epoch: this.lease.epoch, bindingRevision: this.lease.bindingRevision, tabInstanceId: this.lease.tabInstanceId, operationId: 'image-op', ...body }, this.lease));
            if (path === '/read-image') {
                const op = this.db.get<ImageOperation>('operation/image-op');
                op.phase = 'SUCCEEDED';
                this.db.put('operation/image-op', op);
                return Response.json(await this.images.read(body.reference, 'image/png', { operationId: 'image-op', workspaceId: this.lease.workspaceId, bindingRevision: 1, agentId: 'media-agent' }));
            }
            if (path === '/music')
                return Response.json(await this.music.handle('/api/v1/tab/music', { workspaceId: this.lease.workspaceId, epoch: this.lease.epoch, tabInstanceId: this.lease.tabInstanceId, operationId: 'music-op', ...body }, this.lease));
            if (path === '/music-result')
                return Response.json(await this.music.handle('/api/v1/tab/music-result', { workspaceId: this.lease.workspaceId, epoch: this.lease.epoch, tabInstanceId: this.lease.tabInstanceId, operationId: 'music-op', ...body }, this.lease));
            if (path === '/stats') {
                const has = this.db.query("SELECT name FROM sqlite_master WHERE name='media_payloads_v1'").length;
                return Response.json({ providerCalls: this.providerCalls, preparationSignals: this.preparationSignals, binary: has ? this.db.query("SELECT count(*) count,coalesce(sum(length(payload)),0) bytes,min(typeof(payload)) type FROM media_payloads_v1")[0] : { count: 0, bytes: 0 }, legacyPayloadRows: this.db.query("SELECT count(*) count FROM records WHERE key LIKE 'image/chunk/%' OR key LIKE 'music/chunk/%'")[0], catalog: this.db.query("SELECT name FROM sqlite_master WHERE name='media_catalog_schema_v1'").length ? this.db.query('SELECT * FROM media_counters_v1 ORDER BY kind') : [], music: this.db.get('music/journal/music-op'), image: this.db.get('image/manifest/image-op/0'), usage: this.db.snapshotUsage() });
            }
            return new Response('missing', { status: 404 });
        }
        catch (error) {
            return Response.json({ error: error instanceof Error ? error.message : 'error', code: (error as {
                    code?: string;
                }).code }, { status: 409 });
        }
    }
}
export default { fetch(request: Request, env: {
        MEDIA: {
            idFromName(n: string): unknown;
            get(id: unknown): {
                fetch(request: Request): Promise<Response>;
            };
        };
    }) { return env.MEDIA.get(env.MEDIA.idFromName('fixture')).fetch(request); } };
