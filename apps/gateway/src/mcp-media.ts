import { ApiError } from "./common.js";
export interface McpImageBlock {
  type: "image";
  mimeType: string;
  data: string;
}
const MEDIA_TOOLS = new Set([
  "read_image",
  "capture_page_image",
  "generate_image",
]);
const MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);
const MAX_IMAGE_BYTES = 1024 * 1024;
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function signature(bytes: Uint8Array, mime: string): boolean {
  const starts = (values: number[]) =>
    values.every((value, index) => bytes[index] === value);
  if (mime === "image/png") return starts([137, 80, 78, 71, 13, 10, 26, 10]);
  if (mime === "image/jpeg") return starts([255, 216, 255]);
  if (mime === "image/gif")
    return ["GIF87a", "GIF89a"].includes(
      String.fromCharCode(...bytes.subarray(0, 6)),
    );
  return (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  );
}
/** Project only authenticated, succeeded image-tool outcomes; never interpret arbitrary page/source data as MCP content. */
export function projectMcpImages(summary: unknown): {
  data: unknown;
  images: McpImageBlock[];
} {
  if (
    !object(summary) ||
    summary.status !== "SUCCEEDED" ||
    !MEDIA_TOOLS.has(String(summary.tool))
  )
    return { data: summary, images: [] };
  const terminal = summary.data;
  if (
    !object(terminal) ||
    terminal.status !== "SUCCEEDED" ||
    terminal.operationId !== summary.operationId ||
    !object(terminal.data)
  )
    throw new ApiError(
      "INVALID_INPUT",
      "Image operation result is inconsistent with its stored handle.",
    );
  const payload = terminal.data,
    blocks = payload.content;
  if (payload.resultOmitted === true) return { data: summary, images: [] };
  if (!Array.isArray(blocks) || blocks.length < 1 || blocks.length > 4)
    throw new ApiError(
      "INVALID_INPUT",
      "Image operation has no bounded standard image content.",
    );
  const images: McpImageBlock[] = [],
    descriptors: Record<string, unknown>[] = [];
  let totalBytes = 0;
  for (const block of blocks) {
    if (
      !object(block) ||
      block.type !== "image" ||
      typeof block.mimeType !== "string" ||
      !MIME_TYPES.has(block.mimeType) ||
      typeof block.data !== "string"
    )
      throw new ApiError(
        "INVALID_INPUT",
        "Image content requires a supported MIME type and base64 bytes.",
      );
    if (block.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4)
      throw new ApiError(
        "LIMIT_EXCEEDED",
        "Image content exceeds the 1 MiB MCP image budget.",
      );
    if (
      !block.data.length ||
      block.data.length % 4 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(block.data)
    )
      throw new ApiError("INVALID_INPUT", "Image content has invalid base64.");
    let decoded: string;
    try {
      decoded = atob(block.data);
    } catch {
      throw new ApiError("INVALID_INPUT", "Image content has invalid base64.");
    }
    if (btoa(decoded) !== block.data)
      throw new ApiError(
        "INVALID_INPUT",
        "Image base64 must use its canonical byte encoding.",
      );
    const bytes = Uint8Array.from(decoded, (char) => char.charCodeAt(0));
    totalBytes += bytes.length;
    if (totalBytes > MAX_IMAGE_BYTES)
      throw new ApiError(
        "LIMIT_EXCEEDED",
        "Combined image content exceeds the 1 MiB MCP image budget.",
      );
    if (
      !signature(bytes, block.mimeType) ||
      (payload.mimeType !== undefined && payload.mimeType !== block.mimeType)
    )
      throw new ApiError(
        "INVALID_INPUT",
        "Image MIME type differs from its encoded file signature.",
      );
    images.push({ type: "image", mimeType: block.mimeType, data: block.data });
    descriptors.push({
      type: "image",
      mimeType: block.mimeType,
      bytes: bytes.length,
      contentIndex: images.length,
    });
  }
  // Base64 appears once, in standard MCP image blocks, rather than in text and structured JSON too.
  return {
    data: {
      ...summary,
      data: { ...terminal, data: { ...payload, content: descriptors } },
    },
    images,
  };
}
