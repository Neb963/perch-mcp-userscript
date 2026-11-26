import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { RuntimeTools, readImage } from "../../apps/userscript/src/runtime-tools.js";
import { MemoryStore } from "../../apps/userscript/src/storage.js";
import { digest } from "../../apps/userscript/src/native-types.js";
import type { RuntimeContext } from "../../apps/userscript/src/controller.js";
import type { ComputeOptions } from "../../apps/userscript/src/compute.js";
function fixture() {
  const doc = new JSDOM("<body>").window.document;
  const tools = new RuntimeTools({}, new MemoryStore(), doc, "unused");
  const requests: { name: string; args: Record<string, unknown> }[] = [];
  const bytes = new TextEncoder().encode("export const value=42;");
  let executed = 0,
    captured: ComputeOptions | undefined;
  Object.assign(tools, {
    compute: {
      execute: async (options: ComputeOptions) => {
        executed++;
        captured = options;
        await options.files.revision();
        return { result: 42 };
      },
    },
  });
  const context = {
    envelope: {
      operationId: "fixture",
      workspaceId: "workspace",
      bindingRevision: 1,
      deadlineMs: Date.now() + 30000,
      permissions: ["COMPUTE", "READ_SOURCE"],
    },
    signal: new AbortController().signal,
    vfs: {
      snapshot: async () => ({ revision: "1:hash", files: {} }),
      read: async () => bytes,
      list: async () => [],
    },
    authorize: async (name: string, args: Record<string, unknown>) => {
      requests.push({ name, args });
    },
    call: async () => {
      throw new Error("No child tools invoked.");
    },
  } as unknown as RuntimeContext;
  return {
    tools,
    context,
    requests,
    bytes,
    executed: () => executed,
    captured: () => captured,
  };
}
test("pinned compute modules are independently read-authorized and hashed before guest starts", async () => {
  const f = fixture();
  const sha256 = await digest(f.bytes);
  await f.tools.call(
    "execute_js",
    {
      js: "return 42",
      modules: [{ specifier: "math@1.2.3", path: "scratch/math.js", sha256 }],
    },
    f.context,
  );
  assert.equal(f.executed(), 1);
  assert.equal(f.captured()!.modules!["math@1.2.3"], "export const value=42;");
  assert.deepEqual(
    f.requests.map((r) => r.name),
    ["read_b64_file"],
  );
});
test("changed module bytes reject before sandbox execution", async () => {
  const f = fixture();
  await assert.rejects(
    f.tools.call(
      "execute_js",
      {
        js: "return 42",
        modules: [
          {
            specifier: "math@1.2.3",
            path: "scratch/math.js",
            sha256: "0".repeat(64),
          },
        ],
      },
      f.context,
    ),
    (e) => (e as { code: string }).code === "STALE_REVISION",
  );
  assert.equal(f.executed(), 0);
});
test("pure compute does not require a source read merely to retain private revision fencing", async () => {
  const f = fixture();
  f.context.envelope.permissions = ["COMPUTE"];
  await f.tools.call("execute_js", { js: "return 42" }, f.context);
  assert.equal(f.executed(), 1);
  assert.deepEqual(f.requests, []);
});
test("unverified public media adapter rejects before inference or public upload", async () => {
  const f = fixture();
  for (const [tool, args] of [
    ["generate_image", { prompt: "original fixture" }],
    ["upload_file", { text: "original fixture" }],
  ] as const)
    await assert.rejects(
      f.tools.call(tool, args, f.context),
      (e) => (e as { code: string }).code === "UNSUPPORTED_INTERFACE",
    );
  assert.deepEqual(f.requests, []);
});

test("paid audio transfer revocation cannot be mislabeled as a no-effect rejection", async () => {
  const f = fixture();
  Object.assign(f.context.envelope, { permissions: ["MEDIA", "WRITE_SOURCE"] });
  Object.assign(f.context.vfs, { maxBytes: 64 * 1024 * 1024 });
  f.context.media = async (route) => {
    if (route === "start")
      return {
        status: "READY",
        operationId: "fixture",
        bytes: 1,
        sha256: await digest(new Uint8Array([1])),
        chunkBytes: 196608,
      };
    throw Object.assign(new Error("Revoked after generation"), {
      code: "REVOKED",
    });
  };
  await assert.rejects(
    f.tools.call(
      "generate_music",
      {
        style: "original fixture",
        isInstrumental: true,
        outputPath: "scratch/music.mp3",
      },
      f.context,
    ),
    (e) => (e as { effectState: string }).effectState === "PARTIAL",
  );
});
test("completed public POST followed by local source conflict preserves partial effect", async () => {
  const f = fixture();
  f.context.envelope.permissions = [
    "FETCH_PUBLIC",
    "FETCH_POST",
    "WRITE_SOURCE",
  ];
  let calls = 0;
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-type": "application/octet-stream" },
    });
  }) as typeof fetch;
  Object.assign(f.context.vfs, {
    snapshot: async () => {
      throw Object.assign(new Error("Manual source edit"), {
        code: "STALE_REVISION",
      });
    },
  });
  try {
    await assert.rejects(
      f.tools.call(
        "fetch_url",
        {
          url: "https://perchance.org/synthetic-endpoint",
          method: "POST",
          body: "fixture",
          path: "scratch/result.bin",
        },
        f.context,
      ),
      (e) => (e as { effectState: string }).effectState === "PARTIAL",
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = previous;
  }
});


test("image normalization reduces noisy images within the transfer budget and closes the decoder", async () => {
  const oldBitmap = globalThis.createImageBitmap, oldCanvas = globalThis.OffscreenCanvas;
  const sizes: number[] = []; let closed = false;
  const bytes = new Uint8Array(24); bytes.set([137,80,78,71,13,10,26,10]);
  const view = new DataView(bytes.buffer); view.setUint32(16,1024); view.setUint32(20,1024);
  globalThis.createImageBitmap = (async () => ({width:1024,height:1024,close:()=>{closed=true}})) as typeof createImageBitmap;
  globalThis.OffscreenCanvas = class {
    constructor(public width:number, public height:number) { sizes.push(width); }
    getContext() { return { drawImage() {} }; }
    async convertToBlob(options:{type:string}) { assert.equal(options.type,"image/png"); return new Blob([new Uint8Array(this.width*this.height*4)]); }
  } as unknown as typeof OffscreenCanvas;
  try {
    const result = await readImage(bytes,"scratch/noise.png") as {width:number;height:number;originalWidth:number;content:{data:string}[]};
    assert.deepEqual(sizes,[1024,512]); assert.equal(result.width,512); assert.equal(result.height,512);
    assert.equal(result.originalWidth,1024); assert.equal(Buffer.from(result.content[0]!.data,"base64").length,1024*1024);
    assert.equal(closed,true);
  } finally { globalThis.createImageBitmap=oldBitmap; globalThis.OffscreenCanvas=oldCanvas; }
});
