import { ApiError, fields, id } from "./common.js";
import type { SqlRecords } from "./sql.js";

export const IMAGE_MAX_BYTES = 1024 * 1024;
export const IMAGE_CHUNK_BYTES = 192 * 1024;
export const IMAGE_WORKSPACE_BYTES = 8 * IMAGE_MAX_BYTES;
export const IMAGE_TTL_MS = 10 * 60 * 1000;
const MAX_MANIFESTS = 64;
const IMAGE_TOOLS = new Set(["read_image", "generate_image", "capture_page_image"]);
const MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
type Records = Pick<SqlRecords, "get" | "put" | "delete" | "keys" | "transaction">;
export interface ImageLease {
  workspaceId: string;
  epoch: number;
  bindingRevision: number;
  tabInstanceId: string;
  expiresAt: number;
}
export interface ImageOperation {
  operationId: string;
  workspaceId: string;
  epoch: number;
  bindingRevision: number;
  tabInstanceId: string;
  agentId: string;
  tool: string;
  phase: string;
  deadlineMs: number;
  terminalAt?: number;
}
export interface ImageTransferReference {
  operationId: string;
  index: number;
  byteLength: number;
  sha256: string;
}
export interface ImageReadScope {
  workspaceId: string;
  bindingRevision: number;
  agentId: string;
  operationId: string;
}
interface Manifest extends ImageTransferReference {
  workspaceId: string;
  epoch: number;
  bindingRevision: number;
  tabInstanceId: string;
  agentId: string;
  mimeType: string;
  nextOffset: number;
  state: "STAGING" | "READY";
  expiresAt: number;
}
export interface ImageTransferDependencies<T extends ImageOperation> {
  getLease(): ImageLease | undefined;
  getOperation(operationId: string): T | undefined;
  /** Revalidate the original operation's current Registry Grant and Workspace policy. */
  authorize(operation: T): Promise<void>;
  now?(): number;
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function integer(value: unknown, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
    throw new ApiError("INVALID_INPUT", `Invalid image ${name}.`);
  return value as number;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw new ApiError("INVALID_INPUT", "Image SHA-256 must be lowercase hexadecimal.");
  return value;
}
function decode(value: unknown, max: number): Uint8Array {
  if (typeof value !== "string" || !value.length || value.length > Math.ceil(max / 3) * 4 || value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))
    throw new ApiError("INVALID_INPUT", "Invalid bounded image base64.");
  let raw: string;
  try { raw = atob(value); } catch { throw new ApiError("INVALID_INPUT", "Invalid image base64."); }
  if (raw.length > max || btoa(raw) !== value)
    throw new ApiError("INVALID_INPUT", "Image bytes require canonical bounded base64.");
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}
function encode(bytes: Uint8Array): string {
  let raw = "";
  for (let i = 0; i < bytes.length; i += 8192)
    raw += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(raw);
}
async function sha256(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)), (n) => n.toString(16).padStart(2, "0")).join("");
}
function signature(bytes: Uint8Array, mime: string): boolean {
  const starts = (values: number[]) => values.every((value, index) => bytes[index] === value);
  if (mime === "image/png") return starts([137, 80, 78, 71, 13, 10, 26, 10]);
  if (mime === "image/jpeg") return starts([255, 216, 255]);
  if (mime === "image/gif") return ["GIF87a", "GIF89a"].includes(String.fromCharCode(...bytes.subarray(0, 6)));
  return bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP";
}
function reference(value: unknown): ImageTransferReference {
  if (!object(value)) throw new ApiError("INVALID_INPUT", "Image transfer reference required.");
  fields(value, ["operationId", "index", "byteLength", "sha256"]);
  return { operationId: id(value.operationId), index: integer(value.index, 0, 3, "index"), byteLength: integer(value.byteLength, 1, IMAGE_MAX_BYTES, "byte length"), sha256: hash(value.sha256) };
}
/** Private lease-bound image storage. No tool execution, fetch, or public artifact URL exists here. */
export class ImageTransferHandler<T extends ImageOperation = ImageOperation> {
  constructor(private db: Records, private dependencies: ImageTransferDependencies<T>) {}
  private now(): number { return this.dependencies.now?.() ?? Date.now(); }
  private key(operationId: string, index: number): string { return `image/manifest/${operationId}/${index}`; }
  private chunkKey(operationId: string, index: number, offset: number): string { return `image/chunk/${operationId}/${index}/${offset}`; }
  private remove(manifest: Manifest): void {
    for (let offset = 0; offset < manifest.byteLength; offset += IMAGE_CHUNK_BYTES)
      this.db.delete(this.chunkKey(manifest.operationId, manifest.index, offset));
    this.db.delete(this.key(manifest.operationId, manifest.index));
  }
  private manifests(): Manifest[] {
    const manifests: Manifest[] = [];
    for (const key of this.db.keys("image/manifest/")) {
      const manifest = this.db.get<Manifest>(key);
      if (manifest.expiresAt <= this.now()) this.remove(manifest);
      else manifests.push(manifest);
    }
    return manifests;
  }
  /** Invoke with the Workspace's normal expiration pass; reads still enforce the TTL independently. */
  expire(keys?:string[]): void {
    this.db.transaction(() => {
      if(keys===undefined){this.manifests();return;}
      for(const key of keys){
        const manifest=this.db.get<Manifest>(key);
        if(manifest&&manifest.expiresAt<=this.now())this.remove(manifest);
      }
    });
  }
  /** Include in the Workspace's existing alarm; no separate scheduler or binding is required. */
  nextExpiry(): number | undefined {
    const times = this.db.keys("image/manifest/").map((key) => this.db.get<Manifest>(key).expiresAt);
    return times.length ? Math.min(...times) : undefined;
  }
  private operation(body: Record<string, unknown>, lease: ImageLease): T {
    const current = this.dependencies.getLease(), op = this.dependencies.getOperation(id(body.operationId));
    if (!current || current.expiresAt <= this.now() || current.workspaceId !== lease.workspaceId || current.epoch !== lease.epoch || current.bindingRevision !== lease.bindingRevision || current.tabInstanceId !== lease.tabInstanceId || body.workspaceId !== current.workspaceId || body.epoch !== current.epoch || body.bindingRevision !== current.bindingRevision || body.tabInstanceId !== current.tabInstanceId)
      throw new ApiError("STALE_EPOCH", "Image transfer belongs to another active document lease.", 409);
    if (!op || op.workspaceId !== current.workspaceId || op.epoch !== current.epoch || op.bindingRevision !== current.bindingRevision || op.tabInstanceId !== current.tabInstanceId)
      throw new ApiError("NOT_FOUND", "Image operation does not belong to this document lease.", 404);
    if (op.phase !== "RUNNING" || op.terminalAt !== undefined || op.deadlineMs <= this.now() || !IMAGE_TOOLS.has(op.tool))
      throw new ApiError("CONFLICT", "Image transfer requires an unexpired RUNNING image operation.", 409);
    return op;
  }
  private pinned(manifest: Manifest, op: ImageOperation): void {
    if (manifest.workspaceId !== op.workspaceId || manifest.epoch !== op.epoch || manifest.bindingRevision !== op.bindingRevision || manifest.tabInstanceId !== op.tabInstanceId || manifest.agentId !== op.agentId)
      throw new ApiError("STALE_EPOCH", "Image manifest belongs to another operation binding.", 409);
  }
  private progress(manifest: Manifest): Record<string, unknown> {
    return { operationId: manifest.operationId, index: manifest.index, nextOffset: manifest.nextOffset, committed: manifest.state === "READY", expiresAt: manifest.expiresAt };
  }
  async handle(body: Record<string, unknown>, lease: ImageLease): Promise<unknown> {
    const action = body.action;
    const common = ["action", "workspaceId", "epoch", "bindingRevision", "tabInstanceId", "operationId", "index"];
    if (action === "start") fields(body, [...common, "byteLength", "sha256", "mimeType"]);
    else if (action === "chunk") fields(body, [...common, "offset", "data"]);
    else if (action === "commit") fields(body, common);
    else throw new ApiError("INVALID_INPUT", "Unknown image transfer action.");
    const index = integer(body.index, 0, 3, "index"), before = this.operation(body, lease);
    await this.dependencies.authorize(before);
    // Registry revalidation yields. Recheck all local fences before touching storage.
    const op = this.operation(body, lease), key = this.key(op.operationId, index);
    if (action === "start") {
      const byteLength = integer(body.byteLength, 1, IMAGE_MAX_BYTES, "byte length"), sha = hash(body.sha256);
      if (typeof body.mimeType !== "string" || !MIME_TYPES.has(body.mimeType))
        throw new ApiError("INVALID_INPUT", "Unsupported image MIME type.");
      return this.db.transaction(() => {
        const manifests = this.manifests(), existing = this.db.get<Manifest>(key);
        if (existing) {
          this.pinned(existing, op);
          if (existing.byteLength !== byteLength || existing.sha256 !== sha || existing.mimeType !== body.mimeType)
            throw new ApiError("CONFLICT", "Image manifest cannot be replaced.", 409);
          return this.progress(existing);
        }
        if (manifests.length >= MAX_MANIFESTS || manifests.reduce((n, m) => n + m.byteLength, 0) + byteLength > IMAGE_WORKSPACE_BYTES || manifests.filter((m) => m.operationId === op.operationId).reduce((n, m) => n + m.byteLength, 0) + byteLength > IMAGE_MAX_BYTES)
          throw new ApiError("LIMIT_EXCEEDED", "Transient Workspace image storage budget exhausted.", 429, "Wait for ten-minute image expiry. Do not repeat a mutating image tool.");
        const manifest: Manifest = { operationId: op.operationId, index, byteLength, sha256: sha, workspaceId: op.workspaceId, epoch: op.epoch, bindingRevision: op.bindingRevision, tabInstanceId: op.tabInstanceId, agentId: op.agentId, mimeType: body.mimeType as string, nextOffset: 0, state: "STAGING", expiresAt: this.now() + IMAGE_TTL_MS };
        this.db.put(key, manifest);
        return this.progress(manifest);
      });
    }
    const manifest = this.db.get<Manifest>(key);
    if (!manifest || manifest.expiresAt <= this.now())
      throw new ApiError("RESULT_EXPIRED", "Image transfer manifest expired or is absent.", 410, "Inspect the operation. Image transfer never re-executes its tool.");
    this.pinned(manifest, op);
    if (action === "chunk") {
      const offset = integer(body.offset, 0, IMAGE_MAX_BYTES - 1, "offset"), bytes = decode(body.data, IMAGE_CHUNK_BYTES);
      if (offset % IMAGE_CHUNK_BYTES || bytes.length !== Math.min(IMAGE_CHUNK_BYTES, manifest.byteLength - offset))
        throw new ApiError("INVALID_INPUT", "Image chunk must match its fixed contiguous range.");
      return this.db.transaction(() => {
        const current = this.db.get<Manifest>(key);
        if (current.state !== "STAGING" && offset >= current.nextOffset)
          throw new ApiError("CONFLICT", "Committed image cannot be modified.", 409);
        if (offset < current.nextOffset) {
          if (this.db.get<string>(this.chunkKey(op.operationId, index, offset)) !== body.data)
            throw new ApiError("CONFLICT", "Overlapping image chunk has different bytes.", 409);
          return this.progress(current); // Exact duplicate acknowledgement is idempotent.
        }
        if (offset !== current.nextOffset)
          throw new ApiError("CONFLICT", "Image chunk is out of order.", 409);
        this.db.put(this.chunkKey(op.operationId, index, offset), body.data);
        current.nextOffset += bytes.length;
        this.db.put(key, current);
        return this.progress(current);
      });
    }
    const bytes = this.bytes(manifest);
    if (await sha256(bytes) !== manifest.sha256 || !signature(bytes, manifest.mimeType))
      throw new ApiError("INVALID_INPUT", "Image bytes disagree with their hash or MIME signature.");
    this.operation(body, lease);
    return this.db.transaction(() => {
      const current = this.db.get<Manifest>(key);
      if (!current || current.expiresAt <= this.now()) throw new ApiError("RESULT_EXPIRED", "Image manifest expired during commit.", 410);
      this.pinned(current, op);
      if (current.sha256 !== manifest.sha256 || current.byteLength !== manifest.byteLength || current.mimeType !== manifest.mimeType || current.expiresAt !== manifest.expiresAt || current.nextOffset !== manifest.byteLength)
        throw new ApiError("CONFLICT", "Image manifest changed during integrity verification.", 409);
      current.state = "READY";
      this.db.put(key, current); // One atomic publication pointer; partial chunks are never readable.
      return this.progress(current);
    });
  }
  private bytes(manifest: Manifest): Uint8Array {
    if (manifest.nextOffset !== manifest.byteLength)
      throw new ApiError("CONFLICT", "Image transfer is incomplete.", 409);
    const bytes = new Uint8Array(manifest.byteLength);
    for (let offset = 0; offset < bytes.length; offset += IMAGE_CHUNK_BYTES) {
      const chunk = decode(this.db.get<string>(this.chunkKey(manifest.operationId, manifest.index, offset)), IMAGE_CHUNK_BYTES);
      if (chunk.length !== Math.min(IMAGE_CHUNK_BYTES, bytes.length - offset))
        throw new ApiError("INVALID_INPUT", "Stored image chunk length is inconsistent.");
      bytes.set(chunk, offset);
    }
    return bytes;
  }
  /** Caller MUST first authorize the current Grant; read scope comes from that authorization, never model input. */
  async read(value: unknown, mimeType: unknown, scope: ImageReadScope): Promise<{ type: "image"; mimeType: string; data: string }> {
    const ref = reference(value), op = this.dependencies.getOperation(scope.operationId);
    if (!op || ref.operationId !== op.operationId || op.workspaceId !== scope.workspaceId || op.bindingRevision !== scope.bindingRevision || op.agentId !== scope.agentId || op.phase !== "SUCCEEDED" || !IMAGE_TOOLS.has(op.tool))
      throw new ApiError("NOT_FOUND", "Image result is outside the current Agent binding.", 404);
    const manifest = this.db.get<Manifest>(this.key(ref.operationId, ref.index));
    if (!manifest || manifest.expiresAt <= this.now())
      throw new ApiError("RESULT_EXPIRED", "Transient image bytes expired. The tool was not re-executed.", 410, "Use existing workspace image data; start a new read_image operation only if needed.");
    this.pinned(manifest, op);
    if (manifest.state !== "READY" || manifest.byteLength !== ref.byteLength || manifest.sha256 !== ref.sha256 || manifest.mimeType !== mimeType)
      throw new ApiError("INVALID_INPUT", "Image reference does not match a committed manifest.");
    const bytes = this.bytes(manifest);
    if (await sha256(bytes) !== ref.sha256 || !signature(bytes, manifest.mimeType))
      throw new ApiError("INVALID_INPUT", "Stored image bytes failed integrity verification.");
    if (this.now() >= manifest.expiresAt)
      throw new ApiError("RESULT_EXPIRED", "Transient image bytes expired during integrity verification.", 410);
    const current = this.dependencies.getOperation(scope.operationId);
    if (!current || current.phase !== "SUCCEEDED" || current.workspaceId !== scope.workspaceId || current.bindingRevision !== scope.bindingRevision || current.agentId !== scope.agentId)
      throw new ApiError("NOT_FOUND", "Image result authorization changed during read.", 404);
    this.pinned(manifest, current);
    return { type: "image", mimeType: manifest.mimeType, data: encode(bytes) };
  }
  /** Hydrate only the fixed succeeded image-tool terminal shape, before standard MCP projection. */
  async hydrate(summary: unknown, scope: ImageReadScope): Promise<unknown> {
    if (!object(summary) || summary.status !== "SUCCEEDED" || !IMAGE_TOOLS.has(String(summary.tool))) return summary;
    const terminal = summary.data;
    if (!object(terminal) || !object(terminal.data) || !Array.isArray(terminal.data.content)) return summary;
    if (summary.operationId !== scope.operationId || terminal.operationId !== scope.operationId || terminal.status !== "SUCCEEDED")
      throw new ApiError("INVALID_INPUT", "Image terminal handle is inconsistent.");
    if (terminal.data.content.length > 4) throw new ApiError("LIMIT_EXCEEDED", "Too many image result blocks.");
    const content: unknown[] = [];
    let total = 0;
    for (const block of terminal.data.content) {
      if (object(block) && block.imageTransfer !== undefined) {
        fields(block, ["type", "mimeType", "imageTransfer"]);
        if (block.type !== "image") throw new ApiError("INVALID_INPUT", "Image reference block type is invalid.");
        const ref = reference(block.imageTransfer);
        if (ref.index !== content.length) throw new ApiError("INVALID_INPUT", "Image reference index differs from its content position.");
        total += ref.byteLength;
        if (total > IMAGE_MAX_BYTES) throw new ApiError("LIMIT_EXCEEDED", "Combined image result exceeds 1 MiB.");
        content.push(await this.read(ref, block.mimeType, scope));
      } else content.push(block);
    }
    return { ...summary, data: { ...terminal, data: { ...terminal.data, content } } };
  }
}
