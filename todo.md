# Implementation ledger

## W4 — exact development catalog and batching input qualification (CI PENDING)

- Candidate atomic clauses: S03-011/012/014 (19-tool Workerd catalog, unavailable capture metadata, conservative read-only annotations); S03-015/021/022/023 (closed nested batch, effect operationKey, optional pure-read key and nested delivery field rejection).
- Added direct true SDK tools/list assertions in `tests/integration/result-scope-v2.test.ts`; added positive/negative real production parser tests in `tests/unit/development-v2.test.ts`.
- **Do not mark PASS until new exact-head CI succeeds and observes each assertion.** This adds no new permissions or production effects.

## W2 — scoped result authorization SQL experiment (VERIFIED partial improvement)

- Hypothesis: Worker repeats a generic Registry authorization for result/status or cancel before Workspace performs the necessary *original Operation scope* authorization. Removing the former avoids redundant per-operation Registry SQL while the latter retains fresh revocation, Grant, Target, permission and bindingRevision checks.
- Changed `apps/gateway/src/index.ts#mcpDevelopment` to route result/cancel by authenticated opaque scope directly to Workspace. In `workspace.ts#authorizeScopedResult`, use that same authoritative Registry result to enforce the former bindingRevision fence without an earlier Worker request.
- Added Workerd integration coverage for original Grant read/cancel, unrelated Grant denial, altered Target denial and no unauthorized cancellation. This is **not** a completed SQL-budget fix. Compare identical native fixture with 187/44, and revert if there is no measured improvement.
- The first W2 CI (46158519983) passed the new original-Grant negative test but exposed a genuine regression in image-result delivery: removed Worker auth had supplied `bindingRevision` to the image hydration guard. Reuse the revision from the Workspace's mandatory fresh Registry authorization instead; preserve the separate image and post-hydration revocation checks (three fresh boundaries, not four). CI was red; no performance result claimed.
- Exact-head [CI 46158850513](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46158850513) passed after binding revision fix. Same five-stage native fixture **187/44 → 180/44**; unchanged five-stage legacy **251/74 → 244/74**. Status stage Registry **18 → 11** rows read; writes unchanged. Safety tests include real Workerd original Grant Target denial, cancellation, image hydration and post-hydration revocation. See [R11 benchmark report](docs/verification/v0.3-remediation/r11/SQL-EXPERIMENT.md).
- SQL requirement stays FAIL: native 180/44 still exceeds ≤120/40 by 60 reads and 4 writes. Next structural proof: inspect terminal write/index overhead and Registry/Workspace admission and dispatch reads, including old schema and rollback. No unmeasured optimization claims.

## R10 — browser effect-boundary preflight and checkpoint reconciliation (OFFLINE VERIFIED)

- Verified entry branch HEAD: `8d979e6c97e499bf8d43c5bc3cf4feef2b743738`; exact-head [CI 46156655650](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46156655650) passed 730/0/1. Updated stale FINISHING-STATE.md commit/CI/artifact fields.
- Recheck standalone development tool arguments through canonical admission preflight before browser execution; reject reserved transport/delivery fields, malformed bytes, duplicate paths, and invalid mutation preconditions even after upstream admission. Preserve permission ceilings and batch host policy checks.
- Added direct `S03-009` negative tests and one valid write in `tests/unit/development-v2.test.ts`; [CI 46158172940](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46158172940) verified 731 PASS/0 FAIL/1 historical SKIP at `cbef2a2`. Marked only S03-009 PASS after direct evidence.
- Next: measure W2 auth read duplication against the same 187/44 native lifecycle, validate original Grant and binding revision fencing, then verify exact-head CI. No live tests, deployments, owner data modifications or merge.


## R09 — bounded v2 input admission (offline verified)

- Exact source `2e2f5221baddf0bf404accfe66ea8c3be230c46f`; [offline CI 46156403985](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46156403985) **730 PASS, 0 FAIL, 1 historical SKIP**. Executed full pinned CI test/build/benchmark/artifact workflow; no production or native Firefox operations.
- Added iterative input-structure validation (depth ≤16, nodes ≤16,384, no shared/cyclic object references) before any Registry/Workspace work, and serialized UTF-8 envelope budget on standalone requests. The original batch budget remains. Bounded positive and over-limit negative cases are directly asserted by `S03-007/008` tests in `tests/unit/development-v2.test.ts`.
- Promoted only **S03-007** and **S03-008** in existing `SPEC-00-05.md` register on exact named test evidence ([R09](docs/verification/v0.3-remediation/r09/DIRECT-QUALIFICATION.md)). Register: **1,317 = 124 PASS, 4 FAIL, 1,150 NOT_STARTED, 24 DEFERRED_OWNER, 1 BLOCKED_FEASIBILITY, 14 superseded**.
- **Next executable**: Profile native five-stage SQL physical query/index amplification under current authority and choose one measurable safe structural reduction, then exact same 120/40 benchmark and historical-compatibility negative tests; separately qualify next P0 recovery/authorization requirement with direct assertions. S07-023 screenshot remains blocked on operator authorization and demonstrable exact unsaved-preview pixels.
- PR #25 remains draft and unmerged. Do not deploy, run provider/production tests, request browser permissions or merge.

## R08 — finishing state, direct Target/discovery and pre-admission qualifications (offline verified)

- Baseline: source/docs `d9906633467e72d3ecb1364fb60139b5110a3698`, [successful offline CI 46150920907](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46150920907), 727 PASS / 0 FAIL / 1 historical SKIP; 1,317 clauses = 112 PASS / 4 FAIL / 1,162 NOT_STARTED / 24 OWNER / 1 feasibility BLOCKED / 14 superseded.
- [`FINISHING-STATE.md`](docs/verification/v0.3-remediation/FINISHING-STATE.md) created at `bf60957c05c86d2afe87d10a363d147b5178bf74`. This is the cross-agent restart index, not a second requirements database. Includes roadmap, decision register, exact blocker/evidence totals, local reproduction constraints, and next-agent action.
- Added direct `S02-009` boundary test at `542e9ec496f4ed71bf108b070b7402e9509406f0` to `tests/integration/assignment-contract.test.ts`. It asserts canonical Target zero/MAX_SAFE_INTEGER, all four extreme generation combinations, rejected negative/fractional/unsafe/nonfinite inputs, invalid textual variants, and exact increment overflow. Source behavior unchanged. Do not promote requirement to PASS until exact-head CI observes the named test passing.
- Same preserved native lifecycle: 187/44 vs required <=120/40; legacy 251/74. No SQL target claim. Previous read-cache trial saved zero SQL rows and is not being repeated.
- **Next:** inspect exact CI outcome for `542e9ec`; if green, record its named test and exact SHA as direct `S02-009` proof and update existing register. Continue P0 connector authorization/recovery cases, then safe structural SQL reductions measured on original five-stage denominator.
- Runtime limitation in this executor: pinned `npm ci --offline` cannot install uncached `zod@3.25.76`; use exact-head offline GitHub CI for meaningful verification, never claim local test execution. No live provider, Cloudflare preview/deploy, real Firefox, OAuth or merge.

## R07 — eleven directly qualified T0 document contracts (CI SUCCESS)

- Baseline exact code d78a023 and verified R06 register commit 3956255, no live calls/deploy/merge.
- Source checks: S00-003 architecture boundaries; S00-010 labeled historical docs; S00-011 all 52 old tool/permission dispositions; S00-012 unchanged scope; S00-013 exact R00 evidence; S00-015 phase ledger; S00-016 original A01–A34 mapped one-for-one; S02-049 explicit Target; S02-101 exact stale MCP catalog recovery; S04-016 operation-key replay prohibition; S04-080 cross-segment partial and separate Save.
- Change only narrow Connector setup guidance and agent-side instructions plus eleven T0 assertions. The client steps are intentionally UI-agnostic: no fake button names; live external client acceptance remains OWNER.
- Exact source 5cf2aa7 / [CI 46150545750](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46150545750) **727 PASS / 0 FAIL / 1 historical SKIP**, eleven named S00/S02/S04 document-only assertions passed. All package/hash/dry-run and synthetic benchmark steps succeeded. R07 promoted eleven T0-only rows; resulting strict inventory **112 PASS / 4 FAIL / 1162 NOT_STARTED / 24 OWNER / 1 feasibility BLOCKED / 14 SUPERSEDED =1317**. [R07 proof](docs/verification/v0.3-remediation/r07/DOCUMENT-QUALIFICATION.md). No browser/runtime/provider gate inferred.
- Objective SQL native ≤120/40 still **unmet at 187/44**; native unsaved preview pixel gate and owner-only external conditions still blocked. No Cloudflare or browser provider interaction.



## R06 — reject ineffective transaction read cache; qualify eight documentation contracts

- [Trial 6a25baf / offline CI 46148963399](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46148963399): **713 pass / 0 fail / 1 historical skip**; locked typecheck, full tests, source/build hashes and Wrangler dry-run PASS. Direct native lifecycle counters are **44/10 admission, 50/8 poll, 14/1 RUNNING, 56/25 terminal, 23/0 status; total 187/44**. Legacy **251/74**. The cache trial has **exactly zero savings** versus verified 0c4a44e. No cross-request or cross-await cache was attempted.
- **Decision:** restore byte-exact baseline `apps/gateway/src/sql.ts`, delete the rejected experimental cache test and retain no production feature/complexity without benefit. Preserve canonical part corruption checks from 0c4a44e.
- **Verified DOC authority:** exact code [d78a023](https://github.com/Neb963/perch-mcp-userscript/commit/d78a023ad0f2171cbf0732d24fdb0b73b9ea85dc), [offline CI 46149708275](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46149708275) **716 pass / 0 fail / 1 historical skip**, full locked typecheck, tests, native/legacy cost, package checksums, dry-run. Eight independently asserted T0 document-only clauses S00-001,002,004–009 promoted, with exact log evidence; previous first attempt's test matcher failure was fixed and retested. Registry **101 PASS, 4 FAIL, 1173 NOT_STARTED, 24 OWNER, 1 blocked feasibility, 14 superseded = 1317**. [R06 direct qualifications](docs/verification/v0.3-remediation/r06/S00-DOC-QUALIFICATION.md). This is no runtime/provider pass.
- **Release unchanged:** S07-023 exact screenshot pixel capability remains unsupported, native SQL ≤120/40 failed by 67 reads/4 writes, remaining individually unqualified requirements and owner-only gates unresolved. No provider, preview, deployment or merge.

## R00–R05 v0.3 conformance remediation

### 2026-11-28 exact A01 and canonical-integrity qualification

- Exact implementation source `0c4a44e9c1006f329f2efe3cf9813a712c1c4425`, [CI 46147393916](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46147393916): **708 passed, zero failed, one historical skip**; complete offline build, inventory, hashes and Wrangler dry-run. Native 187/44, legacy 251/74; SQL target FAIL remains. All eight downloaded hashes and TXT/JS identity independently verified.
- [A01 direct evidence](docs/verification/v0.3-remediation/r05/A01-DISCOVERY-QUALIFICATION.md) records actual production-route test of exact three-Connector owned discovery, no foreign record reads or Workspace lookup, 50-row bounded pagination and stale cursor rejection. Five rows promoted to PASS; current 1,317: PASS 93, FAIL 4, NOT_STARTED 1,181, OWNER 24, BLOCKED 1, SUPERSEDED 14. This is not proof of the other clauses or full release eligibility.
- Evidence-only commit records the already verified code SHA, not a self-referential artifact SHA. No live action or deployment. No authorization or durable receipt weakening.

### Fresh Registry index benchmark; canonical integrity and A01 evidence

- `ec4b9fd` [offline CI 46147027731](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46147027731) passes all steps. Native five-stage workerd measurement is **187 reads / 44 writes** versus 187/46 baseline (terminal 56/25 rather than 56/27). Legacy is 251/74 versus 249/76; the fresh-only layout trades two additional legacy reads for two fewer writes. Existing databases retain their original index; no migration. Native objective remains unmet.
- Canonical `SqlRecords.get` now validates actual part positions and per-part bounds before interpreting JSON. Focused SQLite tests 5/5 pass, including valid-JSON gaps, missing initial parts, negative/fractional positions, oversized parts, nonmutation on failure and valid multi-part Unicode round-trip. The existing activity scan counter follows the updated projection.
- Added A01 production Registry route acceptance test for exact owned bound targets, empty Connector, all 50 owned Workspaces in bounded pages, stale cursor after unassignment, zero foreign record reads and zero Workspace namespace lookups. Explicitly requested synthetic-only trace records every SQL statement and namespace lookup in request-local context; it cannot silently truncate and is not included in deployed Worker.
- Await exact-head locked CI before promoting A01 rows or recording final measured costs. No live operations or deployment.

### R04 fresh Registry partial workspace indexes (2026-11-28)

- Resume from verified `7260a9b` (offline CI 46143736524). Existing native benchmark 187/46 vs ≤120/40; strict inventory 88 PASS, 4 FAIL, 1186 NOT_STARTED, 24 OWNER, 1 capture blocker, 14 superseded.
- Fresh-only replacement of the broad workspace index with three partial indexes matching the actual active Grant, consumed permit and unresolved Hold lookup predicates. Canonical records, due indexes, terminal retention and rollback compatibility remain unchanged. Existing physical layouts retain the original index.
- Local focused production-module SQLite tests 4/4 passed (TypeScript transpile with locally available compiler; not pinned full-suite qualification). EXPLAIN confirms all three indexed query plans; 1000 successful terminal notices/permits do not obstruct live Grant and Hold lookups, unresolved and resolved outcomes retain exact predicates, and historical full index still works after reopen.
- Locked local install unavailable (uncached dependency). Use existing nondeploying offline CI to measure the same five-stage native/legacy workload; retain only if measured net benefit without safety regression. No new PASS claim or production action. Continue unresolved requirements independently.


### 2026-11-28 complete takeover offline verification exit

- `a736513`, [CI 46143344849](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46143344849) **705 pass/0 fail/1 skip**; exact checked-out tree, full builds/hashes/dry-run passed; no live operations. UI exact-bundle: 30 screenshots, 10/8/2 complete rows, zero outbound requests; local filter/approval/reassign/recovery/UNKNOWN revision details all pass.
- Updated **four still-FAILED** matrix records to their **actual latest values** rather than stale R00 measurements. S08-058 + F13.01/.02 native five-stage lifecycle **187/46** vs **≤120/40**; S07-023 actual preview pixels unsupported. Firefox 2026 Region Capture remains unavailable and Violentmonkey has no tab-pixel API; owner-authored new component/flow required.
- See [R05 exact-head exit](docs/verification/v0.3-remediation/r05/FINAL-OFFLINE-STATUS.md) for complete traceability, source/security boundaries and owner checklist. Matrix 1317: PASS 88, FAIL 4, NOT_STARTED 1186, OWNER 24, BLOCKED 1, SUPERSEDED 14. Strict release gate NOT ELIGIBLE. Remaining work must not be relabeled as complete; PR remains draft, unmerged, no Cloudflare deployment.

### 2026-11-28 exact S10-004 Workspace observation proof

- `9956d04` [CI 46142955098](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46142955098): 705 PASS, 0 FAIL, 1 historical skip; typecheck/build/hashes/dry-run passed. Verified native revision hashes only when the projection supplies `verified:true`; unverified Source, Preview, Saved remain UNKNOWN. Local Activity observation includes Workspace, phase, tool and observedAt with installation scope; does not assert a current clear Hold.
- Same installer rendered 30 screenshots in local Chromium, 10/8/2 complete Workspace rows at 1440×900, 1024×768, 390×844, no overflow or external requests. Extended `tests/offline-manager/closure-r05.py` also checked UNKNOWN/observed outcome on expanded row and 0 Gateway requests on expansion.
- [Direct acceptance evidence](docs/verification/v0.3-remediation/r05/S10-004-PROVENANCE-QUALIFICATION.md) promotes S10-004 to PASS. Register now 1317: PASS 88, FAIL 4, NOT_STARTED 1186, OWNER 24, BLOCKED_CAPTURE 1, SUPERSEDED 14. The SQL target 187/46 vs 120/40 and actual unsaved preview capture remain unresolved. No production, provider or deployment action.

### R03 S10-004 local-first Workspace detail evidence

- Workspace `More actions` detail now discloses SourceRevision, PreviewRevision and SavedRevision; only explicitly verified SHA-256 projections are shown, and unverified/missing native state is labeled UNKNOWN.
- After Activity is intentionally opened, bounded installation-scoped cached Activity metadata records Workspace ID, tool, phase and observedAt. The Workspace detail labels its last **observed** result and warns that current Holds must be inspected in Activity/Recovery; it does not infer a clear state from stale cached history.
- No new auto Gateway request, no native scan, and no change to collapsed Workspace table density. Unit test `S10-004 Workspace detail...` asserts verified/unknown and cached-result cases, and 0 extra management requests while expanding. Pending exact-code CI and bundled Chromium geometry before promoting S10-004.
- This is an operator observation improvement, not an authorization predicate or trustworthy Save revision. Owner acceptance and SQL/pixel gates remain separate.

### Clean-install Resource retirement S09-003

- Source `2a49d88`, [CI 46142275476](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46142275476) passed 704 tests / 0 failed / 1 historical skip. New no-legacy `resourceStorageMaintenance` short circuit prevents inactive Resource schema/trigger writes in native/prepare mode, while legacy data appearing later still migrates.
- Strengthened the test's SQL-write assertion to refuse every CREATE, INSERT, UPDATE, DELETE, DROP, ALTER or REPLACE SQL statement; no incorrect regex can permit an unobserved Resource write. Direct hermetic Chromium manager remains five tabs with zero Library navigation.
- [S09-003 qualification](docs/verification/v0.3-remediation/r05/RESOURCE-RETIREMENT-EVIDENCE.md) moves one previously FAIL clause to PASS. Matrix now 1,317: PASS 87, FAIL 5, NOT_STARTED 1186, OWNER 24, BLOCKED 1, SUPERSEDED 14. Remaining F14 subclauses still require independent verification.
- Pending new exact-head CI for strengthened invariant; no live infrastructure or deployment.

### R03 F14/F25 Resource clean-install storage short circuit

- New v2 workspaces and a fresh native-mode Registry do **not** imply a legacy Resource library exists. `resourceStorageMaintenance` now checks for a legacy library before installing Resource SQL schema/triggers. Legacy/native authority markers stay mandatory if migration was previously started; existing native installations still use their original migration readers.
- The bounded no-resource test verifies `legacy`, `prepare` and `native` initialize zero Resource tables and write no Resource SQL data when no legacy library is present. A legacy library subsequently appearing is migrated to native with exact snapshot verification. A trailing orphan part causes `RESOURCE_SNAPSHOT_CHUNK_GAP`, never silent omission.
- Combined with existing v2 retired resource-tool denial and exact bundled no-Library UI tests, this aims to close S09-003 after exact CI. No cloud migration, deployment, or account access.

### Exact-head CI closure F12/A10/A15/S10-021

- `b7daa00` [offline 46141689975](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46141689975): 703 passed, 0 failed, one historical skip; typecheck, native/legacy benchmarks, package hash, Wrangler dry-run PASS.
- Immutable public revision manifests preserve prior byte-identical source copies and block archive-address collision. Targeted old-Epoch Hold resolution, stale staged-transfer abort, and delayed manager response all have focused production-path negative regressions.
- [R05 independent proof](docs/verification/v0.3-remediation/r05/F12-HISTORICAL-AND-MANAGER-EVIDENCE.md) promotes four previously FAIL clauses. Register 1317: PASS 86, FAIL 6, NOT_STARTED 1186, OWNER 24, CAPTURE blocked 1, superseded 14.
- Native ordinary SQL benchmark still **187/46 >120/40**, unsaved preview pixel capability unsupported, and remaining 1186 normative clauses lack independently accepted evidence. No production tests, deployment, or merge.

### 2026-11-28 F12 integration-test fixture and R05 semantic evidence fix

- The offline public-generator adapter reads provider metadata twice per independent snapshot and does two independent snapshots. Synthetic version generation must therefore advance every **four** requests, not two. The 89ac2b3 offline test correctly failed on inconsistent fake snapshots before publication; fixed the test fixture without altering the production source or weakening the check.
- R05 evidence audit heuristically rejected two `PASS` rows solely because their **operational** descriptions included `pending` (a live state, not a verification state). Retained exact tests, SHA and PASS criteria; clarified these as **unanswered approval** and **unresolved request**, keeping the strict verifier unchanged. Earlier 7c688d9 run had 700 pass / 1 fail / 1 skip; 89ac2b3 run had 701 pass / 2 fail / 1 skip, with these two specific causes.
- Recheck exact new source tree via complete offline CI. No deployment, preview, production request or release-gate relaxation.

### R03 F12 immutable public import publication (2026-11-28)

- Restore verified revision-addressed source under `imports/<slug>/perch-revisions/<snapshotId>/files/`, with an immutable `manifest.json`. Keep backward-compatible `imports/<slug>/<path>` and active `perch-receipt.json` pointing at the exact immutable manifest.
- All alias/immutable paths publish in one binding-local durable pointer and exact readback. On repeated same revision, verify existing immutable bytes, refuse changes before publication; retain previous revision across a new import. Reject reserved metadata path collisions/duplicate selectors and mark selective imports as `materialization:selected` instead of claiming full materialization.
- Trade-off: immutable archives consume physical GM space; existing 64 MiB budget and refusal/recovery safeguards remain, no silent eviction, no new cloud store. Source/doc acceptance remains unqualified until exact-source CI and tests pass; no real public provider request.
- Focused tests: `tests/unit/development-v2.test.ts` F12 original, two successive revisions, corrupt archive, timeout, and existing negative tests. Do not promote S06-048 until verified.

### R05 synthetic bundled manager closure and digest correction (2026-11-28)

- Added reproducible offline Playwright `tests/offline-manager/closure-r05.py` (actual shipped manager, local Chromium, zero network). F18 urgent approval survives foreign Connector filter; F22 three local filter operations add 0 GET; F19 all 6 conflicting controls disabled with delayed rebind; F26 Recovery/Settings local-first during 60s pending Gateway read; F25 no Library destination across v1/v2/outage/unpaired.
- Downloaded candidate `perch-mcp-candidate.zip` SHA-256 `0f0121f5740328ffdbfc3834d10eebb39d771678f5100cb72b6ca7b9b5d20076`; matching PR body, RELEASE metadata and artifacts. TXT/JS digest `7eeb0c71a050bc040cd820b93db51c01ad6a46a7f68e9896e839398c141f2059`.
- Direct evidence [R05 manager closure](docs/verification/v0.3-remediation/r05/MANAGER-CLOSURE.md). Nine previously FAIL rows moved to PASS. Revised 1,317-row register: 82 PASS, 10 FAIL, 1,186 NOT_STARTED, 24 OWNER, 1 capture blocker, 14 superseded; strict release gate remains blocked. Independently unresolved actual preview pixels and native 187/46 vs ≤120/40.
- Offline UI fixture is NOT live Firefox/provider evidence; no production calls, cloud operations or merge.

### 2026-11-28 exact-head F09/OAuth/manager qualification

- Safe demand-driven native compute read path committed at `5c045bc` after detecting and fixing a write-only manual-edit race. The existing size/prefix negatives remain intact, with added 100-file selector and same-size-edit regressions.
- [Offline run 46140138366](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46140138366): 701 PASS, 0 FAIL, 1 historical skip, build/artifacts/dry-run PASS. Local synthetic Chromium exact-installer: 30 screenshots, 10/8/2 complete Workspace rows, 52px desktop row, no external requests.
- Native full five-stage lifecycle still **187 SQL reads / 46 writes**, legacy 249/76. The ≤120/40 objective remains **UNMET**; do not relabel aggregate batching as ordinary per-operation compliance.
- R05 reconciled 19 atomic clauses with direct evidence in [qualification report](docs/verification/v0.3-remediation/r05/F09-OAUTH-UI-QUALIFICATION.md). Requirement inventory remains mostly unverified; screenshot and OWNER gates still block release.
- Next: resolve other normative requirements with independently reproducible tests and safe corrections, investigate SQL terminal/dispatch amplification without weakening authority, preserve draft PR and no live access.

Baseline `298f3b9619335364c668a69b6f04570ae530fcab` (tree `c07b3e7e25ea0e4d063ee11435cc58e3d524059b`), same tree as audited PR #24 head. Work on `repair/v0.3-conformance`. [Authority](docs/v0.3/REMEDIATION-AUTHORITY.md) and [verification index](docs/verification/v0.3-remediation/REQUIREMENT-TRACEABILITY.md).

| Phase | Verification gate | State |
| --- | --- | --- |
| R00 | Pin authority and baseline, build an atomic requirement inventory, rerun the offline suite, replay the P0 reports, and record measured baselines. | Baseline verified |
| R01 | Preflight full batches, fence execution at effect boundaries, preserve receipt uncertainty, and bind operator actions and consent to exact intent. | Regressions verified |
| R02 | Recover transfers and historical local state, deduplicate immutable storage, and exercise publication faults. | Scoped recovery verified. Historical reclamation remains open. |
| R03 | Qualify permanent OAuth, clean installation, all feasible development behavior, and the local-first manager. | OAuth, manager and v2 Resource denial verified offline; F12 retrieval and UI density next; F11 capture feasibility blocked |
| R04 | Meter comparable workflows and quotas, calibrate admission, and qualify long finite access lifetimes. | Pending |
| R05 | Rebuild and test the exact candidate, reconcile every requirement, and verify artifact bytes and the unmerged PR. | In progress: atomic coverage inventory, UI expiry gate, exact-head CI and final PR verification; full normative closure remains blocked |

R01 local verification passed strict TypeScript, 615 tests with zero failures and four phase-gated probes, and the final focused renderer detected zero external requests. [R01 evidence](docs/verification/v0.3-remediation/r01/README.md).

R02 scoped historical recovery, staged transfers, and exact operator writer fencing were verified in local fixtures. [R02 evidence](docs/verification/v0.3-remediation/r02/README.md).

R03 takeover: extend v2 Grants with explicit null expiry, separate token renewal from execution, preserve suspended Connector resource metadata, exclude revoked Grants from active capacity, and add bounded revoked retention. Qualify actual SDK exchange/rotation/revoke and KV expiry across nine finite TTL candidates. One-year default is provisional until ten-year evidence; no production credentials touched. The first takeover checkpoint 84242a5 passed strict typecheck, 665 of 666 tests (one deliberately skipped historical baseline), artifact verification and Wrangler dry-run in run 46091943832. The pinned SDK qualified nine access lifetimes including ten years. Live client compatibility remains OWNER-only.

Next scoped change removes the active Library under every manager state; preserves historical archive export without lazy initialization in v2; isolates local manager rendering during outages; adds local-only filter/sort, compact Workspace/Connector disclosures, and exact issuer/generation-scoped stale summaries. New UI and legacy-archive regressions require a second exact-head offline qualification before marking PASS.

Local Chromium and workerd fixtures use synthetic data. Production, provider, live OAuth and browser acceptance, deployment, preview, and merge are reserved for the operator.

### R03 second-checkpoint investigation

The 3fac671 manager release passed strict typecheck and 667/670 tests in offline run 46093062222: two new legacy Resource-retirement cases failed because the GET harness itself demanded HTTP 200 before exposing a 410 response; the intended gateway rejection was observed. The test assertions are repaired to inspect raw authorized HTTP status/error codes. No production failure was inferred from the tests.

F10 status semantics: stale heartbeat is not verified source. Registry detail must explicitly report unverified SourceRevision/LocalRevision/PreviewRevision/SavedRevision, effective tool permissions, unsupported pixel capture and scoped blockers without reading source. Native generator_info must return reasoned revision objects without implicit verification. A focused local-workerd test exercises a READ_SOURCE-only Connector, unbound discovery, bound Target detail, unauthorized write capability and explicit unavailable verified-source path. Verification pending exact-head CI.

### R04 inline bounded read-only native selectors (2026-11-28)

- Corrected partial terminal-index CI ef6671c run 46111436457 PASS. Exact native operation 194 reads/48 writes; legacy249/76. This is one additional write reduction with unchanged five-stage denominator and compatible existing indexes.
- New measured candidate: only if operation tool is read, mutating===false, and JSON-encoded arguments <=512 UTF-8 bytes, persist exact selector in existing canonical operation context rather than an additional operation_args_v2 row. Preserve all large/mutating args and every result in external payload tables. Strict decode rejects context/external duplicates and unsupported inline shape. Metadata remains inside the private Workspace Durable Object; no external projection may expose args.
- Legacy native migration uses the same shape(), preserving canonical(legacy) equality and all receipt digests. Old external read-selector rows get deleted only when the new canonical row is updated atomically. `activeObligations` must read either layout. Test positive/negative, Unicode, oversized, transition, cold reopen, migration and corrupt external payload. Retain only on equal-workload measured write savings without additional reads or authorization regressions.
### R04 measured Activity savings and native terminal partial index (2026-11-28)

- cacc613 exact-head CI 46110889498 succeeded. Native lifecycle now 194 reads/49 writes; legacy249/76. Removing the new-only combined Activity index reduced one write per complete native terminal and retained correctness of ordered Workspace/phase query and native readback.
- For newly initialized native operation tables only, change operation_native_terminal_v2 from indexing NULL active rows to a partial index `WHERE terminal IS NOT NULL`. The existing lastTerminal aggregate/cleanup query explicitly filters nonnull terminal, so the same ordering/plan applies with fewer write-amplifying entries.
- Verify ADMITTED->RUNNING->SUCCEEDED transition and native stats, durable receipt, cold reopen and compatibility with an old physical full terminal index. All historical databases retain their original index via CREATE INDEX IF NOT EXISTS. Re-measure both modes; revert if negative or ineffective.
### R04 measured count savings and native Activity index (2026-11-28)

- Exact-head 9de5803 CI 46110662684 PASS: native 194 reads/50 writes; legacy249/76, versus prior native 194/52; verifies fresh selective Registry counts and retained UNKNOWN binding hold.
- New-only canonical_activity_v2 removes the combined `(workspace,phase,rank,sort_time,key)` index; the already-present `canonical_activity_workspace_v2` covers Workspace+phase queries within 1000-entry canonical visibility window. Preserve global order, workspace-only, phase-only, serial/expiry indexes and keyset cursor revision checks. Existing databases keep the prior index.
- Focused unit asserts index set, SQL query plan, 200 mixed workspace/phase events and exact sorted combined filters with/without historical index. Run exact-head CI and compare actual native and legacy write rows before deciding to retain.
### R04 selective derived count maintenance (2026-11-28)

- Exact ad6d01a CI 46110343560 PASSED and measured native 194 reads / 52 writes, legacy 249 / 78. The omitted new-only `registry_kind_v1` index reduced two writes per complete lifecycle and preserved 100-row ordered paging, 213 Grant entries, expiry and corruption rejection.
- Introduce a further new-only SQLite trigger optimization: registry_counts_v1 persists only kinds with hot calls (`workspace`, `agent`, `idempotency`). Permit and terminal-notice counts remain exactly computable on demand from registry_entity_v1 and no longer increment a redundant counter in the common dispatch/terminal path. Existing derived-index schema is left untouched and remains compatible.
- Test UNKNOWN terminal-notice bind holds, permit delete, count fallback, persisted hot counts and cold reconstruction. Preserve Activity, 7d expiry and read/list pagination. Evaluate exact-head native and legacy benchmarks; if any regression occurs, revert without changing protocol semantics.
### R04 exact measured physical canonical storage and Registry index (2026-11-28)

- Exact-head 1b053013 CI 46109926275 succeeded. A fresh canonical records WITHOUT ROWID table measured native five-stage **194 reads /54 writes**, legacy **250/80**, compared with previous rowid baseline 193/57 and 246/85. This is a three-write reduction with one additional native read; no existing DO physical schema was migrated. Keep explicit fresh-install-only qualification.
- Follow-up measured-index hypothesis: remove redundant registry_kind_v1 secondary index on *new* RegistryIndex instances; use the canonical kind-prefixed primary key range for deterministic 100-row paging, preserving expired approval filtering and corruption checks. Existing RegistryIndex schema marker prevents unrequested index replacement. Verify EXPLAIN, 213 Grant records, approval expiry, indexed workspace Grant lookup, legacy coexisting secondary index and full external permission negatives.
- Commit only with exact-head offline CI, compare both legacy/native SQL and repeat at 0/150/999/1000 histories as practical. Threshold 120/40 still unmet; no permission checks or durable receipts removed.
### R04 measured no-op fast path and fresh physical schema (2026-11-28)

- ce51cf6 exact-head CI 46109712786 succeeded, but SQL rows native five-stage **193/57**, legacy **246/85**, identical to verified de350a/34657 baseline. The active-poll deadline shortcut adds complexity without measured SQL saving. Revert the Workspace source and remove its additional test before further optimization.
- For new installations only, change the SqlRecords `records` canonical table declaration to `WITHOUT ROWID` (one composite PRIMARY KEY B-tree, not a rowid table with separate key index). Do NOT rebuild or migrate existing `records` tables. Preserve the original schema automatically for previously created Durable Objects via `CREATE TABLE IF NOT EXISTS`.
- Qualify both fresh WITHOUT ROWID and pre-existing rowid shapes under SQLite: chunked Unicode, rollback, triggers, write/delete, cold reopen and exact authorization. Verify actual Miniflare native/legacy SQL rows before claiming a benefit; revert if reads or writes increase or state semantics change.
- Keep fresh-vs-existing physical layout distinction visible in the report and rollout. Owner has expressed willingness to reconfigure credentials, but no live drop/reset or migration is authorized.
### R04 measured rollback and bounded active polling (2026-11-28)

- CI 46109244898 at fbe2132 passed offline typecheck/tests/build, but SQL IN-plan increased five-stage native reads 193→203 and legacy 246→256, with unchanged writes. Revert and remove test; a measured regression cannot remain.
- Reuse exact idle-probe SQL plus durable alarm verification on positive native activeCount. Skip expiry scans only if all operation/maintenance deadlines are future and pending/dirty/outbox/preparation are absent and retention <=1000. Keep every dispatch/Target/lease/phase fence.
- Native Miniflare regression covers successful dispatch, missing-alarm fallback and expired-op rejection. Legacy behavior is unchanged. R04 numeric objective remains unverified until equal-denominator CI benchmarks.
### R04 canonical multi-key authorization read (2026-11-28)

- Exact-head benchmark 34657b7 / run 46105833686 still measures 193 SQL rows read and 57 written per native five-stage operation, target strive <=120/40. Do not silently alter numerator/denominator.
- Add a bounded getMany read to SqlRecords, using one prepared SQLite IN query with 1–8 unique keys, ordered chunk assembly and corruption failure, no source, secrets or SQL string interpolation. The canonical maps exist only in the current function invocation.
- V2 authenticateConnector reads fresh Grant and *claimed* Connector candidates in one SELECT, then executes unchanged owner, credentialEpoch, audience, suspension, permission-ceiling and revocation checks. Identity is never accepted merely because a requested candidate row exists. Existing v1 reads are unchanged.
- Verify updated suite and exact-head five-stage/legacy synthetic workload before accepting any reduction. If Cloudflare query plan reads more rows or changes revocation semantics, revert the optimization; it is a reversible query-only change.
### R04 scoped admission and cost plan

1. Correct v2 `execute_js` admission: local broker reads/write staging are not 1,000 nested remote child RPCs. Preserve v1 estimate, strict conservative positive reserves, exact epoch/transaction state and no weakening of admission accounting. Add v2 batch 1–32 cost bounds and rollover tests.
2. Reproduce true local SDK/Registry/Workspace costs at 0/150/999/1000 histories, ten individual writes versus one grouped write, ten heterogeneous individual calls versus one 10-step batch, 1/5/10/20/30/50 Workspace indexed discovery and 10/20 isolated Connectors.
3. Measure native and legacy canonical storage independently. Compare against v0.2 and verified v0.3 baseline; report SQL reads/writes, KV operations, Worker/DO requests, bytes, incomplete billing dimensions, and target breaches without claiming account-global quota.
4. Retain <=120 SQL reads / <=40 writes as an *unmet* normative target until an exact-head measured workload passes; do not remove fresh scope/revocation/readback checks to improve synthetic metrics. Track OWNER-04 provider billing separately.

### R03 evidence and next gate

- Exact-head b125c32 CI run [46093489526](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46093489526) passed offline typecheck, unit/integration, build, checksum verification and Wrangler dry-run. Earlier 84242a5 run 46091943832 independently qualified nine OAuth SDK lifetimes up to ten years, nonexpiring v2 consent/refresh/client, suspension and revocation. The v2 access-token default is 24 days (browser timer-safe); ten years is an explicitly configured OWNER-02-gated experimental override. Consent and refresh registration remain indefinite.
- The exact tested userscript was rendered in isolated Chromium with 30/50-Workspace synthetic fixtures and zero external network requests. At CI head e742f091 the 1440×900, 1024×768 and 390×844 Workspace views fit 11, 8 and 2 complete rows respectively; all original 8/6/1 density targets pass, no overflow. F17, F21, F25, F26 and F27 checks pass: local identity, stop, scoped Recovery export and private staging remain functional in a cold outage. Obsolete F26 fixture expectations were corrected to test actual local operability rather than invent remote rows.
- The revised exact e742f091 bundle renders 11 desktop (1440×900), 8 laptop (1024×768), and 2 mobile (390×844) complete Workspace rows, satisfying 8/6/1 limits with zero measured horizontal overflow and no external requests.
- F12 changes in next checkpoint: validate optional provider SHA-256, enforce cancellation/deadline for paired public reads, atomically publish a revision-pinned local receipt with import bytes, and cover failed/mismatched/time-out branches without any unauthorized network access.
- R04 offline benchmark at e742f091 in run 46095386706 measured native full read 225 SQL reads / 57 writes, legacy 280/85. Mixed ten individual native calls used 2,485 reads / 554 writes; one ten-step batch used 266 reads / 57 writes. Targets <=120/40 still FAIL. Six indexed discovery sizes and 10/20 Connector synthetic issuance/discovery passed; these are not account-global free-tier guarantees. The benchmark artifacts are uploaded independently before dist cleanup.
- Chromium timer qualification: values above 2^31-1 milliseconds schedule near-immediately; ten-year expires_in is unsafe as a universal client default. Use 24 days (2,073,600 seconds) as timer-safe default with permanent refresh consent, and retain explicit ten-year override as OWNER-02-gated.
- Remaining: F06 conservative historical storage reclamation, actual preview pixels feasibility, all remaining A01–A34 matrix entries, full R04 performance and R05 final exact-head qualification. No unfinished row is PASS.
R05 first exact-head CI qualification at `42ab329` [run 46097599704](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46097599704) succeeded: 686 tests passed, zero failed, one skipped, both offline cost paths, inventory generation, release build/hash check and Wrangler dry-run. Inventory has 1,317 distinct clauses: 54 PASS, 1,196 NOT_STARTED, 28 FAIL, 24 DEFERRED_OWNER, 1 BLOCKED_FEASIBILITY and 14 SUPERSEDED; the strict release gate fails by design. The artifact initially stamped synthetic PR merge `GITHUB_SHA`; next checkpoint corrects provenance to the checked-out source SHA and tree, enforcing expected PR head in CI.

### R04 measured 34657b7 result and batching guidance

- Exact-head native/legacy benchmark [46105833686](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46105833686): **193/57 native**, **246/85 legacy** for equivalent full ordinary lifecycle; native admission stats consolidated one read (194→193). The objective is *Strive <=120/40* (original spec §8.1), not a waiver of mandatory safe replay/revocation/recovery.
- Ten heterogeneous separate native Gateway lifecycles consumed 2,130 reads / 550 writes; one synthetic ten-step batch lifecycle consumed 233 / 57, reductions 89.1%/89.6%. Browser nested effects were not executed in this benchmark, so runtime effect cost remains unverified.
- Update packaged agent knowledge to prefer correctly scoped, fully preflighted 1–32-step batches and explicit per-step receipts, keeping Save/POST, stale dependent actions and unknown effects separate. This operationally reduces free-tier overhead without speculative durability redesign.
- Further 73-read/17-write difference requires substantial Registry/Workspace persistence/index changes. Do not drop independent canonical receipts or indexes simply to satisfy the aspirational metric; design additive, reversible migration and prove full fault coverage before treating a structural rewrite as ready.
### R04 native atomic admission caps snapshot

- `dfdbc6c` native full read lifecycle measured **194 SQL reads / 57 writes**; exact v2 terminal reply removed five global-expiry read rows and retained late-observation UNKNOWN outcome. Native and legacy tests passed.
- OperationStore native admission checks `pendingFull`, `holdsFull` and (mutating only) `holds` from the same canonical SQLite statistics row with separate point SELECTs. Replace with one validated `admissionCaps()` snapshot inside the *same synchronous* admission transaction, before any operation mutation. For legacy storage call original index methods. Preserve limits (128 pending, 128 unresolved), rollback behavior and fail-closed corruption errors.
- Native and legacy exact-head cost benchmark and capacity tests must pass; preserve expiry, UNKNOWN holds, pending outbox and writer transitions. Do not treat the snapshot as cached authority across awaits.
### R04 v2 exact terminal expiry reconciliation

- `ab790965` succeeded exact-head offline tests. Same-denominator native **199 SQL reads / 57 writes**, legacy 253/85; all receipt and Activity tests pass.
- V2 terminal browser reply need not scan unrelated operation/maintenance indexes before acknowledging one exact operation. As with v2 RUNNING, use the canonical exact-operation expireOperation in the same synchronous transaction, with a durable UNKNOWN state and lateObservation if the deadline passed. Throw stale/retired errors *after* the transaction, never roll back reconciliation. Legacy/other routes preserve global expiry/alarms.
- Added distinct expired terminal reply test: time-shift one DISPATCHED operation into the past in offline-only fixture, deliver a late SUCCEEDED observation, verify phase remains UNKNOWN/effect UNKNOWN and lateObservation equals original bytes. Preserve old late RUNNING and F05 image revocation tests.
### R04 ordinary terminal Activity null-overlay optimization

- Exact-head 5469b81 passed offline CI; native lifecycle **201 SQL reads / 57 writes**. Direct v2 RUNNING acknowledgment reduced its Workspace stage from 20 reads to 15 while preserving late-dispatch UNKNOWN records.
- RegistryIndex.sync currently calls CanonicalActivity.setNotice(null) for every immutable successful/known terminal notice. Such receipts never have a `UNKNOWN`/`PARTIAL` overlay; this re-reads Activity metadata and entry without changing state. Skip only the no-op for nonuncertain notices; retain all uncertain overlay creation, resolution updates, tombstone cleanup, and full Activity correctness.
- Verify against existing Activity native/legacy migration and image-revocation tests plus exact native cost benchmark. Record actual read reduction, not inferred savings.
### R04 v2 RUNNING exact-expiry fast path (2026-11-28)

- Native 6a1012 CI 46104277932 passed all offline checks and measured **206 SQL reads / 57 writes** for the equivalent full read lifecycle; generic MCP auth skip saved 12 reads, and synchronous nonimage result recheck skip saved 7 more. The asynchronous image pixel recheck and F05 late-revocation test remain intact.
- Profiled v2 RUNNING acknowledgment repeatedly scans unrelated operation/maintenance due indexes, even though this acknowledgment cannot itself perform effects and the regular poll, heartbeat, terminal and durable alarm perform bounded global cleanup. Fastpath only for v2 RUNNING; preserve legacy, terminal and all other routes.
- On direct RUNNING, verify the exact active lease and operation identity *before* state changes, and expire this exact record under transactionSync. If its deadline already passed, commit a truthful UNKNOWN/REJECTED receipt, then reject the stale acknowledgment *outside* the transaction. Never throw inside transactionSync after mutating expiry or it would roll back the evidence.
- Regression: real Miniflare/native operation lifecycle, scoped status, measured SQL read reduction, test-only time-travel injection of a DISPATCHED operation deadline, stale reply rejection and durable UNKNOWN status. Test-only injection route exists solely in the offline optimization fixture; none of its hooks are packaged into the Worker.
### R04 synchronous status read-cost reduction (2026-11-28)

- `3a668b7` CI 46104037084 passed offline regression and measured native 213 SQL reads / 57 writes for an identical read lifecycle (12 reads fewer than baseline 225/57). Admission and status each omit one redundant generic Registry authorization; the precise Target/Grant ACL remains authoritative. Image revocation fault-injection after hydration passed.
- Non-image status and cancellation currently perform a second Registry auth after the first successful Target ACL despite no asynchronous boundary in between. Identify image-tool types from one canonical `isImageTransferTool` predicate; retain async hydrate and *late* Registry recheck for all image tool results. Synchronous read/write/compute/other status and cancellation still check their Grant exactly once immediately before materializing the scoped result.
- Keep the original image/revocation fault-injection, stale Binding/Grant/Target, late operator recovery, and operation_status/cancel tests. Require exact-head native and legacy benchmark before marking a read reduction; any result leak or test failure must be fixed or reverted.
### R04 cloned-body oversize rejection (2026-11-28)

- CI on f30ca88 showed a bounded JSON classifier unit hanging with an oversized cloned Request body. Root cause: parseBody awaits reader.cancel() on a clone tee whose sibling body is not consumed. Implement nonblocking cancellation on the >512 KiB error branch, preserving immediate 413 behavior and never treating oversized input as a valid scoped tool call.
- Add a bounded wall-clock regression test for invalid/oversized request shapes so a hung reader cannot cancel the whole test subprocess silently. Existing F05 late-revocation image test passed in the same run; do not change its post-hydration Grant recheck.
### R04 48027bd fault-injection correction

- CI 46103447198 found a test packaging error: the pure unit classifier imported the Cloudflare Worker entrypoint under Node. Move the same bounded classifier to pure `mcp-scope.ts` and retain it as an index.ts dependency. No runtime authority changes.
- F05 image-transfer late-revocation probe was configured for five auth checks including the now-removed duplicate generic ingress check. The safe v2 path has four: exact Target, Workspace status, image read, and post-hydration result ACL. Re-arm at check four and independently verify no pixel disclosure after revocation. Never relax the late-recheck or disable the fault-injection assertion.
- Do not claim a read reduction until same-denominator CI benchmark demonstrates it. Roll back scoped skip on any ACL regression.
### R04 targeted double-authorization elimination (2026-11-28)

- Detailed exact-head SQL profile run 46102908402: the Registry receives multiple /internal/authorize RPCs per valid MCP call. The outer mcp() performs a generic Grant check; the v2 tools/call handler performs a second fresh, Target-specific authorization. There is no operator/provider effect between these two checks. The second specific check remains mandatory.
- For a bounded and schema-valid v2 tools/call only when the v2 execution flag is enabled, skip the redundant generic precheck. The inner handler still checks current Grant, revocation, exact audience, permission ceiling, Target, and (for discovery) Connector-owned Workspace index. Tools/list, invalid or oversized JSON, other methods and disabled rollout keep original generic precheck.
- Request cloning is bounded to <=512 KiB, does not consume the actual MCP request stream, and does not cache authorization across requests. Security regression: suspend and revoke must deny tool calls; tools/list and malformed tools must return 403. Equal-denominator benchmark must measure SQL changes before claiming a reduced cost.
- This is a scoped read-cost optimization only, not a removal of fresh Registry authorization or a replacement for effect permits. If the test reveals lost HTTP error semantics, revert and investigate another approach.
### R04 forensic SQL-cost profiling (2026-11-28)

- Authoritative native lifecycle at 282ecef: **225 reads / 57 writes** vs <=120/40. Registry 97/27, Workspace 128/30 across admission, poll, RUNNING, terminal and status. This is synthetic gateway lifecycle, not provider billing.
- Before storage rewrites, add opt-in SQL_TELEMETRY_DETAIL_ENABLED sampled query-shape fingerprints, SQL table and allowlisted key-kind to bounded telemetry. Never log SQL parameters, credentials, generator IDs or source text. Disabled mode must produce zero output.
- Enable profiling only for the native offline benchmark; retain unprofiled legacy comparator. Use exact-head CI to identify dominant query families. Change only measured paths; preserve rollback behavior and fail-closed replay, revocation, Target, lease and terminal receipts.
- This checkpoint is instrumentation, NOT a performance fix or release acceptance. Do not assert <=120/40 until equal-denominator measured lifecycle passes.
### R05 exact-head release audit

1. Read all four atomic requirement matrices mechanically. Validate unique IDs, legal statuses, structural completeness, and that no PASS carries pending or missing verification evidence. Export a deterministic JSON inventory with every unresolved clause. Treat `--strict` as release-blocking until the requirements actually qualify; do not fill gaps by assumption.
2. Complete F18 expired OAuth approval state (visible, disabled with recovery instruction), local table counts/no-match behavior, and ordinary v1/retained v2 UX regression tests. Ensure UI mutation buttons remain disabled under stale authority, hidden document, expired approval, and changed credential pairing.
3. Retain complete historical Resource archives and v1 compatibility without activating the deprecated Library in v2. No production endpoint, account, generator, or tunnel operation.
4. Rebuild exact head with strict TypeScript, locked tests, both native and legacy measured benchmarks, package hashes, offline worker dry-run. Publish unmerged PR with explicit failures and four OWNER-only gates. Verify source and generated TXT/JS checksums match.
5. Normative limitations remain explicit: capture of actual unsaved preview pixels lacks qualified browser surface, ordinary native full lifecycle measured 225 SQL reads/57 writes vs required <=120/40, and 1,196 atomic clauses still had NOT_STARTED at the last baseline. Reconcile individual rows with concrete evidence, never mass-mark PASS.

## V00–V10 development contract (2026-11-27)

Starting point: `main` at `9524583b04e480875011f3675a581357afe315c3`, tree `1179db13df0112c15f7e7942dca198e7d0486dbe`, equal to the merged v0.2.0 qualification head `3fd1e48630737a1defd96484a3af3d3d881c84a1`. The working branch is `development/v0.3.0`. Use local synthetic fixtures and local workerd. Production and preview calls, deployment, real browser/provider tests, production readiness dispatch and merging are operator-only.

### V00 plan and verification

1. Verify the actual base, PR #23, qualification run and workflow triggers. Use the v0.2.0 runtime/contracts and generated catalog as the inventory source.
2. Bring the accepted v0.3 implementation contract into repository authority and mark earlier Helper parity and Resource implementation documents as historical. Publish complete per-tool disposition, permission changes and baseline source boundaries, including retention/export obligations.
3. Establish the phase and evidence ledger. Re-run the locked baseline suite and representative local v0.2 benchmark if available, and record measured differences or exact reproduction blockers. Preserve the full historical evidence.
4. Check document links, catalog/permission coverage and unchanged runtime. Commit the verified authority amendment before v2 runtime work. Keep v2 admission gated until the migration, version skew and activation checks pass.

| Phase | Depends on | Exit gate | Status |
|---|---|---|---|
| V00 | v0.2.0 | Baseline, authority amendment, full disposition, offline reproduction or explicit gap | Verified locally |
| V01 | V00 | Connector-level Grant, strict version coexistence, indexed discovery and explicit Target | Foundation and local SDK catalog verified; rollout gated |
| V02 | V01 | Durable fenced transition, exact management receipts and original-scope result ACL | Gateway and manager basic paths verified |
| V03 | V02 | Binding-isolated store, epoch-safe recovery, verified checkpoints and bounded GC | Core and lease integration verified; exact operator quarantine export verified |
| V04 | V03 | Five filesystem tools with targeted reads, exact preconditions and large transfer | Filesystem and scoped wire paths verified in local fixtures |
| V05 | V04 | Typed batch, Operation keys, isolated staged compute, retrieval and result delivery | Scoped execution and grouped publication verified; retrieval and fault coverage incomplete |
| V06 | V05 | Preview freshness, diagnostics, viewport, actual-pixel feasibility and verified Save | Offline branches verified; OWNER capture and provider gates open |
| V07 | V01–V06 | Exact v2 catalog, archive/export compatibility, retirement and agent knowledge | v2 catalog and knowledge verified; compatibility retirement deferred |
| V08 | V02–V07 | Manager, compatible migration/rollback and one-click rebind | Bundled manager and upgrade verified; OWNER rollout deferred |
| V09 | V01–V08 | Native/legacy workload, capacity, OAuth and fault measurements | Benchmarks recorded; lifecycle target missed |
| V10 | V00–V09 | Exact-head offline qualification, artifacts and unmerged PR | Exact-head qualification in release outputs |

### V00 evidence

- Matching merge and tested trees were verified against GitHub main, PR #23 and offline workflow run [46029453050](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46029453050). The production readiness workflow is main-only or manual. The pull-request workflow is offline and checks exact head. Operator confirmation is the evidence for disabled Cloudflare previews.
- Locked install and local typecheck succeeded. Baseline offline suite passed 553 of 553 with Node 24.22.3 and npm 11.19.1. Both clean-source Miniflare benchmark runs reproduced the measured v0.2.0 SQL rows. The native mode measured 177–182 reads and 51–52 writes. Legacy mode measured 232–255 reads and 78–87 writes. See [raw replay evidence](docs/verification/v0.3-baseline/).
- The v0.3 contract and [tool disposition](docs/v0.3/TOOL-DISPOSITION.md) supersede full Helper parity. Retirement preserves legacy/canonical readers and unsettled evidence. This checkpoint changes documentation only.

### V01 plan

- Define a strict shared Target, versioned Grant and explicit permission-ceiling fields. Require canonical Target encoding, checked generations and exact Connector/client/audience/credential epoch.
- Keep existing v1 tokens and OAuth approval semantics for unchanged fixed assignments. Build a gated v2 Connector consent and scoped discovery path over a bounded, transactionally maintained assignment index. Exercise empty, paused and offline discovery, denied foreign Targets and stale owned Targets, with loopback tests.
- Do not expose the new public catalog or dispatch v2 effects while any implementation dependency remains open. Preserve current core markers and use a separately tested schema fence where v2 authority is written.

### V01 evidence

- Locked baseline dependencies, strict typecheck, and 555 of 555 offline tests passed. Local workerd fixtures verify one Connector with two assigned slots, an independent Connector, empty discovery, exact audience and client checks, foreign/stale Target denial, cursor scope, legacy continuation and real SDK PKCE consent. Public v2 tool listing remains disabled until the catalog and execution path are complete.
- New assignment authority is explicit core schema 3 with an assignment marker. The v0.2 Registry rejects schema 3. Compatible readers retain canonical Activity and Resource markers. OAuth approval listings omit sealed callback URLs, which can contain authorization codes.

### V02 plan

- Use persisted Registry transition intent and exact management receipt. Check operator CAS, canonical native identity, installation proof and old draft acknowledgement. Change Binding/Assignment generations and indexed ownership in one transaction only after Workspace settlement.
- Freeze old admissions/dispatch at Registry and persist a Workspace admission fence. Queue cancellation must prove no dispatch. Active effect, unresolved notice or pending receipt holds the transition. Renew/reply and claim must not transfer an old lease.
- Authorize v2 result and cancel by exact initiating Grant and Target with current tool permissions, independent of browser lease. Test replay, stale revisions, stale scopes, cross-Connector denial, and delayed dispatch in local workerd. Keep catalog disabled.

### V02 evidence

- The Registry persists the transition before checking the Workspace journal. The Workspace fences admissions/dispatched work, cancels proven undispatched queue entries and drains terminal receipts. The Registry rechecks authority and publishes the new generations, owner index and exact receipt together.
- Focused typecheck and 14 offline tests passed, including local workerd coverage for dirty acknowledgement, duplicate claims, old adapter rejection, a transition blocked by dispatched work, exact Grant result access, stale Target/lease rejection, replay and transfer.
- The gateway issues a short-lived installation-authenticated destination proof. Userscript manager integration, in-flight UI and full version-skew acceptance remain V08 work. V2 MCP ingress stays gated.

### V03 plan

- Derive a private namespace from installation, Workspace, assignment, Binding and exact native identity. Use separate epoch writers and retain legacy Workspace-only records for operator quarantine.
- Store checkpoint and local file bytes as verified content-addressed chunks. Persist staged roots before the pointer, verify readback, protect active/held roots and enforce physical capacity. Test exact binary bytes, deduplication, partial persistence, stale epoch and bounded cleanup.
- Integrate lease-based opening, scope operation receipts, and preserve exact offline recovery paths. Do not admit a v2 operation through a legacy local namespace.

### V03 evidence

- Scoped store uses exact Binding and independent Epoch namespaces. Checkpoints deduplicate content-addressed chunks within an Epoch. Mutable pointers are read back and uncertain publication roots remain reachable. Same-Binding reconnect copies the prior verified local manifest only after earlier local journals and publication records are settled. Untagged v0.2 bytes stay quarantined.
- Strict typecheck and 72 focused offline tests passed, including exact binary/empty files, lost pointer acknowledgement, stale writer fence, physical budget, staged-root retention and the 32-chunk GC cap. The controller claims a matching adapter version and opens the scoped store before polling. Operator archive presentation and cross-epoch recovery UI remain integration work.

### V04 plan

- Add strict v2 filesystem schemas, metadata-only manifest and selected-byte native view. Verify PJS/HTML reads and listings avoid unrelated src content. Return bounded byte/line continuations and scope cursors to query and manifest.
- Apply exact preconditions and complete path/collision preflight to write, delete and rename. Use retained native verification and checkpoints where no native CAS exists. Scope binary transfer stage and completeness to the initiating Grant and current Target.
- Exercise same-byte-size changes, invalid UTF-8, exact binary and empty bytes, metadata pagination and partial outcomes using synthetic native interfaces. Integrate the shared catalog only after V05–V07.

### V04 evidence

- Typecheck and eight focused tests passed. A synthetic native fixture with 100 src files observed zero src content reads for panel reads and metadata listing, and exactly four content reads for two requested src files. Same-size manual edits invalidate a digest continuation. Invalid UTF-8, long lines, zero bytes, exact preflight, rename and scoped staged binary commit each have a focused fixture.
- Native mutation still uses full independent verification because the supported interface exposes no comprehensive generation or CAS. V2 MCP dispatch and chained batch publications remain gated until end-to-end integration.

### V05 plan

- Add timestamp-bounded Operation keys with exact scope, digest and retained receipt. Persist them atomically with admission, check retained keys first, and require exact authorization at status/result delivery. Carry versioned tool envelopes and deny legacy child-tool calls for v2.
- Define the closed batch union and preflight all nested inputs before execution. Preserve declared-action receipts and partial effects. Isolate QuickJS read views and staged publication, then integrate restricted GET/POST and verified public import snapshots.
- Exercise lost-response replay, altered digest/Grant, expired key, cancellation, permissions and result projection with local workerd. Keep the gated rollout until all 19 tool definitions and compatibility tests are ready.

### V05 evidence

- Six focused tests and typecheck passed. Workerd validates one-use segments, exact Operation key replay/conflict, key expiry and status lookup, and the local OAuth/MCP v2 tool list of 19 names. QuickJS ran 100 reads with one read-view permit. A denied publication left scratch unchanged. The batch fixture validates the entire shape before effects and preserves completed steps after a later failure.
- A separate execution flag keeps the public v2 catalog opt-in. The waitMs delivery option currently returns the durable handle without waiting. Adjacent general mutation coalescing, public retrieval fault coverage and expanded bundled browser integration were addressed in V09. Provider-specific retrieval fault coverage remains open.

### V06 plan

- Use native source revision for preview and Save. Invalidate applied preview proof on iframe load/replacement or failed refresh. Verify preview epoch, requested freshness and actual viewport geometry, and bound diagnostic entries.
- Review documented Violentmonkey and Firefox capture capabilities without opening a real browser session. Keep unavailable capture explicit if exact preview-surface proof cannot be established.
- Require intended native revision, exact independent saved base, fresh authorized dispatch, durable local Save intent and independent persisted-source readback. Test synthetic stale and uncertain cases while preserving the operator-only native provider gate.

### V06 evidence

- Typecheck and 76 focused tests passed. A frame load and failed refresh clear prior applied proof. Native Save is fenced to the native draft and independently verified saved base. It retains a hold on uncertainty. Capture returns UNSUPPORTED_INTERFACE before opening any capture surface.
- CAPTURE.md records the documented platform limit and evidence required for OWNER-03. Real source, preview and Save remain DEFERRED_OWNER under OWNER-01. No native pixels, actual provider writes or real client render were exercised.

### V07 plan

- Package the 11 checked-in skills, reference and advisory workflow with standalone Markdown install/use guidance and generated exact runtime tool schemas.
- Gate all public v2 calls by the 19-tool catalog. Keep unchanged legacy Grant readers and operator Resource archive/export. Verify v2 denials and document what must remain during compatibility rollout.
- Verify package hashes, provenance and standalone file counts. Treat retirement of compatibility v1 runtime and remaining operator end-to-end automation as separate release gates until verified.

### V07 evidence

- The v2 MCP catalog is limited to the 19 generated schemas. Resource/media methods are excluded for v2 callers. Legacy fixed-scope Grant compatibility and operator Resource archive/export retain their existing authority and records.
- The knowledge package builds exact schema JSON, Markdown tool reference and examples, eleven repository skill files, local instructions, advisory workflow and manifest SHA-256 digests. Local package verification exercised the Worker health and all inner/external digests. The intermediate package was dirty and was used only to verify packaging mechanics.
- Legacy Resource and paid-media implementations remain for staged v1 compatibility. Do not purge or retire recovery data during v2 preparation. Physical legacy runtime and dependency retirement is still open.

### V08 plan

- Expose a v2 Workspaces and Connectors view only when the gateway reports an explicit compatible assignment contract. Preserve exact previous and intended Binding, native-ready proof, management CAS and idempotent receipt recovery.
- Keep one click for a clean or unbound Workspace. Require acknowledgement when old draft state is dirty or unknown. Separate assign/rebind, reconnect, pause, detach and transfer.
- Use the current rendered generation to suppress stale manager responses, and keep conflicts or unresolved effects visible. Test the bundled synthetic UI and document the migration and rollback gates.

### V08 evidence

- Typecheck and 37 focused tests passed. The bundled manager rendered 30 Workspaces in a synthetic document, displayed the v2 navigation, and issued one clean rebind before reconnecting. The real local Worker verified same-endpoint v1 upgrade, v1 token denial and new SDK consent. New tab proof and segment routes pass the actual userscript transport allowlist.
- The operator migration document covers retained data, pause, version skew, fresh consent and compatible-only rollback. Real Firefox interaction and production verification remain DEFERRED_OWNER. Legacy upgrade requires new consent after the fixed-scope Grant fence commits.

### V09 plan

- Measure v2 production SDK ingress and private dispatch lifecycle in local workerd with metered SQL, Worker/DO, alarm and KV usage. Compare legacy/native with the v0.2 replay and use the actual workload denominator when projecting traffic.
- Run discovery at multiple Connector and Workspace counts, and report exact target-versus-measured status. Retain the current OAuth TTL and disabled admission estimate if the full budget and interoperability trade-offs remain unverified.
- Record raw measurements, account quota assumptions, nondeterministic timing and owner-only billing/hibernation evidence. Results remain local observations.

### V09 evidence

- Clean workerd replays recorded 12 measurements each for native and legacy storage. Native full read uses 225–227 SQL reads and 53–57 writes. Legacy uses 280–300 reads and 80–89 writes. The 120/40 goal is unmet. The ten-file write uses 90% fewer rows than ten separate lifecycles in both modes. Indexed discovery has no SQL writes at 1–50 assigned Workspaces.
- The pinned SDK passed five local refresh rotations at two KV puts per rotation. The capacity report models alternate TTLs and retains the 900 s default. These measurements do not establish actual account-wide billing or physical browser hibernation behavior. No optional admission estimates were enabled.
- Coherent adjacent write/delete/rename staging and explicit previous-step base have focused fixture coverage. The final exact-tree qualification follows the V10 plan.

### V10 plan

- Qualify the clean remote PR-head tree with locked install, strict typecheck, full offline tests, clean artifact build, exact digest verification and local Wrangler dry-run only.
- Package matching userscript TXT/JS, Worker, source, candidate, agent knowledge, release metadata and checksums. Preserve historical v0.2 evidence and release gates.
- Publish the unmerged development PR with exact head and acceptance matrix. Distinguish owner-only gates and remaining offline evidence gaps. No production, preview, deployment or merge.
- First exact-head suite found a v1 cancellation regression while dispatch authorization awaited. Preserve the v1 cancellation during ADMITTED state and the v2 cooperative signal semantics. Rerun the full exact-head suite and reissue artifacts after the fix.

## Historical v0.1–v0.2.0 implementation ledger

Status: executable verification candidate implemented. Local static/unit/emulator/rendered tests and packaging are in place; full product acceptance remains blocked by the explicitly listed real-browser/cloud/provider gates. No production deployment or live provider mutation has occurred.

| Phase | Dependency | Deliverable / exit criteria | Status |
|---|---|---|---|
| P00 | — | Client spec, architecture, tool parity, evidence, setup, verification and governance | Complete (design documents only) |
| P01 | P00 | Firefox/Violentmonkey disposable diagnostic userscript; feature-detect editor/src/draft/preview/native Save and frame boundaries; F01/F02/F04/F05 evidence; read-only first then authorized disposable tests | Candidate + current public native audit; T3 open |
| P02 | P00 | Minimal deployable Worker OAuth/Registry/Workspace transport; clean dashboard setup; two named web connectors isolated; current/legacy MCP; F03/F08 | Implemented; local current/legacy OAuth/MCP verified; T4 open |
| P03 | P01/P02 | Shared contracts + strict schemas + typed adapters; state machines, fencing, authorization, error mapping, local emulator, deterministic tests | Implemented and locally verified contracts/state boundaries |
| P04 | P03 | Core VFS, source tools, scratch/imports, revision checks, checkpoint/restore; native draft preserving | Implemented and locally verified; native T3 open |
| P05 | P04 | Preview/eval/refresh/diagnostics/viewport/capture; isolated compute, bounded fetch; F05/F06 | Isolated compute/fetch and native preview candidate verified locally; pixels/T3 open |
| P06 | P04 | Native save, generator lifecycle, upload, independent verification, unknown effect reconciliation; disposable tests | Gated Save/lifecycle/upload candidates; creation and live outcomes open |
| P07 | P03 | Resource registry/editor/import/export/version/diff/assignment; bundled eleven domain skills and provider-neutral workflows; synthetic optional import fixtures, tool-only delivery | Implemented and locally verified; deployed/client T4 open |
| P08 | P05/P06 | Image/music, authorized production state backup/restore/emulator, artifacts; F07/F08, record unresolved parity | Media/artifact candidates implemented; real output and production-state parity open |
| P09 | P04/P07 | Full manager UI setup wizard, OAuth management, diagnostics, backup/restore, pause/rebind/kill, accessibility | Implemented; actual Chromium layout/keyboard + local Worker verified; Firefox/T4 open |
| P10 | P05–P09 | Security, concurrency, fault injection, interoperability, upgrades, quotas and real end-to-end acceptance; F09 | Local security/recovery/concurrency and 30-minute T2 soak verified; external gates open |
| P11 | P10 | Release .user.js and .txt, Worker deployment package, verified dashboard walkthrough, parity report, rollback guide | Verification-candidate artifacts prepared; full release blocked |

P01 and P02 may proceed independently. No production feature activation before relevant feasibility gates. P08 may investigate early without blocking core progress; full parity release still blocked by unresolved mandatory capabilities. No live browser or cloud deployment conducted for P00.

## Current blockers
- Need real Firefox manager and disposable generator tests (F01/F02/F04/F05).
- Need deployment/connector interoperability proof (F03/F08).
- Need authorized real image/music output and arbitrary production server-state parity (F07). Optional fixed public/paid adapters are implemented without unauthorized inference calls.
- Historical exports remain private; the original authored skill library, adapter reference and synthetic fixtures are checked in. No external attachment dependency.
- Candidate executables/deployment package now build. Full release remains blocked; see docs/RELEASE_VERIFICATION.md.

## Intended repository layout
apps/gateway (Worker + DO + OAuth), apps/userscript (top controller, frame executor, native adapter, UI, local VFS), packages/contracts (schemas and types), packages/resources (our original defaults), tests/{unit,integration,fixtures,e2e}, docs, scripts (build/package/deploy validation). Single workspace package manager lockfile. Actual packages/scaffold created in P01–P03 with tested dependencies, no fake runtime.

## P00 evidence checkpoint
- Initial repository was empty. Initialized main and committed the design baseline and protocol supplement.
- Archive integrity and SHA-256 checked locally; relevant platform documents, original tool schemas, skill export manifest and selected captured frontend source inspected. Public primary-source MCP and Cloudflare docs consulted.
- No CI triggered, no production code, no live provider mutation, no deploy performed. P01/P02 are the next eligible feasibility phases.

## P00 handoff amendment
Operator selected Violentmonkey, and requested a standalone coding handoff. Read docs/HANDOFF.md and the checked-in implementation references. All phases may be planned from repository alone. P01/P02 still require real environments for final proof; implement test harnesses and other independently eligible work without waiting for owner attachments. Unresolved authorized media/state integrations are parity blockers, not missing input files.

## Implementation session — 2026-11-26

Remote baseline: main `9b018fb44423b8d00e1ec90afebb0a9b42da6c9e`; only main exists, no PRs or Actions runs. All required handoff files and default fixtures inspected. Runtime work uses `implement/runtime`; no production mutations/deployment authorized or attempted.

### Active P01/P02 plan
- Build a read-only native capability probe and injectable native adapter with deterministic editor/draft/src fixtures; record unsupported live interfaces explicitly.
- Build gateway using pinned official OAuth/MCP implementations, SQLite Durable Objects, isolated assignments, management credential pairing, grant revocation, fenced tab leases and durable operations.
- Run local positive/negative and emulator tests before any external enablement. Browser feature detection must not infer live verification.
- Independent contract/schema, resource and manager modules may be implemented alongside these feasibility harnesses; their higher-tier acceptance remains pending.
- Test dependencies are pinned in one lockfile. Production writes remain gated until their native proof gates pass. Preserve full product requirements when reporting unavailable capabilities.

Historical planning checkpoint: P01/P02 were still in progress at this point. The phase table above and final verification checkpoint below now describe the candidate; external acceptance gates remain open.

## Candidate integration plans and evidence — 2026-11-26

The following independently achievable slices were implemented alongside the P01/P02 feasibility work. These statuses do not satisfy external dependency acceptance by themselves. Each remaining integration step below is bounded and must be verified before its status changes.

| Phase | Implemented slice | Integration/verification plan and remaining gate |
|---|---|---|
| P01 | Read-only installed manager probe, native source adapter, current public native guard detection | Check pure native guard/draft/access interfaces, retain read-only use when unknown; complete real Firefox/Violentmonkey and disposable fixture proof. |
| P02 | Official OAuth/MCP gateway, SQLite Registry/Workspace, pairing, management, lease polling, durable handles | Verify current published profiles, exact resource isolation/revocation, dashboard package dry-run; deployed clean-account/real connector evidence stays pending. |
| P03 | 52 strict tool contracts, permission ceilings, schemas and typed error/state envelopes | Run schema boundary/security tests and actual controller→local Worker integration; freeze effective Grant intersection for composed calls. |
| P04 | Complete source/scratch/binary tools, exact patch preflight, safe regex/parser, imports, checkpoints/recovery | Run default/nondefault draft and manual-edit/partial-effect/BOM fixtures; preserve exact bytes and unresolved history. Real native semantics require T3. |
| P05 | Actual native preview protocol candidate, isolated QuickJS Worker and allowlisted public fetch | Verify worker isolation/termination/child permits, source/preview generation fencing and actual protocol-shaped fixtures; real pixel capture/source lint remain open. |
| P06 | Gated Save/lifecycle candidates and exact independent complete saved-source reader | Exercise lost receipt/stale/empty/binary/owner/listing/delete cases; qualify actual creation/upload/native effects only in authorized disposable provider environment. |
| P07 | Versioned scoped Resource library, safe ZIP preflight/import/export and expanded eleven original skills | Verify seed preservation, ACL/history/CAS, hostile imports, paged tool-only delivery and real local Worker manager journeys. |
| P08 | Optional paid music adapter and durable scoped chunk handler; public media investigation | Integrate bounded browser artifact download/decoding/revision commit and no-replay recovery. No paid call authorized/executed; production-state/general screenshot parity remains blocked. |
| P09 | Complete manager setup, Workspaces/Agents/OAuth, Library, Activity, Settings/recovery | Connect actual transport/controller, separate source/settings restore, trusted fetch hosts, explicit UNKNOWN resolution; verify keyboard/focus/failed-save cases. Synthetic Chromium rendering now passes; native Firefox proof remains missing. |
| P10 | Cross-boundary security review, 1/5/10/20 synthetic concurrency, fault/recovery fixtures | Run final complete suite, dry-run packaged Worker, and 30-minute 20-Workspace local soak. Do not infer deployed quotas/browser memory from local metrics. |
| P11 | Reproducible single-script/TXT + deployment/candidate ZIP packaging | Verify build startup, identical mirrors, package manifests/checksums, operator instructions and acceptance gaps; publish only a verification candidate until all mandatory gates pass. |

Verified checkpoints include contracts `1bb0107`, Resource library `8b47387`/`9dc30fd`, manager `6e0398c`/`324d816`, source `dba7226`/`6c34525`, isolated compute `5b629e2`, native preview protocol `1c0986d`, gateway `8755a8a`, paid media journal `1e2fc5b`, and browser controller `4d0b691` (local commit identifiers; remote checkpoint commits may aggregate equivalent trees).

The full suite reached 194 tests with one integration assertion failure caused by the new metadata-only Resource catalog. The test had compared detailed metadata to an intentionally omitted catalog field; the corrected test fetches full canonical detail and asserts exact body/metadata preservation (`b191ae9`). The focused genuine local Worker manager journey passes. Final aggregate results will follow; no failed run is described as passed.

Current external proof limits: Firefox connector calls failed internally; local Chromium binary missing; official browser download403; cloud browser cannot reach local fixture. No production deployment, native account mutation, native Helper session, CAPTCHA bypass or paid inference occurred. Real Firefox/Cloudflare/web-client/provider gates remain open. Candidate instructions: docs/INSTALLATION.md, CONNECTORS.md, RECOVERY.md and RELEASE_VERIFICATION.md.

### Final image and retention integration plan
- Replace oversized inline image payloads with operation-scoped, digest-verified chunks; hydrate standard MCP image content only after current Agent/binding authorization.
- Schedule physical deletion of terminal result bodies and retained image/music bytes at their ten-minute expiry, including idle Workspaces. Preserve uncertain operation metadata for reconciliation.
- Normalize generated images through the same bounded image renderer; retain committed source effects if later display transfer fails.
- Run targeted boundary tests, complete local checks, rendered manager checks, packaged Worker dry-run and deterministic archive verification before the final GitHub checkpoint.

### Final local verification checkpoint — 2026-11-26
- `npm run check`: 263 unit/integration tests passed, zero failed/skipped; strict typecheck, build and packaged archive/Worker checks passed.
- Actual installed Chromium 158 synthetic manager: all five tabs at 1024×768 and 1920×1080, keyboard/focus/resize, expanded long text and native editing after close passed. No screenshots or private data are required to resume.
- Actual browser image normalization: original alpha pixel `[255,0,0,128]` preserved; locally generated noisy 1024×1024 PNG (3,608,592 bytes) reduced to 512×512 / 871,856 bytes; malformed bytes rejected. This is local pixel evidence, not a provider screenshot or media-output claim.
- Packaged Cloudflare dry-run passed with Wrangler 4.168.0; 1,574.26 KiB raw / 332.54 KiB gzip. No deployment or Actions run performed.
- Image transport: 14 focused tests pass, including a 768 KiB actual local SQLite route, exact standard MCP image blocks, policy revocation, integrity, concurrency, budgets, scope and expiry.
- Physical result/image/music cleanup is scheduled for idle Workspaces; unresolved operation metadata remains available. Rebinding/detach cannot abandon consumed permits; recovered credentials retain an inert binding only for reconciliation.
- Evidence: docs/verification/local-results-20261126.json and linked detailed records. Historical soak: 6,120 operations / 0 failures over 30 minutes and 20 Workspaces; exact final bundle provenance is not available for that run.
- All independently implementable candidate integration and packaging work is complete. Full release remains blocked by the unchanged A01–A14 external/native/provider outcomes in docs/RELEASE_VERIFICATION.md; the next phase is authorized disposable qualification, not a claim of completed parity.

### Live ChatGPT OAuth/Cloudflare remediation — 2026-11-26

- Incident: After attaching `aleph-alpha`, ChatGPT's exact OAuth approval appeared too late in Agents. Live browser then returned `GATEWAY_UNAVAILABLE` and `SCOPE_DENIED: Origin is not allowed` during setup.
- Root causes: blanket Worker CORS/origin restriction applied to public OAuth/MCP routes; costly Resource-library loading on ordinary admin GET; manual-only approval list refresh coupled to unrelated Grants failures; early Continue discarded the HTML form; retries lacked clear read-only separation.
- Remediation: allow exact ChatGPT origins solely on public OAuth/MCP endpoints, leave privileged admin/tab routes origin-restricted, eliminate unnecessary Resource-library coupling, auto-refresh pending approvals serially every four seconds, preserve a retryable early-Continue form, provide explicit expiration instructions, bound GET-only network retry with unchanged POST/long-poll timeouts, and verify v0.1.2 delivery.
- Evidence: new real local Worker OAuth/PKCE flow with `Origin: https://chatgpt.com`, private-route CORS denial tests, browser manager auto-approval regression despite Grants failure, transport no-mutation-replay test, full TypeScript/test/build/checksum/Wrangler dry-run in GitHub Actions, independent Chromium synthetic UI click workflow on generated v0.1.2 artifact. Keep precise CI SHA and output checksums in final PR report.
- Still external/unverified: actual Cloudflare redeployment into operator's account and its current `/health` version; live Firefox/Violentmonkey/ChatGPT OAuth retry; existing provider/native mutation gates. Do not mark these as passed without real evidence.

### Live OAuth form completion and diagnostics remediation — 2026-11-26

- Verified root cause: gateway's `Referrer-Policy: no-referrer` changes form navigation `Origin` to `null`; global `allowedOrigin` and `/authorize/complete` reject the browser despite approved Registry state. MDN Referrer-Policy docs confirm. Root-cause fix adjusts only authorization form policy plus narrow privacy-mode fallback; preserves opaque handle and PKCE/Grant security.
- OAuth diagnostic export previously contained an empty MCP Activity array (~39 bytes) by design; no OAuth trace. Separate read-only report includes bounded gateway OAuth audit, transport failures/latencies, health, schema/version and server errors by trace ID. No credentials, code, source, request body, raw URL or raw Origin stored.
- Verification: exact null-Origin and hostile/cross-site Completion paths in local Worker OAuth flow; diagnostic ring and secret exclusion; offline report; complete strict typecheck, tests, artifact hashes, Worker dry-run and real compiled-userscript UI smoke. Live deployed Firefox/ChatGPT account gate remains external until operator confirms.

### OAuth redirect recovery (2026-11-26)

- Live v0.1.3 diagnostics showed POST /authorize/complete 302 then subsequent consumed POST 200, no observed /token request, and several local transport failures while PersonaMonkey was enabled; user observed improvement with PersonaMonkey disabled. Prevent interpreting gateway 302 as complete client authorization.
- Root-cause repair: persisted sealed callback behind original 256-bit handle and original expiry, exact callback URI defense-in-depth, no second grant/code upon retry; manual script-free fallback navigation for blocked redirects; fail-closed revocation for incomplete code issuance, expired and revoked checks; distinguish redirect issued, fallback and token exchange in redacted audit.
- Required verification: local full OAuth PKCE + blocked-redirect replay integration, hostile handle replay rejection, identical grants before/after replay, no secret logging, browser fallback link navigation, typecheck, tests, build, artifact hash, Wrangler dry-run; only then merge. Live LibreWolf+PersonaMonkey routing and ChatGPT consent callback cannot be asserted from synthetic tests.

### Browser bridge liveness and Grant UI incident — 2026-11-26 (userscript v0.1.5)

- Report: Cloudflare v0.1.4 OAuth connected to ChatGPT, 52 tools and library operational, but all browser tools returned `TAB_OFFLINE`. Manager showed Workspace Active alongside local offline. Grant revoke appeared inert.
- Confirmed: idle Worker long poll holds 25s; userscript non-signaled POST abort incorrectly hardcoded at 15s; controller never retries/reconciles transient poll or heartbeat failure and startup does not reconnect a still-exact bound editor after reload. Grant revocation did not require local confirmation/readback or show a clear terminal outcome.
- Code changes: 30s normal POST timeout in both branches; 45s tab poll, same-lease bounded retry/backoff, degraded state and diagnostic signal, nonfatal transient heartbeat, local exact-binding startup/BFCache reconnect without takeover, scoped operator Stop marker; inline Grant confirmation and authoritative verification/no replay.
- Test gates: strict TypeScript, full unit and local Miniflare/manager integration suite; actual transport signal budgets, poll recovery with same lease, revoked heartbeat fail-closed, native identity matching ambiguity, unknown Grant POST and terminal revoked state, build artifact hashes, Worker dry-run; final distribution userscript TXT.
- External: real LibreWolf/Violentmonkey polling, PersonaMonkey routing and a read-only live `workspace_status` still require operator's existing browser session. No provider writes have been enabled or tested.

### Preview/runtime/tool-contract remediation — 2026-11-26 (userscript v0.1.6)

- Evidence: paired gateway v0.1.4 and browser v0.1.5 transport/lease healthy; live MCP source reads pass. Native preview execution was deliberately blocked by hardcoded `verified: {}` despite an implemented fixed native protocol bridge. Preview observations were incomplete; list_files missed sizes/types, generator_info reused generic status.
- Change: runtime proof by correlated exact-origin preview postMessage constant before page_eval, structural preview refresh + receipt attestation before reporting appliedRevision, explicit diagnostics evidence limitations, byte-accurate list_files entries with backward compatible paths, native metadata known/unknown distinctions, bounded sanitized preview error timeline in diagnostics export. No Worker changes or external Save enablement.
- Verification required: typecheck, native-protocol synthetic forgery tests, source metadata tests, redaction tests, full unit/integration CI, artifact SHA and byte equality, Chromium runtime smoke where feasible. Live LibreWolf + genuine Perchance preview execution and console/refresh behavior remains an explicit external acceptance gate until observed.

## Live integration defect remediation (v0.1.7) — 2026-11-26

Baseline: Operator-provided Image Studio defect report MCP-01–MCP-14 and redacted userscript v0.1.6 diagnostics. Gateway v0.1.4 and live browser lease are healthy. Source revision 6 was unsaved when reported. This remediation changes the userscript and contracts only, not Cloudflare configuration, authorization, native Helper, OAuth, Workspace Binding or the operator's live draft.

| Finding | Code outcome / remaining acceptance |
|---|---|
| MCP-01 Save gate | F04 preflight now supplies independently fetched exact saved-base and complete post-Save public readback behind unchanged two acceptance gates. Effective gated reason visible. Real authorized disposable Save and gateway-provider enablement **remain blocked**; user must manually Save native editor before reloading unsaved draft. |
| MCP-02 fetch_generator | Respects public `getGeneratorPageData` envelope variants without relying on AI Helper; validates optional manifest forms, double-read drift, source assets and panel-only fallback. Live plugin slug retry pending. |
| MCP-03 viewport reset | Real iframe `innerWidth/innerHeight` must match requested dimensions; after native reset, measured width/baseline conflict is reported as PARTIAL instead of false VERIFIED. Live fixed-pane 917→390→917 still pending. |
| MCP-04 real pixels | Browser/userscript has no accepted native pixel capture interface; remains unavailable, no DOM-based fake images. |
| MCP-05 syntax | Reads `getEditorSyntaxErrors` only if native method exists, fences source revision, preserves path/line-provenance uncertainty and independent preview console/warnings channels. Disposable deliberate syntax failure acceptance pending. |
| MCP-06 generator metadata | Adds native public ID with conflict validation, explicit unknown saved/base revision (not fabricated). Ownership/edit/listing remain unknown unless positively detectable. |
| MCP-07 effective status | Lease fencing, claim-permission ceiling, source/preview and Save acceptance matrix including exact reasons. Policy snapshot cached and diagnostic only; Registry remains admission authority. |
| MCP-08 checkpoints | Immutable full-draft checkpoint creation reads back encoded bytes and SHA256 before success; exact digest/bytes/identity/pin/count receipt. Restore now validates stored digest/full-source revision/identity/paths/sizes before effects. |
| MCP-09 writes | Verified `write`/`save_b64_file` receipts include path/UTF-8 byte size/SHA256 while retaining partial and unknown outcomes without fabricated proofs. |
| MCP-10 errors | Bounded known-domain, tool-specific terminal messages; public metadata vs asset/HTTP/network classifications. No raw private HTTP responses in replies or diagnostics. |
| MCP-11 effects boundary | Ordinary generator preview runtime may request public services; this is NOT an MCP privileged Save, lifecycle or upload grant. Existing privileged gates remain. |
| MCP-12 readiness | Preview availability remains verification-dependent; `workspace_status` adds reasoned matrix. T3 live readiness transitions outstanding. |
| MCP-13 envelopes | User-script failure messages improved; ChatGPT host's immediate rejection wrapping requires gateway/host assessment and is not represented as fixed. |
| MCP-14 warning channels | Native warnings and preview console are explicitly separate. Empty warnings/syntax lists do not attest no errors. |

Verification: full TypeScript + deterministic tests + build + userscript/TXT byte identity + Worker dry-run required on the final versioned head; no deployment needed. Real Firefox/Violentmonkey T3, disposable authorized Save and actual-pixel capture remain explicit release gates. Never claim T1/T2 mocks as T3 evidence. Preserve last native source and local Workspace cache, and test on a separate disposable generator before enabling provider effects.

## Epoch-5 reconnect incident / v0.1.8 remediation — 2026-11-26

Source evidence: operator's `Perch-MCP-Epoch-5-Regression-Report-2026-11-26.md`, `Perch-MCP-Save-Gate-Appendix.md` and `perch-mcp-diagnostics5.json`. Gateway live v0.1.4 returns HTTP 409 `EFFECT_UNKNOWN` on `/api/v1/tab/claim`, with healthy OAuth/pairing and Registry. The blocker is terminal `PARTIAL` operation `b5d2a44c-4a28-43a0-8edc-de3a178cdc84`, tool `set_viewport_size`, epoch 5. The original operation result expired but its terminal phase and Activity record persist. Browser lease is absent. Read-only status operations admitted after the hold expired without dispatch. This is not a bootstrap/OAuth failure.

Remediation in `fix/viewport-hold-reconnect-v018`:
- A terminal `PARTIAL/UNKNOWN` **CSS-only viewport operation** cannot retain the new document's lease or block source edits; a still-`RUNNING/DISPATCHED` viewport operation remains fenced. Other uncertain operations (including page_eval, Save, src writes and uploads) remain held.
- Registry no longer reserves a generator writer for `set_viewport_size`. A legacy v0.1.4 reservation is reaped only from an exact matching authenticated terminal notice. The old outcome and Activity record are retained, never rewritten to SUCCEEDED.
- Browser controller remains connected but degraded on future viewport-only uncertainty. It no longer stops its poll loop, and clears the degraded state after verified reset.
- Viewport API accepts `reset:true` without ignored dimensions; bounded post-layout measurement compares actual iframe dimensions and reports specific numeric mismatches. No CSS-only success proof.
- `fetch_generator` now distinguishes argument validation, public API metadata/assets and local cache-commit failures without raw private content.
- Activity distinguishes view-only uncertainty from source/provider uncertainty; automatic reconnect error on old gateway points to exact operation resolution instead of re-pair.
- Safety invariant: no auto-acknowledgement of an arbitrary unknown effect; no provider policy or privileged Save activation; no production mutation in tests.

**Rollout ordering:** v0.1.8 userscript includes a Worker change. Deploy the packaged Worker **v0.1.5** to the existing Cloudflare deployment first, preserving Durable Object bindings, KV and secrets. Then replace the existing Violentmonkey script with the tested v0.1.8 `.user.txt`. If Worker remains v0.1.4, auto-reconnect still rejects the old viewport PARTIAL: use Activity → Resolve uncertain operation after inspecting the source/preview, then Workspaces → Reconnect. Do not re-pair, detach or rebind.

Acceptance T1/T2: strict typecheck; deterministic effects/legacy Registry unit tests; Miniflare epoch-5 partial viewport→release→claim→read-only status→write end-to-end; negative source/Save/provider effect holds; build/archive checksum and Worker dry-run. T3 real Firefox/Violentmonkey and T4 deployed Cloudflare+ChatGPT retest remain necessary. Fetching public plugin slugs and native geometry restoring still require fresh live positive tests. Save gate, real-pixel capture, supported media/provider-state/lifecycle tools remain independently unaccepted; do not claim full product parity.


## Epoch 7 remediation (open)

Base: 454cf6d91d29bb87483e00a196174decbe13ddda (0.1.8). Operator regression appendix confirms dirty Save blocked by independent acceptance/policy gates, public read followed by INVALID_INPUT during import, delayed iframe reset, incomplete metadata and syntax diagnostics. Preserve epoch-7 draft; no production Save or policy bypass during repair.

Plan: harden byte validation against cross-realm typed arrays and large Base64; distinguish import preflight failure from uncertain publication; use bounded actual two-axis viewport convergence with frame fencing; improve metadata/diagnostic provenance; add regressions and run full CI if local runtime cannot fetch dependencies. Keep capability gates explicit until actual authorized evidence. Check final reconnect and source integrity separately from synthetic tests.

### Epoch 7 implementation checkpoint (0.1.9 candidate)
- Cross-realm Uint8Array branding uses the intrinsic typed-array getter, rejects other typed arrays and spoofed objects; import validates case collisions and byte budgets before journal publication.
- Base64 encode/decode uses bounded blocks and linear validation; no recursive repeated-group regex on multi-megabyte payloads.
- Import exceptions after possible manifest publication remain EFFECT_UNKNOWN and retain the journal; preflight diagnostics expose file ordinal and safe reason, not source contents.
- Viewport measurement uses a fixed native geometry probe, bounded repeated samples, both axes, stable outer target and frame/load/generation fencing. CSS-only failure continues to be isolated from persistent source writes.
- Metadata accepts native boolean properties and synchronous predicates without coercion; generator_info attempts independent complete saved-source readback.
- Native syntax accepts bounded flat/grouped arrays and retains partial coverage and source provenance. Unknown shapes are reported without leaking native payloads. Preview capabilities distinguish not-yet-attested, failed probe and unavailable.
- Regression fixtures added for cross-realm bytes, multi-megabyte files, case collision, delayed geometry, replaced iframe, syntax result variants, and boolean predicates.
- No production provider mutations dispatched; active epoch-7 draft remains dirty. Save policy and adapter acceptance remain separate, deliberately closed pending live authorized verification. Capture, media, lifecycle and production state are not certified by these patches. CI required before installation; no deployment performed.

### Epoch 9 / v0.1.11 — HAR verified native Save, Listing and URL-change flows

Evidence: operator-provided ~22 MB HAR from the real Perchance browser. Inspected locally and extracted only noncredential facts: two `changeGeneratorPrivacy` successes, `changeGeneratorName` success with stable ID, `save` success with saveCount/source revision, `checkGeneratorOwnership` is-owner and public `generatorPageDataVersion` with isPrivate, ID, count. No original HAR, email or sessionToken committed.

Actions:
- Correct `window.userOwnsThisGenerator` and `window.userCanSaveThisGenerator()` global predicates (not `app` members); protect Save from silently forking on nonowner.
- Wire `save_generator`, `rename_generator`, `set_listing` through controller and existing native methods; enforce lease, exact bound identity, Grant, saved-source digest and native owner.
- Wait for asynchronous listing/settings modules. Change visibility by confirmed native menu; use native rename handoff, not direct credential replay.
- Add strict public readback: id/isPrivate from `/api/generatorPageDataVersion/<slug>` plus independently complete bytes. Retain UNKNOWN for navigation or unverified outcomes, never retry effects.
- Add selective Worker v0.1.6 policy `NATIVE_ACTIONS_ENABLED=true` while broad provider mutation remains disabled. Required in-place gateway deployment; preserve DO/KV/secret/URL.
- Add HAR-shaped, permission/identity/expiry, nonowner, delayed UI and no-replay tests; verify full build, TXT/JS and Worker dry-run.
- Report: `docs/verification/epoch9-har-native-actions-v0111.md`. No production mutation or live provider Save attempted by this implementation.

### Epoch 8 / v0.1.10 — failure safety and metadata refinement

Evidence: operator-supplied Epoch-8 live regression appendix and redacted v0.1.9 diagnostics. Live positives: public imports (plugin/minimal), native viewport reset, source writes, checkpoints, preview execution and transport. Do not regress them. The assigned aleph-alpha generator is dirty at source revision 12; do not mutate or Save it. Gateway v0.1.5 is connected with providerWritesEnabled=false.

Implementation:
- Preserve both Save authorization gates. Add durable pre-dispatch journaling (DISPATCHED), no-blind-replay UNKNOWN handling, and a readback-only bounded settlement probe. Distinguish verified stored-source revision from a concurrently changed draft revision.
- Interpret native ownership and edit-access predicates only when they return exact booleans, including bounded async predicates. Conflicting listing fields remain unknown, not false.
- Copy cross-realm native ArrayBuffers through intrinsic brand validation. Preserve explicit zero-byte public manifest assets with no response body.
- Preserve accurate MCP UNSUPPORTED_INTERFACE structured errors; host-side outer INVALID_ARGUMENT wrapping is not proven fixable by this userscript. Do not weaken MCP isError semantics.
- No capability toggles, Worker deployment, native pixel-capture claims, invalid-source injection, paid media calls, or production provider writes.

Verification: strict TypeScript, unit/integration tests with intercepted Save and failure injection, package integrity and Worker dry-run in PR Actions. Live T3/T4 acceptance remains open for Save, actual-pixel capture, syntax, and lifecycle/provider tools. See docs/verification/epoch8-regression-v0110.md.

### Epoch 10 / v0.1.12 — gateway lease and unknown-effect Recovery

Source: operator v0.1.11 diagnostics8, gateway 0.1.6, paired, browser paused, two 409 EFFECT_UNKNOWN claims. No exact operation ID exposed in the diagnostic export. Root cause of operator deadlock: unresolved Workspace claim gate without a complete corresponding actionable UI surface, plus first-page-only interactive Activity and unsafe bulk local journal acknowledgement.

Implementation:
- Add scoped read-only Workspace recovery status to Worker, listing lease/claim deadlines and exact unresolved operation IDs/phases, without secrets or tool arguments.
- Add high-density Recovery tab for Workspace selection, classified next steps, explicit per-operation acknowledgements and per-local-journal acknowledgements. Route blocked Reconnect directly to Recovery, distinguish TAB_BUSY active leases from terminal UNKNOWN.
- Render later Activity pages interactively, not as inert JSON.
- Correct controller journal reconciliation to exact matching operation only, preserve other holds; add exact local intent evidence/revision, keep post-rename stable-ID safe manual reconciliation.
- Make Registry resolution idempotently repeatable after lost DO acknowledgement without a second epoch increment; reject different evidence.
- Prove Gateway read-only secrecy, lease/blocker state matrix, UI recovery actions, lost-ack retry, namespace isolation, full checks and packaging. No production user draft mutation, resolution or Cloudflare deployment performed during implementation.

Evidence: docs/verification/epoch10-recovery-v0112.md. Gateway v0.1.7 must be deployed in place before installing userscript v0.1.12 to expose the Recovery status endpoint. Live operator exact hold still requires the new read-only status after installation; do not guess the operation from these diagnostics.

### Epoch 11 / v0.1.13 — Preview, bytes, reconnect and UI reliability

Evidence: live `perch-mcp-diagnostics9.json` (0.1.12/0.1.7): successful long-lived lease/polls with recent preview `UNSUPPORTED_INTERFACE` after `STALE_EPOCH`, plus independent native byte-wrapper unsupported error and a later `TAB_OFFLINE` on live read-only status. No provider mutation attempted. Visual audit: synthetic Chromium 1366×768 and 390×844 ShadowRoot manager screenshots before/after UI improvements.

Changes: frame-specific 15-second native preview attestation cache invalidated on reload, read-only status preflight; guarded byte structured-clone crossing Firefox page realm; 45-second idle viewport CSS restoration and immediate failed-resize cleanup; bounded transient poll retries through authoritative lease expiration, single-flight read-only autoreconnect on network/visibility with 1–60s backoff and strict pause/unknown-effect fences; Recovery one-action UX, compact Workspace surface and stacked narrow-screen data tables. Unimplemented provider tools remain unsupported; gateway 0.1.7 unchanged. Type, test, release and dry-run verification are required before merge. Full native Firefox live re-test remains open; see docs/verification/epoch11-hardening-v0113.md.

### Epoch 12 / v0.1.14 — address paused-without-Workspace dead end

- [x] Reinspect 0.1.13 diagnostics13: paired healthy gateway, stopped browser, manager paused without Workspace, no tab claim. Avoid inventing a held Gateway operation.
- [x] Reorder controller attachment: validate native ID, binding and local journal before pause/claim; report exact failure stage and preserve established connections.
- [x] Fence Stop against late claim replies and queued connection attempts; release stale lease best effort without reconnecting.
- [x] Add guided one-click Connect/Resume, explicit rebind/Link paths, and strict multi-Workspace selection.
- [x] Preserve bootstrap and connect error provenance in redacted diagnostics; retry native initialization read-only.
- [ ] CI strict typecheck/tests, release hashes, Worker dry-run, tested TXT and merge evidence.
- [ ] Live Firefox disposable-Generator acceptance after operator install; no production mutation during development.

See `docs/verification/epoch12-connection-repair-v0114.md`.

## Epoch 13 — source readback must not prevent connection (v0.1.15)

- [x] Diagnose live diagnostics14: `LOCAL_JOURNAL` / `UNSUPPORTED_INTERFACE` before tab claim, healthy Worker.
- [x] Separate journal and source readback from transport lease, retaining all mutation fences.
- [x] Add bounded page-realm byte extraction fallback with manifest-size and independent reread.
- [x] Preserve honest degraded source capability reports and local journal review when readback fails.
- [x] Add negative tests for opaque realm wrappers, phantom zero bytes, corrupted journal and failed native snapshot.
- [ ] Verify complete CI (typecheck/unit/integration/build/artifact hashes/Worker dry-run), merge verified PR.
- [ ] T3 real Firefox native source and T4 external agent continuity: not claimed until observed.

See `docs/verification/epoch13-native-bridge-and-connection-v0115.md`.

## Epoch 14 — continuous developer execution model (v0.1.16)

Authoritative live inputs: SynthPin revision 33 saved/clean, native snapshot verified, gateway 0.1.7 connected. Old browser-local CSS write `4e01ad79-d630-42ab-809e-110fce6e9bce` is UNKNOWN against revision 32; Gateway `operation_status` correctly returns NOT_FOUND for that local-only ID. No real operator source was mutated during this investigation.

- [x] Trace end-to-end local vs gateway operation IDs and the specific Workspace-wide `UNRESOLVED_LOCAL_WRITES` gate.
- [x] Specify state and ownership boundaries and bounded read-only convergence in `docs/USER_SCRIPT_EXECUTION_MODEL.md`.
- [x] Implement current-source baseline adoption on two stable native snapshots, with original UNKNOWN audit preserved; recent overlap scoped to affected paths (15s) and no effect replay.
- [x] Make old import journals independent of native source writes; do not couple foreign Workspace history to current binding.
- [x] Propagate Gateway IDs in new source/Save/restore journals; avoid useless remote Activity pagination for local UUIDs.
- [x] Report actionable effective capabilities in `workspace_status`; Recovery attempts safe local convergence before operator review.
- [x] Add live-failure-shaped synthetic tests, fault injection and negative cases; targeted local VFS harness passed 6/6.
- [ ] Full CI strict typecheck, complete test matrix, Worker dry-run and packaged artifact hash verification.
- [ ] Independent visual and user-flow audit after build; verify new successful baseline state and no regression.
- [ ] Merge only after verified CI; retain real Firefox/live SynthPin mutation as a separately documented acceptance boundary.

Report: `docs/verification/epoch14-continuous-source-development-v0116.md`.

## Epoch 15 — Gateway incident containment and resumable editor connection (2026-11-27)

- [x] Inspect operator diagnostics16: global 500 including /health and diagnostics; browser bootstrap failed before Workspace lookup; do not claim runtime cause without Cloudflare logs
- [x] Separate Worker /live from Registry /health; degrade readiness as HTTP 503 with trace
- [x] Persist redacted structured Worker/Registry incidents in Cloudflare Workers Logs and independent OAUTH_KV; add read-only scheduled probe
- [x] Add automatic bounded retry on HTTP 500/503 for bootstrap/poll/heartbeat without replaying operations; retain last verified Workspace hint
- [x] Preserve 7-day failed-request and bootstrap-stage diagnostics across userscript reloads
- [x] Add fault-injection tests for offline Registry, liveness, monitoring, log privacy/retention and 500 recovery
- [ ] CI full typecheck + unit/integration + artifact hashes + Worker dry-run
- [ ] Merge after green CI and publish exact tested userscript/Worker artifact
- [ ] **Deferred operator acceptance:** deploy Worker v0.1.8 in original Cloudflare account, then verify real `/health`, Cloudflare logs, actual Firefox automatic reconnect; cannot claim from CI

See `docs/verification/epoch15-gateway-incident-v0117.md`.

## Epoch 16 — Registry outage repair and storage-load containment (Worker 0.1.9)

- [x] Reproduce public /health HTTP 503; deployed v0.1.8 is fail-closed but not healthy. Original root exception and account quota are unverified.
- [x] Preserve canonical Registry identity; initialize storage within the fetch error boundary and evaluate issuer defaults only when no persisted core exists.
- [x] Return allowlisted Registry readiness failure reason and Worker version without raw error, credentials or data; reject all non-2xx upstream responses.
- [x] Prevent idle Workspace schema/backoff/alarm writes and enforce persisted retry deadlines even during incoming request traffic.
- [x] Add synthetic regression tests for stored core vs malformed deployment default, idle maintenance, durable outbox retry, and redacted quota/storage classification.
- [ ] Run full CI and verify deployment readiness on the original Worker; live MCP workspace status remains the acceptance gate. No reset, migration, new bindings, or userscript reinstall required for this Worker-only change.

## Epoch 17 — Correct ambiguous quota diagnosis (Worker 0.1.11)

- Operator confirms available account quota; deployment log confirms version upload and bindings. Previous REGISTRY_QUOTA classification was overly broad, not proof of exhausted account quota.
- Discriminate runtime limits, generic limits, overload and explicit account quota; expose only fixed vocabulary and stage for read-only health failures. Preserve canonical state and fail closed.
- Extend independent production deployment check to accommodate slower Cloudflare builds. Root cause and end-to-end recovery pending production evidence.

## Epoch 18 — durable indexed Workspace lifecycle and SQL budgets

Incident confirmed by Cloudflare dashboard (5.93M rows read) and sanitized runtime exception. Preserve canonical records, identity, bindings and OAuth; no destructive schema migration. Add rebuildable lifecycle index, legacy-write dirty triggers, indexed expiry/outbox/queue/holds and transactional counters; bound maintenance batches; instrument cursor rows. Verify cold restart, rollback writes, non-idle history independence, exact effect fences and production readiness. Registry indexing and transport optimization follow independently. T4 remains blocked by exhausted daily quota until actual recovery.

### Epoch 18 — Registry indexing and observability
- Derived Registry catalog indexes expiration, entity paging, workspace-scoped grants/holds and Activity ordering/filtering; current Activity appends update the exact changed entries, while rollback writes trigger reconstruction. Canonical history and unresolved notices remain intact. Scheduled bounded cleanup; no new binding. SQL telemetry is per-invocation via AsyncLocalStorage, fixed route/query categories, no source, credentials, or durable metric writes.

- Active expiration has a separate selection path so historical backlog cannot hide expired execution. Chunk updates now use conditional UPSERT and delete only obsolete parts; rollback readers retain the same canonical record format.

- Added indexed media/retired-lease deadlines and bounded cleanup, preserving indefinite uncertain paid media intents. Ordinary polls no longer enumerate media history.

- Authenticate claims before local maintenance and guard writes; fence expired/superseded claim completions. Failed auxiliary outbox maintenance does not rewrite a committed operation response. New derived tables use compact WITHOUT ROWID layout; canonical tables unchanged.

- Epoch 18: scoped internal configuration to the requested Agent on MCP routes; empty approval refresh 15s, pending 4s, failures back off to 60s. Userscript 0.1.18 / Worker 0.1.12 candidate. Test harness now disposes partially initialized Miniflare instances and CI has an explicit test-step deadline.

- Miniflare CI run 46002237270: 374/375 passed; all SQL tests pass (24 reads/0 writes per idle poll both empty and after 150 operations; lifecycle 190–194 reads and 70–75 writes total, Activity 108 reads/0 writes per 100 entries). Preserve responsive approvals during first 30s of Agents view. Add read-only indexed idle fast path with explicit dirty/active/outbox/expiry/retention/alarm checks; tighten idle budget to 10 reads. No production deployment until full green CI.

- CI 46002621140: functional tests including OAuth approval discovery passed; idle shortcut measured 12 reads, 0 writes, still above strict 10-read target. Remove redundant lease lookup by hashing before synchronous validation and renewal. Add explicit provider SQL quota connectivity-only retry hint (300s, no operation replay), bounded automatic browser retry delays and targeted tests.

## O01–O07 gateway optimization program (2026-11-27)

Authority: docs/optimization/PERCH-MCP-OPTIMIZATION-PLAN.md and companion prompt. Baseline fb998f890e7870afac011f0c54f5035018cfe208. Branch optimization/gateway-o01-o07; do not merge/deploy or contact live services even after quota reset. All production/browser/provider gates DEFERRED_LIVE.

| Phase | Dependency | Exact offline acceptance | Status |
|---|---|---|---|
| O01 | none | pinned runtime baseline; complete ingress and independent SQL/request/KV/alarm counters; hermetic faults/history fixtures | OFFLINE_VERIFIED baseline377/377; ingress/counter extension verified |
| O02 | O01 | idle <=10/0, invalid <=2/0, status target <=5/0; request-local authorization; awaited fencing and durable outbox | OFFLINE_VERIFIED targeted30/30+MCP10/10; status2/0 |
| O03 | O02 | constant Activity append at1000; keyset pages; Resource point lookup independent bodies; bounded verified migration | OFFLINE_VERIFIED: final Activity/Resource corruption and cache guards included in553/553; Resources35/35+workerd1/1 |
| O04 | O03 | typed sole canonical operations, args/results separate; exact state preservation; target lifecycle <=80 reads/30 writes or explicit unmet evidence | OFFLINE_VERIFIED; targets UNMET: final native162–167reads/51–52writes originalharness;177–182/51–52 fullingress |
| O05 | O04 | opt-in authenticated hibernatable notification; healthy push no idle fetch; <=60s silent-loss reconciliation; fallback | OFFLINE_VERIFIED25/25 plus22legacyregressions |
| O06 | O04/O05 | 192KiB binary rows, bounded media catalog/cleanup, legacy hydration, 10-file batch comparison | OFFLINE_VERIFIED47/47; actual6/43BLOBrows |
| O07 | O01–O06 | local conservative admission headroom, no incident OAuth-KV writes; full offline suite/build/dryrun/CI/artifacts/report/operator handoff | OFFLINE_VERIFIED_LOCAL;553/553,typecheck,build,hashes,dryrun; exact-headCI/packagedreceipt required beforedelivery |

Preparation: remote main matches baseline; readiness workflow pushes main only; PR verify has local test/build/dryrun, no deployment. Existing local checkout retained; new isolated worktree used. npm ci locked install passed. Initial baseline test invocation blocked by automatic approval review because default Miniflare Request.cf bootstrap fetched external metadata. Fixture runtime now explicitly cf:false and rejects all outbound worker requests; rerun only after this correction. No live test completed or claimed.

O02 checkpoint: status now reads only requested operation and exact expired result/deadline. Status no longer expires unrelated rows. Durable pending terminal delivery remains retried. Outbox singleflight rereads exact terminal identity before ack. Admission and heartbeat revalidate lease after awaits; stale dispatch failure cannot overwrite concurrent terminal. Request-local MCP authority snapshot eliminates duplicate browser-tool Registry check; dispatch/child authority stays fresh. Local capacity30/30 and OAuth/MCP+new regression10/10 pass. Baseline branch checkpoint564ac019ea4fee39715e3ca6d2ca3db3060bd6c0 verified remote; CLI push lacked credentials, connected GitHub committed equivalent tree then local branch aligned without altering worktree. Incident independent containment12/12 passed. O03 next.

O03 integration: canonical Activity/Resource authority gated by CANONICAL_STORAGE_MODE legacy(default)/prepare/native; background alarm batches and authenticated storage status/step APIs wired. prepare verifies before cutover; persisted native markers override later flag disable; compatible candidate required after cutover. Registry terminal receipt now prevents delayed dispatch even when permit was never created (actual localworkerd2/2 regression/ingress). Terminal receipts and permits remain separate because cancellation can terminalize before dispatch and retention lifetimes differ. Healthy readiness response now includes ok:true only after actual core read/validation, correcting the existing workflow response-contract mismatch without changing production workflow. Full MCP baseline JSON retained separately.

O03 final evidence: Activity append4reads/7writes at0/150/999,6/8 at1000 (oneeviction); firstpage102/0, deep<=103/0 using actualpinnedworkerd. Resource smallget11/0,800KiBget22/0, metadatalist8/0,publish20/4. Resource fixturemigration1073reads84writes; no unmeteredSQL. Atomiccore.schemaVersion2 fences priorRegistrybinary; managementrevision/policy preserved atcutover. Preparedrollback usescompatiblecandidate only afternewwrites; no stalelegacysnapshot fallback. Corruptmigration persistsBLOCKED; transientSQLfailure preserves resumable cursor. Resource export compression now respects existing ZIPimport ratio guard without raisinglimits. All realcloud/browser/provider acceptance DEFERRED_LIVE.

O04 checkpoint: typed canonical operation rows+separate args/results; bounded16-row migration with2-pass canonical+derived+aggregateverification; durableRUNNING, dispatchAttempt uncertaintyfence, terminalreceipt digest independentofpayloadTTL, exact phaseguards. StrictTypeScript+35focusedtests passed (16existingstorage,11nativeunit,5awaitfences,3actualworkerd). Truepre-index10kfirsttwosteps117/81 and133/81 rows;16recordsperstep,0unmetered,no fullv1projection. Full10kconvergence/1000ordinaryretention verified. Rarepre-indexobjects withoutv1projection temporarily503 forjournal-dependent requests untilnativecutover; operatorquietwindow and localterminalnonACKevidence required. Expected0.1.12indexedobjects retainlegacyavailabilityduringprepare. Nativefullingress177reads56writes versus218/72 empty baseline; targets120/40 explicitlyUNMET. No missingtransitionsremovedtohitbudget. O03postreview additionallyguards async Resource legacycommit racingcutover, refreshesrevisiononmetadatareads, prevents fullLibraryload duringRegistrycleanup/migration, and bounds partialActivityUTF8tokens. Resourcefixturemigration revised1238reads87writes includingnewguards;steady pointcost unchanged.

O05 final gate25/25 and22legacyregressions: optionalhibernatableadvisorysocket, scoped30ssingle-useheader ticket (digestonlyatrest), noURLs/source/payloads, singleflight/coalescing/heartbeatfallback. StrictmeasurednativeadmissionHTTP23reads7writesvsPush25/7;zeroaddedwrites. Local12samplesp95~27ms upperbound; actualhibernation/CSP/FirefoxDEFERRED_LIVE. O07nonretryablecorruptionclientcontainment14/14; unknownshape/genericmutationretryflagdoesnotdisablequota/connectivityrecovery.

O06 final gate47/47:1MiBimage48legacyJSONrows→6BLOB;8MiBaudio384→43; pointmusicchunk7/0 at0/1000history. Newv2maintenanceprojectiondoesnotpublishpartialv1readiness; frozen0.1.12rollbackconstructorprovedcompleteorbuildablebeforefence.10kjournalbackfill81steps,max656reads/batch. BinarynewwritesrequireflagtrueANDnativeoperation/schema2; legacy/new/flagoffreadersremainvalid. Actualbatch10xwriteversus1put_files90%lowerrows/calls measured; exactfinalbenchmarksregeneratedaftercandidatecheckpoint.

O07 implementation: optionaldurableperWorkspaceadmissionestimates+completion/lateobservation/retainedcleanup/UTCcarry,accountusageUNKNOWN,noresult/recoverypolicyreroute; localcaps750KVwriteswith256backgroundreserveunderone24hclientassumption; measuredSDKrefresh2KVputs/15min,accepteddiagnosticauditcostseparate. Diagnosticsmax256/dayand100individualrows, GET0writes, noinfraOAuthKVwrites, boundedlogs/ingress. Registrycore/readinesspositivevalidation+no false2xxhealthy. Fullfirstintegrationrun545/547passed;remainingtwofixturesfixed(validpairedcorefields; explicitmissingalarmbeforefaultinjection), targeted20/20passed. Noapplicationthresholdrelaxed. Fullrerun/build/exactSHAofflineCI/artifactsnext.

Final local functional suite547/547passed(44.7s),0failed/skipped; strict0.2.0typecheckpasses. Lastmessagecompatibilityassertionsretainexistingheadroomwordingwhileaddinglimitingdimension. Strictlegacycapacitytestnowtightenedtospecifiedidle<=10/0,active<=25/0,status<=5/0,invalid<=2/0,Activityfirst100<=110/0; noassertionrelaxed. Firstcoldidlecanpayboundedmaintenancepreparation(32/1infullrun),explicitlyseparatefromstableidle10/0. Finalreport/artifact/CIcompletionstillpending.

Final qualification checkpoint: full local suite553/553,0failed/skipped(46.6s);strictTypeScriptpassed. Positive committed Resource schema-presence caching removes repeated sqlite_master scans while marker/generation/authorization stay fresh. Resource35/35unit+1/1workerd; missing native Activity/Resource marker/table faults reject stale legacy fallback; health protocol/schema fields reject coercion. FixtureResource migration267reads87writes; final exact-source whole-gateway benchmarks pending. No target threshold relaxed. Native-only budget caps remain optional/defaultoff; retained cleanup and first-enable/rollover behavior documented.

Final measured source f99b0f313603084cc720c83be974d7fd24f05e49, clean for all eight runtime benchmark outputs. Native original lifecycle162–167reads/51–52writes; fullMCP177–182/51–52,5Worker+6Registry+5Workspacefetches,2KVreads. Default legacy fullMCP232–255/78–87 costs extra for safety and compatibility; native savings require explicit verified migration. Targets80/30 and120/40 remain UNMET. Warm status2/0,idle10/0legacy8/0native,active25/0,invalid2/0; no relaxed thresholds.24h200operations+8760emptyHTTPpolls+1440heartbeats: native139032reads/12501writes vs legacy174962/18673; due-only alarms and12hrestart included, OAuth/MCP absent from this virtual fixture and separately measured.

Release handoff: docs/verification/gateway-optimization-report.md and twelve machine evidence/assumption files committed; mandatory TXT/JS, Worker/source/candidate archives, internal/external manifests and OPERATOR-ACCEPTANCE packaged by build. Local preflight318files verified, clean source, TXTidentical, packagedsyntheticWorkerhealthPASS;Wrangler--dry-runPASS. Final delivery must inspect exact-head offlineCI, rebuild/verify the committed documentation snapshot and supply a qualification receipt with exactcommit/CI/hashlinks. Main stillfb998f8; productionworkflow unchanged; all production/realFirefox/provider/physicalbilling acceptance DEFERRED_LIVE. No merge/deploy/preview/prodprobe authorized.

Final CI provenance correction: offline PR checkout explicitly selects pull_request.head.sha (manualdispatch uses github.sha). Package/source manifest must identify the actual reviewed candidate commit rather than a synthetic PR merge commit. Productionworkflow/trigger unchanged.
