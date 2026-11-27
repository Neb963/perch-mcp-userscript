import { errorCodes } from "../../../packages/contracts/src/errors.js";
import { SqlRecords } from "./sql.js";

const DAY = 86400000;
const RETENTION = 7 * DAY;
export const OAUTH_DIAGNOSTIC_DAILY_CAP = 256;
export const OAUTH_DIAGNOSTIC_VISIBLE_CAP = 100;
const ROUTES = ["authorize", "authorize_complete", "token", "register"] as const;
const ORIGINS = ["missing", "null", "same", "perchance", "chatgpt", "other"] as const;
const CODES = new Set<string>([...errorCodes,
  "CALLBACK_REDIRECT_ISSUED", "CALLBACK_RECOVERY_AVAILABLE", "TOKEN_EXCHANGE_SUCCEEDED",
  "REDIRECT_ISSUED", "HTTP_ERROR", "PENDING_OR_INFO", "INTERNAL_ERROR", "SETUP_REQUIRED",
  "CONFLICT", "EXPIRED", "INVALID_TARGET", "PAUSED", "GATEWAY_DEGRADED",
  "IDEMPOTENCY_CONFLICT", "UNCLASSIFIED",
]);
type DiagnosticInput = {
  route: typeof ROUTES[number]; method: "GET" | "POST"; originClass: typeof ORIGINS[number];
  status: number; code: string; traceId: string;
};
export interface OAuthDiagnosticEvent extends DiagnosticInput { at: number }
type Budget = {
  version: number; day: number; count: number; next_seq: number; row_count: number; last_seen: number;
};
const INPUT_KEYS = ["route", "method", "originClass", "status", "code", "traceId"];
function validNow(now: number): boolean { return Number.isSafeInteger(now) && now >= 0; }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function project(value: unknown, legacy = false): DiagnosticInput | undefined {
  if (!object(value) || (!legacy && Object.keys(value).some(key => !INPUT_KEYS.includes(key)))) return;
  const { route, method, originClass, status, code, traceId } = value;
  if (!ROUTES.includes(route as typeof ROUTES[number]) || (method !== "GET" && method !== "POST") ||
    !ORIGINS.includes(originClass as typeof ORIGINS[number]) || typeof status !== "number" ||
    !Number.isInteger(status) || status < 200 || status > 599 || typeof code !== "string" ||
    typeof traceId !== "string" || !/^[a-f0-9-]{36}$/.test(traceId) || (!legacy && !CODES.has(code))) return;
  return { route: route as DiagnosticInput["route"], method: method as "GET" | "POST",
    originClass: originClass as DiagnosticInput["originClass"], status,
    code: CODES.has(code) ? code : "UNCLASSIFIED", traceId };
}
function exists(db: SqlRecords): boolean {
  return db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='oauth_diagnostic_budget_v1'").length > 0;
}
function legacyRows(db: SqlRecords, now: number): OAuthDiagnosticEvent[] {
  // The old writer retained <=100 fixed-field events. Corrupt oversized history
  // must not force a whole-record allocation during manual diagnostics.
  const rows = db.query<{ part: number; value: string }>("SELECT part,value FROM records WHERE key='diagnostic-events' ORDER BY part LIMIT 5");
  if (!rows.length || rows.length === 5 || rows.some((row, index) => row.part !== index || row.value.length > 32000) ||
    rows.reduce((bytes, row) => bytes + new TextEncoder().encode(row.value).byteLength, 0) > 128 * 1024) return [];
  let value: unknown;
  try { value = JSON.parse(rows.map(row => row.value).join("")); } catch { return []; }
  if (!Array.isArray(value)) return [];
  return value.slice(-OAUTH_DIAGNOSTIC_VISIBLE_CAP).flatMap(row => {
    const safe = project(row, true), at = object(row) ? row.at : undefined;
    return safe && typeof at === "number" && validNow(at) && at > now - RETENTION ? [{ at, ...safe }] : [];
  });
}
function initialBudget(db: SqlRecords, now: number): Budget {
  const today = Math.floor(now / DAY);
  let day = today, count = 0;
  try {
    const old = db.get<unknown>("diagnostic-budget");
    if (old !== undefined) {
      if (object(old) && Number.isSafeInteger(old.minute) && Number(old.minute) >= 0 &&
        Number.isSafeInteger(Number(old.minute) * 60000) && Number.isSafeInteger(old.count) &&
        Number(old.count) >= 0 && Number(old.count) <= 120) {
        const oldDay = Math.floor(Number(old.minute) / 1440);
        if (oldDay >= today) { day = oldDay; count = OAUTH_DIAGNOSTIC_DAILY_CAP; }
      } else count = OAUTH_DIAGNOSTIC_DAILY_CAP;
    } else if (db.query("SELECT key FROM records WHERE key='diagnostic-events' LIMIT 1").length) {
      // History without its old budget cannot prove current-day headroom.
      count = OAUTH_DIAGNOSTIC_DAILY_CAP;
    }
  } catch { count = OAUTH_DIAGNOSTIC_DAILY_CAP; }
  return { version: 1, day, count, next_seq: 0, row_count: 0, last_seen: now };
}
function initialize(db: SqlRecords, now: number): void {
  if (exists(db)) return;
  const budget = initialBudget(db, now);
  db.query("CREATE TABLE oauth_diagnostic_budget_v1 (id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,day INTEGER NOT NULL,count INTEGER NOT NULL CHECK(count>=0 AND count<=256),next_seq INTEGER NOT NULL,row_count INTEGER NOT NULL CHECK(row_count>=0 AND row_count<=100),last_seen INTEGER NOT NULL)");
  db.query("INSERT INTO oauth_diagnostic_budget_v1 VALUES(1,?,?,?,?,?,?)", budget.version, budget.day, budget.count, budget.next_seq, budget.row_count, budget.last_seen);
  db.query("CREATE TABLE oauth_diagnostic_event_v1 (sequence INTEGER PRIMARY KEY,at INTEGER NOT NULL,route TEXT NOT NULL,method TEXT NOT NULL,originClass TEXT NOT NULL,status INTEGER NOT NULL,code TEXT NOT NULL,traceId TEXT NOT NULL UNIQUE)");
}
function budgetRow(db: SqlRecords): Budget {
  const row = db.query<Budget & Record<string, number>>("SELECT version,day,count,next_seq,row_count,last_seen FROM oauth_diagnostic_budget_v1 WHERE id=1")[0];
  if (!row || row.version !== 1 || Object.values(row).some(value => !Number.isSafeInteger(value) || value < 0) ||
    row.count > OAUTH_DIAGNOSTIC_DAILY_CAP || row.row_count > OAUTH_DIAGNOSTIC_VISIBLE_CAP)
    throw new Error("OAUTH_DIAGNOSTIC_STORAGE_UNAVAILABLE");
  return row;
}

/** Best effort only. Failure or missing accounting never blocks OAuth or resets its daily cap. */
export function appendOAuthDiagnostic(db: SqlRecords, event: unknown, now = Date.now()): boolean {
  try {
    const safe = project(event);
    if (!safe || !validNow(now)) return false;
    // SqlRecords nests transactions without savepoints. Never let a caught
    // auxiliary failure partially mutate a caller's authorization transaction.
    if (db.inTransaction) return false;
    return db.transaction(() => {
      initialize(db, now);
      const budget = budgetRow(db), day = Math.floor(now / DAY);
      // UTC identity never moves backwards. A bad/future clock cannot refill an earlier day.
      if (day < budget.day) return false;
      const count = day === budget.day ? budget.count : 0;
      if (count >= OAUTH_DIAGNOSTIC_DAILY_CAP) return false;
      if (db.query("SELECT sequence FROM oauth_diagnostic_event_v1 WHERE traceId=?", safe.traceId).length) return false;
      let rowCount = budget.row_count;
      if (rowCount >= OAUTH_DIAGNOSTIC_VISIBLE_CAP) {
        const oldest = db.query<{ sequence: number }>("SELECT sequence FROM oauth_diagnostic_event_v1 ORDER BY sequence LIMIT 1")[0];
        if (!oldest) throw new Error("OAUTH_DIAGNOSTIC_STORAGE_UNAVAILABLE");
        db.query("DELETE FROM oauth_diagnostic_event_v1 WHERE sequence=?", oldest.sequence);
        rowCount--;
      }
      const sequence = budget.next_seq + 1;
      if (!Number.isSafeInteger(sequence)) throw new Error("OAUTH_DIAGNOSTIC_STORAGE_UNAVAILABLE");
      db.query("INSERT INTO oauth_diagnostic_event_v1 VALUES(?,?,?,?,?,?,?,?)", sequence, now,
        safe.route, safe.method, safe.originClass, safe.status, safe.code, safe.traceId);
      db.query("UPDATE oauth_diagnostic_budget_v1 SET day=?,count=?,next_seq=?,row_count=?,last_seen=? WHERE id=1",
        day, count + 1, sequence, rowCount + 1, Math.max(now, budget.last_seen));
      return true;
    });
  } catch { return false; }
}

/** Explicit diagnostic reads never initialize tables, prune rows, or write counters. */
export function readOAuthDiagnostics(db: SqlRecords, now = Date.now()): OAuthDiagnosticEvent[] {
  if (!validNow(now)) return [];
  const history = legacyRows(db, now);
  if (exists(db)) {
    budgetRow(db); // Unknown/missing accounting is unavailable, not a guessed empty history.
    const rows = db.query<OAuthDiagnosticEvent & Record<string, string | number>>("SELECT at,route,method,originClass,status,code,traceId FROM oauth_diagnostic_event_v1 WHERE at>? ORDER BY sequence DESC LIMIT 100", now - RETENTION);
    for (const row of rows.reverse()) {
      const safe = project(row, true);
      if (safe && validNow(row.at)) history.push({ at: row.at, ...safe });
    }
  }
  // The legacy array is retained for rollback/history. Project only fixed fields
  // and merge duplicate request traces without copying any imported extra data.
  const byTrace = new Map<string, OAuthDiagnosticEvent>();
  for (const event of history) byTrace.set(event.traceId, event);
  return [...byTrace.values()].sort((a, b) => a.at - b.at).slice(-OAUTH_DIAGNOSTIC_VISIBLE_CAP);
}
