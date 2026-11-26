/** Trusted-controller-only image upload; never expose send or lease scope to generator code. */
export interface BrowserImageScope {
  operationId: string;
  workspaceId: string;
  epoch: number;
  bindingRevision: number;
  tabInstanceId: string;
}
export interface ImageUploadOptions {
  operation: BrowserImageScope;
  send(body: Record<string, unknown>): Promise<unknown>;
  signal?: AbortSignal;
}
const MAX_BYTES = 1024 * 1024;
const CHUNK_BYTES = 192 * 1024;
const MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function fail(message: string, code = "INVALID_INPUT"): never {
  throw Object.assign(new Error(message), { code, recovery: "Inspect the existing operation and local workspace image. Image upload never re-executes its tool." });
}
function encode(bytes: Uint8Array): string {
  let raw = "";
  for (let i = 0; i < bytes.length; i += 8192) raw += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(raw);
}
function checkSignal(signal?: AbortSignal): void { if (signal?.aborted) fail("Image transfer interrupted; inspect the existing operation.", "EFFECT_UNKNOWN"); }
function progress(value: unknown, operationId: string, index: number, size: number): { nextOffset: number; committed: boolean } {
  if (!object(value) || value.operationId !== operationId || value.index !== index || !Number.isSafeInteger(value.nextOffset) || (value.nextOffset as number) < 0 || (value.nextOffset as number) > size || typeof value.committed !== "boolean" || ((value.nextOffset as number) !== size && (value.nextOffset as number) % CHUNK_BYTES) || (value.committed && value.nextOffset !== size))
    fail("Gateway returned inconsistent image progress.");
  return { nextOffset: value.nextOffset as number, committed: value.committed as boolean };
}
/** Call only for successful known image-tool payloads before terminal persistence and its inline limit. */
export async function uploadImageResult(result: unknown, options: ImageUploadOptions): Promise<unknown> {
  if (!object(result) || !Array.isArray(result.content)) return result;
  if (result.content.length < 1 || result.content.length > 4) fail("Image result requires one to four image blocks.");
  let total = 0;
  // Validate all blocks before the first byte leaves the browser.
  const images = result.content.map((block, index) => {
    if (!object(block) || block.type !== "image" || typeof block.mimeType !== "string" || !MIME_TYPES.has(block.mimeType) || typeof block.data !== "string" || !block.data.length || block.data.length > Math.ceil(MAX_BYTES / 3) * 4 || block.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(block.data)) fail("Image result contains invalid bounded image content.");
    let raw: string;
    try { raw = atob(block.data); } catch { fail("Image result has invalid base64."); }
    if (btoa(raw) !== block.data) fail("Image result base64 is not canonical.");
    const bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0));
    total += bytes.length;
    if (total > MAX_BYTES) fail("Combined image result exceeds 1 MiB.", "LIMIT_EXCEEDED");
    return { index, mimeType: block.mimeType, bytes };
  });
  const content: Record<string, unknown>[] = [];
  for (const image of images) {
    checkSignal(options.signal);
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", image.bytes as Uint8Array<ArrayBuffer>)), (n) => n.toString(16).padStart(2, "0")).join("");
    const send = async (action: string, body: Record<string, unknown> = {}) => {
      checkSignal(options.signal);
      const response = await options.send({ ...options.operation, action, index: image.index, ...body });
      checkSignal(options.signal);
      return progress(response, options.operation.operationId, image.index, image.bytes.length);
    };
    let state = await send("start", { byteLength: image.bytes.length, sha256, mimeType: image.mimeType });
    // At most six chunks per 1 MiB image. Resume only server-acknowledged exact byte ranges.
    for (let count = 0; state.nextOffset < image.bytes.length && count < 6; count++) {
      const offset = state.nextOffset, end = Math.min(offset + CHUNK_BYTES, image.bytes.length);
      const next = await send("chunk", { offset, data: encode(image.bytes.subarray(offset, end)) });
      if (next.nextOffset !== end || next.committed) fail("Gateway image acknowledgement advanced unexpectedly.");
      state = next;
    }
    if (state.nextOffset !== image.bytes.length) fail("Image upload exceeded its bounded chunk count.");
    if (!state.committed) state = await send("commit");
    if (!state.committed) fail("Gateway did not commit image bytes.");
    content.push({ type: "image", mimeType: image.mimeType, imageTransfer: { operationId: options.operation.operationId, index: image.index, byteLength: image.bytes.length, sha256 } });
  }
  return { ...result, content };
}
