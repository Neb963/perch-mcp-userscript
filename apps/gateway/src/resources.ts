import {
  ResourceLibrary,
  ResourceError,
  type LibraryState,
  type ResourceContext,
  type ResourceInput,
  type ResourceKind,
  type ImportDecisions,
  type ScopeType,
} from "../../../packages/resource-library/src/index.js";
import { defaultResources } from "../../../packages/resources/defaults.js";
import {
  ApiError,
  canonical,
  digest,
  id,
  json,
  parseBody,
  revision,
  str,
} from "./common.js";
import { SqlRecords } from "./sql.js";
import {
  NativeResourceLibrary, resourceLibraryIsNative, resourceLibraryRevision,
} from "./resource-storage.js";
export async function loadLibrary(db: SqlRecords): Promise<ResourceLibrary | NativeResourceLibrary> {
  if (resourceLibraryIsNative(db)) return new NativeResourceLibrary(db);
  const saved = db.get<LibraryState | undefined>("library");
  if (saved === null) throw new ResourceError("INCOMPATIBLE_VERSION", "Invalid resource snapshot");
  const library = new ResourceLibrary(saved);
  if (saved === undefined) {
    await library.seed(defaultResources);
    db.transaction(() => {
      if (db.get("library") === undefined) db.put("library", library.snapshot());
    });
    return new ResourceLibrary(db.get<LibraryState>("library"));
  }
  return library;
}
function metadata(
  r: import("../../../packages/resource-library/src/index.js").Resource,
): Record<string, unknown> {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title.slice(0, 200),
    description: r.description.slice(0, 512),
    enabled: r.enabled,
    revision: r.revision,
    hash: r.hash,
    customized: r.customized,
    deleted: r.deleted,
    upstreamVersion: r.upstreamVersion?.slice(0, 100),
  };
}
function page(
  items: unknown[],
  url: URL,
  revision: number,
): Record<string, unknown> {
  const raw = url.searchParams.get("cursor"),
    parts = raw?.split(":");
  const offset = parts ? Number(parts[1]) : 0;
  if (
    (parts && (parts.length !== 2 || Number(parts[0]) !== revision)) ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  )
    throw new ApiError(
      "RESOURCE_CONFLICT",
      "List changed or cursor is invalid; restart the list.",
      409,
    );
  const end = Math.min(items.length, offset + 100);
  return {
    items: items.slice(offset, end),
    revision,
    cursor: end < items.length ? revision + ":" + end : null,
  };
}
export async function resourceAdmin(
  request: Request,
  db: SqlRecords,
  reauthorize: () => void,
): Promise<Response> {
  try {
    const url = new URL(request.url),
      path = url.pathname,
      prefix = "/api/v1/admin/resources",
      library = await loadLibrary(db),
      before = library.revision;
    reauthorize();
    if (request.method === "GET") {
      if (path === prefix)
        return json(page((library instanceof NativeResourceLibrary ? library.listMetadata() : library.list()).map(metadata), url, library.revision));
      if (path === prefix + "/export")
        return new Response(library.exportZip() as BodyInit, {
          headers: {
            "Content-Type": "application/zip",
            "Content-Disposition":
              'attachment; filename="perch-mcp-library.zip"',
            "Cache-Control": "no-store",
          },
        });
      if (path === prefix + "/assignments")
        return json(
          page(library instanceof NativeResourceLibrary ? library.assignments() : library.snapshot().assignments, url, library.revision),
        );
      const m = /^\/api\/v1\/admin\/resources\/([a-z0-9-]+)(\/history)?$/.exec(
        path,
      );
      if (m)
        return json(
          m[2]
            ? page((library instanceof NativeResourceLibrary ? library.historyMetadata(m[1]!) : library.history(m[1]!)).map(metadata), url, library.revision)
            : library.get(m[1]!),
        );
      throw new ApiError("NOT_FOUND", "Resource route not found.", 404);
    }
    const expectedMethod =
      /^\/api\/v1\/admin\/resources\/[^/]+$/.test(path) &&
      !path.endsWith("/assign") &&
      !path.endsWith("/import")
        ? "PUT"
        : "POST";
    if (request.method !== expectedMethod)
      throw new ApiError("INVALID_INPUT", expectedMethod + " required.", 405);
    const b = await parseBody(request, 12 * 1024 * 1024),
      key = id(request.headers.get("Idempotency-Key"), "Idempotency-Key"),
      hash = await digest(canonical({ path, method: request.method, body: b })),
      old = db.get<{ hash: string; result: unknown; expires: number }>(
        "idempotency/" + key,
      );
    if (old && old.expires > Date.now()) {
      if (old.hash !== hash)
        throw new ApiError(
          "IDEMPOTENCY_CONFLICT",
          "Key was used for another request.",
          409,
        );
      return json(old.result);
    }
    let result: unknown;
    if (path === prefix + "/import/preview" || path === prefix + "/import") {
      const base64 = str(b.archiveBase64, "archiveBase64", 12 * 1024 * 1024);
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4)
        throw new ApiError("INVALID_INPUT", "Invalid archive base64.");
      const bytes = Uint8Array.from(atob(base64), (x) => x.charCodeAt(0));
      const preview = await library.previewImport(bytes);
      if (path.endsWith("/preview"))
        return json({
          digest: preview.digest,
          entries: preview.entries,
          libraryRevision: preview.libraryRevision,
        });
      result = await library.commitImport(
        preview,
        b.decisions as ImportDecisions,
        Number(b.expectedRevision),
      );
    } else if (path === prefix + "/assign") {
      library.assign(
        b.scopeType as ScopeType,
        b.scopeType === "global" ? "global" : String(b.scopeId),
        String(b.resourceId),
        b.enabled === true,
        Number(b.expectedRevision),
      );
      result = {
        revision: library.revision,
        items: library instanceof NativeResourceLibrary ? library.assignments() : library.snapshot().assignments,
      };
    } else if (path === prefix) {
      result = await library.publish(b.resource as ResourceInput, "absent");
    } else {
      const m =
        /^\/api\/v1\/admin\/resources\/([a-z0-9-]+)(?:\/(restore|delete))?$/.exec(
          path,
        );
      if (!m) throw new ApiError("NOT_FOUND", "Resource route not found.", 404);
      if (m[2] === "restore")
        result = await library.restore(
          m[1]!,
          Number(b.historicalRevision),
          Number(b.expectedRevision),
        );
      else if (m[2] === "delete") {
        library.remove(m[1]!, Number(b.expectedRevision));
        result = { deleted: true, revision: library.revision };
      } else {
        const input = b.resource as ResourceInput;
        if (input?.id !== m[1])
          throw new ApiError(
            "INVALID_INPUT",
            "Resource path ID differs from body.",
          );
        result = await library.publish(input, Number(b.expectedRevision));
      }
    }
    db.transaction(() => {
      reauthorize();
      if (!(library instanceof NativeResourceLibrary) && resourceLibraryIsNative(db))
        throw new ApiError("RESOURCE_CONFLICT", "Resource storage changed during the request; retry against the current library.", 409);
      revision(before, resourceLibraryRevision(db));
      const repeat = db.get<{ hash: string; result: unknown; expires: number }>(
        "idempotency/" + key,
      );
      if (repeat && repeat.expires > Date.now()) {
        if (repeat.hash !== hash)
          throw new ApiError(
            "IDEMPOTENCY_CONFLICT",
            "Key was used for another request.",
            409,
          );
        throw new ApiError(
          "RESOURCE_CONFLICT",
          "Concurrent request already committed; retry same idempotency key.",
          409,
        );
      }
      if (library instanceof NativeResourceLibrary) library.commit(before);
      else db.put("library", library.snapshot());
      db.put("idempotency/" + key, {
        hash,
        result,
        expires: Date.now() + 86400000,
      });
    });
    return json(result);
  } catch (error) {
    if (error instanceof ResourceError)
      throw new ApiError(error.code, error.message, 409);
    throw error;
  }
}
export async function resourceTool(
  db: SqlRecords,
  name: string,
  args: Record<string, unknown>,
  context: ResourceContext,
): Promise<unknown> {
  const l = await loadLibrary(db);
  if (["skill", "get_workflow", "read_documentation"].includes(name)) {
    const r = l.get(
      String(args.id),
      context,
      args.revision === undefined ? undefined : Number(args.revision),
    );
    if (
      (name === "get_workflow" && r.kind !== "workflow") ||
      (name === "skill" && r.kind !== "skill")
    )
      throw new ApiError("NOT_FOUND", "Resource has a different kind.", 404);
    if (name !== "read_documentation")
      return { ...r, libraryRevision: l.revision };
    const path = args.path === undefined ? undefined : String(args.path);
    const body =
      path === undefined
        ? r.body
        : Object.hasOwn(r.files, path)
          ? r.files[path]
          : undefined;
    if (body === undefined)
      throw new ApiError(
        "NOT_FOUND",
        "Documentation or reference file not found in authorized Resource.",
        404,
      );
    const lines = body.split("\n"),
      offset = Number(args.offset ?? 1),
      limit = Number(args.limit ?? 2000),
      slice = lines.slice(offset - 1, offset - 1 + limit);
    return {
      id: r.id,
      path: path ?? null,
      revision: r.revision,
      hash: r.hash,
      libraryRevision: l.revision,
      lines: slice.map((text, i) => ({ line: offset + i, text })),
      text: slice.map((text, i) => `${offset + i}: ${text}`).join("\n"),
      nextOffset: offset - 1 + limit < lines.length ? offset + limit : null,
    };
  }
  const kind: ResourceKind | undefined =
    name === "list_skills"
      ? "skill"
      : name === "list_workflows"
        ? "workflow"
        : name === "get_instructions"
          ? "instruction"
          : undefined;
  const rows = l instanceof NativeResourceLibrary && name !== "get_instructions" && name !== "search_documentation"
    ? l.listMetadata(context, kind) : l.list(context, kind);
  if (name === "get_instructions") {
    if (new TextEncoder().encode(JSON.stringify(rows)).byteLength <= 200000)
      return { items: rows, libraryRevision: l.revision };
    return {
      items: rows.map(metadata),
      libraryRevision: l.revision,
      bodiesOmitted: true,
      recovery:
        "Read every Instruction body with read_documentation id, offset and limit; exact revision is included.",
    };
  }
  const offset = args.cursor === undefined ? 0 : Number(args.cursor),
    limit = Math.min(100, Number(args.limit ?? 100));
  if (!Number.isInteger(offset) || offset < 0)
    throw new ApiError("INVALID_INPUT", "Invalid resource cursor.");
  if (name === "search_documentation") {
    const query = String(args.query ?? "").toLowerCase();
    const matches: unknown[] = [];
    for (const r of rows) {
      const files = {
        ...(r.kind === "document" ? { "": r.body } : {}),
        ...r.files,
      };
      for (const [path, body] of Object.entries(files)) {
        for (const [index, line] of body.split("\n").entries())
          if (line.toLowerCase().includes(query))
            matches.push({
              id: r.id,
              path: path || null,
              revision: r.revision,
              line: index + 1,
              excerpt: line.slice(0, 1000),
            });
      }
    }
    return {
      items: matches.slice(offset, offset + limit),
      libraryRevision: l.revision,
      cursor: offset + limit < matches.length ? String(offset + limit) : null,
    };
  }
  const items = rows.slice(offset, offset + limit).map(metadata);
  return {
    items,
    libraryRevision: l.revision,
    cursor: offset + limit < rows.length ? String(offset + limit) : null,
  };
}
