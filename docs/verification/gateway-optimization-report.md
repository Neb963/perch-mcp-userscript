# O01–O07 optimization release candidate — 0.2.0

Date: 2026-11-27. Worker and userscript: **0.2.0**. Branch: `optimization/gateway-o01-o07`. Baseline: `fb998f890e7870afac011f0c54f5035018cfe208` (Worker 0.1.12/userscript 0.1.18). Final benchmark source: **`f99b0f313603084cc720c83be974d7fd24f05e49`**, clean worktree. Subsequent evidence/documentation changes do not change application code. `RELEASE.json.sourceCommit` identifies the exact packaged final commit; the delivered qualification receipt records its exact offline CI run and final download hashes. The [offline workflow](https://github.com/Neb963/perch-mcp-userscript/actions/workflows/verify-userscript.yml?query=branch%3Aoptimization%2Fgateway-o01-o07) must pass before delivery. No merge, deployment, preview, production endpoint, provider operation or real-browser test belongs to this qualification.

The implementation completes the offline scope of O01–O07. Status and idle costs improve; native storage reduces lifecycle writes and removes history-dependent serialization. **The lifecycle targets remain unmet.** Optional features remain disabled pending operator acceptance. The default legacy path preserves compatibility and pays additional safety costs; it does not deliver the native lifecycle savings until migration is explicitly activated.

## Evidence boundaries

| Evidence | What it establishes | What it does not establish |
|---|---|---|
| Consumed workerd SQLite cursor counters | Actual local reads, writes, statements, failures, trigger/index work visible to cursors | Authoritative Cloudflare account billing or unrelated consumption |
| Test-only ingress instrumentation | Separate Worker/Registry/Workspace fetches, KV methods, alarm API calls/invocations, response bytes | CPU, physical storage, GB-s or hidden provider billing work |
| SDK OAuth/MCP loopback ingress | Actual pinned OAuth library/token validation and MCP HTTP routing | Live account authentication or provider compatibility |
| Synthetic sockets and bundled DOM controller | Authentication, advisory delivery, coalescing, missed-wake fallback, flag compatibility | Firefox CSP/background suspension or physical hibernation |
| Virtual 24-hour clocks and constructor restart | Due-only cleanup, deadlines, durable continuation, result expiry and no replay | A physical 24-hour cloud soak or eviction billing |
| Capacity model | Explicit workload/coefficient estimates, independent quota dimensions | Hard admission capacity or global provider headroom |

Runtime: Node 22-compatible test suite, Miniflare **4.20260730.0**, workerd **1.20260730.1**, compatibility date **2026-07-30**, pinned lockfile. Fixtures explicitly set `cf:false` and deny every outbound Worker request; metrics are test-only and absent from the release import graph. Initial default Miniflare metadata attempts were blocked by automatic approval review; corrected hermetic runs are the passing evidence. Public documentation research is separate from runtime testing.

The tiny ordinary fixture reads `main.pjs` and returns a synthetic marker; it does not transfer actual source bodies. Histories are 0/150/999/1000 retained ordinary operations. Full ingress includes one admission, browser fetch, durable RUNNING, terminal commit, Registry receipt/drain, and one MCP status retrieval. OAuth acquisition, later TTL/retention/alarm work, media and migration are separately measured. Four lifecycle samples describe history boundaries; their p95 is descriptive, not a statistically reliable production tail estimate. Stable idle has three samples per history, twelve total.

Machine evidence: [baseline](gateway-optimization-baseline.json), [native ingress](gateway-optimization/native.json), [default legacy ingress](gateway-optimization/legacy.json), [original harness](gateway-optimization/internal.json), [batch](gateway-optimization/batch.json), [media](gateway-optimization/media.json), [OAuth](gateway-optimization/oauth.json), [native virtual day](gateway-optimization/virtual-native.json), [legacy virtual day](gateway-optimization/virtual-legacy.json), [HTTP capacity](gateway-optimization/capacity-http.json), [push capacity](gateway-optimization/capacity-push.json), [local qualification](gateway-optimization/qualification-local.json).

## Before/after and acceptance targets

All SQL numbers below are reads/writes, not requests.

| Warm path | Baseline | Candidate | Target/result |
|---|---:|---:|---|
| Workspace stable HTTP idle, default legacy | 10/0 | 10/0 | <=10/0 met |
| Workspace stable HTTP idle, native | not applicable | 8/0 | <=10/0 met |
| Active waiting poll, default legacy | 25/0 | 25/0 | <=25/0 met |
| Workspace exact ordinary status | 19/0 | 2/0 | <=5/0 met |
| Well-formed invalid lease | 2/0 | 2/0 | <=2/0 met |
| First Activity page, 100 entries, default legacy route | 108/0 | 106/0 | <=110/0 met |
| First Activity page, 100 entries, native full route | 108/0 | 108/0 | <=110/0 met |
| Native Activity storage first/deep page | whole-array authority | 102/0; deep maximum 103/0 | Keyset seek bounded by page, ten pages tested |
| Original tiny lifecycle, both DOs, first/last fixture | 192/75; 196/70 | 162/52; 167/52 native | **80/30 target UNMET; 40/15 stretch UNMET** |

The first cold legacy idle probe pays **32/1** for bounded preparation; it is deliberately excluded from the warm 10/0 assertion and is not advertised as zero-cost initialization. Repeated exact status does not enumerate or expire unrelated operations; actual requested expiry can persist its own transition. Security-negative cases use independent assertions rather than a clean-path budget exemption.

| Retained history | Baseline full MCP | Candidate default legacy | Candidate native | Native improvement vs baseline |
|---:|---:|---:|---:|---|
| 0 | 218/72 | 232/80 | 177/52 | reads 18.8%; writes 27.8% |
| 150 | 225/70 | 239/78 | 180/51 | reads 20.0%; writes 27.1% |
| 999 | 239/70 | 253/78 | 180/51 | reads 24.7%; writes 27.1% |
| 1000 | 249/84 | 255/87 | 182/52 | reads 26.9%; writes 38.1% |

Default legacy ingress is more expensive than the baseline: +14 reads/+8 writes at the empty boundary, +6/+3 at capacity. Durable dispatch-attempt ambiguity fencing, exact async lease/admission/outbox checks and compatibility metadata have a cost. Those safeguards remain. Native authority removes the legacy/projection duplication after verified cutover; no threshold, durable transition, receipt, hold or permission check was deleted to claim a target.

Native full ingress has median/p95/max **180/182/182 reads** and **51/52/52 writes**. It uses **5 Worker requests, 6 Registry requests, 5 Workspace requests**, versus baseline 5/8/5. Each lifecycle uses **2 KV reads, 0 KV writes/list/deletes**; `getAlarm`=6, `setAlarm`=0–2, no alarm callback in that synchronous sample, SQL failures=0. Local DO wall proxy median/p95/max is 10/19/19 ms; it is not CPU or billed duration. Full-route sampled response bytes=2,220. A later cleanup bill is not included in those synchronous numbers.

**Full MCP target <=120 reads/40 writes including amortized cleanup is UNMET before cleanup.** Later cleanup cannot make the 51–52 synchronous writes satisfy 40. The candidate preserves the invariant and reports the result. The retained receipt/permit authorities are separate because an operation can terminalize before a permit exists and their retention lifetimes differ. There is no safe basis in this evidence to declare a mathematical minimum or an exhausted optimization space.

## Activity, Resources, media and batching

| Operation/fixture | Measured result | Qualification |
|---|---|---|
| Native Activity append at 0/150/999 | 4 reads/7 writes | Individual canonical entry, no whole-array rewrite |
| Native Activity append at 1000 | 6/8 | One eligible ordinary visibility eviction; unresolved overlays retained |
| Resource small revision get | 11/0 | Unrelated bodies omitted |
| Resource ~800 KiB revision get | 22/0 | Payload-dependent, ten statements, no unmetered SQL |
| Resource metadata list | 8/0 | Bodies omitted |
| Resource publish | 20/4 | Existing graph/revision/ACL/history budget retained |
| Small Resource fixture migration | 267/87 | Includes verification/fences; not a maximum-library bound |
| 1 MiB image payload | 48 legacy JSON rows -> 6 BLOB rows | Metadata/index rows excluded; real local handler/storage |
| 8 MiB audio payload | 384 legacy JSON rows -> 43 BLOB rows | Same 192 KiB wire chunks; metadata/index rows excluded |
| Music point read, 0 vs 1000 unrelated journals | 7/0 in both | Scoped catalog lookup; excludes OAuth/MCP ingress |
| 10k legacy media-journal maintenance | 81 bounded steps, maximum 656 reads/step | Old canonical records retained; restart/dirty writes tested |
| Ten separate 1 KiB file writes | 1,880 reads/540 writes | Actual synthetic OAuth/MCP lifecycle for each |
| One existing `put_files` call for the same ten files | 188/54 | 90% fewer reads/writes and calls; same revision/permission/outcome contract |

The ten-write comparison uses 50 vs 5 Worker requests, 60 vs 6 Registry requests, 50 vs 5 Workspace requests and 20 vs 2 KV reads. No new generic batch RPC was added. Binary format gates require both explicit enablement and native Workspace/schema readiness. Manifest/digest/MIME/expiry/ACK/paid-intent tests reject corrupt or mismatched data; missing native data cannot fall back or regenerate an uncertain paid effect. Existing Base64 payloads remain readable after activation and flag disable.

The release benchmark initially exposed a repeated schema-presence scan: intermediate full ingress was 228–233 reads. A positive cache limited to committed Resource schema presence removes 51 reads from each measured full lifecycle. It never caches absence, authorization, migration markers or generations; rolled-back installation cannot poison the cache. Cold partial schema and missing native marker tests fail closed. The intermediate regression was corrected before the final measurements above.

## Push notification qualification

The optional socket is advisory: committed SQL and existing HTTP fetch/reply remain authoritative. Tickets expire after 30 seconds, are single-use/scoped, and travel through a WebSocket subprotocol header. URLs carry no credential. At most two sockets, including closing sockets, count toward a Workspace's limit. Hibernation attachments retain only required nonsecret scope. The server accepts no application execution messages; it sends only ready/work-available signals.

| Gate | Local result |
|---|---|
| Healthy opted-in idle | 0 periodic HTTP work-fetch calls; heartbeat retained |
| Native admission, HTTP vs push | 23/7 vs 25/7: +2 reads, **0 additional writes** |
| Admission-request-start to HTTP fetch-start upper bound | 12 samples: median 25.12 ms, p95/max 33.60 ms (<1 s target) |
| Missed/lost/reordered/duplicate notification | Single-flight/coalesced authoritative fetch; existing heartbeat work hint |
| Silent-loss recovery | <=60 s heartbeat interval while client timers run; suspended browsers remain a live gate |
| Restart, expiry, ticket replay, origin/scope/lease change, pause/revoke, socket limit | Synthetic positive and negative cases passed |
| Flag off/old HTTP clients/disconnected socket | Existing HTTP pacing and bounded retry retained |

Raw observed outgoing messages in the latency fixture were 14 for 12 admissions including handshake/reconciliation signals. Physical hibernation, real background-tab scheduling, Firefox/CSP and provider billing remain **DEFERRED_LIVE**. Opt-in is not a guarantee of zero total idle requests: authenticated heartbeat and reconnect remain.

## Deferred work, initialization and migration cost

| 24-hour virtual scenario | Candidate legacy | Candidate native |
|---|---:|---:|
| Operations in first 8 h | 200 | 200 |
| Empty HTTP polls / heartbeats | 8,760 / 1,440 | 8,760 / 1,440 |
| Worker fetches | 10,800 | 10,800 |
| Registry / Workspace fetches | 2,040 / 11,201 | 2,040 / 11,201 |
| SQL reads / writes | 174,962 / 18,673 | 139,032 / 12,501 |
| Registry / Workspace alarm callbacks | 2 / 322 | 3 / 322 |
| Alarm get / set / delete | 11,724 / 722 / 0 | 11,726 / 725 / 0 |
| SQL failures | 0 | 0 |

This is trusted-AS internal admission/status plus actual local browser HTTP, **not full SDK OAuth/MCP ingress**. Logical ticks reproduce 5-second recent/15-second stable poll counts, zero jitter, 60-second heartbeat and due-only alarms; both canonical readers restart at 12 h. The first operation stays SUCCEEDED and returns RESULT_EXPIRED at 24 h; it is not replayed. Alarm callbacks add DO invocations beyond the fetch columns. Local summed invocation wall proxies (14,262/13,218 ms) are overlapping instrumentation, not end-to-end elapsed time or billed duration. One extra final exact-status read is included.

| One-time synthetic bootstrap stage, native benchmark | SQL reads/writes | Worker/Registry/Workspace fetches | Other counts |
|---|---:|---:|---|
| Initial pairing/workspace fixture setup | 506/232 | 7/10/1 | alarm get 9, set 2 |
| Explicit empty/small native preparation/cutover | 1,429/178 | 26/26/7 | alarm get 11, delete 1 |
| SDK registration, authorization, code/token acquisition | 354/68 | 6/14/0 | KV get 4, put 4; alarm get 4 |

These are three distinct stages, excluded from steady-state capacity tables. Setup is a synthetic fixture, not the cost of attaching every real installation. The migration sample is not a bound for a 16 MiB Resource library or 10k operations. Migration work, dirty reconciliation, trigger/index writes and temporary duplicate storage need separate operator quota allocation.

Workspace migration copies/verifies at most 16 logical records and a 1 MiB serialized budget plus one accepted-record overshoot per step. The true pre-index 10k corpus converges without an unbounded first-request v1 rebuild; all active/unresolved state is preserved. Resource streaming bounds source-part work, but complete-item validation can materialize one accepted Resource up to 16 MiB. Activity streaming bounds source parts/events and retains uncertain overlays independently of its 1,000 ordinary positions. SQL step bounds are not universal CPU/memory maxima.

## Capacity estimates and limiting dimensions

As rechecked on 2026-11-27, independent Free allowances are Worker 100k requests/day; DO 100k requests/day, 5M SQL reads/day, 100k SQL writes/day, 13k GB-s/day and 5 GB SQL storage; KV 100k reads/day and 1k writes/day. Primary references: [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [KV limits](https://developers.cloudflare.com/kv/platform/limits/). Daily reset is 00:00 UTC. The operator must recheck pricing and actual account use before release.

The following values are **modeled subtotals, rounded up**, not measured account usage. The model uses maximum measured native lifecycle/idle coefficients, measured SDK refresh plus a separately accepted full-ring diagnostic append, 2% retries, a separate 20% unrelated-consumption reserve, 60-second heartbeat, 15-minute refresh, 5-second recent/15-second stable HTTP polling, 0.25 reconnects/editor-hour, and explicit cleanup/media/log/storage/duration assumptions. Startup, issuance and migration are excluded from these subtotals and reported above, not assumed free. The 20% reserve is a comparison margin, not included in the displayed consumption. Provider traffic outside this gateway remains unknown.

### HTTP fallback model

| Scenario | Worker requests | DO requests | SQL reads | SQL writes | KV writes |
|---|---:|---:|---:|---:|---:|
| 1 editor, 8 h idle | 2,502 | 3,056 | 25,900 | 2,094 | 66 |
| 1 editor, 8 h, 200 calls | 6,769 | 8,599 | 90,642 | 14,334 | 66 |
| 1 editor, 24 h, 1,000 calls | 24,305 | 32,345 | 365,112 | 67,480 | 196 |
| 5 editors, 8 h, 200 each | 33,844 | 42,993 | 453,207 | 71,666 | 327 |
| 10 editors, 8 h, 200 each | 67,688 | 85,986 | 906,413 | 143,331 | 653 |
| 20 editors, 8 h, 200 each | 135,375 | 171,972 | 1,812,826 | 286,661 | 1,306 |
| 50 editors, 8 h, 200 each, stress only | 338,436 | 429,930 | 4,532,064 | 716,652 | 3,264 |
| 1 editor, 8 h, 50 ordinary + 50 images + 5 music | 5,785 | 8,060 | 68,232 | 14,823 | 66 |

### Healthy opt-in push model

| Scenario | Worker requests | DO requests | SQL reads | SQL writes | KV writes |
|---|---:|---:|---:|---:|---:|
| 1 editor, 8 h idle | 527 | 1,082 | 10,217 | 2,106 | 66 |
| 1 editor, 8 h, 200 calls | 1,547 | 3,377 | 48,977 | 14,346 | 66 |
| 1 editor, 24 h, 1,000 calls | 6,679 | 14,719 | 224,449 | 67,516 | 196 |
| 5 editors, 8 h, 200 each | 7,732 | 16,881 | 244,882 | 71,727 | 327 |
| 10 editors, 8 h, 200 each | 15,464 | 33,762 | 489,764 | 143,453 | 653 |
| 20 editors, 8 h, 200 each | 30,927 | 67,524 | 979,527 | 286,906 | 1,306 |
| 50 editors, 8 h, 200 each, stress only | 77,316 | 168,810 | 2,448,816 | 717,264 | 3,264 |
| 1 editor, 8 h, 50 ordinary + 50 images + 5 music | 2,113 | 4,388 | 38,971 | 14,835 | 66 |

The modeled limiting dimension is SQL writes for active workloads and KV writes for the idle workload. Ten editors already exceed SQL-write allowance under either transport. Five active editors consume approximately 71.7k writes before the 20k reserve, installation, migration or unrelated traffic; this is conditional model space, not a supported five-editor guarantee. Fifty editors are stress evidence, never a free-tier claim. Push primarily reduces request/read traffic and cannot remove required durable transition writes.

Actual SDK refresh uses **2 KV reads + 2 KV puts per rotation**, no KV list/delete, with a 900-second access token TTL. One continuously refreshing client therefore needs about **64 KV puts/8 h or 192/24 h**, before issuance and other traffic. Five 24-hour clients consume about **960**, leaving almost no 1k allowance. Immediate same-minute sampled refreshes measure 13/0 Registry SQL, 2 DO calls, one Worker request. A separately accepted full 100-event audit append adds 56/4 and one Registry call in the native sample; the model conservatively adds it for each refresh despite the 256/day audit cap. Diagnostics never write to OAuth KV.

Heartbeat, reconnect, cleanup, media and retry coefficients remain assumptions, clearly identified in JSON. Media uses measured payload row counts but **assumed incremental wire-chunk ingress cost**, with 1 MiB images/8 MiB audio; actual providers were never called. The HTTP model retains a conservative reconnect-message allowance; the push override assumes no inbound application messages and 64 reads/8 writes per reconnect. Its outbound raw-message subtotal covers assumed connection signals only, not all admission notifications; the local 14-message fixture above is the measured evidence. Outbound messages do not consume the stated DO incoming-message allowance. Logs use four routine events/operation as a reserve, not observed logging. Physical storage assumes ~1 MiB Registry + Workspace metadata/retention and omits actual library bodies, held/late-observation maxima and migration duplication. Those omissions prohibit a physical-storage capacity guarantee.

The HTTP one-editor/200-call model records 473 KV reads, zero KV lists, about 1.44 GB-s local-wall proxy, ~3.17 MB assumed storage, 816 assumed log events, 6,650 alarm gets/459 sets/51 callbacks after retry allowance. Push gives 473 KV reads, ~0.79 GB-s proxy, the same storage/log assumptions and 1,428 alarm gets/459 sets/51 callbacks. All scenarios' unrounded dimensions are retained in JSON. Real CPU, billing duration, log costs, hibernation eligibility, storage bytes and account counters are **DEFERRED_LIVE**.

## Admission policy and failure containment

`ADMISSION_BUDGET_ENABLED=false` by default. When enabled, durable **per-Workspace allocation estimates** reserve completion, bounded late observation, retained cleanup and UTC carry before new admission. They are not account reservations. `accountUsage` remains UNKNOWN; no hot-path analytics query or per-read budget write exists. Terminal result/status/recovery is never rejected solely by this policy; actual provider failure can still prevent persistence and must retain recoverable local evidence.

SQL/request envelopes remain conservative 20% allocations; the amended KV envelope is 750 writes with 256 reserved for one measured 24-hour refresh stream plus margin. The enabled default admits roughly **30 small fresh operations/day before retained-cleanup reserve**, not 200. Retained history can reduce that to zero; expensive tools can exceed the envelope immediately. First activation/UTC rollover carries active/pending/held obligations and reserves a bounded counts/bytes cleanup estimate. Unknown/corrupt/out-of-bound summaries deny new admission, schedule bounded preparation and preserve results/recovery. No same-day reservation refund is claimed.

At 50%/70% usage, diagnostics change. The 70% label does **not** implement automatic optional-maintenance throttling; necessary safety work remains unchanged. At 85%, expensive admissions are restricted; projected 95% denies new admissions. Operators must size baseline for client count, cleanup, migration and other applications. Conservative over-reservation is the explicit compromise for local estimates without global analytics.

Infra incidents use bounded structured logs and an isolate-local summary, **zero new OAuth KV writes**; historical incident keys remain readable. OAuth diagnostics use individual bounded rows, maximum 256 accepted events/day and a 100-event ring; GET adds no writes. Early path/method/body/credential-shape checks and fixed local rate buckets protect selected registration/bootstrap/socket ingress without claiming a global quota shield. Existing terminal/recovery paths are exempt. `/live` stays SQL-independent; `/health` positively validates current Registry core and successful response shape, with no cached healthy result or type coercion. Classified corruption stops automatic client bootstrap retries; quota/connectivity recovery retains bounded backoff without operation replay. Telemetry failures cannot change application outcomes.

## Migration and rollback decisions

The exact operator procedure and API contracts are [STORAGE-MIGRATION.md](../optimization/STORAGE-MIGRATION.md) and [OPERATOR-ACCEPTANCE.md](../../OPERATOR-ACCEPTANCE.md). Existing Worker identity, DO IDs/bindings, OAuth KV, credentials, Workspace/Agent assignment and wire protocols remain. New storage uses legacy -> bounded prepare/verify -> atomic per-domain native marker, with old-binary schema fences. Flag disable after cutover retains the native reader. Old 0.1.12 rollback after native writes is prohibited; use a compatible 0.2.0 reader. No reverse migration, stale snapshot fallback, automatic old-data deletion, reset or re-pair is supplied.

Expected baseline Workspaces already have their v1 projection and keep ordinary behavior during prepare. **Rare nonempty pre-index Workspaces without that projection are quiesced for journal-dependent admission/poll/claim/heartbeat/release/terminal reply until NATIVE**; exact status/recovery/migration remain readable, outbox delivery waits. `prepare` READY alone leaves them quiesced. The operator must settle active effects, preserve unacknowledged browser evidence and explicitly complete native cutover. This availability compromise avoids an unbounded first-request scan and is not claimed as live-accepted behavior.

Resources and Activity preserve raw legacy snapshots through verified cutover, with dirty-generation tracking, byte/hash/semantic verification, native marker checks and failure states. Missing/corrupt canonical records fail closed. A schema-presence cache contains no authority or authorization. Mixed per-domain states are supported by the compatible candidate; there is no cross-object atomic migration. Legacy snapshot cleanup is separate future operator-authorized work, not silently performed by this release.

## Verification and release handoff

| Gate | Local result |
|---|---|
| Locked dependency installation | PASS; no dependency upgrades |
| Baseline reproduction | 377/377 PASS |
| Final functional suite | **553/553 PASS**, 0 failed/cancelled/skipped; 46.6 s local wall |
| Strict TypeScript | PASS |
| Keyset query plans and real SQL scaling | PASS; 0/150/999/1000 histories, 10k corpora |
| Concurrency and isolation | 1/5/10/20 scenarios; 50-editor one-failed/49-successful bulkhead stress PASS |
| Quota/SQL/alarm/KV/dispatch/ack faults and restart | PASS; exact terminal retry, no uncertain replay, independent Workspace recovery |
| Migration/rollback/corrupt input | PASS; Unicode/chunks, dirty legacy writes/deletes, both directions of canonical verification, marker faults, old constructor compatibility |
| Media/Resources/batch | PASS; full-size synthetic bytes, integrity/expiry/paid intent, imports/exports/revision/ACL, existing batch outcomes |
| Bundled synthetic DOM flows | PASS; real bundled controller/transport, Worker compute isolation, corruption retry containment and push lifecycle |
| Preflight build/hash checks | PASS; 318 files, identical TXT/JS and nested Worker, clean source, packaged local Worker health |
| Wrangler local dry-run | PASS; `--dry-run` exits without deployment |
| Final exact-head offline CI and final hashes | Required before delivery; recorded by the delivered qualification receipt and exact `RELEASE.json` |
| Production/Firefox/provider/physical hibernation/account billing | **DEFERRED_LIVE** |

Two intermediate full-suite failures were fixture issues: newly strengthened core validation required complete valid synthetic core fields, and a scheduling-fault test had to clear an already-earlier alarm before expecting a new setAlarm call. A later error-message compatibility assertion retained the established word `headroom` alongside the new limiting dimension. Focused and full reruns passed; no security or numeric budget assertion was relaxed. Existing original capacity assertions were tightened to 10/25/2/2/110 clean-path targets. Lifecycle misses remain visible instead of forcing those aspirational thresholds green.

Release contents: mandatory standalone `perch-mcp.user.txt`, byte-identical `.user.js`, Worker ZIP, exact tracked source ZIP, complete candidate ZIP, operator checklist, `RELEASE.json`, internal SHA256SUMS and external DOWNLOAD-SHA256SUMS. Internal manifest hashes the source and nested artifacts; external manifest also hashes the enclosing candidate ZIP. Generated binaries are CI/download artifacts, not committed source bundles. The PR remains unmerged; production workflows are unchanged. The offline PR workflow explicitly checks out `pull_request.head.sha`, rather than a synthetic merge commit. The final delivery requires the exact-head offline CI and a clean-source rebuild; no production-readiness workflow is dispatched.

## Reproduction (offline only)

```sh
npm ci --no-fund
export CLOUDFLARE_CF_FETCH_ENABLED=false WRANGLER_SEND_METRICS=false
npm run typecheck
npm test
BENCHMARK_NATIVE=true node --import tsx scripts/benchmark-gateway.ts /tmp/native.json
node --import tsx scripts/benchmark-gateway.ts /tmp/legacy.json
BENCHMARK_NATIVE=true node --import tsx scripts/benchmark-internal.ts /tmp/internal.json
BENCHMARK_NATIVE=true node --import tsx scripts/benchmark-batch.ts /tmp/batch.json
node --import tsx scripts/benchmark-media.ts /tmp/media.json
OAUTH_BENCHMARK_NATIVE=true node --import tsx scripts/benchmark-oauth-refresh.ts /tmp/oauth.json
VIRTUAL_NATIVE=true node --import tsx scripts/virtual-day-gateway.ts /tmp/virtual-native.json
node --import tsx scripts/virtual-day-gateway.ts /tmp/virtual-legacy.json
node --import tsx scripts/capacity-model.ts /tmp/native.json /tmp/http.json - /tmp/oauth.json
node --import tsx scripts/capacity-model.ts /tmp/native.json /tmp/push.json docs/verification/gateway-optimization/push-assumptions.json /tmp/oauth.json
PERCH_REQUIRE_CLEAN_ARTIFACT=1 npm run build
PERCH_REQUIRE_CLEAN_ARTIFACT=1 npm run verify:artifacts
npx wrangler deploy --dry-run --config apps/gateway/wrangler.jsonc
```

Baseline reproduction uses detached `fb998f8` with the exact test-only ingress harness/fixture/script copied from this branch and no product-source changes. Never remove `--dry-run`, use remote Wrangler, query production readiness or activate a migration as part of these commands. Operator-only deployment, feature activation, quota observations, authorized disposable fixtures and compatible rollback are enumerated in the separate checklist. No live acceptance is marked passed by this report.
