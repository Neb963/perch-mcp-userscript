import { ApiError } from "./common.js";
import { readMediaMetadata, type MediaRecordStore } from "./binary-payloads.js";
type Kind = "image" | "music";
interface Counters {
    count: number;
    bytes: number;
    busy: number;
}
const PREFIX = { image: "image/manifest/", music: "music/journal/" } as const;
const WEEK = 7 * 86400000;
const tracked = (row: string) => `(${row}.key LIKE 'image/manifest/%' OR ${row}.key LIKE 'music/journal/%')`;
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
/** Rebuildable metadata only. Persistent counters and dirty tracking include legacy-binary writes. */
export class MediaCatalog {
    private initialized = false;
    constructor(private readonly db: MediaRecordStore) { }
    get available(): boolean { return typeof this.db.query === "function"; }
    initialize(): void { this.init(); }
    private init(): void {
        if (this.initialized)
            return;
        if (!this.db.query)
            throw new Error("SQLITE_SCHEMA_INCOMPATIBLE");
        if (this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='media_catalog_schema_v1'").length) {
            this.initialized = !this.db.inTransaction;
            return;
        }
        this.db.transaction(() => {
            this.db.query!("CREATE TABLE IF NOT EXISTS media_catalog_v1 (key TEXT PRIMARY KEY,kind TEXT NOT NULL,operation_id TEXT NOT NULL,bytes INTEGER NOT NULL CHECK(bytes>=0),busy INTEGER NOT NULL CHECK(busy IN (0,1)),due INTEGER) WITHOUT ROWID");
            this.db.query!("CREATE INDEX IF NOT EXISTS media_catalog_operation_v1 ON media_catalog_v1(kind,operation_id)");
            this.db.query!("CREATE INDEX IF NOT EXISTS media_catalog_due_v1 ON media_catalog_v1(kind,due) WHERE due IS NOT NULL");
            this.db.query!("CREATE INDEX IF NOT EXISTS media_catalog_payload_due_v1 ON media_catalog_v1(kind,due) WHERE bytes>0 AND due IS NOT NULL");
            this.db.query!("CREATE TABLE IF NOT EXISTS media_counters_v1 (kind TEXT PRIMARY KEY,count INTEGER NOT NULL CHECK(count>=0),bytes INTEGER NOT NULL CHECK(bytes>=0),busy INTEGER NOT NULL CHECK(busy>=0)) WITHOUT ROWID");
            this.db.query!("INSERT OR IGNORE INTO media_counters_v1 VALUES('image',0,0,0),('music',0,0,0)");
            this.db.query!("CREATE TABLE IF NOT EXISTS media_prepare_v1 (kind TEXT PRIMARY KEY,cursor TEXT NOT NULL,complete INTEGER NOT NULL CHECK(complete IN (0,1))) WITHOUT ROWID");
            this.db.query!("INSERT OR IGNORE INTO media_prepare_v1 VALUES('image','',0),('music','',0)");
            this.db.query!("CREATE TABLE IF NOT EXISTS media_dirty_v1 (key TEXT PRIMARY KEY) WITHOUT ROWID");
            this.db.query!("CREATE TRIGGER IF NOT EXISTS media_count_insert_v1 AFTER INSERT ON media_catalog_v1 BEGIN UPDATE media_counters_v1 SET count=count+1,bytes=bytes+NEW.bytes,busy=busy+NEW.busy WHERE kind=NEW.kind; END");
            this.db.query!("CREATE TRIGGER IF NOT EXISTS media_count_delete_v1 AFTER DELETE ON media_catalog_v1 BEGIN UPDATE media_counters_v1 SET count=count-1,bytes=bytes-OLD.bytes,busy=busy-OLD.busy WHERE kind=OLD.kind; END");
            this.db.query!("CREATE TRIGGER IF NOT EXISTS media_count_update_v1 AFTER UPDATE ON media_catalog_v1 BEGIN UPDATE media_counters_v1 SET bytes=bytes-OLD.bytes+NEW.bytes,busy=busy-OLD.busy+NEW.busy WHERE kind=NEW.kind; END");
            for (const [event, row] of [["INSERT", "NEW"], ["DELETE", "OLD"]] as const)
                this.db.query!(`CREATE TRIGGER IF NOT EXISTS media_dirty_${event.toLowerCase()}_v1 AFTER ${event} ON records WHEN ${tracked(row)} BEGIN INSERT INTO media_dirty_v1 VALUES(${row}.key) ON CONFLICT(key) DO NOTHING; END`);
            this.db.query!(`CREATE TRIGGER IF NOT EXISTS media_dirty_update_v1 AFTER UPDATE ON records BEGIN INSERT INTO media_dirty_v1 SELECT OLD.key WHERE ${tracked("OLD")} ON CONFLICT(key) DO NOTHING; INSERT INTO media_dirty_v1 SELECT NEW.key WHERE ${tracked("NEW")} ON CONFLICT(key) DO NOTHING; END`);
            this.db.query!("CREATE TABLE media_catalog_schema_v1(version INTEGER PRIMARY KEY CHECK(version=1))");
            this.db.query!("INSERT INTO media_catalog_schema_v1 VALUES(1)");
        });
        this.initialized = !this.db.inTransaction;
    }
    private syncKey(key: string): void {
        const kind: Kind = key.startsWith(PREFIX.image) ? "image" : key.startsWith(PREFIX.music) ? "music" : (() => { throw new Error("SQLITE_RECORD_CORRUPT"); })();
        const value = readMediaMetadata<Record<string, unknown>>(this.db, key);
        if (value === undefined)
            this.db.query!("DELETE FROM media_catalog_v1 WHERE key=?", key);
        else {
            if (!value || typeof value !== "object" || typeof value.operationId !== "string" || !value.operationId.length)
                throw new Error("SQLITE_RECORD_CORRUPT");
            let bytes: number, busy = 0, due: number | null = null;
            if (kind === "image") {
                if (!integer(value.byteLength) || value.byteLength === 0 || !integer(value.expiresAt) || !["STAGING", "READY"].includes(String(value.state)))
                    throw new Error("SQLITE_RECORD_CORRUPT");
                bytes = value.byteLength;
                due = value.expiresAt;
            }
            else {
                if (!integer(value.bytes) || !integer(value.createdAt) || typeof value.phase !== "string" || !["INTENT", "READY", "REJECTED", "UNKNOWN", "DELIVERED", "EXPIRED"].includes(value.phase))
                    throw new Error("SQLITE_RECORD_CORRUPT");
                bytes = value.bytes;
                busy = value.phase === "INTENT" || bytes > 0 ? 1 : 0;
                const deadlines: number[] = [];
                if (bytes > 0) {
                    if (!integer(value.expiresAt))
                        throw new Error("SQLITE_RECORD_CORRUPT");
                    deadlines.push(value.expiresAt);
                }
                if (["DELIVERED", "EXPIRED", "REJECTED"].includes(value.phase))
                    deadlines.push(value.createdAt + WEEK);
                due = deadlines.length ? Math.min(...deadlines) : null;
            }
            this.db.query!("INSERT INTO media_catalog_v1 VALUES(?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET operation_id=excluded.operation_id,bytes=excluded.bytes,busy=excluded.busy,due=excluded.due WHERE media_catalog_v1.operation_id<>excluded.operation_id OR media_catalog_v1.bytes<>excluded.bytes OR media_catalog_v1.busy<>excluded.busy OR media_catalog_v1.due IS NOT excluded.due", key, kind, value.operationId, bytes, busy, due);
        }
        this.db.query!("DELETE FROM media_dirty_v1 WHERE key=?", key);
    }
    /** Use after the owning metadata write, in the same transaction. */
    changed(key: string): void { if (!this.available)
        return; this.init(); this.syncKey(key); }
    /** At most 128 legacy metadata records plus 128 dirty records, with a durable cursor. */
    prepare(kind: Kind, limit = 128): boolean {
        if (!this.available)
            return true;
        this.init();
        return this.db.transaction(() => {
            const state = this.db.query!<{
                cursor: string;
                complete: number;
            }>("SELECT cursor,complete FROM media_prepare_v1 WHERE kind=?", kind)[0];
            if (!state)
                throw new Error("SQLITE_RECORD_CORRUPT");
            const prefix = PREFIX[kind], bound = Math.min(128, Math.max(1, limit));
            if (!state.complete) {
                if (state.cursor !== "" && !state.cursor.startsWith(prefix)) throw new Error("SQLITE_RECORD_CORRUPT");
                const rows = state.cursor === ""
                    ? this.db.query!<{key: string}>("SELECT DISTINCT key FROM records WHERE key>=? AND key<? ORDER BY key LIMIT ?", prefix, prefix + "\uffff", bound)
                    : this.db.query!<{key: string}>("SELECT DISTINCT key FROM records WHERE key>? AND key<? ORDER BY key LIMIT ?", state.cursor, prefix + "\uffff", bound);
                for (const { key } of rows)
                    this.syncKey(key);
                const cursor = rows.at(-1)?.key ?? state.cursor, complete = rows.length < bound ? 1 : 0;
                this.db.query!("UPDATE media_prepare_v1 SET cursor=?,complete=? WHERE kind=?", cursor, complete, kind);
            }
            const dirty = this.db.query!<{
                key: string;
            }>("SELECT key FROM media_dirty_v1 WHERE key>=? AND key<? ORDER BY key LIMIT ?", prefix, prefix + "\uffff", bound);
            for (const { key } of dirty)
                this.syncKey(key);
            return !!this.db.query!<{
                complete: number;
            }>("SELECT complete FROM media_prepare_v1 WHERE kind=?", kind)[0]?.complete && !this.db.query!("SELECT key FROM media_dirty_v1 WHERE key>=? AND key<? LIMIT 1", prefix, prefix + "\uffff").length;
        });
    }
    /** Read-only operator diagnostic; partial counts describe indexed metadata, not provider capacity. */
    status(kind: Kind): Record<string, unknown> {
        if (!this.db.query || !this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='media_catalog_schema_v1'").length)
            return { stage: "UNINITIALIZED", indexedCount: null, indexedReservedBytes: null, indexedBusy: null };
        const state = this.db.query<{complete:number}>("SELECT complete FROM media_prepare_v1 WHERE kind=?", kind)[0];
        const counts = this.db.query<{count:number;bytes:number;busy:number}>("SELECT count,bytes,busy FROM media_counters_v1 WHERE kind=?", kind)[0];
        if (!state || ![0,1].includes(state.complete) || !counts || !integer(counts.count) || !integer(counts.bytes) || !integer(counts.busy))
            throw new Error("SQLITE_RECORD_CORRUPT");
        const prefix = PREFIX[kind];
        const dirty = this.db.query("SELECT key FROM media_dirty_v1 WHERE key>=? AND key<? LIMIT 1", prefix, prefix + "\uffff").length > 0;
        return { stage: state.complete && !dirty ? "READY" : "PREPARE", indexedCount: counts.count, indexedReservedBytes: counts.bytes, indexedBusy: counts.busy };
    }
    counters(kind: Kind): Counters {
        if (!this.prepare(kind))
            throw new ApiError("TAB_BUSY", "Media storage preparation is incomplete; no new media effect was started.", 503, "Retry new admission after bounded storage maintenance; retain existing operation evidence.");
        const result = this.db.query!<{
            count: number;
            bytes: number;
            busy: number;
        }>("SELECT count,bytes,busy FROM media_counters_v1 WHERE kind=?", kind)[0];
        if (!result || !integer(result.count) || !integer(result.bytes) || !integer(result.busy))
            throw new Error("SQLITE_RECORD_CORRUPT");
        return result;
    }
    operationBytes(kind: Kind, operationId: string): number {
        const result = this.db.query!<{
            bytes: number;
        }>("SELECT coalesce(sum(bytes),0) bytes FROM media_catalog_v1 WHERE kind=? AND operation_id=?", kind, operationId)[0];
        if (!result || !integer(result.bytes))
            throw new Error("SQLITE_RECORD_CORRUPT");
        return result.bytes;
    }
    due(kind: Kind, now: number, payloadOnly = false): string[] {
        this.prepare(kind);
        return this.db.query!<{
            key: string;
        }>(`SELECT key FROM media_catalog_v1 WHERE kind=? AND due IS NOT NULL ${payloadOnly ? "AND bytes>0 " : ""}AND due<=? ORDER BY due LIMIT 128`, kind, now).map(row => row.key);
    }
    nextDue(kind: Kind, payloadOnly = false): number | undefined {
        this.prepare(kind);
        return this.db.query!<{
            due: number;
        }>(`SELECT due FROM media_catalog_v1 WHERE kind=? AND due IS NOT NULL ${payloadOnly ? "AND bytes>0 " : ""}ORDER BY due LIMIT 1`, kind)[0]?.due;
    }
}
const catalogs = new WeakMap<MediaRecordStore, MediaCatalog>();
export function mediaCatalog(db: MediaRecordStore): MediaCatalog { let result = catalogs.get(db); if (!result) {
    result = new MediaCatalog(db);
    catalogs.set(db, result);
} return result; }
