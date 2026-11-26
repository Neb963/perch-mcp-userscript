import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { unzipSync } from "fflate";
import { Miniflare } from "miniflare";
const bytes = await readFile("dist/perch-mcp-candidate.zip"),
  files = unzipSync(bytes);
const checksums = new TextDecoder().decode(files["SHA256SUMS.txt"]);
let checked = 0;
const manifestPaths = new Set<string>();
for (const line of checksums.trim().split("\n")) {
  const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
  assert.ok(match);
  assert.ok(!manifestPaths.has(match[2]!));
  manifestPaths.add(match[2]!);
  const contents = files[match[2]!];
  assert.ok(contents, `Archive manifest path missing:${match[2]}`);
  assert.equal(createHash("sha256").update(contents).digest("hex"), match[1]);
  checked++;
}
assert.deepEqual([...manifestPaths].sort(), Object.keys(files).filter(p => p !== "SHA256SUMS.txt").sort());
const cloud = unzipSync(files["perch-mcp-cloudflare.zip"]!);
for (const [path, contents] of Object.entries(cloud)) assert.deepEqual(contents, files["cloudflare/" + path]);
const release = JSON.parse(new TextDecoder().decode(files["RELEASE.json"]));
if (process.env.PERCH_REQUIRE_CLEAN_ARTIFACT === "1") assert.equal(release.sourceDirty, false);
assert.deepEqual(files["perch-mcp.user.js"], files["perch-mcp.user.txt"]);
assert.ok(
  new TextDecoder()
    .decode(files["perch-mcp.user.js"])
    .startsWith("// ==UserScript=="),
);
assert.ok(files["cloudflare/worker.mjs"]);
assert.ok(files["docs/RELEASE_VERIFICATION.md"]);
assert.ok(
  !Object.keys(files).some(
    (p) => p.includes("node_modules/") || p.endsWith("/.dev.vars"),
  ),
);
const config = JSON.parse(
  new TextDecoder().decode(cloud["wrangler.json"]),
);
assert.deepEqual(config.migrations[0].new_sqlite_classes, [
  "Registry",
  "Workspace",
]);
assert.equal(config.vars.PROVIDER_WRITES_ENABLED, "false");
const extracted = await mkdtemp(join(tmpdir(), "perch-packaged-worker-"));
const scriptPath = join(extracted, "worker.mjs");
await writeFile(scriptPath, cloud["worker.mjs"]!);
const mf = new Miniflare({
  modules: true,
  scriptPath,
  modulesRoot: dirname(scriptPath),
  compatibilityDate: config.compatibility_date,
  compatibilityFlags: config.compatibility_flags,
  kvNamespaces: ["OAUTH_KV"],
  durableObjects: {
    REGISTRY: { className: "Registry", useSQLite: true },
    WORKSPACES: { className: "Workspace", useSQLite: true },
  },
  bindings: {
    BOOTSTRAP_SECRET: "artifact-verification-".padEnd(64, "x"),
    ISSUER_URL: "https://artifact.test",
  },
});
try {
  const response = await mf.dispatchFetch("https://artifact.test/health");
  assert.equal(response.status, 200);
  const health = (await response.json()) as {
    schemaVersion: number;
    protocolVersions: string[];
  };
  assert.equal(health.schemaVersion, 1);
  assert.ok(health.protocolVersions.includes("2026-07-28"));
} finally {
  await mf.dispose();
  await rm(extracted, { recursive: true, force: true });
}
console.log(
  JSON.stringify({
    verifiedFiles: checked,
    txtMirrorIdentical: true,
    nestedCloudArchiveIdentical: true,
    sourceTree: release.sourceTree,
    sourceDirty: release.sourceDirty,
    bundledWorkerHealth: "PASS",
    candidateSha256: createHash("sha256").update(bytes).digest("hex"),
  }),
);
