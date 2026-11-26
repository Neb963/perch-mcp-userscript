import { Unzip, UnzipInflate, strToU8, zipSync } from 'fflate';

export type ResourceKind = 'skill' | 'workflow' | 'instruction' | 'document';
export type ScopeType = 'global' | 'workspace' | 'agent';
export interface ResourceContext { workspaceId?: string; agentId?: string }
export interface ResourceInput {
  id: string; kind: ResourceKind; title?: string; description?: string; body: string;
  files?: Record<string, string>; enabled?: boolean; dependencies?: string[];
  provenance?: string; license?: string; upstreamVersion?: string;
}
export interface Resource extends Required<Omit<ResourceInput, 'upstreamVersion'>> {
  upstreamVersion?: string; revision: number; hash: string; customized: boolean; deleted: boolean;
}
export interface Assignment { scopeType: ScopeType; scopeId: string; resourceId: string; enabled: boolean }
export interface LibraryState { schemaVersion: 1; revision: number; resources: Record<string, Resource[]>; assignments: Assignment[] }
export interface ImportEntry { id: string; kind: ResourceKind; bytes: number; action: 'add' | 'conflict' | 'excluded'; reason?: string }
export interface ImportPreview { digest: string; resources: ResourceInput[]; entries: ImportEntry[]; libraryRevision: number }
export type ImportDecisions = Record<string, { action: 'replace' | 'skip' | 'fork'; newId?: string }>;
export class ResourceError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'ResourceError' }
}
export const RESOURCE_LIMITS = Object.freeze({ archiveBytes: 8 * 1024 * 1024, totalBytes: 16 * 1024 * 1024, fileBytes: 1024 * 1024, files: 500, ratio: 100, resources: 250, revisions: 100 });
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const idPattern = /^[a-z0-9][a-z0-9-]{0,79}$/;
const kinds = new Set<ResourceKind>(['skill', 'workflow', 'instruction', 'document']);
const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype']);
function clone<T>(value: T): T { return structuredClone(value) }
function fail(code: string, message: string): never { throw new ResourceError(code, message) }
function bytes(value: string): number { return encoder.encode(value).length }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
export function resourcePath(value: string): string {
  if (typeof value !== 'string' || value.length > 500 || value !== value.normalize('NFC') || /[\\\x00-\x1f\x7f:%]/.test(value) || value.startsWith('/') || value.endsWith('/')) fail('INVALID_ARCHIVE', 'Archive path is not a canonical relative path');
  if (value.split('/').some(x => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(x) || x === '.' || x === '..' || forbiddenKeys.has(x))) fail('INVALID_ARCHIVE', 'Archive contains an unsafe path segment');
  return value;
}
async function hash(value: string | Uint8Array): Promise<string> {
  const source = typeof value === 'string' ? encoder.encode(value) : value;
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', source as BufferSource)), x => x.toString(16).padStart(2, '0')).join('');
}
function normalize(input: ResourceInput): Required<Omit<ResourceInput, 'upstreamVersion'>> & Pick<ResourceInput, 'upstreamVersion'> {
  if (!record(input) || !idPattern.test(input.id) || forbiddenKeys.has(input.id) || !kinds.has(input.kind) || typeof input.body !== 'string') fail('INVALID_RESOURCE', 'Resource requires a canonical ID, known kind and text body');
  const accepted = new Set(['id', 'kind', 'title', 'description', 'body', 'files', 'enabled', 'dependencies', 'provenance', 'license', 'upstreamVersion']);
  if (Object.keys(input).some(k => !accepted.has(k))) fail('INVALID_RESOURCE', 'Resource has unknown metadata fields');
  if (bytes(input.body) > RESOURCE_LIMITS.fileBytes) fail('LIMIT_EXCEEDED', 'Resource body exceeds 1 MiB');
  const files: Record<string, string> = Object.create(null) as Record<string, string>;
  const seen = new Set<string>();
  if (input.files !== undefined && !record(input.files)) fail('INVALID_RESOURCE', 'Resource files must be a text map');
  let size = bytes(input.body);
  for (const [path, content] of Object.entries(input.files ?? {})) {
    resourcePath(path);
    if (typeof content !== 'string' || seen.has(path.toLowerCase())) fail('INVALID_RESOURCE', 'Resource reference files conflict or are not text');
    if (bytes(content) > RESOURCE_LIMITS.fileBytes) fail('LIMIT_EXCEEDED', 'Resource reference exceeds 1 MiB');
    size += bytes(content); seen.add(path.toLowerCase()); files[path] = content;
  }
  if (size > RESOURCE_LIMITS.totalBytes || Object.keys(files).length >= RESOURCE_LIMITS.files) fail('LIMIT_EXCEEDED', 'Resource reference budget exceeded');
  const dependencies = input.dependencies ?? [];
  if (!Array.isArray(dependencies) || dependencies.length > 100 || dependencies.some(x => typeof x !== 'string' || !idPattern.test(x)) || new Set(dependencies).size !== dependencies.length) fail('INVALID_RESOURCE', 'Invalid resource dependencies');
  for (const key of ['title', 'description', 'provenance', 'license', 'upstreamVersion'] as const) if (input[key] !== undefined && (typeof input[key] !== 'string' || bytes(input[key]!) > 4000)) fail('INVALID_RESOURCE', `Invalid ${key}`);
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') fail('INVALID_RESOURCE', 'enabled must be boolean');
  return { id: input.id, kind: input.kind, title: input.title ?? input.id, description: input.description ?? '', body: input.body, files, enabled: input.enabled ?? true, dependencies: [...dependencies], provenance: input.provenance ?? 'Operator authored/imported; unverified', license: input.license ?? 'Unspecified; verify redistribution permission', ...(input.upstreamVersion === undefined ? {} : { upstreamVersion: input.upstreamVersion }) };
}
function asInput(resource: Resource): ResourceInput {
  return { id: resource.id, kind: resource.kind, title: resource.title, description: resource.description, body: resource.body, files: clone(resource.files), enabled: resource.enabled, dependencies: [...resource.dependencies], provenance: resource.provenance, license: resource.license, ...(resource.upstreamVersion === undefined ? {} : { upstreamVersion: resource.upstreamVersion }) };
}
function active(state: LibraryState, id: string): Resource | undefined { const rows = Object.hasOwn(state.resources, id) ? state.resources[id] : undefined; return rows?.[rows.length - 1] }
function validateGraph(state: LibraryState): void {
  const visited = new Set<string>(), visiting = new Set<string>();
  const walk = (id: string) => {
    if (visiting.has(id)) fail('DEPENDENCY_CYCLE', `Resource dependency cycle at ${id}`);
    if (visited.has(id)) return;
    const resource = active(state, id);
    if (!resource || resource.deleted) fail('MISSING_DEPENDENCY', `Missing Resource ${id}`);
    visiting.add(id); for (const dependency of resource.dependencies) walk(dependency); visiting.delete(id); visited.add(id);
  };
  for (const id of Object.keys(state.resources)) if (!active(state, id)?.deleted) walk(id);
}
function validateBudget(state: LibraryState): void {
  if (Object.keys(state.resources).length > RESOURCE_LIMITS.resources) fail('LIMIT_EXCEEDED', 'Library resource limit reached');
  if (bytes(JSON.stringify(state)) > RESOURCE_LIMITS.totalBytes) fail('LIMIT_EXCEEDED', 'Library history budget reached; export before explicit pruning');
}

/** Pure transaction model. Persist snapshot() in the same serialized storage transaction as the caller's CAS. */
export class ResourceLibrary {
  private state: LibraryState;
  constructor(state?: LibraryState) {
    this.state = state ? clone(state) : { schemaVersion: 1, revision: 0, resources: {}, assignments: [] };
    if (this.state.schemaVersion !== 1 || !Number.isSafeInteger(this.state.revision) || this.state.revision < 0 || !record(this.state.resources) || !Array.isArray(this.state.assignments)) fail('INCOMPATIBLE_VERSION', 'Unsupported resource snapshot');
    for (const [id, revisions] of Object.entries(this.state.resources)) {
      if (!idPattern.test(id) || forbiddenKeys.has(id) || !Array.isArray(revisions) || revisions.length === 0 || revisions.length > RESOURCE_LIMITS.revisions) fail('INVALID_RESOURCE', 'Invalid persisted Resource history');
      let previous = 0;
      for (const resource of revisions) {
        if (!record(resource) || resource.id !== id || !Number.isSafeInteger(resource.revision) || resource.revision <= previous || !/^[0-9a-f]{64}$/.test(resource.hash) || typeof resource.customized !== 'boolean' || typeof resource.deleted !== 'boolean') fail('INVALID_RESOURCE', 'Invalid persisted Resource revision');
        normalize(asInput(resource)); previous = resource.revision;
      }
    }
    const assignmentKeys = new Set<string>();
    for (const assignment of this.state.assignments) {
      if (!record(assignment) || !['global', 'workspace', 'agent'].includes(assignment.scopeType) || typeof assignment.scopeId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(assignment.scopeId) || (assignment.scopeType === 'global' && assignment.scopeId !== 'global') || typeof assignment.enabled !== 'boolean' || !active(this.state, assignment.resourceId) || active(this.state, assignment.resourceId)?.deleted) fail('INVALID_RESOURCE', 'Invalid persisted Resource assignment');
      const key = JSON.stringify([assignment.scopeType, assignment.scopeId, assignment.resourceId]);
      if (assignmentKeys.has(key)) fail('INVALID_RESOURCE', 'Duplicate persisted Resource assignment');
      assignmentKeys.add(key);
    }
    validateGraph(this.state); validateBudget(this.state);
  }
  snapshot(): LibraryState { return clone(this.state) }
  get revision(): number { return this.state.revision }
  history(id: string): Resource[] { return clone(Object.hasOwn(this.state.resources, id) ? this.state.resources[id]! : []) }
  diff(id: string, fromRevision: number, toRevision: number): { path: string; startLine: number; removed: string[]; added: string[] }[] {
    const history = this.history(id), from = history.find(r => r.revision === fromRevision), to = history.find(r => r.revision === toRevision);
    if (!from || !to) fail('RESOURCE_NOT_FOUND', 'Diff revision does not exist');
    const before: Record<string, string> = { 'body.md': from.body, ...Object.fromEntries(Object.entries(from.files).map(([path, content]) => [`refs/${path}`, content])) }, after: Record<string, string> = { 'body.md': to.body, ...Object.fromEntries(Object.entries(to.files).map(([path, content]) => [`refs/${path}`, content])) };
    const result: { path: string; startLine: number; removed: string[]; added: string[] }[] = [];
    for (const path of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      const left = before[path as keyof typeof before]?.split('\n') ?? [], right = after[path as keyof typeof after]?.split('\n') ?? [];
      let start = 0, leftEnd = left.length, rightEnd = right.length;
      while (start < leftEnd && start < rightEnd && left[start] === right[start]) start++;
      while (leftEnd > start && rightEnd > start && left[leftEnd - 1] === right[rightEnd - 1]) { leftEnd--; rightEnd-- }
      if (start < leftEnd || start < rightEnd) result.push({ path, startLine: start + 1, removed: left.slice(start, leftEnd), added: right.slice(start, rightEnd) });
    }
    return result;
  }
  async duplicate(id: string, newId: string): Promise<Resource> { return this.publish({ ...asInput(this.get(id)), id: newId }, 'absent') }
  list(context?: ResourceContext, kind?: ResourceKind): Resource[] {
    const effective = Object.keys(this.state.resources).sort().map(id => active(this.state, id)!).filter(r => !r.deleted && (!kind || r.kind === kind));
    if (context === undefined) return clone(effective);
    const result = effective.filter(resource => {
      let enabled = resource.enabled;
      for (const [type, scopeId] of [['global', 'global'], ['workspace', context.workspaceId], ['agent', context.agentId]] as const) {
        if (scopeId === undefined) continue;
        const assignment = this.state.assignments.find(a => a.scopeType === type && a.scopeId === scopeId && a.resourceId === resource.id);
        if (assignment) enabled = assignment.enabled;
      }
      return enabled;
    });
    const ids = new Set(result.map(r => r.id));
    for (const resource of result) for (const dependency of resource.dependencies) if (!ids.has(dependency)) fail('MISSING_DEPENDENCY', `Effective Resource ${resource.id} requires ${dependency}`);
    return clone(result);
  }
  get(id: string, context?: ResourceContext, revision?: number): Resource {
    const current = this.list(context).find(r => r.id === id);
    if (!current) fail('RESOURCE_NOT_FOUND', 'Resource is unavailable in this scope');
    const resource = revision === undefined ? current : this.state.resources[id]?.find(r => r.revision === revision && !r.deleted);
    if (!resource) fail('RESOURCE_NOT_FOUND', 'Resource revision does not exist');
    return clone(resource);
  }
  private expected(expectedRevision: number): void { if (expectedRevision !== this.state.revision) fail('RESOURCE_CONFLICT', 'Library changed; refresh and review before publishing') }
  private async stage(state: LibraryState, input: ResourceInput, expectedRevision: number | 'absent', customized = true): Promise<Resource> {
    const value = normalize(input), previous = active(state, value.id);
    if (expectedRevision === 'absent' ? previous !== undefined : previous?.revision !== expectedRevision) fail('RESOURCE_CONFLICT', `Resource ${value.id} changed; refresh before publishing`);
    if ((state.resources[value.id]?.length ?? 0) >= RESOURCE_LIMITS.revisions) fail('LIMIT_EXCEEDED', 'Resource history limit reached; export history before explicit pruning');
    const resource: Resource = { ...value, revision: (previous?.revision ?? 0) + 1, hash: await hash(JSON.stringify(value)), customized, deleted: false };
    (state.resources[value.id] ??= []).push(resource); return resource;
  }
  private commit(next: LibraryState): void { validateGraph(next); validateBudget(next); next.revision = this.state.revision + 1; this.state = next }
  async publish(input: ResourceInput, expectedRevision: number | 'absent'): Promise<Resource> {
    const before = this.state.revision, next = clone(this.state), resource = await this.stage(next, input, expectedRevision);
    this.expected(before); this.commit(next); return clone(resource);
  }
  async seed(resources: ResourceInput[]): Promise<{ added: string[]; updated: string[]; preserved: string[] }> {
    if (resources.length > RESOURCE_LIMITS.resources || new Set(resources.map(x => x.id)).size !== resources.length) fail('INVALID_RESOURCE', 'Duplicate/default resource budget exceeded');
    const before = this.state.revision, next = clone(this.state), result = { added: [] as string[], updated: [] as string[], preserved: [] as string[] };
    for (const input of resources) {
      const value = normalize(input), current = active(next, value.id);
      if (current?.customized || current?.deleted) { result.preserved.push(value.id); continue }
      if (current && current.hash === await hash(JSON.stringify(value))) continue;
      await this.stage(next, value, current?.revision ?? 'absent', false); (current ? result.updated : result.added).push(value.id);
    }
    this.expected(before); if (result.added.length || result.updated.length) this.commit(next); return result;
  }
  async restore(id: string, historicalRevision: number, expectedRevision: number): Promise<Resource> {
    const historical = this.state.resources[id]?.find(r => r.revision === historicalRevision && !r.deleted);
    if (!historical) fail('RESOURCE_NOT_FOUND', 'Historical Resource revision does not exist');
    return this.publish(asInput(historical), expectedRevision);
  }
  assign(scopeType: ScopeType, scopeId: string, resourceId: string, enabled: boolean, expectedLibraryRevision: number): void {
    this.expected(expectedLibraryRevision);
    if (!['global', 'workspace', 'agent'].includes(scopeType) || typeof scopeId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(scopeId) || (scopeType === 'global' && scopeId !== 'global') || typeof enabled !== 'boolean') fail('INVALID_RESOURCE', 'Invalid assignment scope');
    if (!active(this.state, resourceId) || active(this.state, resourceId)?.deleted) fail('RESOURCE_NOT_FOUND', 'Assigned Resource does not exist');
    const next = clone(this.state); next.assignments = next.assignments.filter(a => !(a.scopeType === scopeType && a.scopeId === scopeId && a.resourceId === resourceId));
    next.assignments.push({ scopeType, scopeId, resourceId, enabled }); this.commit(next);
  }
  remove(id: string, expectedRevision: number): void {
    const previous = active(this.state, id);
    if (!previous || previous.revision !== expectedRevision) fail('RESOURCE_CONFLICT', 'Resource changed or does not exist');
    if (this.state.assignments.some(a => a.resourceId === id) || this.list().some(r => r.dependencies.includes(id))) fail('RESOURCE_IN_USE', 'Remove assignments and dependent Resources before deletion');
    if (this.state.resources[id]!.length >= RESOURCE_LIMITS.revisions) fail('LIMIT_EXCEEDED', 'Resource history limit reached');
    const next = clone(this.state); next.resources[id]!.push({ ...clone(previous), revision: previous.revision + 1, enabled: false, deleted: true, customized: true }); this.commit(next);
  }
  async previewImport(archive: Uint8Array): Promise<ImportPreview> {
    const files = readSafeZip(archive), resources: ResourceInput[] = [], entries: ImportEntry[] = [];
    const manifest = files['manifest.json'];
    if (manifest !== undefined) {
      let parsed: unknown; try { parsed = JSON.parse(manifest) } catch { fail('INVALID_ARCHIVE', 'Invalid package manifest JSON') }
      if (!record(parsed) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.resources) || parsed.resources.length > RESOURCE_LIMITS.resources) fail('INVALID_ARCHIVE', 'Unsupported package manifest');
      for (const item of parsed.resources) {
        if (!record(item) || typeof item.id !== 'string' || typeof item.path !== 'string' || !kinds.has(item.kind as ResourceKind)) fail('INVALID_ARCHIVE', 'Invalid resource manifest entry');
        resourcePath(item.path); const body = files[item.path]; if (body === undefined) fail('INVALID_ARCHIVE', 'Resource body missing from archive');
        const metadata = item.metadata === undefined ? {} : item.metadata;
        if (!record(metadata)) fail('INVALID_ARCHIVE', 'Resource metadata must be an object');
        const refs: Record<string, string> = {};
        if (item.files !== undefined) {
          if (!record(item.files)) fail('INVALID_ARCHIVE', 'Invalid reference file mapping');
          for (const [name, archivePath] of Object.entries(item.files)) { if (typeof archivePath !== 'string') fail('INVALID_ARCHIVE', 'Invalid reference file path'); resourcePath(name); resourcePath(archivePath); if (files[archivePath] === undefined) fail('INVALID_ARCHIVE', 'Resource reference file missing'); refs[name] = files[archivePath]! }
        }
        resources.push(normalize({ ...metadata, id: item.id, kind: item.kind as ResourceKind, body, files: refs } as ResourceInput));
      }
    } else {
      for (const [path, body] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
        if (!/^[a-z0-9][a-z0-9-]*\.md$/.test(path)) fail('INVALID_ARCHIVE', 'Flat import accepts only <skill-id>.md files or a manifest package');
        const id = path.slice(0, -3);
        if (['readme', 'report', 'platform-bug-report', 'opencode'].includes(id)) { entries.push({ id, kind: 'document', bytes: bytes(body), action: 'excluded', reason: 'Reporting/OpenCode/runtime archive metadata is excluded from the active library' }); continue }
        resources.push(normalize({ id, kind: 'skill', body, title: id, provenance: 'Operator imported flat Markdown; review source and redistribution rights' }));
      }
    }
    if (new Set(resources.map(r => r.id)).size !== resources.length) fail('INVALID_ARCHIVE', 'Duplicate Resource IDs in package');
    for (const resource of resources) entries.push({ id: resource.id, kind: resource.kind, bytes: bytes(resource.body) + Object.values(resource.files ?? {}).reduce((n, value) => n + bytes(value), 0), action: active(this.state, resource.id) ? 'conflict' : 'add' });
    return { digest: await hash(JSON.stringify(resources)), resources, entries, libraryRevision: this.state.revision };
  }
  async commitImport(preview: ImportPreview, decisions: ImportDecisions, expectedLibraryRevision: number): Promise<Resource[]> {
    this.expected(expectedLibraryRevision);
    if (preview.libraryRevision !== expectedLibraryRevision || preview.digest !== await hash(JSON.stringify(preview.resources))) fail('RESOURCE_CONFLICT', 'Import preview changed or is stale');
    if (!record(decisions) || preview.resources.length > RESOURCE_LIMITS.resources) fail('INVALID_RESOURCE', 'Invalid import decisions');
    const next = clone(this.state), result: Resource[] = [];
    for (const item of preview.resources) {
      const current = active(next, item.id), decision = decisions[item.id];
      if (decision?.action === 'skip') continue;
      if (current && !decision) fail('RESOURCE_CONFLICT', `Explicit conflict decision required for ${item.id}`);
      if (decision && !['replace', 'skip', 'fork'].includes(decision.action)) fail('INVALID_RESOURCE', 'Unknown import conflict decision');
      const target = decision?.action === 'fork' ? decision.newId : item.id;
      if (typeof target !== 'string') fail('INVALID_RESOURCE', 'Fork requires a new Resource ID');
      if (decision?.action === 'fork' && active(next, target)) fail('RESOURCE_CONFLICT', 'Fork target already exists');
      result.push(await this.stage(next, { ...item, id: target }, decision?.action === 'fork' ? 'absent' : current?.revision ?? 'absent'));
    }
    this.expected(expectedLibraryRevision); if (result.length) this.commit(next); return clone(result);
  }
  exportZip(): Uint8Array {
    const files: Record<string, Uint8Array> = {}, resources: unknown[] = [];
    for (const resource of this.list()) {
      const input = asInput(resource), { body, files: refs, ...metadata } = input, path = `resources/${resource.id}/body.md`, refPaths: Record<string, string> = {};
      files[path] = strToU8(body);
      for (const [name, content] of Object.entries(refs ?? {})) { const refPath = `resources/${resource.id}/refs/${name}`; files[refPath] = strToU8(content); refPaths[name] = refPath }
      resources.push({ id: input.id, kind: input.kind, path, metadata: Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== 'id' && key !== 'kind')), files: refPaths });
    }
    files['manifest.json'] = strToU8(JSON.stringify({ schemaVersion: 1, packageId: 'perch-mcp-export', libraryRevision: this.state.revision, resources }, null, 2));
    return zipSync(files, { level: 6 });
  }
}

/** ZIP32 central-directory preflight followed by bounded streaming inflate and CRC verification. */
export function readSafeZip(archive: Uint8Array): Record<string, string> {
  if (!(archive instanceof Uint8Array) || archive.length < 22 || archive.length > RESOURCE_LIMITS.archiveBytes) fail('INVALID_ARCHIVE', 'Archive compressed byte budget invalid');
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength), u16 = (offset: number) => view.getUint16(offset, true), u32 = (offset: number) => view.getUint32(offset, true);
  let end = -1;
  for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 65557); offset--) if (u32(offset) === 0x06054b50 && offset + 22 + u16(offset + 20) === archive.length) { end = offset; break }
  if (end < 0 || u16(end + 4) || u16(end + 6) || u16(end + 8) !== u16(end + 10)) fail('INVALID_ARCHIVE', 'ZIP end record missing or multi-disk archive unsupported');
  const count = u16(end + 10), directorySize = u32(end + 12), directoryOffset = u32(end + 16);
  if (count > RESOURCE_LIMITS.files || directoryOffset + directorySize !== end || directoryOffset > end) fail('INVALID_ARCHIVE', 'ZIP directory budget/range invalid');
  const expected = new Map<string, { size: number; crc: number; directory: boolean }>(), folded = new Set<string>();
  let cursor = directoryOffset, total = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || u32(cursor) !== 0x02014b50) fail('INVALID_ARCHIVE', 'Invalid ZIP directory entry');
    const flags = u16(cursor + 8), method = u16(cursor + 10), crc = u32(cursor + 16), compressed = u32(cursor + 20), size = u32(cursor + 24), nameLength = u16(cursor + 28), extraLength = u16(cursor + 30), commentLength = u16(cursor + 32), attributes = u32(cursor + 38), localOffset = u32(cursor + 42);
    if (cursor + 46 + nameLength + extraLength + commentLength > end || flags & 1 || ![0, 8].includes(method) || size === 0xffffffff || compressed === 0xffffffff || localOffset === 0xffffffff) fail('INVALID_ARCHIVE', 'Encrypted/ZIP64/unsupported ZIP entry');
    let name: string; try { name = decoder.decode(archive.subarray(cursor + 46, cursor + 46 + nameLength)) } catch { fail('INVALID_ARCHIVE', 'Archive names must be UTF-8') }
    const directory = name.endsWith('/');
    resourcePath(directory ? name.slice(0, -1) : name);
    if (directory && (size !== 0 || compressed > 2)) fail('INVALID_ARCHIVE', 'Directory entry contains data');
    if (folded.has(name.replace(/\/$/, '').toLowerCase()) || ![0, 0x4000, 0x8000].includes((attributes >>> 16) & 0xf000)) fail('INVALID_ARCHIVE', 'Duplicate/case-colliding paths or symlink');
    if (size > RESOURCE_LIMITS.fileBytes || size > Math.max(1, compressed) * RESOURCE_LIMITS.ratio || (total += size) > RESOURCE_LIMITS.totalBytes) fail('LIMIT_EXCEEDED', 'ZIP expansion budget exceeded');
    if (localOffset + 30 > directoryOffset || u32(localOffset) !== 0x04034b50 || u16(localOffset + 6) !== flags || u16(localOffset + 8) !== method) fail('INVALID_ARCHIVE', 'ZIP local/central headers disagree');
    const localNameLength = u16(localOffset + 26), localExtraLength = u16(localOffset + 28), dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressed > directoryOffset || decoder.decode(archive.subarray(localOffset + 30, localOffset + 30 + localNameLength)) !== name) fail('INVALID_ARCHIVE', 'ZIP entry range/name invalid');
    expected.set(name, { size, crc, directory }); folded.add(name.replace(/\/$/, '').toLowerCase()); cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== end) fail('INVALID_ARCHIVE', 'ZIP central directory size mismatch');
  const result: Record<string, string> = {}, chunks = new Map<string, Uint8Array[]>(), sizes = new Map<string, number>();
  let emitted = 0, entries = 0;
  const unzip = new Unzip(file => {
    const entry = expected.get(file.name); if (!entry || ++entries > count) fail('INVALID_ARCHIVE', 'Unexpected or duplicate local ZIP entry');
    if (chunks.has(file.name)) fail('INVALID_ARCHIVE', 'Duplicate local ZIP entry');
    chunks.set(file.name, []); sizes.set(file.name, 0);
    file.ondata = (error, data, final) => {
      if (error) fail('INVALID_ARCHIVE', 'ZIP decompression failed');
      const size = (sizes.get(file.name) ?? 0) + data.length;
      if (size > entry.size || (emitted += data.length) > RESOURCE_LIMITS.totalBytes) { file.terminate(); fail('LIMIT_EXCEEDED', 'ZIP actual expansion exceeds declaration') }
      sizes.set(file.name, size); chunks.get(file.name)!.push(data.slice());
      if (final) {
        if (size !== entry.size) fail('INVALID_ARCHIVE', 'ZIP file size mismatch');
        const joined = new Uint8Array(size); let offset = 0; for (const chunk of chunks.get(file.name)!) { joined.set(chunk, offset); offset += chunk.length }
        if (crc32(joined) !== entry.crc) fail('INVALID_ARCHIVE', 'ZIP CRC mismatch');
        try { if (!entry.directory) result[file.name] = decoder.decode(joined) } catch { fail('INVALID_ARCHIVE', 'Resource files must be valid UTF-8') }
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  try { for (let offset = 0; offset < archive.length; offset += 1024) unzip.push(archive.subarray(offset, Math.min(archive.length, offset + 1024)), offset + 1024 >= archive.length) } catch (error) { if (error instanceof ResourceError) throw error; fail('INVALID_ARCHIVE', 'ZIP parsing failed') }
  if (Object.keys(result).length !== [...expected.values()].filter(entry => !entry.directory).length || entries !== count) fail('INVALID_ARCHIVE', 'ZIP contains missing or unfinished files');
  return result;
}
function crc32(data: Uint8Array): number {
  let crc = -1;
  for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0) }
  return (crc ^ -1) >>> 0;
}
