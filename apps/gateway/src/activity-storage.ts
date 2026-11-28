import { ApiError } from "./common.js";
import { SqlRecords } from "./sql.js";

export type ActivityEvent = Record<string, unknown>;
export type ActivityStorageMode = "legacy" | "prepare" | "native";
type Stage = "LEGACY" | "PREPARE" | "BACKFILL" | "BACKFILL_NOTICES" |
  "VERIFY" | "VERIFY_NOTICES" | "VERIFY_ROWS" | "VERIFIED" | "NATIVE" | "BLOCKED";
type Parser = {
  part: number; offset: number; sequence: number;
  phase: "start" | "valueOrEnd" | "value" | "separator" | "finished";
  token: string; depth: number; quoted: boolean; escaped: boolean;
};
type Progress = { parser?: Parser; cursor?: string; reason?: string };
type Meta = {
  version: number; stage: Stage; generation: number; sequence: number;
  revision: number; progress: string;
};
type Entry = {
  key: string; base: string | null; notice: string | null; serial: number | null;
  workspace: string; phase: string; rank: number; sort_time: number;
  verified_base: number; verified_notice: number;
};
export interface ActivityMigrationStatus {
  version: 2; stage: Stage; authority: "legacy" | "native";
  sequence: number; revision: number; part?: number;
  rollback: "legacy-compatible" | "compatible-binary-required";
  reason?: string;
}
export interface ActivityPage {
  items: ActivityEvent[]; revision: number; cursor: string | null;
}
const STAGES: readonly string[] = ["LEGACY", "PREPARE", "BACKFILL", "BACKFILL_NOTICES",
  "VERIFY", "VERIFY_NOTICES", "VERIFY_ROWS", "VERIFIED", "NATIVE", "BLOCKED"];
const HISTORY = 1000;
const MAX_EVENT_BYTES = 512 * 1024;
const MAX_BATCH = 32;
const NOTICE_PREFIX = "terminal-notice/";
const isUncertain = (phase: unknown) => phase === "UNKNOWN" || phase === "PARTIAL";
class CorruptActivity extends Error {
  constructor() { super("SQLITE_RECORD_CORRUPT"); }
}
function parser(): Parser {
  return { part: 0, offset: 0, sequence: 0, phase: "start", token: "", depth: 0,
    quoted: false, escaped: false };
}
function validateEvent(value: unknown): ActivityEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CorruptActivity();
  const event = value as ActivityEvent;
  for (const field of ["workspaceId", "operationId", "phase"])
    if (typeof event[field] !== "string" || !event[field] || String(event[field]).length > 256)
      throw new CorruptActivity();
  if (new TextEncoder().encode(JSON.stringify(event)).byteLength > MAX_EVENT_BYTES)
    throw new CorruptActivity();
  return event;
}
function eventKey(event: ActivityEvent): string {
  return String(event.workspaceId) + "/" + String(event.operationId);
}
function sortFields(event: ActivityEvent) {
  const number = (n: unknown) => typeof n === "number" && Number.isFinite(n) ? n : 0;
  const resolution = event.resolution as { timestamp?: unknown } | null | undefined;
  return {
    workspace: String(event.workspaceId), phase: String(event.phase),
    rank: Number(!(isUncertain(event.phase) && !event.resolution)),
    sortTime: -Math.max(number(event.timestamp), number(resolution?.timestamp)),
  };
}
function stale(): never {
  throw new ApiError("STALE_REVISION", "Activity changed; restart the list.", 409);
}
function encodeCursor(value: unknown): string {
  return "a2." + btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value)))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function decodeCursor(raw: string): Record<string, unknown> {
  if (!raw.startsWith("a2.") || raw.length > 4096 || !/^a2\.[A-Za-z0-9_-]+$/.test(raw)) stale();
  try {
    const binary = atob(raw.slice(3).replaceAll("-", "+").replaceAll("_", "/"));
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, char => char.charCodeAt(0))));
    if (!value || typeof value !== "object" || Array.isArray(value)) stale();
    return value as Record<string, unknown>;
  } catch { return stale(); }
}

/** Individual canonical Activity entries. Legacy snapshots are retained, never used after cutover. */
export class CanonicalActivity {
  constructor(private readonly db: SqlRecords) {
    if (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='canonical_activity_meta_v2'").length)
      return;
    db.transaction(() => {
      db.query("CREATE TABLE canonical_activity_meta_v2 (singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL,stage TEXT NOT NULL,generation INTEGER NOT NULL,sequence INTEGER NOT NULL,revision INTEGER NOT NULL,progress TEXT NOT NULL)");
      db.query("INSERT INTO canonical_activity_meta_v2 VALUES(1,2,'LEGACY',0,0,0,'{}')");
      db.query("CREATE TABLE canonical_activity_source_v2 (singleton INTEGER PRIMARY KEY CHECK(singleton=1),generation INTEGER NOT NULL)");
      db.query("INSERT INTO canonical_activity_source_v2 VALUES(1,0)");
      db.query("CREATE TABLE canonical_activity_v2 (key TEXT PRIMARY KEY,base TEXT,notice TEXT,serial INTEGER,workspace TEXT NOT NULL,phase TEXT NOT NULL,rank INTEGER NOT NULL CHECK(rank IN (0,1)),sort_time INTEGER NOT NULL,verified_base INTEGER NOT NULL DEFAULT 0,verified_notice INTEGER NOT NULL DEFAULT 0,CHECK(base IS NOT NULL OR notice IS NOT NULL),CHECK((base IS NULL AND serial IS NULL) OR (base IS NOT NULL AND serial IS NOT NULL))) WITHOUT ROWID");
      db.query("CREATE INDEX canonical_activity_order_v2 ON canonical_activity_v2(rank,sort_time,key)");
      db.query("CREATE INDEX canonical_activity_workspace_v2 ON canonical_activity_v2(workspace,rank,sort_time,key)");
      db.query("CREATE INDEX canonical_activity_phase_v2 ON canonical_activity_v2(phase,rank,sort_time,key)");
      // Combined Workspace + phase pagination is already bounded by the
      // Workspace index and 1000-entry canonical retention. Omitting this
      // additional B-tree on new installations saves an Activity-index write
      // per terminal without weakening Activity snapshots, keyset cursors or
      // migration verification. Existing databases keep their physical index.
      db.query("CREATE INDEX canonical_activity_serial_v2 ON canonical_activity_v2(serial) WHERE base IS NOT NULL");
      for (const [event, row] of [["INSERT", "NEW"], ["UPDATE", "NEW"], ["DELETE", "OLD"]] as const) {
        const tracked = `${row}.key='activity' OR ${row}.key LIKE 'terminal-notice/%'` +
          (event === "UPDATE" ? " OR OLD.key='activity' OR OLD.key LIKE 'terminal-notice/%'" : "");
        db.query(`CREATE TRIGGER canonical_activity_source_${event.toLowerCase()}_v2 AFTER ${event} ON records WHEN ${tracked} BEGIN UPDATE canonical_activity_source_v2 SET generation=generation+1 WHERE singleton=1; END`);
        // Old binaries must fail closed instead of silently writing a stale retained snapshot.
        const activity = `${row}.key='activity'` + (event === "UPDATE" ? " OR OLD.key='activity'" : "");
        db.query(`CREATE TRIGGER canonical_activity_guard_${event.toLowerCase()}_v2 BEFORE ${event} ON records WHEN (${activity}) AND (SELECT stage FROM canonical_activity_meta_v2 WHERE singleton=1)='NATIVE' BEGIN SELECT RAISE(ABORT,'ACTIVITY_NATIVE_REQUIRES_COMPATIBLE_BINARY'); END`);
      }
    });
  }
  private meta(): Meta {
    const meta = this.db.query<Meta & Record<string, string | number | null>>("SELECT version,stage,generation,sequence,revision,progress FROM canonical_activity_meta_v2 WHERE singleton=1")[0];
    if (!meta || meta.version !== 2 || !STAGES.includes(meta.stage) ||
      !Number.isSafeInteger(meta.sequence) || meta.sequence < 0 || !Number.isSafeInteger(meta.revision) || meta.revision < 0)
      throw new CorruptActivity();
    return meta;
  }
  private progress(meta: Meta): Progress {
    try {
      const progress = JSON.parse(meta.progress) as Progress;
      if (!progress || typeof progress !== "object" || Array.isArray(progress)) throw new Error();
      return progress;
    } catch { throw new CorruptActivity(); }
  }
  private save(meta: Meta, progress: Progress): void {
    this.db.query("UPDATE canonical_activity_meta_v2 SET stage=?,generation=?,sequence=?,revision=?,progress=? WHERE singleton=1",
      meta.stage, meta.generation, meta.sequence, meta.revision, JSON.stringify(progress));
  }
  private generation(): number {
    const value = this.db.query<{ generation: number }>("SELECT generation FROM canonical_activity_source_v2 WHERE singleton=1")[0]?.generation;
    if (!Number.isSafeInteger(value) || Number(value) < 0) throw new CorruptActivity();
    return Number(value);
  }
  isNative(): boolean { return this.meta().stage === "NATIVE"; }
  status(): ActivityMigrationStatus {
    const meta = this.meta(), progress = this.progress(meta), native = meta.stage === "NATIVE";
    return { version: 2, stage: meta.stage, authority: native ? "native" : "legacy", sequence: meta.sequence,
      revision: meta.revision, rollback: native ? "compatible-binary-required" : "legacy-compatible",
      ...(progress.parser ? { part: progress.parser.part } : {}),
      ...(progress.reason ? { reason: progress.reason } : {}) };
  }
  private entry(key: string): Entry | undefined {
    return this.db.query<Entry & Record<string, string | number | null>>("SELECT * FROM canonical_activity_v2 WHERE key=?", key)[0];
  }
  private putSide(key: string, side: "base" | "notice", event: ActivityEvent | null, serial?: number): boolean {
    const old = this.entry(key), encoded = event === null ? null : JSON.stringify(validateEvent(event));
    if ((old?.[side] ?? null) === encoded && (side !== "base" || encoded === null || old?.serial === serial)) return false;
    const base = side === "base" ? encoded : old?.base ?? null;
    const notice = side === "notice" ? encoded : old?.notice ?? null;
    if (base === null && notice === null) {
      this.db.query("DELETE FROM canonical_activity_v2 WHERE key=?", key);
      return true;
    }
    const effective = validateEvent(JSON.parse((notice ?? base)!));
    if (eventKey(effective) !== key) throw new CorruptActivity();
    const fields = sortFields(effective);
    const nextSerial = base === null ? null : side === "base" ? serial : old!.serial;
    if (base !== null && !Number.isSafeInteger(nextSerial)) throw new CorruptActivity();
    this.db.query("INSERT INTO canonical_activity_v2(key,base,notice,serial,workspace,phase,rank,sort_time,verified_base,verified_notice) VALUES(?,?,?,?,?,?,?,?,0,0) ON CONFLICT(key) DO UPDATE SET base=excluded.base,notice=excluded.notice,serial=excluded.serial,workspace=excluded.workspace,phase=excluded.phase,rank=excluded.rank,sort_time=excluded.sort_time,verified_base=0,verified_notice=0",
      key, base, notice, nextSerial ?? null, fields.workspace, fields.phase, fields.rank, fields.sortTime);
    return true;
  }
  private trim(sequence: number, limit: number): void {
    const due = this.db.query<{ key: string }>("SELECT key FROM canonical_activity_v2 WHERE base IS NOT NULL AND serial<=? ORDER BY serial LIMIT ?", sequence - HISTORY, limit);
    for (const { key } of due) this.putSide(key, "base", null);
  }
  append(event: ActivityEvent): void {
    this.db.transaction(() => {
      const meta = this.meta();
      if (meta.stage !== "NATIVE") throw new Error("ACTIVITY_NOT_NATIVE");
      const key = eventKey(validateEvent(event)), existing = this.entry(key);
      if (existing?.base !== null && existing?.base !== undefined) {
        if (existing.base === JSON.stringify(event)) return;
        throw new ApiError("CONFLICT", "Activity cannot rewrite the original outcome.", 409);
      }
      meta.sequence++;
      if (!Number.isSafeInteger(meta.sequence)) throw new CorruptActivity();
      this.putSide(key, "base", event, meta.sequence);
      this.trim(meta.sequence, 1);
      meta.revision++;
      this.save(meta, this.progress(meta));
    });
  }
  /** Receipt overlays have a distinct lifetime from the ordinary 1000-entry visibility window. */
  setNotice(key: string, event: ActivityEvent | null): void {
    this.db.transaction(() => {
      const meta = this.meta();
      if (meta.stage !== "NATIVE") throw new Error("ACTIVITY_NOT_NATIVE");
      if (this.putSide(key, "notice", event)) {
        meta.revision++;
        this.save(meta, this.progress(meta));
      }
    });
  }
  resolve(workspaceId: string, operationId: string, resolution: unknown): void {
    this.db.transaction(() => {
      const meta = this.meta();
      if (meta.stage !== "NATIVE") throw new Error("ACTIVITY_NOT_NATIVE");
      const key = workspaceId + "/" + operationId, old = this.entry(key);
      if (!old) return;
      let changed = false;
      for (const side of ["base", "notice"] as const)
        if (old[side] !== null) changed = this.putSide(key, side, {
          ...validateEvent(JSON.parse(old[side]!)), resolution,
        }, old.serial ?? undefined) || changed;
      if (changed) { meta.revision++; this.save(meta, this.progress(meta)); }
    });
  }
  page(raw: string | null, status: string | null, workspace: string | null, revision: number): ActivityPage {
    const meta = this.meta();
    if (meta.stage !== "NATIVE") throw new Error("ACTIVITY_NOT_NATIVE");
    const where: string[] = [], values: (string | number | null)[] = [];
    if (workspace) { where.push("workspace=?"); values.push(workspace); }
    if (status) { where.push("phase=?"); values.push(status); }
    if (raw) {
      const cursor = decodeCursor(raw);
      if (cursor.version !== 2 || cursor.revision !== revision || cursor.activityRevision !== meta.revision ||
        cursor.workspace !== workspace || cursor.status !== status || (cursor.rank !== 0 && cursor.rank !== 1) ||
        typeof cursor.sortTime !== "number" || !Number.isFinite(cursor.sortTime) || typeof cursor.key !== "string") stale();
      where.push("(rank,sort_time,key)>(?,?,?)");
      values.push(Number(cursor.rank), cursor.sortTime, cursor.key);
    }
    const rows = this.db.query<Entry & Record<string, string | number | null>>(
      "SELECT key,base,notice,rank,sort_time FROM canonical_activity_v2" + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY rank,sort_time,key LIMIT 101", ...values);
    const last = rows[Math.min(rows.length, 100) - 1];
    return { items: rows.slice(0, 100).map(row => validateEvent(JSON.parse((row.notice ?? row.base)!))), revision,
      cursor: rows.length > 100 && last ? encodeCursor({ version: 2, revision, activityRevision: meta.revision,
        workspace, status, rank: last.rank, sortTime: last.sort_time, key: last.key }) : null };
  }
  /** Scan at most one legacy 32k-character chunk and `limit` events; never materialize the whole array. */
  private scanArray(state: Parser, visit: (event: ActivityEvent, serial: number) => void, limit: number): boolean {
    if (!Number.isSafeInteger(state.part) || state.part < 0 || !Number.isSafeInteger(state.offset) || state.offset < 0 ||
      !Number.isSafeInteger(state.sequence) || state.sequence < 0 || typeof state.token !== "string" || state.token.length > MAX_EVENT_BYTES ||
      !["start", "valueOrEnd", "value", "separator", "finished"].includes(state.phase) ||
      !Number.isSafeInteger(state.depth) || state.depth < 0 || state.depth > MAX_EVENT_BYTES ||
      typeof state.quoted !== "boolean" || typeof state.escaped !== "boolean" ||
      (!state.token && (state.depth !== 0 || state.quoted || state.escaped)))
      throw new CorruptActivity();
    const row = this.db.query<{ part: number; value: string }>("SELECT part,value FROM records WHERE key='activity' AND part>=? ORDER BY part LIMIT 1", state.part)[0];
    if (!row) {
      if (state.phase === "finished" || (state.phase === "start" && state.part === 0)) return true;
      throw new CorruptActivity();
    }
    if (row.part !== state.part || state.offset > row.value.length || row.value.length > 32000) throw new CorruptActivity();
    let emitted = 0;
    for (; state.offset < row.value.length;) {
      const char = row.value[state.offset++]!;
      if (state.token) {
        state.token += char;
        if (state.token.length > MAX_EVENT_BYTES) throw new CorruptActivity();
        if (state.quoted) {
          if (state.escaped) state.escaped = false;
          else if (char === "\\") state.escaped = true;
          else if (char === '"') state.quoted = false;
        } else if (char === '"') state.quoted = true;
        else if (char === "{" || char === "[") state.depth++;
        else if (char === "}" || char === "]") state.depth--;
        if (state.depth === 0) {
          let value: unknown;
          try { value = JSON.parse(state.token); } catch { throw new CorruptActivity(); }
          visit(validateEvent(value), ++state.sequence);
          state.token = ""; state.phase = "separator";
          if (++emitted >= limit) break;
        }
        continue;
      }
      if (/[ \t\r\n]/.test(char)) continue;
      if (state.phase === "start") {
        if (char !== "[") throw new CorruptActivity();
        state.phase = "valueOrEnd";
      } else if (state.phase === "separator") {
        if (char === ",") state.phase = "value";
        else if (char === "]") state.phase = "finished";
        else throw new CorruptActivity();
      } else if (state.phase === "value" || state.phase === "valueOrEnd") {
        if (char === "]" && state.phase === "valueOrEnd") state.phase = "finished";
        else if (char === "{") { state.token = "{"; state.depth = 1; }
        else throw new CorruptActivity();
      } else throw new CorruptActivity();
    }
    if (new TextEncoder().encode(state.token).byteLength > MAX_EVENT_BYTES) throw new CorruptActivity();
    if (state.offset === row.value.length) { state.part++; state.offset = 0; }
    return false;
  }
  private noticeKeys(cursor: string, limit: number): string[] {
    return this.db.query<{ key: string }>("SELECT DISTINCT key FROM records WHERE key>=? AND key<? AND key>? ORDER BY key LIMIT ?", NOTICE_PREFIX, NOTICE_PREFIX + "\uffff", cursor, limit).map(row => row.key);
  }
  private noticeEvent(key: string): { event: ActivityEvent | null; bytes: number } {
    // A terminal notice is request-bounded. Reject malformed/unbounded legacy values before allocating them.
    const parts = this.db.query<{ part: number; value: string }>("SELECT part,value FROM records WHERE key=? ORDER BY part LIMIT 18", key);
    let bytes = 0;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i]!.part !== i || parts[i]!.value.length > 32000) throw new CorruptActivity();
      bytes += new TextEncoder().encode(parts[i]!.value).byteLength;
    }
    if (!parts.length || bytes > MAX_EVENT_BYTES || parts.length === 18) throw new CorruptActivity();
    let notice: Record<string, unknown>;
    try { notice = JSON.parse(parts.map(row => row.value).join("")) as Record<string, unknown>; }
    catch { throw new CorruptActivity(); }
    if (!notice || typeof notice !== "object" || Array.isArray(notice)) throw new CorruptActivity();
    if (!isUncertain(notice.phase) || !notice.event) return { event: null, bytes };
    const event = validateEvent(notice.event);
    if (eventKey(event) !== key.slice(NOTICE_PREFIX.length)) throw new CorruptActivity();
    return { event, bytes };
  }
  /** Durable, restartable bounded work. `prepare` never cuts over; `native` requires complete verification. */
  advance(mode: ActivityStorageMode, limit = MAX_BATCH): ActivityMigrationStatus {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BATCH) throw new ApiError("INVALID_INPUT", "Migration batch must be 1–32.");
    try {
      this.db.transaction(() => {
        const meta = this.meta();
        if (meta.stage === "NATIVE" || mode === "legacy" || meta.stage === "BLOCKED") return;
        let progress = this.progress(meta), generation = this.generation();
        if (meta.stage === "LEGACY" || meta.generation !== generation) {
          meta.stage = "PREPARE"; meta.generation = generation; meta.sequence = 0;
          progress = { cursor: "" };
        }
        if (meta.stage === "PREPARE") {
          const rows = this.db.query<{ key: string }>("SELECT key FROM canonical_activity_v2 ORDER BY key LIMIT ?", limit);
          for (const { key } of rows) this.db.query("DELETE FROM canonical_activity_v2 WHERE key=?", key);
          if (rows.length < limit) { meta.stage = "BACKFILL"; progress = { parser: parser() }; }
        } else if (meta.stage === "BACKFILL") {
          if (!progress.parser) throw new CorruptActivity();
          const done = this.scanArray(progress.parser, (event, serial) => {
            this.putSide(eventKey(event), "base", event, serial);
            this.trim(serial, 1);
          }, limit);
          meta.sequence = progress.parser.sequence;
          if (done) { meta.stage = "BACKFILL_NOTICES"; progress = { cursor: "" }; }
        } else if (meta.stage === "BACKFILL_NOTICES" || meta.stage === "VERIFY_NOTICES") {
          // At most 32 request-bounded notices and 1 MiB decoded input per step.
          const keys = this.noticeKeys(progress.cursor ?? "", limit), verifying = meta.stage === "VERIFY_NOTICES";
          let sourceBytes = 0;
          for (const key of keys) {
            if (sourceBytes >= MAX_EVENT_BYTES) break;
            const parsed = this.noticeEvent(key), { event } = parsed, nativeKey = key.slice(NOTICE_PREFIX.length);
            sourceBytes += parsed.bytes;
            if (verifying) {
              const actual = this.entry(nativeKey);
              if ((actual?.notice ?? null) !== (event ? JSON.stringify(event) : null)) throw new CorruptActivity();
              if (event) this.db.query("UPDATE canonical_activity_v2 SET verified_notice=1 WHERE key=?", nativeKey);
            } else if (event) this.putSide(nativeKey, "notice", event);
            progress.cursor = key;
          }
          if (!keys.length) {
            meta.stage = verifying ? "VERIFY_ROWS" : "VERIFY";
            progress = verifying ? { cursor: "" } : { parser: parser() };
          }
        } else if (meta.stage === "VERIFY") {
          if (!progress.parser) throw new CorruptActivity();
          const done = this.scanArray(progress.parser, (event, serial) => {
            if (serial <= meta.sequence - HISTORY) return;
            const row = this.entry(eventKey(event));
            if (row?.serial !== null && row?.serial !== undefined && row.serial > serial) return; // Later duplicate wins, as in the legacy Map projection.
            if (!row || row.serial !== serial || row.base !== JSON.stringify(event)) throw new CorruptActivity();
            this.db.query("UPDATE canonical_activity_v2 SET verified_base=1 WHERE key=?", row.key);
          }, limit);
          if (done) {
            if (progress.parser.sequence !== meta.sequence) throw new CorruptActivity();
            meta.stage = "VERIFY_NOTICES"; progress = { cursor: "" };
          }
        } else if (meta.stage === "VERIFY_ROWS") {
          const rows = this.db.query<Entry & Record<string, string | number | null>>("SELECT * FROM canonical_activity_v2 WHERE key>? ORDER BY key LIMIT ?", progress.cursor ?? "", limit);
          for (const row of rows) {
            if ((row.base !== null && row.verified_base !== 1) || (row.notice !== null && row.verified_notice !== 1)) throw new CorruptActivity();
            const effective = validateEvent(JSON.parse((row.notice ?? row.base)!)), fields = sortFields(effective);
            if (eventKey(effective) !== row.key || row.workspace !== fields.workspace || row.phase !== fields.phase || row.rank !== fields.rank || row.sort_time !== fields.sortTime) throw new CorruptActivity();
            progress.cursor = row.key;
          }
          if (rows.length < limit) { meta.stage = "VERIFIED"; progress = {}; }
        } else if (meta.stage === "VERIFIED" && mode === "native") {
          // All source mutations (including old raw chunk writes/deletes) increment generation.
          if (this.generation() !== meta.generation) throw new CorruptActivity();
          const core = this.db.get<Record<string, unknown>>("core");
          if (core !== undefined) {
            if (!core || typeof core !== "object" || Array.isArray(core) || (core.schemaVersion !== 1 && core.schemaVersion !== 2 &&
              !(core.schemaVersion === 3 && core.assignmentContractVersion === 2)))
              throw new CorruptActivity();
            if (core.schemaVersion === 1) this.db.put("core", { ...core, schemaVersion: 2 });
          }
          meta.stage = "NATIVE"; meta.revision++;
          for (const event of ["insert", "update", "delete"])
            this.db.query(`DROP TRIGGER canonical_activity_source_${event}_v2`);
        }
        this.save(meta, progress);
      });
    } catch (error) {
      if (error instanceof CorruptActivity) {
        this.db.transaction(() => {
          const meta = this.meta();
          if (meta.stage !== "NATIVE") { meta.stage = "BLOCKED"; this.save(meta, { reason: "INVALID_LEGACY_ACTIVITY" }); }
        });
      }
      throw error;
    }
    return this.status();
  }
  /** Operator recovery after repairing malformed legacy input; never changes native authority. */
  restart(): ActivityMigrationStatus {
    this.db.transaction(() => {
      const meta = this.meta();
      if (meta.stage === "NATIVE") throw new ApiError("CONFLICT", "Native Activity requires a compatible rollback binary.", 409);
      meta.stage = "PREPARE"; meta.generation = this.generation(); meta.sequence = 0;
      this.save(meta, { cursor: "" });
    });
    return this.status();
  }
}
