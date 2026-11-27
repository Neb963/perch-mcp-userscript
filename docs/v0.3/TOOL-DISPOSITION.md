# v0.2.0 to v0.3 tool, permission and source disposition

Inventory source is the baseline strict schema and generated catalog in `packages/contracts/src/tools.ts` and `docs/TOOL_SCHEMAS.json` at `9524583b04e480875011f3675a581357afe315c3`. The Tool column accounts for all 52 baseline names. v2 keeps or redefines 16, retires 36, and adds `rename`, `delete`, and `batch`. The v2 catalog contains exactly 19 names.

The baseline listing and its generated reference are retained for compatibility. Retirement is a v2 implementation requirement, with staged v1 compatibility only under the original pinned scope. A removal from the v2 catalog does not authorize cleanup of historical records, unresolved effects or retained bytes.

| Baseline tool | Baseline execution and static minimum permissions | v2 disposition |
|---|---|---|
| `skill` | Gateway. `READ_RESOURCES`. | Retire. Agent-local versioned Skill files. |
| `read` | Browser. `READ_SOURCE`. | Retain. Replace the single-file and directory forms with selected exact text/binary file reads. Directory queries move to list_files. |
| `write` | Browser. `WRITE_SOURCE`. | Retain. Replace the single-file form with preconditioned inline file sets and bounded private staged transfers. |
| `edit` | Browser. `READ_SOURCE`, `WRITE_SOURCE`. | Retire. Client-side transform plus exact write, or declared isolated computation. |
| `patch` | Browser. `READ_SOURCE`, `WRITE_SOURCE`. | Retire. Client-side transform plus exact write, or declared isolated computation. |
| `glob` | Browser. `READ_SOURCE`. | Retire. Bounded metadata list/filter. |
| `grep` | Browser. `READ_SOURCE`. | Retire. Client-side selected reads or bounded isolated computation. Remove RE2JS only after legacy-import audit. |
| `list_code_definition_names` | Browser. `READ_SOURCE`. | Retire. Agent-side inspection or scoped computation. Remove Babel parser only after legacy-import audit. |
| `copy_lines` | Browser. `READ_SOURCE`, `WRITE_SOURCE`. | Retire. Client-side selected reads plus exact write, or scoped computation. |
| `read_image` | Browser. `READ_SOURCE`. | Retire. Read exact file bytes via read. Keep scoped image transport for actual preview capture. |
| `page_eval` | Browser. `PREVIEW_EXECUTE`. | Retain. Retain under explicit Target, preview freshness and effect permit. |
| `page_refresh` | Browser. `PREVIEW_CONTROL`. | Retain. Retain under explicit Target and verified rendering. Preserve separate preamble permission. |
| `execute_js` | Browser. `COMPUTE`. | Retain. Retain QuickJS. Predeclare access, bound the read view and stage final writes. |
| `set_viewport_size` | Browser. `PREVIEW_CONTROL`. | Retain. Retain with measured geometry and bounded dimensions. |
| `fetch_url` | Browser. `FETCH_PUBLIC`, `WRITE_SOURCE`. | Retain. Retain public-only retrieval with grouped GETs or a standalone durable POST intent. |
| `fetch_generator` | Browser. `FETCH_PUBLIC`, `WRITE_SOURCE`. | Retain. Retain bounded immutable public import publication with verified revision. |
| `generate_image` | Browser. `MEDIA`, `WRITE_SOURCE`. | Retire. Remove new provider effects and retain existing unsettled receipts and scoped artifact recovery. |
| `generate_music` | Browser. `MEDIA`, `WRITE_SOURCE`. | Retire. Remove new paid intents and provider dispatch. Preserve read-only records, Holds, fences, and retained authorized payload handling. |
| `upload_file` | Browser. `UPLOAD_PUBLIC`. | Retire. Remove creation of public assets. Preserve existing operator recovery evidence. |
| `download_server_plugin_state` | Browser. `PRODUCTION_READ`, `WRITE_SOURCE`. | Retire. Remove remote production-state access. Preserve existing operator evidence. |
| `upload_server_plugin_state` | Browser. `PRODUCTION_RESTORE`. | Retire. Remove new production-state replacement. Preserve unresolved effect recovery without replay. |
| `attach_file` | Browser. `READ_SOURCE`, `EXPORT_ARTIFACT`. | Retire. Remove remote attachment catalog. Preserve scoped existing artifact evidence and capture result transfer. |
| `workspace_status` | Browser. `READ_SOURCE`. | Retain. Replace default browser/source scan with Registry-owned discovery. Verify source only on explicit request. |
| `workspace_snapshot` | Browser. `READ_SOURCE`. | Retire. Use targeted read/list. Keep complete native snapshots internally where proof requires them. |
| `put_files` | Browser. `WRITE_SOURCE`. | Retire. Use write inline. Keep verified multi-file mutation internals. |
| `save_b64_file` | Browser. `WRITE_SOURCE`. | Retire. Use inline base64 or staged write. |
| `read_b64_file` | Browser. `READ_SOURCE`. | Retire. Use read with base64 and exact bounded ranges. |
| `capture_page_image` | Browser. `PREVIEW_CONTROL`, `EXPORT_ARTIFACT`. | Retain. Retain actual-pixel gate and verified BLOB/image projection. Require dedicated CAPTURE_PREVIEW opt-in. |
| `list_files` | Browser. `READ_SOURCE`. | Retain. Replace scan/hash behavior with bounded metadata-only listing. |
| `rename_file` | Browser. `READ_SOURCE`, `WRITE_SOURCE`. | Retire. Use rename with source precondition and absent destination. |
| `delete_file` | Browser. `WRITE_SOURCE`. | Retire. Use delete with source preconditions. Generator deletion remains native operator action. |
| `checkpoint_create` | Browser. `READ_SOURCE`, `WRITE_SOURCE`. | Retire. Keep operator-only checkpoint controls and internal mutation checkpoints. |
| `checkpoint_list` | Browser. `READ_SOURCE`. | Retire. Keep operator-only checkpoint list/export. |
| `checkpoint_restore` | Browser. `READ_SOURCE`, `WRITE_SOURCE`. | Retire. Keep operator-only verified restore, scoped to Binding with an exact current precondition. |
| `save_generator` | Browser. `READ_SOURCE`, `SAVE`. | Retain. Require explicit native SourceRevision and verified SavedRevision precondition. Retain exact readback and Hold. |
| `generator_info` | Browser. `READ_SOURCE`. | Retain. Retain scoped native identity/ownership. Verify saved bytes only when requested. |
| `create_generator` | Browser. `CREATE`. | Retire. Use native operator lifecycle. Preserve outstanding operation evidence. |
| `rename_generator` | Browser. `RENAME`. | Retire. Use native operator lifecycle. Rebinding follows verified identity, never Slug alone. |
| `duplicate_generator` | Browser. `DUPLICATE`. | Retire. Use native operator lifecycle. Preserve outstanding operation evidence. |
| `set_listing` | Browser. `LISTING`. | Retire. Use native operator lifecycle. Preserve outstanding operation evidence. |
| `delete_generator` | Browser. `DELETE`. | Retire. Use native operator lifecycle. Preserve outstanding operation evidence. |
| `list_skills` | Gateway. `READ_RESOURCES`. | Retire. Agent-local manifest and Skill files. |
| `list_workflows` | Gateway. `READ_RESOURCES`. | Retire. Agent-local manifest and advisory workflow. |
| `get_workflow` | Gateway. `READ_RESOURCES`. | Retire. Agent-local advisory generator-development walkthrough. |
| `get_instructions` | Gateway. `READ_RESOURCES`. | Retire. Agent-local instructions. |
| `search_documentation` | Gateway. `READ_RESOURCES`. | Retire. Agent-local reference search. |
| `read_documentation` | Gateway. `READ_RESOURCES`. | Retire. Agent-local reference files. |
| `operation_status` | Gateway. `READ_SOURCE`. | Retain. Require exact original ACL and Target. Lookup by retained Operation ID or key. |
| `cancel_operation` | Gateway. `WRITE_SOURCE`. | Retain. Require exact original ACL and Target. Cooperatively request stop while preserving actual effects. |
| `editor_undo` | Browser. `WRITE_SOURCE`. | Retire. Keep native undo in operator editor. |
| `editor_redo` | Browser. `WRITE_SOURCE`. | Retire. Keep native redo in operator editor. |
| `preview_diagnostics` | Browser. `PREVIEW_CONTROL`. | Retain. Retain bounded preview-epoch diagnostics with explicit coverage, staleness and gaps. |

The baseline schema marks music as a browser tool because it is lease-bound. The gateway may serve its fixed authorized backend through the browser operation. Legacy dynamic permissions also add FETCH_POST for POST, READ_SOURCE for preview file input or pinned compute modules, WRITE_SOURCE for preview resultPath, PREVIEW_EXECUTE for refresh preambles or emulator seeding, and READ_SOURCE for asset uploads from a file. A no-argument legacy production-state restore is reconciliation-only under PRODUCTION_READ. Preserve these restrictions wherever legacy execution remains available.

## Permission disposition

| Baseline permission | v2 disposition |
|---|---|
| READ_SOURCE | Retain. Required for source reads and verified source status, source write preflight/readback, generator info, Save, and declared compute or preview file reads. Registry-only discovery does not require it and withholds private revisions and source metadata. |
| WRITE_SOURCE | Retain. Required for explicit source/local writes, including staged transfer, declared compute writes, retrieval publication and preview resultPath. Cancellation follows original Operation permissions. |
| PREVIEW_CONTROL | Retain for refresh, diagnostics, viewport and capture. |
| PREVIEW_EXECUTE | Retain as explicit opt-in for eval and refresh preambles. |
| COMPUTE | Retain as explicit opt-in with additional permissions derived from declared access. |
| FETCH_PUBLIC | Retain as explicit opt-in, with destination WRITE_SOURCE. |
| FETCH_POST | Retain as explicit opt-in, with FETCH_PUBLIC and WRITE_SOURCE. |
| SAVE | Retain as explicit opt-in with READ_SOURCE. Keep Save outside batch. |
| CREATE, RENAME, DUPLICATE, LISTING, DELETE | Retire as active v2 generator lifecycle permissions. These legacy labels do not authorize v2 file rename or delete. |
| MEDIA, UPLOAD_PUBLIC, PRODUCTION_READ, PRODUCTION_RESTORE | Retire from active v2 policy. Preserve exact legacy labels for archived evidence and readers. |
| EXPORT_ARTIFACT | Retire from active v2 policy. Cannot grant v2 capture. |
| READ_RESOURCES | Retire from active v2 policy and default grants. |
| New CAPTURE_PREVIEW | Require explicit opt-in independently of legacy permissions, and PREVIEW_CONTROL. |

Default v2 policy is READ_SOURCE, WRITE_SOURCE and PREVIEW_CONTROL. Dispatch uses the intersection of current Grant ceiling, Workspace permissions and exact Operation scope. Operation result access rechecks the underlying current permission and original Grant. Permission changes do not erase evidence. New permissions require explicit consent and never arise by mapping a retired label.

## Baseline source and route disposition

| Source / entry point | v2 disposition and compatibility gate |
|---|---|
| `apps/gateway/src/index.ts`, `registry.ts`, `registry-core.ts`, `registry-index.ts` | Keep OAuth/MCP SDK, exact audience, issuer, approvals, pause/revoke, credential fences and authenticated admin/tab routes. Select tool/resource semantics by authenticated contract. Legacy `/api/v1/admin/agents` records remain fixed-scope. Add versioned Connector, Assignment and Binding management and preserve exact historical receipts. |
| `apps/gateway/src/workspace.ts`, `operation-store.ts`, `operation-index.ts`, `activity-storage.ts` | Preserve Workspace IDs, queues, dispatch-attempt fences, durable RUNNING, terminal exact receipts, cancellation, lease, Activity and operation authority markers. Add original v2 scope, Operation keys and segment permits. Legacy, prepare and native readers remain compatible. |
| `apps/gateway/src/push-notifications.ts`, `poll-pacing.ts`, `sql-meter.ts`, `admission-budget.ts`, `maintenance-index.ts` | Preserve advisory ticket/notification and HTTP authority, bounded due-only alarms, SQL instrumentation, recovery reserve, clean separation of local estimates and provider measurements. Remove Resource/media-specific alarms only after tracing retained obligations. |
| `apps/gateway/src/resources.ts`, `resource-storage.ts`, `packages/resource-library`, `packages/resources` | `/internal/resource-tool` and active seed, list, item, history, assignments, import, import preview, publish, restore, disable/delete are retired from development. Preserve authenticated bounded legacy/native Resource archive/export of custom revisions, hashes and data integrity. Preserve immutable authority markers and handle absence without initialization. Package repository knowledge as agent-local files. |
| `apps/gateway/src/index.ts`, `media/handler.ts`, `media/elevenlabs.ts`, `media-catalog.ts` | Retire new media generation, optional provider credentials/configuration and paid-intent admission. Audit `/api/v1/tab/music` and `/api/v1/tab/music-result`, admin diagnostics and cleanup. Keep bounded read-only recovery and conservative capacity/TTL readers for existing intent, unknown and result records. |
| `apps/gateway/src/binary-payloads.ts`, `image-transfer.ts`, `mcp-media.ts` | Preserve generic scoped BLOB/legacy readers, bounded image upload/read/status/ACK/TTL, strict MIME/digest/signature, `/api/v1/tab/image` and standard MCP image projection. Remove media-only callers without reusing old export grants. |
| `apps/userscript/src/source-tools.ts`, `adapter.ts`, `vfs.ts`, `controller.ts` | Keep native source safety, exact mutation proof and Save. Replace broad snapshots on ordinary read/list with targeted content and metadata. Keep compatible journal and archive/recovery readers. Move local active bytes, pointers, checkpoints, artifact paths and claims under canonical Binding/epoch scope. Remove helper-only patch/search/definitions/copy/undo/redo after strict v1 retirement audit. |
| `apps/userscript/src/runtime-tools.ts`, `preview.ts`, `compute.ts`, `compute-worker.ts` | Retain preview, isolated computation and bounded broker. Retire provider media/state and generic child RPC from v2. Preserve positively correlated preview origin and freshness, disposable guest worker, permissions on exact publication, body/byte limits. |
| `apps/userscript/src/lifecycle.ts`, `public-fetch.ts`, `public-generator.ts`, `public-media.ts` | Keep independent saved-source proof and safe public retrieval. Remove new lifecycle/public media effects under v2. Preserve required operator readback/reconciliation and avoid removal based on filename alone. |
| `apps/userscript/src/manager.ts`, `resource-drafts.ts`, `artifacts.ts`, `main.ts`, `autoconnect.ts` | Replace active Library/media/lifecycle tabs and routes. Keep operator archive of customized and unpublished local Resource drafts, recovery, private file import and checkpoint controls where authorized. Gate reconnect by exact current Binding/lease and version. Never auto-follow Slug or discard native draft. |
| `packages/contracts/src/tools.ts`, `envelopes.ts`, `effect-policy.ts` | Keep strict baseline schemas and historical effects where needed for v1 and archival readers. Separate implementation-version and MCP-profile checks from v2 Target authority. Audit tool/permission switches on both Worker and browser. |
| `@babel/parser`, `re2js` in `package.json` | Only direct runtime imports are in `source-tools.ts` for definitions lookup and grep. Remove pinned dependencies only when those imports and supported v1 execution paths are retired and tested. Preserve unrelated dependencies. |
| `tests/unit/contracts.test.ts`, Resource/media/lifecycle tests and existing baseline benchmarks | Keep as compatibility, denial and archival/recovery regression evidence as appropriate. File catalog parity is a historical v1 assertion. Add v2 strict-schema and retirement negatives before changing those expectations. Baseline benchmarks remain reproducible from the pinned tree. |

Verify all route and module dispositions against the final V07 diff, including alarms, dependencies, permits, local archive paths and authoritative resource markers. V00 records scope and baseline behavior. The implementation remains v0.2.0 until the corresponding phases change it.
