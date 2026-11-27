import { ApiError } from "./common.js";
import type { SqlRecords } from "./sql.js";
export const BINARY_CHUNK_BYTES = 192 * 1024;
export type PayloadFormat = "BLOB_V1";
export interface MediaRecordStore {
    get<T>(key: string, fallback?: T): T;
    put(key: string, value: unknown): void;
    delete(key: string): void;
    keys(prefix: string): string[];
    transaction<T>(fn: () => T): T;
    query?: SqlRecords["query"];
    readonly inTransaction?: boolean;
}
/** Validate the actual legacy chunk layout before treating metadata or Base64 as canonical. */
export function readMediaMetadata<T>(db: MediaRecordStore, key: string): T | undefined {
    if (!db.query) return db.get<T>(key);
    const rows = db.query<{part:number;value:string}>("SELECT part,value FROM records WHERE key=? ORDER BY part", key);
    if (!rows.length) return undefined;
    if (rows.some((row,index)=>row.part!==index || typeof row.value!=="string")) throw new Error("SQLITE_RECORD_CORRUPT");
    try { return JSON.parse(rows.map(row=>row.value).join("")) as T; }
    catch { throw new Error("SQLITE_RECORD_CORRUPT"); }
}
/** Format is pinned by the owning manifest. A missing native row never falls back to stale JSON. */
export class BinaryPayloads {
    private initialized = false;
    constructor(private readonly db: MediaRecordStore) { }
    available(): boolean { return typeof this.db.query === "function"; }
    prepare(): void { this.init(); }
    private init(): void {
        if (this.initialized)
            return;
        if (!this.db.query)
            throw new ApiError("INCOMPATIBLE_VERSION", "Native binary payloads require a compatible storage reader.", 409);
        if (this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='media_payloads_v1'").length) {
            this.initialized = !this.db.inTransaction;
            return;
        }
        this.db.transaction(() => {
            this.db.query!("CREATE TABLE IF NOT EXISTS media_payloads_v1 (key TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, payload BLOB NOT NULL CHECK(typeof(payload)='blob' AND length(payload) BETWEEN 1 AND 196608)) WITHOUT ROWID");
            this.db.query!("CREATE INDEX IF NOT EXISTS media_payloads_expiry_v1 ON media_payloads_v1(expires_at)");
        });
        this.initialized = !this.db.inTransaction;
    }
    put(key: string, bytes: Uint8Array, expiresAt: number): void {
        if (!bytes.length || bytes.length > BINARY_CHUNK_BYTES || !Number.isSafeInteger(expiresAt))
            throw new ApiError("INVALID_INPUT", "Native binary chunk bounds are invalid.");
        this.init();
        this.db.query!("INSERT INTO media_payloads_v1 VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET expires_at=excluded.expires_at,payload=excluded.payload WHERE media_payloads_v1.expires_at<>excluded.expires_at OR media_payloads_v1.payload<>excluded.payload", key, expiresAt, bytes.slice().buffer as ArrayBuffer);
    }
    get(key: string): Uint8Array {
        this.init();
        const row = this.db.query!<{
            payload: ArrayBuffer;
        }>("SELECT payload FROM media_payloads_v1 WHERE key=?", key)[0];
        if (!row)
            throw new ApiError("RESULT_EXPIRED", "Native binary chunk is absent; the operation was not replayed.", 410);
        if (!(row.payload instanceof ArrayBuffer) || !row.payload.byteLength || row.payload.byteLength > BINARY_CHUNK_BYTES)
            throw new Error("SQLITE_RECORD_CORRUPT");
        return new Uint8Array(row.payload);
    }
    delete(key: string): void { this.init(); this.db.query!("DELETE FROM media_payloads_v1 WHERE key=?", key); }
    /** Bounded orphan/expiry cleanup; reads still apply the owning manifest's exact TTL. */
    expire(now: number, limit = 64): void {
        if (!this.available())
            return;
        if (!this.initialized && !this.db.query!("SELECT name FROM sqlite_master WHERE type='table' AND name='media_payloads_v1'").length)
            return;
        this.init();
        this.db.query!("DELETE FROM media_payloads_v1 WHERE key IN (SELECT key FROM media_payloads_v1 WHERE expires_at<=? ORDER BY expires_at LIMIT ?)", now, Math.min(64, Math.max(1, limit)));
    }
}
