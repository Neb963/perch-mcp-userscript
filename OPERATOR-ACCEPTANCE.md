# Operator acceptance — Perch MCP 0.2.0 candidate

Target: **Worker 0.2.0 / userscript 0.2.0**. Use the exact candidate SHA, unmerged PR, tested artifact links and checksums identified in the [final optimization report](docs/verification/gateway-optimization-report.md). This document does not authorize a different tree or an untested rebuild.

**All production, real Firefox/Violentmonkey, Cloudflare billing/hibernation and provider checks below are `DEFERRED_LIVE`.** Only the Operator may deploy, activate migration/features, merge or perform live acceptance after explicit release authorization. A quota reset alone does not authorize those actions. The implementation agent must not execute these steps, call production endpoints, dispatch production readiness, run a preview deployment, merge the PR or schedule future live work.

The candidate is an offline-tested release candidate. It does not certify previously unavailable provider capabilities or full product parity. A successful build, SQL microbenchmark or `/live` response is not production acceptance.

## 1. Preserve the installation and establish the release boundary

- [ ] Record the exact candidate commit, PR and artifact checksums from the final report. Keep the matching `perch-mcp.user.txt`, identical `.user.js`, Worker package, source ZIP, `RELEASE.json` and checksum manifest. Confirm version 0.2.0 in both userscript metadata and Worker release evidence; investigate any mismatch before deploying.
- [ ] Preserve the current Worker version and configuration. Confirm the existing Worker origin, `REGISTRY` and `WORKSPACES` class bindings, original SQLite Durable Object namespaces/migration history, `OAUTH_KV`, issuer, secrets and browser installation identity. Registry stays named `installation`; Workspace names stay unchanged.
- [ ] Preserve native drafts, local checkpoints/backups, pending browser operation evidence, current pairing and existing credentials. Do not clear Violentmonkey storage, install a second independent script, re-pair, reset a database, rotate credentials or rebind a Workspace to make the upgrade appear successful.
- [ ] Inspect existing UNKNOWN/PARTIAL effects and active operations. Preserve their exact IDs and reconciliation evidence locally. An upgrade or data rollback cannot prove that a provider effect did not happen.
- [ ] Record current account counters and available storage. Include other Workers/clients sharing the account. Reserve capacity for migration, terminal delivery and cleanup; do not begin close to an exhausted provider allowance.
- [ ] Choose a quiet interval. Pause new work where necessary and settle in-flight effects. A nonempty pre-index Workspace without `operation_index_state_v1` requires this quiet interval: its bounded preparation cannot acknowledge browser terminal results, heartbeat or outbox delivery until native readiness. Existing indexed 0.1.12 Workspaces do not have that restriction.

`main` has production Git integration and a production readiness workflow. The Operator's eventual merge/deploy decision is the release action. Do not modify those workflows, disable their checks or use a preview deployment to bypass the authorization boundary. Retain the exact compatible candidate package for post-cutover rollback; the old Worker is not a valid rollback after native schema/BLOB adoption.

## 2. Deploy with optional adoption disabled

Use the existing deployment and bindings, with the matching candidate Worker package or explicitly approved Git integration path. Do not create a new installation. Initial candidate settings are:

| Setting | Initial value | Meaning |
|---|---|---|
| `CANONICAL_STORAGE_MODE` | `legacy` | Retain legacy authority where no native cutover already exists. |
| `PUSH_NOTIFICATIONS_ENABLED` | `false` | Existing HTTP transport. |
| `BINARY_PAYLOADS_ENABLED` | `false` | Existing payload format for new manifests/intents. |
| `ADMISSION_BUDGET_ENABLED` | `false` | Local estimated admission policy is opt-in. |
| `SQL_TELEMETRY_ENABLED` | `false` | Avoid routine per-invocation SQL measurement logs; enable only for a bounded measurement window if required. |

Preserve accepted issuer, origin policy, provider/native-action gates and secrets. Optional optimization flags do not grant SAVE, media, upload, listing, deletion or production-state permissions. Do not enable provider operations merely to qualify storage or transport.

The candidate also prepares rebuildable media/maintenance metadata in bounded background batches. This preparation is independent of the canonical flag. Legacy v1 maintenance tracking stays complete or absent before the Workspace native fence; v1 tracking triggers are removed only after operation schema 2. Existing uncertain music intents and retained bytes remain canonical. New media preparation may return `TAB_BUSY` before creating a new manifest/paid intent; retain the current operation evidence and wait for preparation rather than regenerating a provider result. There is no separate bulk payload migration API.

- [ ] Operator deploys the exact candidate and records the deployed version.
- [ ] Operator checks `/live`: HTTP 200, `ok:true`, Worker version 0.2.0. This establishes Worker liveness only.
- [ ] Operator checks uncached `/health`: HTTP 200, version 0.2.0, public `schemaVersion:1`, expected `paired:true` and `configured:true`. A classified 503 is a failed readiness gate; record its fixed reason/trace and stop new work. Do not reset pairing to hide it.
- [ ] Operator checks `/.well-known/oauth-authorization-server` and the exact `/.well-known/oauth-protected-resource/mcp/<Agent ID>` advertised for an existing connector. Issuer/resource must match the current origin and exact Agent endpoint. The pinned SDK uses `/token` for token exchange and advertised revocation; do not assume a new `/revoke` implementation.
- [ ] Confirm Registry/Workspace IDs, bindings, Grants and existing management credentials remain intact. Confirm a correct unpaired setup is distinguishable from a corrupted/failed Registry; this existing paired installation must not unexpectedly become unpaired.

## 3. Install the matching userscript and qualify HTTP first

Replace the existing Violentmonkey script contents with the complete tested **`perch-mcp.user.txt`** or matching `.user.js`; keep the existing script/storage identity. Preserve any native dirty draft before a document reload. Do not Save, publish or replace source as an incidental upgrade step.

- [ ] Record Firefox, Violentmonkey and userscript versions. Confirm 0.2.0 installed in the intended top-level editor and ordinary native editing still works during gateway failure.
- [ ] Reconnect through the existing exact Binding. Allow an existing valid lease to release/expire according to normal fencing; do not force a takeover, create another installation or change Epoch manually.
- [ ] Confirm an existing connector can call `workspace_status`, retrieve instructions/skills and perform a read-only source lookup. Check Generator ID, Draft ID, binding/source revisions, permissions and operation results without exporting source or credentials into diagnostics.
- [ ] Confirm operation status remains scoped to the current Agent/Binding. A stale/foreign handle must not expose another Workspace's data.
- [ ] Keep a compatible old HTTP userscript for a controlled compatibility check if needed. Old client/new Worker must continue HTTP; new client/old compatible Worker must fall back to HTTP. Do not downgrade the Worker after native adoption.
- [ ] Inspect `GET /api/v1/admin/diagnostics`. OAuth event records retain their redacted fields; `incidents` is a bounded, non-durable **per-isolate** summary and can disappear on eviction. It is not an account usage ledger. No incident write should consume OAuth KV.

## 4. Prepare, verify and activate canonical storage

Read [STORAGE-MIGRATION.md](docs/optimization/STORAGE-MIGRATION.md) before changing the canonical flag. Activity, Resource and each Workspace cut over independently. There is no cross-object atomic switch and no automatic deletion of retained legacy state.

All endpoints below use the existing management Bearer credential in the `Authorization` header. Never put credentials, tickets or source in URLs, shell history, screenshots or committed acceptance evidence.

| Action | Exact interface |
|---|---|
| Read Registry revision and counts | `GET /api/v1/admin/state` |
| Read Registry migration status | `GET /api/v1/admin/storage` |
| One bounded Registry step | `POST /api/v1/admin/storage/step`, JSON `{ "expectedRevision": <current Registry revision> }`, fresh `Idempotency-Key` |
| Restart repaired pre-native Activity | `POST /api/v1/admin/storage/restart-activity`, same revision/key contract; native Activity rejects restart |
| Read selected Workspace revision | `GET /api/v1/admin/workspaces/:id` |
| Read Workspace migration and auxiliary readiness | `GET /api/v1/admin/workspaces/:id/storage-migration`; returns canonical progress plus read-only maintenance/media readiness |
| One bounded Workspace step | Same Workspace endpoint, `POST` JSON `{ "action":"step", "expectedRevision":<current Workspace revision> }`, fresh `Idempotency-Key` |
| Resume repaired blocked Workspace | Same POST with `"action":"resume"` |
| Read uncertainty/budget/recovery evidence | `GET /api/v1/admin/workspaces/:id/recovery` |

A new action needs a new idempotency key. An interrupted request repeats its exact original body/key to retrieve the recorded result. Obtain a fresh entity revision before the next mutation. Do not substitute an Epoch, Activity revision, library revision or migration generation for the expected management revision.

The Workspace status GET includes `maintenanceReady` (`true`, `false`, or explicit `null` when unavailable) and `media.image`/`media.music`. Each media status reports `binaryWritesEnabled` and metadata stage `UNINITIALIZED`, `PREPARE`, `READY` or `UNAVAILABLE`, with nullable indexed count/reserved-byte/busy counters. These are partial rebuildable metadata observations, not canonical totals or account quota. A read-only status does not initialize an unused catalog; an authorized new transfer may start preparation and return `TAB_BUSY` before any new manifest/paid intent. Existing result reads/commit/ACK and uncertainty recovery retain their current path. `READY` does not authorize deletion of a busy/UNKNOWN intent or prove free-tier capacity. Record unavailable auxiliary diagnostics without resetting state; they do not replace canonical migration progress. POST step/resume receipts deliberately return their exact recorded canonical result, not changing auxiliary measurements.

1. Set `CANONICAL_STORAGE_MODE=prepare` through the existing deployment configuration.
2. Read Registry status and start a bounded Registry step. Enumerate **all** existing Workspace pages and start a step for each selected Workspace. Status-only initialization is not proof that a dormant Workspace has a continuation alarm.
3. Let persisted alarms continue bounded preparation; inspect status at a bounded cadence. Wait for Activity `VERIFIED`, Resource `VERIFY` with `verified:true`, and each Workspace `READY`. An absent, never-initialized Resource library stays uninitialized until its existing default-library workflow runs; do not call absence corruption or silently replace operator resources.
4. If a domain reports `BLOCKED`, preserve its last authority. Produce a reproducible fixture and obtain a reviewed exact repair; do not guess missing values, erase a hold or restore an old snapshot. After repair, restart Activity, resume Workspace, or let a changed Resource legacy generation restart its bounded migration. A provider quota failure needs restored headroom and retry, not data reset.
5. For rare pre-index Workspaces, preparation deliberately returns `GATEWAY_DEGRADED`/503 for admission, dispatch/poll, claim, heartbeat, release and terminal reply until `NATIVE`. Browser terminal evidence remains **unacknowledged** and must stay in its local journal. Exact clean status/recovery remains available, but outbox delivery waits for native readiness. `prepare` stops at `READY` and remains quiesced until explicit native activation. Do not mark uninterrupted terminal availability passed for this case.
6. Record preparation's SQL reads/writes, alarm calls and peak physical storage separately from steady state. Legacy snapshots, old projections, new metadata/content and indexes coexist. A Resource value can require the existing 16 MiB per-item validation allocation; fixed batch counts do not imply a universal memory/CPU bound.
7. Before any native cutover, mode `legacy` can stop preparation while retaining the legacy authority. After any native cutover, this setting stops only still-legacy migrations; it never downgrades already-native authority.
8. After explicit approval and headroom review, set `CANONICAL_STORAGE_MODE=native`. Verify the native marker independently for Activity, Resource and every selected Workspace. Registry storage core becomes schema 2 after Activity/Resource cutover; Workspace storage becomes schema 2 after operation cutover. Public health/protocol schema remains 1.
9. Verify Resource point lookup/list/history, exact immutable restore semantics, filtered Activity pages, stale cursor rejection, operation status/result expiry, unresolved receipts, scoped cancellation and restart recovery. Preserve all existing semantics; do not replay a provider effect to manufacture migration evidence.

No ordinary request should fall back from native authority to a stale retained legacy copy. Old binary access is fenced. Retained legacy data and old projections require a separately reviewed, explicitly authorized cleanup program after successful live acceptance; this candidate does not automatically delete them.

## 5. Opt into push notifications

Set `PUSH_NOTIFICATIONS_ENABLED=true` only after separate Operator approval. There is no new manager push button/local toggle: the matching userscript negotiates the capability in its authenticated claim. A compatible reconnect may be required to negotiate a new session; preserve the exact Binding and native draft.

| Check | Required observation |
|---|---|
| Healthy foreground idle | Controller diagnostic `notifications.state` becomes `connected`; after the initial authoritative fetch, no periodic `/api/v1/tab/poll` traffic occurs. Authenticated heartbeat remains at its existing approximately 60-second cadence. |
| New work | The notification wakes one HTTP fetch/execution loop. WebSocket frames contain only advisory `ready`/`available`, never operation args, source, credentials or execution authority. |
| Silent missed signal | Pending work is reconciled through heartbeat `workAvailable`; the foreground nominal recovery bound is one heartbeat interval. Suspended/throttled browser timers can exceed 60 seconds. Record actual foreground/background behavior separately. |
| Socket/network interruption | Existing-lease HTTP fetching resumes; reconnect backs off with jitter. No parallel execution or automatic replay occurs. A possibly dispatched HTTP request is not aborted merely because transport changed. |
| Pause, release, navigation or revoke | The old generation stops receiving useful signals; no new operation bypasses current Registry/lease authority. A completed external effect remains subject to ordinary terminal/reconciliation rules. |
| Unsupported socket/CSP or old client | Existing bounded HTTP fallback continues. Real Firefox/Violentmonkey CSP compatibility and background-tab behavior must be observed, not inferred from local tests. |
| Disable flag | Set `false`, reconnect normally if needed, and confirm HTTP fallback. This does not downgrade canonical storage. |

The implementation uses authenticated `POST /api/v1/tab/ticket` and `GET /api/v1/tab/socket?workspaceId=<nonsecret ID>`; the short-lived one-use proof travels in the WebSocket subprotocol offer, not the URL. Do not manually copy a ticket or export raw handshake headers. Existing controller diagnostics report `http`, `fallback`, `connected` or `stopped` plus bounded retry/failure information. Observe the existing diagnostic export; do not invent a new UI control.

Cloudflare physical hibernation and actual billing remain a separate gate. An open socket, no traffic, or local wakeup latency does not prove hibernation. Raw incoming application messages and billable-equivalent message requests are different measurements.

## 6. Opt into binary payload storage and controlled tool acceptance

`BINARY_PAYLOADS_ENABLED=true` selects new BLOB writes only when that Workspace's operation storage is already `NATIVE`/schema 2. Each new image manifest or paid-music INTENT fixes its `BLOB_V1` format. Existing unmarked retained payloads keep legacy JSON/Base64 decoding; there is no wholesale payload copy/cutover.

- [ ] On an explicitly authorized disposable fixture, verify exact image bytes/MIME/SHA-256, duplicate chunk behavior, commit/ACK, expiry and restart hydration. Wire chunks stay at 192 KiB: a 1 MiB payload uses six BLOB payload rows; an 8 MiB payload uses 43. Count manifests/index metadata separately. SQL fixtures established these counts offline; do not add a new production raw-SQL tool to inspect them.
- [ ] Disable the flag after a marked payload exists and confirm that existing BLOB read/ACK/expiry still works. New owners select the legacy format while disabled. Missing/corrupt marked payload must fail closed; it must not select stale legacy chunks or regenerate a result.
- [ ] Preserve music `INTENT`/`UNKNOWN` records and paid-intent no-replay semantics. Payload expiry/ACK deletes bytes according to the existing ten-minute payload TTL; it does not prove or erase an uncertain provider effect.
- [ ] Exercise a representative ten-file task with existing `put_files`, current `expectedRevision`, per-file results and complete readback. Current contract: at most 64 files and 256 KiB total decoded inline contents. Verify a partial/native conflict is explicit and does not trigger blind repetition.

Real media generation, native Save/lifecycle mutation, external upload, listing, deletion and production-state restore require their existing permissions **and separate explicit consent for the exact disposable fixture/action**. Paid media additionally requires explicit paid-provider authorization. Do not mutate a production generator, pay for generation, change provider account settings or enable a previously unavailable capability merely to demonstrate quota accounting. If consent or a required interface is absent, retain that gate as `DEFERRED_LIVE`/blocked rather than replacing it with a mock pass.

## 7. Optional admission envelope

Keep `ADMISSION_BUDGET_ENABLED=false` until measured traffic and the intended client count are known. This is a per-Workspace **admission estimate**, not a provider/account meter or reserved global completion capacity.

Optional JSON overrides are `ADMISSION_BUDGET_CAPS_JSON` and `ADMISSION_BUDGET_BASELINE_JSON`. Their dimensions are `sqlReads`, `sqlWrites`, `workerRequests`, `durableObjectRequests`, `durationMs`, `storageBytes`, `kvReads`, `kvWrites`, `logEvents`. Inspect the final candidate defaults before enabling. The amended default KV write allocation is 750 with a 256 baseline for one measured 24-hour refresh stream plus margin; SQL/request caps remain at their separate conservative allocations. Additional clients and delayed cleanup require baseline sizing from measurements, not multiplication of nominal free-tier capacity.

- [ ] Configure a measured baseline that includes token issuance/refresh, HTTP or push heartbeat/reconnect traffic, already-retained result/media/history cleanup, migration, logs and unrelated account reserve. Default baseline assumptions are not a proven worst-case bound.
- [ ] Enable `ADMISSION_BUDGET_ENABLED=true` only after reviewing those allocations. Read `admissionBudget` through the existing Workspace recovery endpoint. Check `enabled`, `known`, `caps`, `reserved`, `retainedCleanup`, `cleanupSummary`, `ratio`, `mode`, `staleDay` and `observedAt`; `accountUsage` remains `UNKNOWN`.
- [ ] Confirm threshold reporting at 50%/70%; 85% restricts expensive new tools and projected 95% rejects new admissions. The 70% mode is diagnostic; do not infer an unimplemented automatic background throttle from its name.
- [ ] Confirm ordinary local estimates remain deliberately conservative: the default enabled SQL envelope admits roughly 30 small operations/day with no retained-cleanup reserve under its worst-case reservation coefficients, not a claim that the measured 200-call workload fits that policy. Retained history can reduce that count further, including zero new admissions until the envelope is explicitly configured. Some expensive tools reserve more than the default envelope and can be rejected immediately when the policy is enabled; optional admission enforcement is disabled by default.
- [ ] Observe UTC rollover and restart. First activation/rollover reserves a bounded retained-cleanup estimate in addition to carrying active/pending/held obligations and the configured background baseline. Inspect `retainedCleanup` and `cleanupSummary`, which include retained operation/result/media/retired-lease counts and bytes. Missing, corrupt or out-of-bound summaries deny new admission; large retained history can place the local envelope in recovery-only mode. These conservative coefficients still do not reserve real provider capacity or bound unrelated traffic. Do not delete/reset counters to bypass admission policy.
- [ ] Confirm existing terminal reporting, result retrieval and recovery remain available when the **internal admission policy** denies new work or its diagnostic state is unavailable. Actual provider SQL/storage exhaustion can still prevent persistence: keep local evidence, do not report success without commit, and retry/reconcile the exact result when capacity recovers. The rare pre-index migration exception remains as documented above.

Disabling this flag stops local admission enforcement; it does not increase any provider allowance, release real account quota or make uncertain effects replayable.

## 8. Measure each quota dimension independently

Use actual account/Worker metrics, a fixed UTC window and known workload counts. Retain redacted before/after counters, configuration, versions, operation counts, status/heartbeat/refresh counts, retries and migration stage. Separate unrelated account traffic. Do not export credentials, source, media, raw OAuth URLs or private request captures.

Reference allowances below come from the dated 2026-11-27 handoff. Recheck current account plan/limits before release using the official [Worker pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/), [KV limits](https://developers.cloudflare.com/kv/platform/limits/) and [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) documentation.

| Dimension | Recorded free-tier reference | Measure and distinguish |
|---|---:|---|
| Worker requests | 100,000/day | Public MCP, OAuth, heartbeat/fallback, socket opens, management and status calls. |
| Durable Object requests | 100,000/day | Registry/Workspace calls, alarms and current provider WebSocket accounting. Do not equate this with Worker request count. |
| SQL rows read | 5,000,000/day | Full ingress, cold startup, migration, repeated status, auth, retention and cleanup. Local cursor rows are measurements, not authoritative account billing. |
| SQL rows written | 100,000/day | Canonical transitions, indexes, deletes, receipts, migration and cleanup; account alarm storage calls separately from cursor counters. |
| Worker CPU | Recheck current per-invocation limit | Measure Worker CPU separately from DO duration and response wall time; a short local request does not establish compliance with the provider CPU limit. |
| DO duration | 13,000 GB-s/day | Actual provider billed duration/hibernation. Local wall time, CPU time and the budget's `durationMs` proxy are not GB-s. |
| DO SQL storage | 5 GB total account reference | Peak retained legacy/native representations, indexes, results/media and unresolved state. This is a physical capacity, not a daily-reset quota. |
| OAuth KV | 100,000 reads/day; 1,000 writes/day | Count `get`, `put`, `delete`, `list` separately and compare each to its current allowance. Initial issuance, refresh and other applications are additional to ordinary MCP traffic. |
| Logs | Recheck current plan | Event count/ingestion/sampling; distinguish bounded explicit events from platform invocation logs. Temporary SQL measurement logging has its own cost. |
| WebSocket messages | Recheck current pricing | Raw incoming application messages separately from the provider's one-request-per-20 billable equivalent; socket opens are requests, outbound notifications are a different count. Protocol ping/pong is not an application message. |

Daily allowances reset at **00:00 UTC** (01:00 in Poland during winter). A reset restores an allowance; it neither repairs corrupt state nor authorizes deployment/replay.

Pinned local SDK evidence measured **two KV writes per successful refresh rotation**, with the unchanged **900-second access token TTL**. If a client refreshes continuously every 15 minutes:

| Continuous refresh-active workload | Refresh-only KV writes |
|---|---:|
| One client, 8 hours | 64 |
| One client, 24 hours | 192 |
| Five clients, 24 hours | 960 |

These are projections from measured per-refresh coefficients, not observed production daily counters. Initial registration/issuance, refresh retries, other clients and other account applications add cost. Five such 24-hour clients leave only about 40 of a 1,000-write daily allowance before those additions. Avoid treating SQL improvements or push idle savings as removal of the OAuth KV limit. Do not lengthen token security windows or change provider billing implicitly to make a capacity table fit.

Record at least: one foreground idle editor over a controlled interval; a representative ordinary-operation workload including status, RUNNING/terminal and later cleanup; a restart/renewal interval; staged migration cost; and a controlled multi-editor workload. Measure OAuth refresh separately. Compare before/after using the same payload/tool mix and elapsed interval. Report median/p95/max where appropriate, actual limiting dimension, unexplained deltas and any unmet target. Fifty editors is a synthetic stress fixture, not a promised free-tier production capacity.

## 9. Stop, recover and roll back

| Observed condition | Operator action |
|---|---|
| Worker live, Registry readiness failed | Stop new work, record the fixed reason/trace and actual account counters; preserve pairing/storage and restore required provider capacity. Do not start an unbounded probe loop. Classified corruption/schema/configuration failures with `retryable:false` stop automatic connectivity retries; repair them before a manual retry. Known SQL-quota connectivity backoff remains separate from operation replay permission. |
| Pre-native preparation problem | Set canonical mode `legacy` to stop incomplete migration; preserve the last legacy authority and diagnose the recorded domain. Roll back code only if **no** native marker/BLOB or other incompatible storage adoption exists anywhere. |
| Any native schema 2/BLOB adoption | Use only the verified compatible candidate reader. Do not deploy Worker 0.1.12, restore a stale legacy snapshot, remove fences or reset an object. No reverse migration is supplied. |
| Push/CSP problem | Set push flag `false` and confirm normal HTTP fallback through a compatible reconnect. Keep current operation identity and canonical state. |
| New BLOB adoption problem | Set BLOB flag `false` for future owners; retain a reader for existing `BLOB_V1` manifests and their exact recovery/expiry state. |
| Admission estimate/configuration problem | Inspect recovery/account measurements, preserve counters, adjust the authorized policy or disable optional admission enforcement. This does not repair provider quota or authorize replay. |
| Unknown external effect or missing terminal commit | Preserve native/local evidence and the exact operation handle. Reconcile through existing authorized readback/recovery; never regenerate/re-execute merely to recreate a missing result. |

The Operator records each gate as passed only with actual evidence. Keep unresolved production/Firefox/CSP/hibernation/provider gates `DEFERRED_LIVE`, and record consent-limited tests as unperformed. A complete offline candidate and an unmerged reviewable PR are the implementation deliverables; production rollout and final live acceptance remain the Operator's decisions.
