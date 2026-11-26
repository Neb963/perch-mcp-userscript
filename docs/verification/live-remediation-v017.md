# v0.1.7 live defect remediation — 2026-11-26

## Scope and evidence

The live Image Studio defect report describes successful read/write/preview/inference but an unsaved final source revision, a rejected public plugin fetch, and an incorrectly verified viewport reset. The paired userscript v0.1.6 diagnostics confirm a connected, healthy browser lease; a gateway or OAuth reset is not indicated. This release modifies only the userscript and protocol contract metadata, not the deployed gateway (v0.1.4).

The repository test suite provides T1/T2 candidate evidence. The operator's live findings are external baseline evidence, not proof that v0.1.7 has passed T3.

## Implementation and failure modes

### Public generator and saved-source retrieval

`fetch_generator` uses credential-free `POST https://perchance.org/api/getGeneratorPageData` and CDN files on `https://user.uploads.dev/file/<immutable-key>`. It accepts a `data.generator` response with or without an explicit `status: success` and native manifest entries in recognized `key`/optional `size` or string forms. Metadata is independently fetched twice; a revision change rejects instead of combining mixed source. Every asset is size bounded; paths are canonical and case-insensitive collisions reject. Provider HTTP failures are classified by stage without returning response bodies.

A missing `srcManifest` yields a **panels-only** reference import; it cannot be used as an independent Save receipt, full source backup or manifest completeness proof. The native Save readback uses the same public reader but **requires a complete manifest and exact Generator ID, draft and source bytes**. No private AI Helper session or privileged API is called.

### Native Save and authorization

Global Cloudflare `PROVIDER_WRITES_ENABLED` is still false and browser `externalWritesVerified` is still false. No user source was saved, and no provider settings were changed. `workspace_status.effectiveCapabilities.saveGenerator` explains detected, accepted, authorized and gate reasons. The current gateway policy is an explicitly **last-observed** diagnostic snapshot; Registry admission remains authoritative.

The internal Save driver now supplies the verified independent saved base to the existing native adapter, preflights intended revision and native identity, retains the original operation ID, and performs a complete fresh public stored-source readback after the native Save call. An absent/void native Save receipt cannot be the sole success criterion; complete independent stored-source match may verify success. A failed/unknown effect is retained and must never be replayed automatically. Actual acceptance must use an explicitly authorized disposable generator before either gate can be enabled. The user's live Image Studio revision was **unsaved** when the report was written: before replacing the userscript or reloading the editor, use the native manual Save control and independently verify its result, or export every unsaved source panel and required assets.

### Viewport

`set_viewport_size` measures the assigned native preview iframe's `innerWidth/innerHeight` using the fixed, exact-origin and correlated native evaluate protocol. Set and reset are not marked verified solely because CSS properties changed. Reset restores only the adapter's owned prior inline style. Under an unchanged editor pane, a mismatching native width is a reported `NATIVE_CONFLICT` with a partial effect, not a false success. If the native frame or its pane changes, no arbitrary restoration is attempted. A real Firefox fixed-pane set/reset/refresh trace remains required for T3 acceptance.

### Diagnostics and contracts

`getEditorSyntaxErrors()` is read only if present; syntax rows are bounded and source revision fenced. No synthetic line mapping is claimed: `locationVerified:false` until direct live source-map confirmation. An empty native syntax collector remains partial; preview console/warnings and editor lint are separate. Live screenshot capture remains unavailable because no authorized raw-pixel interface has been verified.

`generator_info` adds native Public ID with conflict detection and explicit unknown independently verified saved-base revision. `workspace_status` exposes claim lease lifetime and permission ceiling, preview availability and specific Save gate reasons without leaking leases or tokens. Checkpoints and successful write receipts include hashes/sizes/identity/readback proof. New error messages contain only fixed public codes/stages, never native source, credentials or private HTTP payloads.

The tools for privileged media, public upload, production-state operations, lifecycle mutation and real pixel capture remain disabled until an authorized public/native equivalent and T3 validation exist. A working generator plugin inside a preview does not make its Helper-only or privileged methods available as an MCP RPC. Do not use page_eval or arbitrary public HTTP calls to circumvent a provider gate.

## Acceptance matrix

| Item | Automated candidate | Real operator gate |
|---|---|---|
| Public `text-to-image-plugin` fetch | Schema variants, missing manifest, malformed/HTTP failures and revision drift | Retry live fetch; inspect completeness/path/count before treating as backup |
| Viewport 917→390→reset | Synthetic size measurement and ineffective-reset negative case | Fixed native pane, compare child dimensions before/after reset and refresh |
| Checkpoint/restore | Full-source readback, checksum/identity/revision and stale/corrupt negatives | Disposable full text + binary + empty file and restoration |
| Native Save | No-effect gated path and independent base/post-readback driver | Authorized disposable Save after explicit gate acceptance, stale/lost-receipt recovery |
| Syntax | Recognized/unrecognized/empty collector rows | Deliberate malformed disposable PJS/HTML and exact path/line validation |
| Actual pixels | Unavailable is truthful | Approved browser screenshot facility or documented alternative |
| OAuth/Workspace | Existing v0.1.6 live healthy | Confirm existing pairing/Grant/Workspace unaffected by installation |

**Installation:** Replace the existing Violentmonkey script with the verified `.user.txt`; do not create a second script. Preserve the gateway and credentials, do not Rebind. Protect unsaved source before reloading. After reload, inspect `workspace_status`, `preview_diagnostics`, and safe `page_eval` before any source changes. Trigger `fetch_generator` only with the appropriate Workspace permissions and understand that it commits a local reference import.

**Verification provenance:** Final CI run, artifact SHA-256 and merge commit are recorded in the PR for v0.1.7. No unsupported T3/T4 claims are made.
