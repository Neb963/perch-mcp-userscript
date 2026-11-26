import { build } from "esbuild";
import { readFile, writeFile, mkdir, cp, readdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import ts from "typescript";
execFileSync(process.execPath, ["packages/resources/generate-defaults.mjs"], {
  stdio: "inherit",
});
await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
const worker = await build({
  entryPoints: ["apps/userscript/src/compute-worker.ts"],
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  target: "firefox128",
  legalComments: "inline",
});
const workerSource = worker.outputFiles[0]!.text;
const userScriptVersion = JSON.parse(await readFile("package.json", "utf8")).version;
const metadata = `// ==UserScript==
// @name         Perch MCP (verification candidate)
// @namespace    https://github.com/Neb963/perch-mcp-userscript
// @version      ${userScriptVersion}
// @description  Isolated Perchance workspace MCP controller. External acceptance gates remain open.
// @match        https://perchance.org/*
// @exclude      https://perchance.org/ai-agent*
// @run-at       document-start
// @inject-into  content
// @noframes
// @grant        GM_info
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// ==/UserScript==
`;
await build({
  entryPoints: ["apps/userscript/src/main.ts"],
  bundle: true,
  outfile: "dist/perch-mcp.user.js",
  format: "iife",
  platform: "browser",
  target: "firefox128",
  legalComments: "inline",
  banner: { js: metadata },
  define: { __COMPUTE_WORKER_SOURCE__: JSON.stringify(workerSource) },
});
const userscript = await readFile("dist/perch-mcp.user.js");
await writeFile("dist/perch-mcp.user.txt", userscript);
await build({
  entryPoints: ["apps/gateway/src/index.ts"],
  bundle: true,
  outfile: "dist/cloudflare/worker.mjs",
  format: "esm",
  platform: "neutral",
  target: "es2022",
  external: ["node:*", "cloudflare:*"],
  conditions: ["workerd", "worker", "browser"],
  mainFields: ["browser", "module", "main"],
  legalComments: "inline",
});
const parsedConfig = ts.parseConfigFileTextToJson(
  "wrangler.jsonc",
  await readFile("apps/gateway/wrangler.jsonc", "utf8"),
);
if (parsedConfig.error) throw new Error("Invalid gateway configuration.");
const sourceConfig = parsedConfig.config;
sourceConfig.main = "worker.mjs";
sourceConfig.$schema = undefined;
await writeFile(
  "dist/cloudflare/wrangler.json",
  JSON.stringify(sourceConfig, null, 2) + "\n",
);
await writeFile(
  "dist/cloudflare/package.json",
  JSON.stringify(
    {
      name: "perch-mcp-gateway-candidate",
      private: true,
      type: "module",
      scripts: { deploy: "wrangler deploy", dev: "wrangler dev" },
      devDependencies: {
        wrangler: JSON.parse(await readFile("package.json", "utf8"))
          .devDependencies.wrangler,
      },
    },
    null,
    2,
  ) + "\n",
);
await cp("docs", "dist/docs", { recursive: true });
await cp("README.md", "dist/README.md");
await cp("CLIENT_SPEC.md", "dist/CLIENT_SPEC.md");
await cp("apps/gateway/.dev.vars.example", "dist/cloudflare/.dev.vars.example");
await writeFile(
  "dist/STATUS.txt",
  "VERIFICATION CANDIDATE — NOT A FULL-PARITY RELEASE. Read docs/RELEASE_VERIFICATION.md before installation. Production provider mutations and unverified preview capabilities remain gated.\n",
);
const packageInfo = JSON.parse(await readFile("package.json", "utf8"));
const sourceTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
  encoding: "utf8",
}).trim();
await writeFile(
  "dist/RELEASE.json",
  JSON.stringify(
    {
      classification: "verification-candidate",
      version: packageInfo.version,
      sourceTree,
      sourceDirty:
        execFileSync("git", ["status", "--porcelain"], {
          encoding: "utf8",
        }).trim().length > 0,
      protocolVersions: ["2026-07-28", "2025-11-25", "2025-06-18"],
      dependencies: packageInfo.dependencies,
    },
    null,
    2,
  ) + "\n",
);
const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
const inventory: string[] = [
  "# Third-party dependency inventory",
  "",
  "Includes runtime and build/test dependencies; upstream license texts are retained below. Source dependency versions are pinned by package-lock.json.",
  "",
];
for (const [path, info] of Object.entries(lock.packages) as [
  string,
  { version?: string; license?: string; name?: string },
][]) {
  if (!path.startsWith("node_modules/") || !info.version) continue;
  const name = info.name ?? path.split("node_modules/").at(-1)!;
  inventory.push(
    `- ${name}@${info.version}: ${info.license ?? "see upstream package"}`,
  );
  let names: string[];
  try {
    names = await readdir(path);
  } catch {
    continue;
  }
  for (const file of names.filter((n) =>
    /^(?:licen[cs]e|copying|notice)(?:\.|$)/i.test(n),
  )) {
    try {
      const content = await readFile(path + "/" + file);
      const folder =
        "dist/licenses/" +
        name.replace(/[^A-Za-z0-9._-]/g, "_") +
        "-" +
        info.version;
      await mkdir(folder, { recursive: true });
      await writeFile(folder + "/" + file, content);
    } catch {
      /* Directories are not license text. */
    }
  }
}
await writeFile("dist/THIRD_PARTY_NOTICES.md", inventory.join("\n") + "\n");
await cp("dist/licenses", "dist/cloudflare/licenses", { recursive: true });
await cp(
  "dist/THIRD_PARTY_NOTICES.md",
  "dist/cloudflare/THIRD_PARTY_NOTICES.md",
);
await cp("docs/INSTALLATION.md", "dist/cloudflare/README.md");
const zipOptions = {
  level: 9 as const,
  mtime: new Date("2000-01-01T00:00:00Z"),
};
const hashes: Record<string, string> = {};
async function collect(
  path: string,
  prefix = "",
): Promise<Record<string, Uint8Array>> {
  const entries: Record<string, Uint8Array> = {};
  for (const item of (await readdir(path, { withFileTypes: true })).sort(
    (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  )) {
    const rel = prefix + item.name;
    if (item.isDirectory())
      Object.assign(entries, await collect(`${path}/${item.name}`, rel + "/"));
    else {
      const bytes = await readFile(`${path}/${item.name}`);
      entries[rel] = bytes;
      hashes[rel] = createHash("sha256").update(bytes).digest("hex");
    }
  }
  return entries;
}
const cloud = await collect("dist/cloudflare");
await writeFile("dist/perch-mcp-cloudflare.zip", zipSync(cloud, zipOptions));
for (const key of Object.keys(hashes)) delete hashes[key];
const archive = await collect("dist");
delete archive["perch-mcp-candidate.zip"];
archive["SHA256SUMS.txt"] = new TextEncoder().encode(
  Object.entries(hashes)
    .map(([name, hash]) => `${hash}  ${name}`)
    .join("\n") + "\n",
);
await writeFile("dist/perch-mcp-candidate.zip", zipSync(archive, zipOptions));
await writeFile("dist/SHA256SUMS.txt", archive["SHA256SUMS.txt"]!);
console.log(
  JSON.stringify({
    userscriptBytes: userscript.length,
    workerSourceBytes: new TextEncoder().encode(workerSource).length,
    artifacts: [
      "perch-mcp.user.js",
      "perch-mcp.user.txt",
      "perch-mcp-cloudflare.zip",
      "perch-mcp-candidate.zip",
    ],
  }),
);
