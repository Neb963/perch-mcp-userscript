import { createHash } from 'node:crypto';
import {
  ResourceLibrary, ResourceError, RESOURCE_LIMITS,
  validateResourceRevision, resourceAsInput,
  type Resource, type ResourceInput, type ResourceContext, type ResourceKind,
  type LibraryState, type Assignment, type ScopeType, type ImportPreview, type ImportDecisions,
} from '../../../packages/resource-library/src/index.js';
import { canonical } from './common.js';
import { SqlRecords } from './sql.js';

export type ResourceStorageMode = 'legacy' | 'prepare' | 'native';
type Metadata = Omit<Resource, 'body' | 'files'>;
type Phase = 'BACKFILL' | 'VERIFY' | 'NATIVE' | 'RESTART' | 'BLOCKED';
type Stage = 'root' | 'root-key' | 'root-colon' | 'root-value' | 'root-next' |
  'resource-key' | 'resource-colon' | 'resource-array' | 'resource-item' | 'resource-next' | 'resource-comma' |
  'assignment-item' | 'assignment-next' | 'string' | 'number' | 'capture' | 'done';
interface Parser {
  stage: Stage; rootKey?: string; token: string; returnStage?: Stage; escaped: boolean;
  afterComma: boolean; rootKeys: string[]; resourceIds: string[]; resourceId?: string; resourceRevisions: number;
  previousRevision: number; version?: number; revision?: number;
  capture?: { kind: 'resource' | 'assignment'; id: number; part: number; depth: number; quoted: boolean; escaped: boolean };
  nextContent: number; resources: number; revisions: number; rowBytes: number; keyBytes: number;
  assignments: number; assignmentBytes: number;
}
interface Migration {
  phase: Phase; generation: number; legacyGeneration: number; sourcePart: number; sourceOffset: number;
  sourceBytes: number; verified: boolean; parser: Parser; error?: string;
}
interface Header {
  generation: number; revision: number; resource_count: number; revision_count: number;
  row_bytes: number; key_bytes: number; assignment_count: number; assignment_bytes: number; next_content: number; next_assignment: number;
}
interface RevisionRow { id: string; revision: number; metadata: string; content_id: number; digest: string; json_bytes: number }
interface CurrentRow { id: string; revision: number; metadata: string; history_count: number }
interface AssignmentRow { scope_type: string; scope_id: string; resource_id: string; content_id: number; digest: string; seq: number; json_bytes: number }
const CHUNK_CHARS = 32000;
const MIGRATION_OBJECTS_PER_STEP = 8;
const ZERO = { schemaVersion: 1 as const, revision: 0, resources: {}, assignments: [] };
const encoder = new TextEncoder();
const size = (s: string) => encoder.encode(s).byteLength;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const corrupt = (reason = 'RESOURCE_STORAGE_CORRUPT'): never => { throw new Error(reason); };
const metadata = (resource: Resource): Metadata => { const { body: _body, files: _files, ...rest } = resource; return rest; };
const parse = <T>(value: string): T => { try { return JSON.parse(value) as T; } catch { return corrupt(); } };
const assignmentKey = (a: Assignment) => JSON.stringify([a.scopeType, a.scopeId, a.resourceId]);
function parser(): Parser {
  return { stage: 'root', token: '', escaped: false, afterComma: false, rootKeys: [], resourceIds: [], resourceRevisions: 0,
    previousRevision: 0, nextContent: 1, resources: 0, revisions: 0, rowBytes: 0, keyBytes: 0, assignments: 0, assignmentBytes: 0 };
}
// Cache only committed schema presence, never authority, marker data, or absence.
// A cached table which is later dropped still fails on the mandatory marker SELECT.
const installedSchemas = new WeakSet<SqlRecords>();
const RESOURCE_TABLES = [
  'resource_storage_v2', 'resource_legacy_generation_v2', 'resource_header_v2',
  'resource_current_v2', 'resource_revision_v2', 'resource_content_v2',
  'resource_assignment_v2', 'resource_source_digest_v2', 'resource_content_gc_v2',
] as const;
function installed(db: SqlRecords): boolean {
  if (installedSchemas.has(db)) return true;
  const rows = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN (" + RESOURCE_TABLES.map(() => '?').join(',') + ')',...RESOURCE_TABLES);
  if (!rows.length) return false;
  if (rows.length !== RESOURCE_TABLES.length) return corrupt();
  if (!db.inTransaction) installedSchemas.add(db);
  return true;
}
function install(db: SqlRecords): void {
  if (installed(db)) return;
  db.transaction(() => {
    db.query('CREATE TABLE resource_storage_v2 (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)');
    db.query('CREATE TABLE resource_legacy_generation_v2 (id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL)');
    db.query('INSERT INTO resource_legacy_generation_v2 VALUES(1,0)');
    db.query('CREATE TABLE resource_source_digest_v2 (generation INTEGER NOT NULL, part INTEGER NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(generation,part)) WITHOUT ROWID');
    db.query('CREATE TABLE resource_header_v2 (generation INTEGER PRIMARY KEY, revision INTEGER NOT NULL, resource_count INTEGER NOT NULL, revision_count INTEGER NOT NULL, row_bytes INTEGER NOT NULL, key_bytes INTEGER NOT NULL, assignment_count INTEGER NOT NULL, assignment_bytes INTEGER NOT NULL, next_content INTEGER NOT NULL, next_assignment INTEGER NOT NULL)');
    db.query('CREATE TABLE resource_current_v2 (generation INTEGER NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, metadata TEXT NOT NULL, history_count INTEGER NOT NULL, PRIMARY KEY(generation,id)) WITHOUT ROWID');
    db.query('CREATE TABLE resource_revision_v2 (generation INTEGER NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, metadata TEXT NOT NULL, content_id INTEGER NOT NULL, digest TEXT NOT NULL, json_bytes INTEGER NOT NULL, PRIMARY KEY(generation,id,revision)) WITHOUT ROWID');
    db.query('CREATE TABLE resource_content_v2 (generation INTEGER NOT NULL, content_id INTEGER NOT NULL, part INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(generation,content_id,part)) WITHOUT ROWID');
    db.query('CREATE TABLE resource_assignment_v2 (generation INTEGER NOT NULL, scope_type TEXT NOT NULL, scope_id TEXT NOT NULL, resource_id TEXT NOT NULL, content_id INTEGER NOT NULL, digest TEXT NOT NULL, seq INTEGER NOT NULL, json_bytes INTEGER NOT NULL, PRIMARY KEY(generation,scope_type,scope_id,resource_id)) WITHOUT ROWID');
    db.query('CREATE INDEX resource_assignment_order_v2 ON resource_assignment_v2(generation,seq)');
    db.query('CREATE TABLE resource_content_gc_v2 (generation INTEGER NOT NULL, content_id INTEGER NOT NULL, PRIMARY KEY(generation,content_id)) WITHOUT ROWID');
    for (const [event, row] of [['INSERT','NEW'], ['DELETE','OLD'], ['UPDATE','NEW']] as const) {
      db.query(`CREATE TRIGGER resource_legacy_${event.toLowerCase()}_v2 AFTER ${event} ON records WHEN ${row}.key='library'${event === 'UPDATE' ? " OR OLD.key='library'" : ''} BEGIN UPDATE resource_legacy_generation_v2 SET generation=generation+1 WHERE id=1; END`);
      db.query(`CREATE TRIGGER resource_native_guard_${event.toLowerCase()}_v2 BEFORE ${event} ON records WHEN (${row}.key='library'${event === 'UPDATE' ? " OR OLD.key='library'" : ''}) AND (SELECT json_extract(value,'$.phase') FROM resource_storage_v2 WHERE id=1)='NATIVE' BEGIN SELECT RAISE(ABORT,'RESOURCE_NATIVE_REQUIRES_COMPATIBLE_BINARY'); END`);
    }
  });
}
function legacyGeneration(db: SqlRecords): number {
  const n = db.query<{ generation: number }>('SELECT generation FROM resource_legacy_generation_v2 WHERE id=1')[0]?.generation;
  if (!Number.isSafeInteger(n) || n! < 0) return corrupt();
  return n!;
}
function state(db: SqlRecords): Migration | undefined {
  const value = db.query<{ value: string }>('SELECT value FROM resource_storage_v2 WHERE id=1')[0]?.value;
  if (value === undefined) {
    // An installed-but-unstarted schema has no header. Every completed copy,
    // including an empty native library, has a header and requires its marker.
    if (db.query('SELECT generation FROM resource_header_v2 LIMIT 1').length) return corrupt();
    return undefined;
  }
  const s = parse<Migration>(value);
  if (!s || !['BACKFILL','VERIFY','NATIVE','RESTART','BLOCKED'].includes(s.phase) || !Number.isSafeInteger(s.generation) || s.generation < 1 || !Number.isSafeInteger(s.legacyGeneration) || s.legacyGeneration < 0 || !s.parser || !Number.isSafeInteger(s.sourcePart) || !Number.isSafeInteger(s.sourceOffset)) return corrupt();
  return s;
}
function writeState(db: SqlRecords, s: Migration): void {
  db.query('INSERT INTO resource_storage_v2 VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value', JSON.stringify(s));
}
function assertNative(db: SqlRecords): Migration {
  const s = state(db);
  if (s?.phase !== 'NATIVE') return corrupt('RESOURCE_STORAGE_NOT_NATIVE');
  if (legacyGeneration(db) !== s.legacyGeneration) return corrupt('LEGACY_WRITE_AFTER_RESOURCE_CUTOVER');
  return s;
}
export function resourceStorageStatus(db: SqlRecords): { phase: Phase | 'LEGACY'; verified: boolean; sourcePart: number; sourceBytes: number; generation: number } {
  if (!installed(db)) return { phase: 'LEGACY', verified: false, sourcePart: 0, sourceBytes: 0, generation: 0 };
  const s = state(db);
  if (s?.phase === 'NATIVE' && legacyGeneration(db) !== s.legacyGeneration) return corrupt('LEGACY_WRITE_AFTER_RESOURCE_CUTOVER');
  return { phase: s?.phase ?? 'LEGACY', verified: s?.verified ?? false, sourcePart: s?.sourcePart ?? 0, sourceBytes: s?.sourceBytes ?? 0, generation: s?.generation ?? 0 };
}
export function resourceLibraryIsNative(db: SqlRecords): boolean { return resourceStorageStatus(db).phase === 'NATIVE'; }
export function resourceLibraryRevision(db: SqlRecords): number {
  if (!resourceLibraryIsNative(db)) return db.get<LibraryState | undefined>('library')?.revision ?? 0;
  return header(db, assertNative(db).generation).revision;
}
function header(db: SqlRecords, generation: number): Header {
  const h = db.query<Header & Record<string, number>>('SELECT * FROM resource_header_v2 WHERE generation=?', generation)[0];
  if (!h || Object.values(h).some(n => !Number.isSafeInteger(n) || n < 0)) return corrupt();
  return h;
}
function readContent(db: SqlRecords, generation: number, contentId: number, expectedDigest?: string): string {
  const rows = db.query<{ part: number; value: string }>('SELECT part,value FROM resource_content_v2 WHERE generation=? AND content_id=? ORDER BY part', generation, contentId);
  if (!rows.length || rows.some((r, index) => r.part !== index || typeof r.value !== 'string')) return corrupt();
  const raw = rows.map(r => r.value).join('');
  if (size(raw) > RESOURCE_LIMITS.totalBytes || (expectedDigest !== undefined && hash(raw) !== expectedDigest)) return corrupt();
  return raw;
}
function writeContent(db: SqlRecords, generation: number, contentId: number, raw: string): void {
  let offset = 0, part = 0;
  while (offset < raw.length) {
    let end = Math.min(raw.length, offset + CHUNK_CHARS);
    if (end < raw.length && /[\uD800-\uDBFF]/.test(raw[end - 1]!)) end--;
    db.query('INSERT INTO resource_content_v2 VALUES(?,?,?,?)', generation, contentId, part++, raw.slice(offset, end));
    offset = end;
  }
}
function validateAssignment(a: Assignment): void {
  if (!a || typeof a !== 'object' || !['global','workspace','agent'].includes(a.scopeType) || typeof a.scopeId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(a.scopeId) || (a.scopeType === 'global' && a.scopeId !== 'global') || typeof a.resourceId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(a.resourceId) || ['constructor','prototype','__proto__'].includes(a.resourceId) || typeof a.enabled !== 'boolean') return corrupt('RESOURCE_SNAPSHOT_INVALID_ASSIGNMENT');
}
function insertRevision(db: SqlRecords, generation: number, resource: Resource, contentId: number, raw: string, historyCount: number): void {
  const meta = JSON.stringify(metadata(resource));
  db.query('INSERT INTO resource_revision_v2 VALUES(?,?,?,?,?,?,?)', generation, resource.id, resource.revision, meta, contentId, hash(raw), size(JSON.stringify(resource)));
  db.query('INSERT INTO resource_current_v2 VALUES(?,?,?,?,?) ON CONFLICT(generation,id) DO UPDATE SET revision=excluded.revision,metadata=excluded.metadata,history_count=excluded.history_count', generation, resource.id, resource.revision, meta, historyCount);
}
function skeleton(r: CurrentRow): Resource {
  const meta = parse<Metadata>(r.metadata);
  if (!meta || meta.id !== r.id || meta.revision !== r.revision || !Number.isSafeInteger(r.history_count) || r.history_count < 1 || r.history_count > RESOURCE_LIMITS.revisions) return corrupt();
  return { ...meta, body: '', files: {} };
}
function validateGraph(db: SqlRecords, generation: number, libraryRevision: number): void {
  const resources: Record<string, Resource[]> = {};
  for (const r of db.query<CurrentRow & Record<string, string | number>>('SELECT id,revision,metadata,history_count FROM resource_current_v2 WHERE generation=? ORDER BY id', generation)) resources[r.id] = [skeleton(r)];
  new ResourceLibrary({ schemaVersion: 1, revision: libraryRevision, resources, assignments: [] });
  const dangling = db.query('SELECT a.resource_id FROM resource_assignment_v2 a LEFT JOIN resource_current_v2 r ON r.generation=a.generation AND r.id=a.resource_id WHERE a.generation=? AND (r.id IS NULL OR json_extract(r.metadata,\'$.deleted\')=1) LIMIT 1', generation);
  if (dangling.length) return corrupt('RESOURCE_SNAPSHOT_INVALID_ASSIGNMENT');
}
function snapshotBytes(h: Header): number {
  return size(JSON.stringify({ ...ZERO, revision: h.revision })) + h.row_bytes + h.key_bytes + Math.max(0, h.resource_count - 1) + h.revision_count - h.resource_count + h.assignment_bytes + Math.max(0, h.assignment_count - 1);
}
function beginCapture(p: Parser, kind: 'resource' | 'assignment'): void {
  p.afterComma = false;
  p.capture = { kind, id: p.nextContent++, part: 0, depth: 0, quoted: false, escaped: false };
  p.stage = 'capture';
}
function completeCapture(db: SqlRecords, s: Migration): void {
  const p = s.parser, capture = p.capture!, raw = readContent(db, s.generation, capture.id);
  if (capture.kind === 'resource') {
    const value = parse<Resource>(raw);
    validateResourceRevision(value, p.resourceId!, p.previousRevision);
    if (++p.resourceRevisions > RESOURCE_LIMITS.revisions) return corrupt('RESOURCE_SNAPSHOT_REVISION_LIMIT');
    if (s.phase === 'VERIFY') {
      const row = db.query<RevisionRow & Record<string, string | number>>('SELECT id,revision,metadata,content_id,digest,json_bytes FROM resource_revision_v2 WHERE generation=? AND id=? AND revision=?', s.generation, value.id, value.revision)[0];
      if (!row || canonical(parse<Resource>(readContent(db, s.generation, row.content_id, row.digest))) !== canonical(value) || canonical(parse<Metadata>(row.metadata)) !== canonical(metadata(value))) return corrupt('RESOURCE_SNAPSHOT_VERIFY_FAILED');
    } else insertRevision(db, s.generation, value, capture.id, raw, p.resourceRevisions);
    p.previousRevision = value.revision; p.revisions++; p.rowBytes += size(JSON.stringify(value)); p.stage = 'resource-next';
  } else {
    const value = parse<Assignment>(raw); validateAssignment(value);
    const compact = JSON.stringify(value);
    if (s.phase === 'VERIFY') {
      const row = db.query<AssignmentRow & Record<string, string | number>>('SELECT scope_type,scope_id,resource_id,content_id,digest,seq,json_bytes FROM resource_assignment_v2 WHERE generation=? AND scope_type=? AND scope_id=? AND resource_id=?', s.generation, value.scopeType, value.scopeId, value.resourceId)[0];
      if (!row || row.seq !== p.assignments || canonical(parse<Assignment>(readContent(db, s.generation, row.content_id, row.digest))) !== canonical(value)) return corrupt('RESOURCE_SNAPSHOT_VERIFY_FAILED');
    } else {
      if (db.query('SELECT resource_id FROM resource_assignment_v2 WHERE generation=? AND scope_type=? AND scope_id=? AND resource_id=?',s.generation,value.scopeType,value.scopeId,value.resourceId).length) return corrupt('RESOURCE_SNAPSHOT_DUPLICATE_ASSIGNMENT');
      db.query('INSERT INTO resource_assignment_v2 VALUES(?,?,?,?,?,?,?,?)', s.generation, value.scopeType, value.scopeId, value.resourceId, capture.id, hash(raw), p.assignments, size(compact));
    }
    p.assignments++; p.assignmentBytes += size(compact); p.stage = 'assignment-next';
  }
  delete p.capture;
}
/** Only framing is parsed incrementally; complete individual immutable values use JSON.parse and the existing validators. */
function consume(db: SqlRecords, s: Migration, text: string, start: number): number {
  const p = s.parser;
  let offset = start, completed = 0, captureText = '';
  const flushCapture = () => {
    if (captureText) {
      if (s.phase === 'BACKFILL') db.query('INSERT INTO resource_content_v2 VALUES(?,?,?,?)', s.generation, p.capture!.id, p.capture!.part++, captureText);
      // VERIFY reads the exact original immutable fragments by their stable content id.
      captureText = '';
    }
  };
  while (offset < text.length && completed < MIGRATION_OBJECTS_PER_STEP) {
    const c = text[offset]!;
    if (p.stage === 'capture') {
      captureText += c; const cap = p.capture!;
      if (cap.quoted) { if (cap.escaped) cap.escaped = false; else if (c === '\\') cap.escaped = true; else if (c === '"') cap.quoted = false; }
      else if (c === '"') cap.quoted = true;
      else if (c === '{' || c === '[') cap.depth++;
      else if (c === '}' || c === ']') cap.depth--;
      offset++;
      if (cap.depth === 0) { flushCapture(); completeCapture(db, s); completed++; }
      continue;
    }
    if (p.stage === 'string') {
      p.token += c; if (p.token.length > 5000) return corrupt('RESOURCE_SNAPSHOT_KEY_LIMIT');
      offset++;
      if (p.escaped) p.escaped = false;
      else if (c === '\\') p.escaped = true;
      else if (c === '"') {
        const value = parse<string>(p.token); p.token = ''; p.stage = p.returnStage!;
        if (p.stage === 'root-colon') {
          if (!['schemaVersion','revision','resources','assignments'].includes(value) || p.rootKeys.includes(value)) return corrupt('RESOURCE_SNAPSHOT_ROOT_INVALID');
          p.rootKeys.push(value); p.rootKey = value;
        } else {
          if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(value) || ['constructor','prototype','__proto__'].includes(value) || p.resourceIds.includes(value) || p.resourceIds.length >= RESOURCE_LIMITS.resources) return corrupt('RESOURCE_SNAPSHOT_RESOURCE_INVALID');
          p.resourceIds.push(value); p.resourceId = value; p.resourceRevisions = 0; p.previousRevision = 0;
          p.resources++; p.keyBytes += size(JSON.stringify(value)) + 3;
        }
      }
      continue;
    }
    if (p.stage === 'number') {
      if (/[0-9eE+.\-]/.test(c)) { p.token += c; if (p.token.length > 32) return corrupt('RESOURCE_SNAPSHOT_NUMBER_INVALID'); offset++; continue; }
      const value = parse<number>(p.token); p.token = '';
      if (!Number.isSafeInteger(value) || value < 0 || (p.rootKey === 'schemaVersion' && value !== 1)) return corrupt('RESOURCE_SNAPSHOT_VERSION_INVALID');
      if (p.rootKey === 'schemaVersion') p.version = value; else p.revision = value;
      p.stage = 'root-next'; continue;
    }
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t') { offset++; continue; }
    const expect = (value: string, next: Stage) => { if (c !== value) return corrupt('RESOURCE_SNAPSHOT_SYNTAX'); p.stage = next; if (value === ',') p.afterComma = true; offset++; };
    const key = (next: Stage) => { if (c !== '"') return corrupt('RESOURCE_SNAPSHOT_SYNTAX'); p.afterComma = false; p.stage = 'string'; p.returnStage = next; p.token = '"'; p.escaped = false; offset++; };
    switch (p.stage) {
      case 'root': expect('{', 'root-key'); break;
      case 'root-key': if (c === '}') { if (p.afterComma) return corrupt('RESOURCE_SNAPSHOT_TRAILING_COMMA'); p.stage = 'done'; offset++; } else key('root-colon'); break;
      case 'root-colon': expect(':', 'root-value'); break;
      case 'root-value':
        if (p.rootKey === 'resources') expect('{', 'resource-key');
        else if (p.rootKey === 'assignments') expect('[', 'assignment-item');
        else { p.token = ''; p.stage = 'number'; }
        break;
      case 'root-next': if (c === '}') { p.stage = 'done'; offset++; } else expect(',', 'root-key'); break;
      case 'resource-key': if (c === '}') { if (p.afterComma) return corrupt('RESOURCE_SNAPSHOT_TRAILING_COMMA'); p.stage = 'root-next'; offset++; } else key('resource-colon'); break;
      case 'resource-colon': expect(':', 'resource-array'); break;
      case 'resource-array': expect('[', 'resource-item'); break;
      case 'resource-item':
        if (c === ']') { if (p.afterComma || !p.resourceRevisions) return corrupt('RESOURCE_SNAPSHOT_EMPTY_HISTORY'); p.stage = 'resource-comma'; offset++; }
        else if (c === '{') beginCapture(p, 'resource'); else return corrupt('RESOURCE_SNAPSHOT_RESOURCE_INVALID');
        break;
      case 'resource-next': if (c === ']') { p.stage = 'resource-comma'; offset++; } else expect(',', 'resource-item'); break;
      case 'resource-comma': if (c === '}') { p.stage = 'root-next'; offset++; } else expect(',', 'resource-key'); break;
      case 'assignment-item': if (c === ']') { if (p.afterComma) return corrupt('RESOURCE_SNAPSHOT_TRAILING_COMMA'); p.stage = 'root-next'; offset++; } else if (c === '{') beginCapture(p, 'assignment'); else return corrupt('RESOURCE_SNAPSHOT_INVALID_ASSIGNMENT'); break;
      case 'assignment-next': if (c === ']') { p.stage = 'root-next'; offset++; } else expect(',', 'assignment-item'); break;
      case 'done': return corrupt('RESOURCE_SNAPSHOT_TRAILING_DATA');
      default: return corrupt('RESOURCE_SNAPSHOT_PARSER_INVALID');
    }
  }
  flushCapture();
  return offset;
}
function cleanupGeneration(db: SqlRecords, generation: number): boolean {
  for (const table of ['resource_content_v2','resource_revision_v2','resource_current_v2','resource_assignment_v2','resource_content_gc_v2','resource_source_digest_v2'] as const) {
    const keys = db.query<{ a: string | number; b: string | number; c: string | number }>(
      table === 'resource_content_v2' ? `SELECT content_id a,part b,0 c FROM ${table} WHERE generation=? LIMIT 32` :
      table === 'resource_revision_v2' ? `SELECT id a,revision b,0 c FROM ${table} WHERE generation=? LIMIT 32` :
      table === 'resource_current_v2' ? `SELECT id a,0 b,0 c FROM ${table} WHERE generation=? LIMIT 32` :
      table === 'resource_assignment_v2' ? `SELECT scope_type a,scope_id b,resource_id c FROM ${table} WHERE generation=? LIMIT 32` :
      table === 'resource_content_gc_v2' ? `SELECT content_id a,0 b,0 c FROM ${table} WHERE generation=? LIMIT 32` : `SELECT part a,0 b,0 c FROM ${table} WHERE generation=? LIMIT 32`, generation);
    if (!keys.length) continue;
    for (const k of keys) {
      if (table === 'resource_content_v2') db.query(`DELETE FROM ${table} WHERE generation=? AND content_id=? AND part=?`, generation,k.a,k.b);
      else if (table === 'resource_revision_v2') db.query(`DELETE FROM ${table} WHERE generation=? AND id=? AND revision=?`, generation,k.a,k.b);
      else if (table === 'resource_current_v2') db.query(`DELETE FROM ${table} WHERE generation=? AND id=?`, generation,k.a);
      else if (table === 'resource_assignment_v2') db.query(`DELETE FROM ${table} WHERE generation=? AND scope_type=? AND scope_id=? AND resource_id=?`, generation,k.a,k.b,k.c);
      else if (table === 'resource_content_gc_v2') db.query(`DELETE FROM ${table} WHERE generation=? AND content_id=?`, generation,k.a);
      else db.query(`DELETE FROM ${table} WHERE generation=? AND part=?`, generation,k.a);
    }
    return true;
  }
  db.query('DELETE FROM resource_header_v2 WHERE generation=?', generation); return false;
}
/** Fence binaries which only understand the retained legacy snapshot. Public protocol schema stays v1. */
function fenceLegacyRegistryBinary(db: SqlRecords): void {
  const core = db.get<Record<string, unknown> | undefined>('core');
  if (core === undefined) return;
  if (!core || typeof core !== 'object' || Array.isArray(core) || (core.schemaVersion !== 1 && core.schemaVersion !== 2)) return corrupt('RESOURCE_SNAPSHOT_CORE_SCHEMA_INVALID');
  if (core.schemaVersion === 1) db.put('core',{ ...core, schemaVersion: 2 });
}
/** At most32 obsolete assignment-content rows per maintenance invocation. */
function cleanupNativeContent(db: SqlRecords, generation: number): void {
  const pending = db.query<{content_id:number}>('SELECT content_id FROM resource_content_gc_v2 WHERE generation=? ORDER BY content_id LIMIT 1',generation)[0];
  if (!pending) return;
  const parts = db.query<{part:number}>('SELECT part FROM resource_content_v2 WHERE generation=? AND content_id=? ORDER BY part LIMIT 32',generation,pending.content_id);
  for (const row of parts) db.query('DELETE FROM resource_content_v2 WHERE generation=? AND content_id=? AND part=?',generation,pending.content_id,row.part);
  if (parts.length < 32) db.query('DELETE FROM resource_content_gc_v2 WHERE generation=? AND content_id=?',generation,pending.content_id);
}
/** The Registry schedules this only after authenticated writes, startup adoption or an existing migration alarm. */
export function resourceStorageNeedsMaintenance(db: SqlRecords, mode: ResourceStorageMode): boolean {
  if (!installed(db)) return mode !== 'legacy' && db.query("SELECT part FROM records WHERE key='library' AND part=0").length !== 0;
  const s = state(db);
  if (!s) return mode !== 'legacy' && db.query("SELECT part FROM records WHERE key='library' AND part=0").length !== 0;
  if (s.phase === 'NATIVE') {
    if (legacyGeneration(db) !== s.legacyGeneration) return corrupt('LEGACY_WRITE_AFTER_RESOURCE_CUTOVER');
    return db.query('SELECT content_id FROM resource_content_gc_v2 WHERE generation=? LIMIT 1',s.generation).length !== 0;
  }
  if (mode === 'legacy') return false;
  if (s.legacyGeneration !== legacyGeneration(db)) return true;
  if (s.phase === 'BLOCKED') return false;
  return s.phase !== 'VERIFY' || !s.verified || mode === 'native';
}
/** Operator flag gates both adoption and cutover; native authority is sticky if the flag later changes. */
export function resourceStorageMaintenance(db: SqlRecords, mode: ResourceStorageMode, maxParts = 4): ReturnType<typeof resourceStorageStatus> {
  if (!['legacy','prepare','native'].includes(mode) || !Number.isSafeInteger(maxParts) || maxParts < 1 || maxParts > 4) return corrupt('RESOURCE_STORAGE_CONFIGURATION_INVALID');
  if (!installed(db)) { if (mode === 'legacy') return resourceStorageStatus(db); install(db); }
  let attempted: Migration | undefined;
  try { db.transaction(() => {
    const currentGeneration = legacyGeneration(db);
    let s = state(db);
    if (s?.phase === 'NATIVE') { if (s.legacyGeneration !== currentGeneration) return corrupt('LEGACY_WRITE_AFTER_RESOURCE_CUTOVER'); cleanupNativeContent(db,s.generation); return; }
    if (mode === 'legacy') return;
    if (!s) {
      if (!db.query('SELECT part FROM records WHERE key=\'library\' AND part=0').length) return;
      s = { phase: 'BACKFILL', generation: 1, legacyGeneration: currentGeneration, sourcePart: 0, sourceOffset: 0, sourceBytes: 0, verified: false, parser: parser() };
      writeState(db, s);
    }
    attempted = s;
    if (s.legacyGeneration !== currentGeneration) { s.phase = 'RESTART'; s.verified = false; }
    if (s.phase === 'BLOCKED') return corrupt(s.error ?? 'RESOURCE_STORAGE_BLOCKED');
    if (s.phase === 'RESTART') {
      if (cleanupGeneration(db, s.generation)) { writeState(db,s); return; }
      s = { phase: 'BACKFILL', generation: s.generation + 1, legacyGeneration: currentGeneration, sourcePart: 0, sourceOffset: 0, sourceBytes: 0, verified: false, parser: parser() };
    }
    if (s.phase === 'VERIFY' && s.verified) {
      if (mode === 'native') { fenceLegacyRegistryBinary(db); s.phase = 'NATIVE'; writeState(db,s); }
      return;
    }
    for (let i = 0; i < maxParts; i++) {
      const source = db.query<{ value: string }>('SELECT value FROM records WHERE key=\'library\' AND part=?', s.sourcePart)[0]?.value;
      if (source === undefined) {
        if (db.query("SELECT part FROM records WHERE key='library' AND (part<0 OR part>?) LIMIT 1",s.sourcePart).length) return corrupt('RESOURCE_SNAPSHOT_CHUNK_GAP');
        const p = s.parser;
        if (p.stage !== 'done' || p.rootKeys.length !== 4 || p.version !== 1 || p.revision === undefined) return corrupt('RESOURCE_SNAPSHOT_INCOMPLETE');
        const h: Header = { generation: s.generation, revision: p.revision, resource_count: p.resources, revision_count: p.revisions, row_bytes: p.rowBytes, key_bytes: p.keyBytes, assignment_count: p.assignments, assignment_bytes: p.assignmentBytes, next_content: p.nextContent, next_assignment: p.assignments };
        if (snapshotBytes(h) > RESOURCE_LIMITS.totalBytes) return corrupt('RESOURCE_SNAPSHOT_BUDGET');
        validateGraph(db,s.generation,p.revision);
        if (s.phase === 'BACKFILL') {
          db.query('INSERT INTO resource_header_v2 VALUES(?,?,?,?,?,?,?,?,?,?)', h.generation,h.revision,h.resource_count,h.revision_count,h.row_bytes,h.key_bytes,h.assignment_count,h.assignment_bytes,h.next_content,h.next_assignment);
          s.phase = 'VERIFY'; s.parser = parser(); s.sourcePart = 0; s.sourceOffset = 0;
        } else {
          if (canonical(header(db,s.generation)) !== canonical(h)) return corrupt('RESOURCE_SNAPSHOT_VERIFY_FAILED');
          s.verified = true;
          if (mode === 'native') { fenceLegacyRegistryBinary(db); s.phase = 'NATIVE'; }
        }
        writeState(db,s); return;
      }
      if (s.sourceOffset === 0) {
        s.sourceBytes += size(source);
        if (s.phase === 'BACKFILL') db.query('INSERT INTO resource_source_digest_v2 VALUES(?,?,?)',s.generation,s.sourcePart,hash(source));
        else if (db.query<{digest:string}>('SELECT digest FROM resource_source_digest_v2 WHERE generation=? AND part=?',s.generation,s.sourcePart)[0]?.digest !== hash(source)) return corrupt('RESOURCE_SNAPSHOT_VERIFY_FAILED');
      }
      if (s.sourceBytes > RESOURCE_LIMITS.totalBytes * 2 + 2 * 1024 * 1024) return corrupt('RESOURCE_SNAPSHOT_BUDGET');
      s.sourceOffset = consume(db,s,source,s.sourceOffset);
      if (s.sourceOffset < source.length) break;
      s.sourcePart++; s.sourceOffset = 0;
    }
    writeState(db,s);
  }); } catch (error) {
    const sourceInvalid = error instanceof ResourceError || (error instanceof Error && /^(?:RESOURCE_SNAPSHOT_|RESOURCE_STORAGE_CORRUPT)/.test(error.message));
    if (sourceInvalid) {
      // A malformed source stops background retries. SQL/quota faults remain resumable.
      // Never replace a native marker or select stale legacy authority on failure.
      try { db.transaction(() => {
        const persisted = state(db) ?? attempted;
        if (persisted && persisted.phase !== 'NATIVE') {
          persisted.phase = 'BLOCKED'; persisted.verified = false; persisted.error = 'RESOURCE_SNAPSHOT_INVALID';
          writeState(db,persisted);
        }
      }); } catch { /* Preserve the original error if fault persistence itself is unavailable. */ }
    }
    throw error;
  }
  return resourceStorageStatus(db);
}

/** Request-local staging over normalized metadata; complete bodies are loaded only for requested revisions or explicit full export/search. */
export class NativeResourceLibrary {
  private migration: Migration;
  private initial: Header;
  private model?: ResourceLibrary;
  private staged: Resource[] = [];
  constructor(private db: SqlRecords) { this.migration = assertNative(db); this.initial = header(db,this.migration.generation); }
  get revision(): number { return this.model?.revision ?? this.initial.revision; }
  private currents(): CurrentRow[] { return this.db.query<CurrentRow & Record<string,string|number>>('SELECT id,revision,metadata,history_count FROM resource_current_v2 WHERE generation=? ORDER BY id', this.initial.generation); }
  private assignmentRows(context?: ResourceContext): AssignmentRow[] {
    if (context === undefined) return this.db.query<AssignmentRow & Record<string,string|number>>('SELECT scope_type,scope_id,resource_id,content_id,digest,seq,json_bytes FROM resource_assignment_v2 WHERE generation=? ORDER BY seq',this.initial.generation);
    return this.db.query<AssignmentRow & Record<string,string|number>>('SELECT scope_type,scope_id,resource_id,content_id,digest,seq,json_bytes FROM resource_assignment_v2 WHERE generation=? AND ((scope_type=\'global\' AND scope_id=\'global\') OR (scope_type=\'workspace\' AND scope_id=?) OR (scope_type=\'agent\' AND scope_id=?)) ORDER BY seq',this.initial.generation,context.workspaceId ?? '',context.agentId ?? '');
  }
  assignments(): Assignment[] {
    if (this.model) return this.model.snapshot().assignments;
    this.refreshReadHeader();
    return this.assignmentRows().map(r => this.assignment(r));
  }
  private refreshReadHeader(): void {
    if (this.model) return;
    this.initial = header(this.db,assertNative(this.db).generation);
  }
  private assignment(row: AssignmentRow): Assignment {
    const value = parse<Assignment>(readContent(this.db,this.initial.generation,row.content_id,row.digest)); validateAssignment(value);
    if (value.scopeType !== row.scope_type || value.scopeId !== row.scope_id || value.resourceId !== row.resource_id) return corrupt();
    return value;
  }
  private validation(context?: ResourceContext): ResourceLibrary {
    if (this.model) return this.model;
    this.refreshReadHeader();
    const resources: Record<string, Resource[]> = {};
    for (const row of this.currents()) resources[row.id] = [skeleton(row)];
    return new ResourceLibrary({ schemaVersion: 1, revision: this.initial.revision, resources, assignments: this.assignmentRows(context).map(r => this.assignment(r)) });
  }
  private mutable(): ResourceLibrary { return this.model ??= this.validation(); }
  listMetadata(context?: ResourceContext, kind?: ResourceKind): Resource[] { return this.validation(context).list(context,kind); }
  list(context?: ResourceContext, kind?: ResourceKind): Resource[] { return this.listMetadata(context,kind).map(r => this.getRevision(r.id,r.revision)); }
  historyMetadata(id: string): Resource[] {
    this.refreshReadHeader();
    return this.db.query<RevisionRow & Record<string,string|number>>('SELECT id,revision,metadata,content_id,digest,json_bytes FROM resource_revision_v2 WHERE generation=? AND id=? ORDER BY revision',this.initial.generation,id).map(r => ({ ...parse<Metadata>(r.metadata), body: '', files: {} }));
  }
  history(id: string): Resource[] { return this.historyMetadata(id).map(r => this.getRevision(id,r.revision)); }
  private getRevision(id: string, revision: number): Resource {
    const pending = this.staged.find(r => r.id === id && r.revision === revision); if (pending) return structuredClone(pending);
    const row = this.db.query<RevisionRow & Record<string,string|number>>('SELECT id,revision,metadata,content_id,digest,json_bytes FROM resource_revision_v2 WHERE generation=? AND id=? AND revision=?',this.initial.generation,id,revision)[0];
    if (!row) throw new ResourceError('RESOURCE_NOT_FOUND','Resource revision does not exist');
    const value = parse<Resource>(readContent(this.db,this.initial.generation,row.content_id,row.digest));
    validateResourceRevision(value,id); if (value.revision !== revision || canonical(metadata(value)) !== canonical(parse<Metadata>(row.metadata))) return corrupt();
    return value;
  }
  get(id: string, context?: ResourceContext, revision?: number): Resource {
    const current = this.validation(context).get(id,context);
    const resource = this.getRevision(id,revision ?? current.revision);
    if (resource.deleted) throw new ResourceError('RESOURCE_NOT_FOUND','Resource revision does not exist');
    return resource;
  }
  snapshot(): LibraryState {
    const resources: Record<string,Resource[]> = {};
    for (const row of this.currents()) resources[row.id] = this.history(row.id);
    for (const resource of this.staged) { const rows = resources[resource.id] ??= []; if (!rows.some(r => r.revision === resource.revision)) rows.push(structuredClone(resource)); }
    return { schemaVersion: 1, revision: this.revision, resources, assignments: this.assignments() };
  }
  private historyCount(id: string): number { return (this.currents().find(r => r.id === id)?.history_count ?? 0) + this.staged.filter(r => r.id === id).length; }
  private checkStaged(resource: Resource): void {
    if (this.historyCount(resource.id) >= RESOURCE_LIMITS.revisions) throw new ResourceError('LIMIT_EXCEEDED','Resource history limit reached; export history before explicit pruning');
    this.staged.push(resource); this.checkBudget();
  }
  private nextHeader(): Header {
    const h = { ...this.initial, revision: this.revision };
    const ids = new Set(this.currents().map(r => r.id));
    for (const resource of this.staged) {
      if (!ids.has(resource.id)) { ids.add(resource.id); h.resource_count++; h.key_bytes += size(JSON.stringify(resource.id)) + 3; }
      h.revision_count++; h.row_bytes += size(JSON.stringify(resource));
    }
    const assignments = this.assignments(); h.assignment_count = assignments.length; h.assignment_bytes = assignments.reduce((n,a) => n+size(JSON.stringify(a)),0);
    return h;
  }
  private checkBudget(): void { if (snapshotBytes(this.nextHeader()) > RESOURCE_LIMITS.totalBytes) throw new ResourceError('LIMIT_EXCEEDED','Library history budget reached; export before explicit pruning'); }
  async publish(input: ResourceInput, expected: number | 'absent'): Promise<Resource> {
    const resource = await this.mutable().publish(input,expected); this.checkStaged(resource); return structuredClone(resource);
  }
  async restore(id: string, historicalRevision: number, expected: number): Promise<Resource> {
    const historical = this.getRevision(id,historicalRevision); if (historical.deleted) throw new ResourceError('RESOURCE_NOT_FOUND','Historical Resource revision does not exist');
    return this.publish(resourceAsInput(historical),expected);
  }
  assign(type: ScopeType, scope: string, id: string, enabled: boolean, expected: number): void { this.mutable().assign(type,scope,id,enabled,expected); this.checkBudget(); }
  remove(id: string, expected: number): void {
    const model = this.mutable(), before = model.snapshot(), current = this.getRevision(id,expected);
    if (!before.resources[id]) throw new ResourceError('RESOURCE_CONFLICT','Resource changed or does not exist');
    // The ordinary model copies the body into the tombstone; materialize only this exact current revision.
    before.resources[id] = [current]; this.model = new ResourceLibrary(before); this.model.remove(id,expected);
    const resource = this.model.history(id).at(-1)!; this.checkStaged(resource);
  }
  async previewImport(archive: Uint8Array): Promise<ImportPreview> { return this.validation().previewImport(archive); }
  async commitImport(preview: ImportPreview, decisions: ImportDecisions, expected: number): Promise<Resource[]> {
    const resources = await this.mutable().commitImport(preview,decisions,expected); for (const r of resources) this.checkStaged(r); return resources;
  }
  exportZip(): Uint8Array {
    const resources: Record<string,Resource[]> = {};
    for (const r of this.list()) resources[r.id] = [r];
    return new ResourceLibrary({ schemaVersion: 1, revision: this.revision, resources, assignments: [] }).exportZip();
  }
  /** Caller must wrap this and its idempotency receipt in the same transaction. */
  commit(expected: number): void {
    if (!this.db.inTransaction) throw new Error('Resource commit requires transaction');
    const s = assertNative(this.db), persisted = header(this.db,s.generation);
    if (s.generation !== this.initial.generation || persisted.revision !== expected || this.initial.revision !== expected) throw new ResourceError('RESOURCE_CONFLICT','Library changed; refresh and review before publishing');
    const h = this.nextHeader(), counts = new Map(this.currents().map(r => [r.id,r.history_count]));
    for (const resource of this.staged) {
      const content = h.next_content++, raw = JSON.stringify(resource); writeContent(this.db,h.generation,content,raw);
      const count = (counts.get(resource.id) ?? 0) + 1; counts.set(resource.id,count); insertRevision(this.db,h.generation,resource,content,raw,count);
    }
    const oldRows = this.assignmentRows(), old = new Map(oldRows.map(r => [JSON.stringify([r.scope_type,r.scope_id,r.resource_id]),r]));
    const upcoming = this.assignments();
    let lastSequence = -1;
    for (const a of upcoming) {
      const key = assignmentKey(a), row = old.get(key), raw = JSON.stringify(a);
      if (row && canonical(this.assignment(row)) === canonical(a)) {
        if (row.seq < lastSequence) {
          lastSequence = h.next_assignment++;
          this.db.query('UPDATE resource_assignment_v2 SET seq=? WHERE generation=? AND scope_type=? AND scope_id=? AND resource_id=?',lastSequence,h.generation,a.scopeType,a.scopeId,a.resourceId);
        } else lastSequence = row.seq;
        old.delete(key); continue;
      }
      if (row) { this.db.query('INSERT OR IGNORE INTO resource_content_gc_v2 VALUES(?,?)',h.generation,row.content_id); old.delete(key); }
      const content = h.next_content++; writeContent(this.db,h.generation,content,raw);
      lastSequence = h.next_assignment++;
      this.db.query('INSERT INTO resource_assignment_v2 VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(generation,scope_type,scope_id,resource_id) DO UPDATE SET content_id=excluded.content_id,digest=excluded.digest,seq=excluded.seq,json_bytes=excluded.json_bytes',h.generation,a.scopeType,a.scopeId,a.resourceId,content,hash(raw),lastSequence,size(raw));
    }
    for (const row of old.values()) {
      this.db.query('DELETE FROM resource_assignment_v2 WHERE generation=? AND scope_type=? AND scope_id=? AND resource_id=?',h.generation,row.scope_type,row.scope_id,row.resource_id);
      this.db.query('INSERT OR IGNORE INTO resource_content_gc_v2 VALUES(?,?)',h.generation,row.content_id);
    }
    this.db.query('UPDATE resource_header_v2 SET revision=?,resource_count=?,revision_count=?,row_bytes=?,key_bytes=?,assignment_count=?,assignment_bytes=?,next_content=?,next_assignment=? WHERE generation=?',h.revision,h.resource_count,h.revision_count,h.row_bytes,h.key_bytes,h.assignment_count,h.assignment_bytes,h.next_content,h.next_assignment,h.generation);
    this.initial = h; this.staged = []; this.model = undefined;
  }
}
