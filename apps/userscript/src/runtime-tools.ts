import { executeDevelopment, type DevelopmentContext } from './development-v2.js';
import { createComputeWorkerClient, ExecutionError } from "./compute.js";
import { PreviewAdapter, createNativePreviewBridge } from "./preview.js";
import { fetchPublic } from "./public-fetch.js";
import { readPublicGenerator } from "./public-generator.js";
import {
  base64ToBytes,
  BrowserError,
  bytesToBase64,
  canonicalPath,
  decodeText,
  digest,
  type KeyValueStore,
} from "./native-types.js";
import { PublicMedia } from "./public-media.js";
import { ArtifactStore } from "./artifacts.js";
import type { AdditionalTools, RuntimeContext } from "./controller.js";
declare const __COMPUTE_WORKER_SOURCE__: string;
/** Context stays in the controller closure. Agent code receives only bounded serialized broker values. */
export class RuntimeTools implements AdditionalTools {
  private previews = new Map<string, PreviewAdapter>();
  private compute: ReturnType<typeof createComputeWorkerClient>;
  private readonly previewOutcomes: { at: number; tool: string; durationMs: number; code: string; outcome: 'ok' | 'error' }[] = [];
  diagnostics() {
    return { previewEvents: this.previewOutcomes.map((event) => ({ ...event })) };
  }
  private recordPreview(event: { at: number; tool: string; durationMs: number; code: string; outcome: 'ok' | 'error' }) {
    this.previewOutcomes.push(event);
    if (this.previewOutcomes.length > 50) this.previewOutcomes.splice(0, this.previewOutcomes.length - 50);
  }
  constructor(
    private page: unknown,
    private store: KeyValueStore,
    private doc: Document = document,
    workerSource = __COMPUTE_WORKER_SOURCE__,
  ) {
    this.compute = createComputeWorkerClient(workerSource);
  }
  callDevelopment(context: DevelopmentContext): Promise<unknown> {
    return executeDevelopment(context,this.compute);
  }
  capabilityReport(context: RuntimeContext): Record<string, unknown> {
    return this.preview(context).availability();
  }
  async preflightPreview(context: RuntimeContext): Promise<void> {
    if (!context.envelope.permissions.includes('PREVIEW_CONTROL') &&
        !context.envelope.permissions.includes('PREVIEW_EXECUTE')) return;
    await this.preview(context).preflight();
  }
  supports(name: string): boolean {
    return [
      "generate_image",
      "upload_file",
      "generate_music",
      "execute_js",
      "fetch_url",
      "fetch_generator",
      "read_image",
      "page_eval",
      "page_refresh",
      "set_viewport_size",
      "capture_page_image",
      "preview_diagnostics",
    ].includes(name);
  }
  private preview(context: RuntimeContext): PreviewAdapter {
    const id = context.envelope.workspaceId;
    let preview = this.previews.get(id);
    if (!preview) {
      preview = new PreviewAdapter({
        frame: () =>
          this.doc.querySelector<HTMLIFrameElement>("#outputIframeEl"),
        revision: async () => (await context.vfs.snapshot()).revision,
        bridge: createNativePreviewBridge(this.page, {
          host: this.doc.defaultView!,
          frame: () =>
            this.doc.querySelector<HTMLIFrameElement>("#outputIframeEl"),
          revision: async () => (await context.vfs.snapshot()).revision,
        }),
        verified: {},
        readText: async (p) => decodeText(await context.vfs.read(p)),
        writeFile: async (p, bytes, revision) =>
          context.vfs.writeBatch([{ path: p, bytes }], revision),
      });
      this.previews.set(id, preview);
    }
    return preview;
  }
  dispose(): void {
    for (const preview of this.previews.values()) preview.restoreViewport();
    this.previews.clear();
  }
  async call(
    name: string,
    args: Record<string, unknown>,
    context: RuntimeContext,
  ): Promise<unknown> {
    if (name === "generate_image" || name === "upload_file") {
      const candidate = new PublicMedia({
        verifiedPreview: false,
        evaluate: async (js, timeoutMs) =>
          (
            (await this.preview(context).call("page_eval", {
              js,
              timeoutMs,
            })) as { result: unknown }
          ).result,
        revision: async () => (await context.vfs.snapshot()).revision,
        readFile: (path) => context.vfs.read(path),
        writeFile: (path, bytes, revision) =>
          context.vfs.writeBatch([{ path, bytes }], revision),
        retainArtifact: (bytes, fileName, _mime) =>
          new ArtifactStore(this.store).create(
            context.envelope.workspaceId,
            context.envelope.bindingRevision,
            fileName,
            bytes,
          ),
        retainUploadSecret: (operationId, value) =>
          this.store.set(
            `perch:upload-capability:${context.envelope.workspaceId}:${operationId}`,
            { ...value, bindingRevision: context.envelope.bindingRevision },
          ),
        decodeImage: decodeImageBytes,
        beforeEffect: async () => {
          context.adapter.assertMutationReady();
          await context.adapter.assertIdentity();
          await context.authorize(name, args);
        },
      });
      const operation = {
        operationId: context.envelope.operationId,
        deadlineMs: context.envelope.deadlineMs,
        signal: context.signal,
      };
      if (name === "upload_file") return candidate.uploadFile(args, operation);
      const generated = await candidate.generateImage(args, operation);
      try {
        if (!generated || typeof generated !== "object" || !("path" in generated) || typeof generated.path !== "string")
          throw new Error("Generated output path is missing.");
        const path = canonicalPath(generated.path);
        return { ...generated, ...await readImage(await context.vfs.read(path), path) as Record<string, unknown> };
      } catch {
        throw new ExecutionError(
          "PARTIAL_EFFECT",
          "Generated image was committed, but display normalization failed. Inspect the output file; do not regenerate.",
          "PARTIAL",
        );
      }
    }
    if (name === "generate_music") {
      let providerReady = false;
      try {
        const path = canonicalPath(String(args.outputPath));
        if (!path.startsWith("src/") && !path.startsWith("scratch/"))
          throw new ExecutionError(
            "PATH_DENIED",
            "Music output requires src/ or scratch/.",
          );
        const before = await context.vfs.snapshot();
        if (
          Object.values(before.files).reduce((n, b) => n + b.length, 0) +
            8 * 1024 * 1024 >
          context.vfs.maxBytes
        )
          throw new ExecutionError(
            "QUOTA_EXCEEDED",
            "Reserve 8 MiB local capacity before paid generation.",
          );
        const artifacts = new ArtifactStore(this.store);
        const local = await artifacts.list();
        if (
          local.reduce((n, a) => n + a.bytes, 0) + 8 * 1024 * 1024 >
          8 * 1024 * 1024
        )
          throw new ExecutionError(
            "QUOTA_EXCEEDED",
            "Download or expire retained local attachments before paid generation.",
          );
        const manifest = (await context.media("start")) as {
          status: string;
          operationId: string;
          bytes: number;
          sha256: string;
          chunkBytes: number;
          metadata?: Record<string, unknown>;
        };
        providerReady = manifest.status === "READY";
        if (manifest.status !== "READY")
          throw new ExecutionError(
            "EFFECT_UNKNOWN",
            "Music has no verified ready artifact. Reconcile this Operation ID instead of generating again.",
            "UNKNOWN",
          );
        if (
          manifest.operationId !== context.envelope.operationId ||
          !Number.isInteger(manifest.bytes) ||
          manifest.bytes < 1 ||
          manifest.bytes > 8 * 1024 * 1024 ||
          manifest.chunkBytes !== 196608 ||
          !/^[a-f0-9]{64}$/.test(manifest.sha256)
        )
          throw new ExecutionError(
            "EFFECT_UNKNOWN",
            "Music manifest is invalid after provider dispatch.",
            "UNKNOWN",
          );
        const bytes = new Uint8Array(manifest.bytes);
        let offset = 0;
        while (offset < bytes.length) {
          const part = (await context.media("chunk", offset)) as {
            operationId: string;
            offset: number;
            totalBytes: number;
            sha256: string;
            base64: string;
            nextOffset: number | null;
            done: boolean;
          };
          if (
            part.operationId !== manifest.operationId ||
            part.offset !== offset ||
            part.totalBytes !== bytes.length ||
            part.sha256 !== manifest.sha256
          )
            throw new ExecutionError(
              "EFFECT_UNKNOWN",
              "Music chunk scope or digest mismatch.",
              "UNKNOWN",
            );
          const chunk = base64ToBytes(part.base64);
          if (
            !chunk.length ||
            chunk.length > manifest.chunkBytes ||
            offset + chunk.length > bytes.length
          )
            throw new ExecutionError(
              "EFFECT_UNKNOWN",
              "Invalid music chunk.",
              "UNKNOWN",
            );
          bytes.set(chunk, offset);
          offset += chunk.length;
          if (
            (offset === bytes.length) !== part.done ||
            part.nextOffset !== (part.done ? null : offset)
          )
            throw new ExecutionError(
              "EFFECT_UNKNOWN",
              "Music chunk sequence is inconsistent.",
              "UNKNOWN",
            );
        }
        if ((await digest(bytes)) !== manifest.sha256)
          throw new ExecutionError(
            "EFFECT_UNKNOWN",
            "Music artifact SHA256 mismatch.",
            "UNKNOWN",
          );
        // Preserve paid output independently of the draft before decoding or a revision-sensitive source commit.
        const artifact = await artifacts.create(
          context.envelope.workspaceId,
          context.envelope.bindingRevision,
          path.split("/").pop() ?? "music.mp3",
          bytes,
        );
        let decodedSeconds: number | undefined;
        try {
          if (typeof OfflineAudioContext !== "function")
            throw new Error("Audio decoder unavailable.");
          const audio = await new OfflineAudioContext(
            1,
            1,
            44100,
          ).decodeAudioData(bytes.slice().buffer as ArrayBuffer);
          decodedSeconds = audio.duration;
          if (
            !Number.isFinite(decodedSeconds) ||
            decodedSeconds < 1 ||
            decodedSeconds > 610
          )
            throw new Error("Audio duration invalid.");
        } catch {
          throw new ExecutionError(
            "PARTIAL_EFFECT",
            `Paid audio retained as local artifact ${artifact.id}; browser playback decode is unverified.`,
            "PARTIAL",
          );
        }
        try {
          await context.authorize("save_b64_file", {
            path,
            data: "",
            expectedRevision: before.revision,
          });
          const written = await context.vfs.writeBatch(
            [{ path, bytes }],
            before.revision,
          );
          if (written.status !== "SUCCEEDED")
            throw new Error("Source commit uncertain.");
        } catch {
          throw new ExecutionError(
            "PARTIAL_EFFECT",
            `Paid audio retained as local artifact ${artifact.id}; draft changed or permission was revoked before file commit.`,
            "PARTIAL",
          );
        }
        let consumed = false;
        try {
          await context.media("chunk", manifest.bytes, manifest.sha256);
          consumed = true;
        } catch {
          /* Output remains recoverable locally; upstream retention expires independently. */
        }
        return {
          path,
          bytes: bytes.length,
          sha256: manifest.sha256,
          artifactId: artifact.id,
          actualSeconds: decodedSeconds,
          provider: manifest.metadata,
          validation: {
            browserDecode: true,
            listening: "UNVERIFIED",
            lyrics: "UNVERIFIED",
          },
          gatewayArtifactConsumed: consumed,
          revision: (await context.vfs.snapshot()).revision,
        };
      } catch (error) {
        if (
          providerReady &&
          !(
            error instanceof ExecutionError &&
            (error.effectState === "PARTIAL" || error.effectState === "UNKNOWN")
          )
        )
          throw new ExecutionError(
            "PARTIAL_EFFECT",
            "Provider audio was generated; transfer, storage or permission failed afterward. Inspect retained artifacts and usage; do not regenerate.",
            "PARTIAL",
          );
        throw error;
      }
    }
    if (name === "execute_js") {
      const modules: Record<string, string> = {};
      let moduleBytes = 0;
      for (const entry of (args.modules ?? []) as {
        specifier: string;
        path: string;
        sha256: string;
      }[]) {
        await context.authorize("read_b64_file", {
          path: entry.path,
          offset: 0,
          limit: 262144,
        });
        const source = await context.vfs.read(entry.path);
        moduleBytes += source.length;
        if (source.length > 262144 || moduleBytes > 524288)
          throw new ExecutionError(
            "LIMIT_EXCEEDED",
            "Pinned module prefetch exceeds256KiB per module or512KiB total.",
          );
        if ((await digest(source)) !== entry.sha256)
          throw new ExecutionError(
            "STALE_REVISION",
            "Pinned module SHA256 differs from requested source.",
          );
        try {
          modules[entry.specifier] = new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: true,
          }).decode(source);
        } catch {
          throw new ExecutionError(
            "INVALID_INPUT",
            "Pinned module is not UTF8 JavaScript.",
          );
        }
      }

      const readPermit = (path: string) =>
        context.authorize("read_b64_file", { path, offset: 0, limit: 262144 });
      return this.compute.execute({
        modules,
        js: String(args.js),
        timeoutMs: Math.min(
          Number(args.timeoutMs ?? 120000),
          Math.max(1, context.envelope.deadlineMs - Date.now()),
        ),
        signal: context.signal,
        files: {
          revision: async () => {
            return (await context.vfs.snapshot()).revision;
          },
          read: async (path) => {
            await readPermit(path);
            return context.vfs.read(path);
          },
          list: async () => {
            await context.authorize("list_files", {});
            return context.vfs.list();
          },
          writeBatch: async (writes, expectedRevision) => {
            // Broker batches must be authorized against the parent Grant AND current Registry policy.
            const additions = writes
              .filter((w) => w.bytes !== null)
              .map((w) => ({
                path: w.path,
                encoding: "base64",
                content: bytesToBase64(w.bytes!),
              }));
            if (additions.length)
              await context.authorize("put_files", {
                files: additions,
                expectedRevision,
              });
            for (const item of writes.filter((w) => w.bytes === null))
              await context.authorize("delete_file", {
                path: item.path,
                expectedRevision,
              });
            const result = await context.vfs.writeBatch(
              writes,
              expectedRevision,
            );
            if (result.status !== "SUCCEEDED")
              throw new ExecutionError(
                result.status === "PARTIAL"
                  ? "PARTIAL_EFFECT"
                  : "EFFECT_UNKNOWN",
                "Compute write set did not commit completely.",
                result.status === "PARTIAL" ? "PARTIAL" : "UNKNOWN",
              );
            return { revision: result.revision };
          },
        },
        tools: { call: (tool, toolArgs) => context.call(tool, toolArgs) },
      });
    }
    if (name === "fetch_url") {
      const approvedHosts = (await this.store.get<string[]>(
        "perch:fetch-approved-hosts",
      )) ?? ["perchance.org", "user.uploads.dev"];
      const response = await fetchPublic(String(args.url), {
        approvedHosts,
        method: args.method === "POST" ? "POST" : "GET",
        body: typeof args.body === "string" ? args.body : undefined,
        allowPost: context.envelope.permissions.includes("FETCH_POST"),
        timeoutMs: Math.min(
          Number(args.timeoutMs ?? 120000),
          Math.max(1, context.envelope.deadlineMs - Date.now()),
        ),
        signal: context.signal,
      });
      try {
        const before = await context.vfs.snapshot();
        const result = await context.vfs.writeBatch(
          [{ path: String(args.path), bytes: response.bytes }],
          before.revision,
        );
        if (result.status !== "SUCCEEDED") return result;
        return {
          status: response.status,
          contentType: response.contentType,
          bytes: response.bytes.length,
          savedTo: args.path,
          textPreview: response.textPreview,
          revision: result.revision,
        };
      } catch (error) {
        if (args.method === "POST")
          throw new ExecutionError(
            "PARTIAL_EFFECT",
            "Public POST completed but local file persistence failed. Reconcile remote state; do not repeat the POST.",
            "PARTIAL",
          );
        throw error;
      }
    }
    if (name === "fetch_generator") {
      const slug = args.generatorName;
      if (typeof slug !== 'string' ||
          !/^[a-z0-9][a-z0-9-]{0,119}$/.test(slug))
        throw new ExecutionError('INVALID_INPUT',
          'fetch_generator/argument: generatorName must be a canonical public Slug.');
      const expected = (await context.vfs.snapshot()).revision;
      let snapshot: Awaited<ReturnType<typeof readPublicGenerator>>;
      try {
        snapshot = await readPublicGenerator(slug, fetch, context.signal);
      } catch (error) {
        if (error instanceof ExecutionError) {
          throw new ExecutionError(error.code,
            `fetch_generator/public-api: ${error.message.slice(0,300)}`,
            error.effectState, error.effects);
        }
        // Any exception here is upstream metadata/manifest handling, not a
        // malformed slug. Classify without exposing provider response bodies.
        const stage = error && typeof error==='object' &&
          'code' in error && error.code === 'PATH_DENIED'
          ? 'source-manifest path rejected' : 'unrecognized provider response';
        throw new ExecutionError('UNSUPPORTED_INTERFACE',
          `fetch_generator/public-api: ${stage}; no source installed.`);
      }
      let imported: Awaited<ReturnType<typeof context.vfs.importSnapshot>>;
      try {
        imported = await context.vfs.importSnapshot(
          snapshot.slug,snapshot.files,expected);
      } catch (error) {
        const e = error as {code?:unknown; effectState?:unknown};
        const code = typeof e?.code === 'string' && /^[A-Z][A-Z0-9_]{0,47}$/.test(e.code)
          ? e.code : 'EFFECT_UNKNOWN';
        throw new ExecutionError(code,
          `fetch_generator/scratch-commit: ${code}; ${error instanceof BrowserError ? error.message.slice(0, 240) : 'Local publication failed.'} Provider source was read but cache commit is not verified.`,
          code==='EFFECT_UNKNOWN'||e?.effectState==='UNKNOWN'?'UNKNOWN':'NONE');
      }
      return {
        ...imported,
        generatorId: snapshot.generatorId,
        providerRevision: snapshot.revision,
        bytes: snapshot.bytes,
        count: snapshot.count,
        revisionChanged: false,
        completeness: snapshot.completeness,
        missingManifest: snapshot.missingManifest,
        source: 'public-api:getGeneratorPageData',
        skipped: snapshot.missingManifest
          ? [{ kind: 'src-manifest', reason: 'Public API did not supply a complete src manifest; imported panels only. Not a complete backup.' }]
          : [],
      };
    }
    if (name === "read_image")
      return readImage(
        await context.vfs.read(String(args.file_path)),
        String(args.file_path),
      );
    // Diagnostics must still work when the editor is read-only or native
    // mutation guards are busy. Every preview operation verifies the current
    // Generator/Draft Binding before touching its frame.
    await context.adapter.assertIdentity();
    if (name !== 'preview_diagnostics') context.adapter.assertMutationReady();
    const started = Date.now();
    try {
      const result = await this.preview(context).call(name, args);
      this.recordPreview({ at: started, tool: name, durationMs: Date.now() - started, code: 'OK', outcome: 'ok' });
      return result;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        && /^[A-Z][A-Z0-9_]{0,47}$/.test(error.code) ? error.code : 'PREVIEW_FAILED';
      this.recordPreview({ at: started, tool: name, durationMs: Date.now() - started, code, outcome: 'error' });
      throw error;
    }
  }
}
function dimensions(bytes: Uint8Array): {
  width: number;
  height: number;
  mime: string;
} {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length >= 24 &&
    bytes[0] === 137 &&
    String.fromCharCode(...bytes.subarray(1, 4)) === "PNG"
  )
    return {
      width: v.getUint32(16),
      height: v.getUint32(20),
      mime: "image/png",
    };
  if (
    bytes.length >= 10 &&
    String.fromCharCode(...bytes.subarray(0, 3)) === "GIF"
  )
    return {
      width: v.getUint16(6, true),
      height: v.getUint16(8, true),
      mime: "image/gif",
    };
  if (
    bytes.length >= 30 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  ) {
    const kind = String.fromCharCode(...bytes.subarray(12, 16));
    if (kind === "VP8X")
      return {
        width: 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)),
        height: 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)),
        mime: "image/webp",
      };
    if (kind === "VP8 ")
      return {
        width: v.getUint16(26, true) & 16383,
        height: v.getUint16(28, true) & 16383,
        mime: "image/webp",
      };
    if (kind === "VP8L" && bytes.length >= 25) {
      const bits = v.getUint32(21, true);
      return {
        width: 1 + (bits & 16383),
        height: 1 + ((bits >>> 14) & 16383),
        mime: "image/webp",
      };
    }
  }
  if (bytes.length > 4 && bytes[0] === 255 && bytes[1] === 216) {
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at++] !== 255) break;
      const marker = bytes[at++]!;
      if (marker === 217 || marker === 218) break;
      const length = v.getUint16(at);
      if (length < 2 || at + length > bytes.length) break;
      if (
        [
          192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
        ].includes(marker)
      )
        return {
          width: v.getUint16(at + 5),
          height: v.getUint16(at + 3),
          mime: "image/jpeg",
        };
      at += length;
    }
  }
  throw new ExecutionError(
    "INVALID_INPUT",
    "File is not a supported PNG, JPEG, WebP or GIF image.",
  );
}
export async function readImage(
  bytes: Uint8Array,
  path: string,
): Promise<unknown> {
  if (bytes.length > 8 * 1024 * 1024)
    throw new ExecutionError("LIMIT_EXCEEDED", "Image input exceeds 8 MiB.");
  const header = dimensions(bytes);
  if (
    !header.width ||
    !header.height ||
    header.width * header.height > 16 * 1024 * 1024
  )
    throw new ExecutionError(
      "LIMIT_EXCEEDED",
      "Image exceeds the 16 megapixel decode limit.",
    );
  if (
    typeof createImageBitmap !== "function" ||
    typeof OffscreenCanvas !== "function"
  )
    throw new ExecutionError(
      "UNSUPPORTED_INTERFACE",
      "This browser cannot normalize image bytes in the isolated controller.",
    );
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(
      new Blob([bytes.slice().buffer as ArrayBuffer], { type: header.mime }),
    );
  } catch {
    throw new ExecutionError(
      "INVALID_INPUT",
      "Image decoder rejected the file.",
    );
  }
  try {
    if (bitmap.width !== header.width || bitmap.height !== header.height)
      throw new ExecutionError(
        "INVALID_INPUT",
        "Image dimensions do not match the validated header.",
      );
    const scale = Math.min(1, 1024 / bitmap.width, 1024 / bitmap.height);
    let width = Math.max(1, Math.round(bitmap.width * scale));
    let height = Math.max(1, Math.round(bitmap.height * scale));
    // A bounded reduction preserves actual decoded pixels and PNG alpha while
    // fitting noisy images into the authenticated transfer budget.
    for (let attempt = 0; attempt < 5; attempt++) {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d");
      if (!ctx)
        throw new ExecutionError("UNSUPPORTED_INTERFACE", "Image canvas is unavailable.");
      ctx.drawImage(bitmap, 0, 0, width, height);
      const normalized = new Uint8Array(
        await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer(),
      );
      if (normalized.length <= 1024 * 1024)
        return {
          path, width, height, originalWidth: bitmap.width, originalHeight: bitmap.height,
          mimeType: "image/png",
          content: [{ type: "image", mimeType: "image/png", data: bytesToBase64(normalized) }],
        };
      width = Math.max(1, Math.floor(width / 2));
      height = Math.max(1, Math.floor(height / 2));
    }
    throw new ExecutionError("LIMIT_EXCEEDED", "Normalized image exceeds the 1 MiB result limit.");
  } finally {
    bitmap.close();
  }
}

export async function decodeImageBytes(
  bytes: Uint8Array,
): Promise<{ width: number; height: number; mimeType: string }> {
  if (bytes.length > 8 * 1024 * 1024)
    throw new ExecutionError("LIMIT_EXCEEDED", "Image exceeds 8 MiB.");
  const header = dimensions(bytes);
  if (
    !header.width ||
    !header.height ||
    header.width * header.height > 16 * 1024 * 1024
  )
    throw new ExecutionError("LIMIT_EXCEEDED", "Image exceeds 16 megapixels.");
  if (typeof createImageBitmap !== "function")
    throw new ExecutionError(
      "UNSUPPORTED_INTERFACE",
      "Image decoder unavailable.",
    );
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(
      new Blob([bytes.slice().buffer as ArrayBuffer], { type: header.mime }),
    );
  } catch {
    throw new ExecutionError(
      "INVALID_INPUT",
      "Image decoder rejected generated bytes.",
    );
  }
  try {
    if (bitmap.width !== header.width || bitmap.height !== header.height)
      throw new ExecutionError(
        "INVALID_INPUT",
        "Decoded image header mismatch.",
      );
    return {
      width: bitmap.width,
      height: bitmap.height,
      mimeType: header.mime,
    };
  } finally {
    bitmap.close();
  }
}
