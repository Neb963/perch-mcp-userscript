# Browser implementation and evidence

2026-11-26; implementation evidence T1 only. No Firefox, Violentmonkey installation, real Perchance generator mutation, native Save, uploader or lifecycle operation was performed by these tests. This is an executable candidate adapter, not a live provider certification.

## Executable boundaries

| Component | Implemented behavior | Verification |
|---|---|---|
| `NativeAdapter` | Fixed native editor/srcState methods; lossless Generator ID projection, legitimate empty Draft ID, explicit binding checks, readiness/helper/collaboration guards, complete panel/src byte snapshot, manifest and byte recheck, exact sequential write/readback | Original synthetic native interface fixture |
| `VirtualFileSystem` | Native panels/src plus private Workspace scratch; `imports/` read-only; revision generation + SHA-256; complete preflight, immutable checkpoint before write, durable intent, explicit partial/unknown result, holds survive reload | Binary `[0,255,1,128,10]`, empty bytes, reload, human edit and lost receipt fixtures |
| `ChunkStore` | 192 KiB immutable chunks and digest, manifest pointer last; failed write preserves prior manifest; explicit orphan collection | Interrupted manifest write and missing chunk |
| `SourceTools` | Numbered UTF-8 read, byte-paged base64 read/write, exact replacement/edit, preflight Add/Update/Delete patch, glob, RE2 grep, actual Babel JS/TS and embedded script definition parser, CRLF-preserving copy, source CRUD, checkpoints and native undo/redo adapter | Positive and negative cases in browser-core test |
| Native Save | Native method only; independently read saved base and complete intended source; permission, identity, source revision and readiness checks; `saved` receipt plus complete readback; stale/challenge errors; uncertain result remains UNKNOWN | Synthetic saved/stale/created-on-update fixture; production disabled |

A checkpoint restore stages native source; it never invokes Save. Checkpoints include all native panels/src and local scratch/import snapshots with identity and digest. Imported source snapshots cannot be modified by agent tools. Checkpoint history retains five unpinned snapshots plus pinned snapshots; budget refusal occurs before mutation. Unknown/partial intent is never evicted or replayed automatically. Operator reconciliation requires an inspected current revision and an explicit acknowledgement; no agent tool exposes that acknowledgement.

## Interfaces

```typescript
const adapter = new NativeAdapter(nativePage, { cloneInto: copyValidatedBytes });
const vfs = new VirtualFileSystem(adapter, isolatedGMStore, workspaceId);
const source = new SourceTools(vfs, adapter);
const report = await adapter.probe();
const snapshot = await vfs.snapshot();
const result = await source.call("edit", {
  path: "main.pjs", oldString: "old", newString: "new"
});
```

`KeyValueStore` is asynchronous `get<T>`, `set<T>`, `delete`, `list`. `GMStore` accepts only isolated manager API callbacks; page localStorage is not a supported backing store. No native account/store object, secret or credential is projected by the adapter. The adapter never evaluates model JavaScript or exports privileged callbacks to page code.

## Explicit budgets and limitations

| Area | Current limit / behavior | Remaining evidence |
|---|---|---|
| Native snapshot / local Workspace | 64 MiB default aggregate; at most 1000 native src files; 16 MiB per inline local file | Real GM capacity/performance; larger streaming/chunk transfer parity |
| Internal mutation batch | At most 1000 writes; MCP `put_files` remains bounded by its shared schema | Real native multi-file failure/readback and pending viewer buffer handling |
| Checkpoint storage | 64 MiB encoded aggregate default; required checkpoint cannot silently evict pinned data | Real manager storage quota and upgrade behavior |
| Search | RE2 syntax, pattern <=1024 chars; 8 MiB scan, 10000 collected matches, 100 per page; unsupported lookaround/backreferences rejected | Large binary/file corpus and browser responsiveness |
| Definitions | Actual parser; 1 MiB source scan; 1000 entries, 45 KiB result, 200-char signature; PJS named function bodies only | Provider PJS grammar is not reconstructed; dynamic declarations not inferred |
| Native snapshot consistency | Complete read + manifest/byte recheck and per-write revalidation | No provider-wide lock exists; manual mutation after the last read can still force PARTIAL/HOLD |
| Source revision | Monotonic observed-generation counter plus complete-source hash | Unobserved A→B→A changes cannot be detected without verified native event hooks |
| Native Save | Disabled unless a tested integration injects `externalWritesVerified` and an independent readback driver | F04/A06 live receipt, native save-state, exact empty/binary source, lost receipt/late commit and challenge proof |
| Lifecycle / standalone upload | Fixed lifecycle candidates are implemented below; production gate remains disabled. Standalone upload embed has no verified adapter | Verified native create/rename/duplicate/listing/delete controls and upload embed sequencing; A07/A08 remain blocked |

Native lifecycle and upload methods observed in the historical handoff remain candidates. Calling undocumented raw mutation endpoints would bypass the accepted native orchestration contract. Their absence is a mandatory parity blocker, not a successful unavailable-tool test. Public documentation and operator-native actions remain authorized investigation alternatives; neither proves autonomous parity without recorded behavior.

## Reproduction

`node --import tsx --test tests/unit/browser-core.test.ts` runs 18 original deterministic tests. Tests make no network requests and use no third-party source captures. They cover binary/empty files, no credential projection, default/nondefault Draft identity, readiness gates, path traversal/case collision, lost native receipt, manual edit after partial mutation, durable hold after reload, checkpoint full restore, chunk corruption/interruption, exact edit/patch preflight, linear-time regex, pagination, CRLF and parser line ranges, and Save's disabled/live-fixture branches.

Live procedure remains `docs/TEST_PLAN.md` A03/A06/A07 with an explicitly authorized disposable generator and cleanup ledger. First install and run the read-only probe; verify exact Firefox/Violentmonkey versions, content injection and native object access. Do not enable production Save merely because a fixture passed.

## P06 candidate lifecycle and independent readback amendment

`NativeLifecycle` implements fixed candidate native settings rename, listing button, duplicate and delete methods. It requires a separate live external-write evidence gate, native ownership, current native revision, independent saved identity/ownership, and configured permission. Listing/duplicate/delete also require a fresh exact tool/input/target/revision/Epoch approval. Duplicate explicitly selects saved source; it verifies a different Generator ID, complete identical saved source, new ownership and Unlisted state while preserving the original Binding. A candidate native duplicate that leaves the new generator Listed returns UNKNOWN and does not claim parity.

Each lifecycle action persists DISPATCHED intent before invoking a native control. Reused Operation IDs never repeat the control. Unknown lifecycle effects fence later actions for that Generator ID, including after adapter reconstruction. `reconcile(operationId)` only performs independent reads. Delete verification requires both exact-ID absence from owner inventory and native source-not-found evidence; one failed public request cannot certify deletion. Rename returns required explicit rebind, duplicate returns required new Binding, and delete returns required detach. This component does not administer or silently replace a gateway Grant.

The settings `duplicateGenerator`/`deleteGenerator` method names and optional duplicate-name field remain feature-detected candidates. Their behavior is verified against original synthetic fixtures only. A live interface mismatch returns UNSUPPORTED_INTERFACE before dispatch. Create remains blocked on native document transition: opening `/minimal#edit:new`, staging inert source, verified native creation and Unlisted state, and explicit new Workspace attachment cannot be represented as a successful mutation of the existing Binding.

`SavedSourceReader` provides a complete independent public readback driver: fixed `/api/getGeneratorPageData`, immutable Perchance upload assets, cookie omission, no redirects, bounded streamed bytes, exact ID/Slug/panels/manifest paths/file lengths, zero-byte anomaly detection, full digest, and a second saved-source read to reject mixed revisions. Missing manifest is not interpreted as empty. It never calls a mutation API. Owner inventory proof for lifecycle still requires a verified native ownership adapter; this public reader cannot infer ownership.

`SourceTools.call("save_generator", args, {save: trustedSaveContext})` now connects the native Save candidate only when the controller supplies its internal saved base, independent readback, Operation ID and explicit permission. An agent cannot supply that context. The path persists complete checkpoint and intent before native Save, retains partial/unknown state, and rejects replays. Without that integration context the tool reports UNSUPPORTED_INTERFACE with its exact missing evidence.

`VirtualFileSystem.importSnapshot` atomically publishes byte-exact public source under `imports/<snapshot-id>/` after full path/case/size preflight. Agent write/edit/delete tools cannot modify these files. Root-directory reads accept the shared read-schema limit, root definition extraction includes top-level panels, and Workspace snapshots include actual small panel text plus src manifests (large panels explicitly direct the caller to paged `read`).

Reproduce all browser candidate evidence with `node --import tsx --test tests/unit/browser-core.test.ts tests/unit/browser-lifecycle.test.ts`: 32 passing T1 tests. No external provider call or production mutation occurred.
