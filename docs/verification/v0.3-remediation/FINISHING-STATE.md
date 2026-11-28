# Perch MCP v0.3 — finishing state and restart checkpoint

**Scope:** `repair/v0.3-conformance`, draft PR [#25](https://github.com/Neb963/perch-mcp-userscript/pull/25); never merge, deploy, make live provider changes, or execute real Firefox/OAuth/Cloudflare acceptance without a current explicit Operator authorization.

This is an *operational index*, not a second requirement database. Normative authority: [revision 3](../../v0.3/REMEDIATION-AUTHORITY.md), [unified specification](../../v0.3/PERCH-MCP-V0.3-IMPLEMENTATION-SPEC.md), [original traceability index](REQUIREMENT-TRACEABILITY.md), and `AGENTS.md`. Consult the four existing atomic registers rather than inferring feature completion from test counts.

## A. Source of truth — observed 2026-11-28

| Field | Exact observed value |
| --- | --- |
| Default branch | `main`, `298f3b9619335364c668a69b6f04570ae530fcab` |
| Remediation branch checkpoint before this document | `d9906633467e72d3ecb1364fb60139b5110a3698`, tree `3f25dc8693e506b3de42430a33a8ff4b631ebd39` |
| Last independently offline-verified source/docs commit | `d9906633467e72d3ecb1364fb60139b5110a3698` |
| Verified offline CI | [46150920907](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46150920907), successful at that SHA: 727 PASS, 0 FAIL, 1 historical SKIP |
| PR | [#25](https://github.com/Neb963/perch-mcp-userscript/pull/25): open, draft, unmerged |
| Release | **NOT ELIGIBLE**; neither complete offline qualification nor production acceptance |
| Native five-stage SQL lifecycle | **187 rows read, 44 written**; required **≤120/40**; native deficit 67 reads and 4 writes |
| Measured stages (read/write) | admission 44/10; poll/dispatch 50/8; RUNNING 14/1; terminal/outbox 56/25; scoped status 23/0 |
| Legacy equivalent | **251 rows read, 74 written**; separately measured, not counted toward native target |
| Atomic requirement register | 1,317 total = **112 PASS + 4 FAIL + 1,162 NOT_STARTED + 24 DEFERRED_OWNER + 1 BLOCKED_FEASIBILITY + 14 SUPERSEDED** |
| Active FAIL requirement IDs | `S07-023` (actual unsaved-preview pixels); `S08-058`, `F13.01`, `F13.02` (native SQL budget) |
| Feasibility blocker | Actual authorized preview pixels lack a verified Firefox/Violentmonkey-only capture implementation |
| Package evidence | GitHub Actions artifact `perch-mcp-userscript-tested` for 46150920907; candidate ZIP SHA-256 `d4b465e5a377d90177afbb8b162bf41ca97d04e6ec9f006cf3344d82df67b129`; userscript `.txt`/`.js` SHA-256 `93685686ff9990058fbed4014955cd67d2c3018e1d7186b114ca873f61e4e70e` |

**Evidence limitations:** Historical passing tests cannot auto-qualify `NOT_STARTED` rows. The local Miniflare/Workerd operation benchmark is synthetic execution over actual Worker/Registry/Workspace and pinned SDK, not provider production. Source package recovered from the exact CI artifact agrees with the tested commit. In the present executor, the dependency registry is unreachable and `npm ci --offline` fails with `ENOTCACHED` for `zod@3.25.76`; installed Node is 22.16.0, while Babel 8 declares 22.18+ (or 24.11+). The existing CI is the last reproducible full offline verification until an environment with lockfile dependencies is available. Do not claim local test success from an attempted installation.

## B. Dependency-aware roadmap

| Workstream | State | Existing evidence | Next action | Blocking dependency |
| --- | --- | --- | --- | --- |
| W0 — Baseline/authority | VERIFIED_OFFLINE | Exact branch/PR, AGENTS, revision-3 authority, source archive, register, CI reconciled here | Keep this index synchronized with every meaningful verified source checkpoint | None |
| W1 — Correctness/recovery | READY | R01/R02/R03/R05 findings and 727-test CI; direct assertions exist for selected F01–F27 | Prioritize unqualified P0 authorization, uncertainty and recovery paths; reproduce and test production-path assertions | Unproven clauses must not be marked PASS |
| W2 — Native database budget | READY | [R04 measurements](r04/PERFORMANCE-RESULTS.md), exact 187/44 lifecycle and rejected zero-saving cache trial | Profile actual hot SQL shapes by stage, propose falsifiable structural reduction; rerun same denominator and negatives | 67-read / 4-write deficit |
| W3 — Preview pixels | BLOCKED_FEASIBILITY | [Feasibility analysis](r05/FINAL-OFFLINE-STATUS.md) | Prepare minimal owner-authorized design or prove Firefox userscript-only surface identity/capture; never substitute DOM rasterization | Operator capture permission/component choice if required |
| W4 — Requirement verification | READY | [Four registers](REQUIREMENT-TRACEABILITY.md); 112 directly qualified clauses | Qualify high-risk groups with direct runtime assertions and update existing register incrementally | 1,162 individually unqualified |
| W5 — Integration/compatibility | IN_PROGRESS | Legacy/native preservation and scoped manager evidence in R05; original A01 only partly qualified | Test exact v2 catalog, revocation, Target isolation, historical readers, failure/restart paths | Real browser/provider tests reserved |
| W6 — Candidate/handoff | BLOCKED_OWNER | Exact d990 artifact hashes, build, Wrangler *dry-run* and CI already passed | Rebuild exact final source after engineering gates, preserve owners' acceptance checklist | W1/W2/W3/W4/W5; OWNER-01–04 |

`COMPLETE` is reserved for a workstream whose full acceptance conditions have been met. `VERIFIED_OFFLINE` for W0 means baseline reconstruction only, not product acceptance.

## C. Active work and immediately executable queue

- **Working scope:** nondeploying remediation PR #25. At entry, no later source commit existed than d990; do not overwrite newer commits discovered on a future invocation.
- **Next technical priority:** W2 native SQL lifecycle plus W1 high-risk unqualified recovery/authorization paths. Keep parallel independent work possible. Existing 187/44 data has stage partition above.
- **Source/test entrypoints:** `apps/gateway/src/{registry,workspace,registry-index,operation-store,operation-index,sql,sql-meter}.ts`; `scripts/benchmark-development-v2.ts`; `tests/integration/{assignment-contract,workspace-native,optimization-faults}.test.ts`; `tests/fixtures/optimization-runtime.ts`.
- **Verification command in a dependency-capable offline runner:** `npm ci --ignore-scripts --no-audit --no-fund && npm run typecheck && npm test && npm run audit:requirements:strict && npm run build && npm run verify:artifacts`; run exact workload `BENCHMARK_NATIVE=true BENCHMARK_TRACE=true BENCHMARK_SQL_PROFILE=true node --import tsx scripts/benchmark-development-v2.ts /tmp/native-v2.json` with a real Git checkout and the same synthetic fixture.
- **Rejected experiment:** transaction-local SQL read cache at `6a25baf`: 713/0/1 tests but *zero* measured SQL savings; reverted. Do not repeat absent a different, measured hypothesis. Earlier partial indexes and WITHOUT ROWID changes were new-database-only; existing physical indexes remain unchanged.
- **Needed proof:** each proposed SQL reduction must preserve fresh authorization/revocation, Connector/Target isolation, exact idempotency and durable terminal receipts on restart. Every new requirement PASS needs direct observations, the exact source SHA, and a stable test selector. Do not relabel based on doc presence.

## D. Decision register

| Issue | Decision and rationale | Alternatives rejected/blocked | Rollback or owner gate |
| --- | --- | --- | --- |
| Release scope | Strict offline candidate only; PR #25 stays draft | No production deploy/preview/probe, no main merge | Owner must authorize each external acceptance gate |
| Native 120/40 objective | Retain unchanged; instrument by phase and query shape before optimizing | Cache trial saved zero rows; batching amortization does not satisfy the one-operation denominator | Revert ineffective complexity; preserve historical readers |
| Source integrity | Use exact measured commit/CI/artifact hashes; docs updates are not automatically qualified source builds | Do not infer verified head from passing older run | Rerun full offline checks at next meaningful source checkpoint |
| Capture | Return `UNSUPPORTED_INTERFACE` until authorized exact preview pixels are proven | DOM reconstruction, arbitrary screen capture and hidden browser privileges are non-equivalent/unsafe | Owner decision if an additional permission or companion is needed |
| Local environment | Source recovered from trusted CI artifact, but no claim of locked local tests while NPM cache is absent | Do not bypass pinned lockfile or upgrade packages only to make local install possible | Reproduce in CI's pinned environment |

## E. NEXT AGENT START HERE

1. Read this file, `AGENTS.md`, revision-3 authority, [R07 direct evidence](r07/DOCUMENT-QUALIFICATION.md), and [R05 final status](r05/FINAL-OFFLINE-STATUS.md).
2. Fetch *actual* PR #25 and `repair/v0.3-conformance` HEAD. The last proven starting source SHA was **d9906633467e72d3ecb1364fb60139b5110a3698**. Reconcile any newer branch head before modifying.
3. Inspect native five-stage benchmark query profiles and choose one concrete measurable read/write elimination hypothesis. Do not reimplement the failed read cache. Do not change the benchmark denominator.
4. In parallel, pick a specific P0 `NOT_STARTED` authorization/recovery clause and add a non-tautological direct negative/positive production-path test. A failing test is a finding, not a passed requirement.
5. Commit bounded changes with source and evidence, run full exact-head offline CI when appropriate, update the existing 1,317-clause register only with direct proof, and update this index and `todo.md`.
6. Leave draft PR unmerged and untouched by production/live actions. Deliver `.txt` userscript and exact artifact hashes only when rebuilt from the newly verified source.
