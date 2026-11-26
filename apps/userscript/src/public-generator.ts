import { canonicalPath, digest, utf8 } from "./native-types.js";
import { ExecutionError } from "./compute.js";
export interface PublicGeneratorSnapshot {
  generatorId: string;
  slug: string;
  revision: string;
  files: Record<string, Uint8Array>;
  count: number;
  bytes: number;
}
async function boundedResponse(
  response: Response,
  max: number,
): Promise<Uint8Array> {
  if (!response.ok || response.redirected || response.type === "opaque")
    throw new ExecutionError(
      "PROVIDER_REJECTED",
      "Public generator read failed. No partial source was installed.",
    );
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (reader)
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > max)
          throw new ExecutionError(
            "LIMIT_EXCEEDED",
            "Public generator snapshot exceeds the configured budget.",
          );
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
/** Fixed public read interfaces only. No native credentials, mutation API, or arbitrary proxy. */
export async function readPublicGenerator(
  slug: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<PublicGeneratorSnapshot> {
  if (!/^[a-z0-9][a-z0-9-]{0,119}$/.test(slug))
    throw new ExecutionError(
      "INVALID_INPUT",
      "Use a canonical generator Slug.",
    );
  const options = {
    credentials: "omit" as const,
    redirect: "error" as const,
    cache: "no-store" as const,
    referrerPolicy: "no-referrer" as const,
    signal: signal ?? AbortSignal.timeout(30000),
  };
  async function metadata() {
    let data: unknown;
    try {
      const response = await fetcher(
        "https://perchance.org/api/getGeneratorPageData",
        {
          ...options,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ generatorName: slug }),
        },
      );
      data = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await boundedResponse(response, 4 * 1024 * 1024),
        ),
      );
    } catch (error) {
      if (error instanceof ExecutionError) throw error;
      throw new ExecutionError(
        "UNSUPPORTED_INTERFACE",
        "Complete public saved-source interface unavailable. Dependency-only source is not a complete backup.",
      );
    }
    const root = data as Record<string, unknown>,
      g = root?.generator as Record<string, unknown>;
    if (
      root.status !== "success" ||
      !g ||
      String(g.name) !== slug ||
      typeof g.modelText !== "string" ||
      typeof g.outputTemplate !== "string" ||
      !["string", "number"].includes(typeof g.id) ||
      !g.srcManifest ||
      typeof g.srcManifest !== "object" ||
      Array.isArray(g.srcManifest)
    )
      throw new ExecutionError(
        "UNSUPPORTED_INTERFACE",
        "Public saved source is missing exact identity, panels or source manifest.",
      );
    if (typeof g.id === "number" && !Number.isSafeInteger(g.id))
      throw new ExecutionError(
        "UNSUPPORTED_INTERFACE",
        "Generator ID cannot be serialized losslessly.",
      );
    return g;
  }
  const before = await metadata();
  const files: Record<string, Uint8Array> = Object.create(null) as Record<
    string,
    Uint8Array
  >;
  files["main.pjs"] = utf8.encode(before.modelText as string);
  files["index.html"] = utf8.encode(before.outputTemplate as string);
  let total = files["main.pjs"]!.length + files["index.html"]!.length;
  const paths = Object.keys(before.srcManifest as object).sort();
  if (paths.length > 1000)
    throw new ExecutionError(
      "LIMIT_EXCEEDED",
      "Public source has more than 1000 files.",
    );
  for (const relative of paths) {
    const path = canonicalPath(`src/${relative}`);
    const entry = (before.srcManifest as Record<string, unknown>)[relative];
    if (!entry || typeof entry !== "object")
      throw new ExecutionError(
        "UNSUPPORTED_INTERFACE",
        "Source manifest entries must contain exact key and byte size.",
      );
    const { key, size } = entry as { key?: unknown; size?: unknown };
    if (
      typeof key !== "string" ||
      !/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,255}$/.test(key) ||
      typeof size !== "number" ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > 16 * 1024 * 1024
    )
      throw new ExecutionError(
        "UNSUPPORTED_INTERFACE",
        "Public source manifest changed or exceeds supported file size.",
      );
    if (Object.keys(files).some((p) => p.toLowerCase() === path.toLowerCase()))
      throw new ExecutionError(
        "PATH_DENIED",
        "Public source manifest has a path collision.",
      );
    const bytes = await boundedResponse(
      await fetcher(
        `https://user.uploads.dev/file/${encodeURIComponent(key)}`,
        options,
      ),
      Math.min(16 * 1024 * 1024, 32 * 1024 * 1024 - total),
    );
    if (bytes.length !== size)
      throw new ExecutionError(
        "NATIVE_CONFLICT",
        "Public file length differs from manifest. No snapshot was installed.",
      );
    files[path] = bytes;
    total += bytes.length;
    if (total > 32 * 1024 * 1024)
      throw new ExecutionError(
        "LIMIT_EXCEEDED",
        "Public source snapshot exceeds 32 MiB.",
      );
  }
  const after = await metadata();
  const fingerprint = (g: Record<string, unknown>) =>
    JSON.stringify([
      g.id,
      g.name,
      g.modelText,
      g.outputTemplate,
      g.srcManifest,
      g.sourceRevision,
      g.editorPayloadRevision,
      g.saveCount,
    ]);
  if (fingerprint(before) !== fingerprint(after))
    throw new ExecutionError(
      "STALE_REVISION",
      "Saved source changed during retrieval. No mixed snapshot was installed.",
    );
  const manifest = await Promise.all(
    Object.keys(files)
      .sort()
      .map(async (p) => [p, files[p]!.length, await digest(files[p]!)]),
  );
  return {
    generatorId: String(before.id),
    slug,
    revision: await digest(JSON.stringify([String(before.id), manifest])),
    files,
    count: Object.keys(files).length,
    bytes: total,
  };
}
