# Perch MCP v0.3 — finishing state and restart checkpoint

**Scope:** `repair/v0.3-conformance`, draft PR [#25](https://github.com/Neb963/perch-mcp-userscript/pull/25); never merge, deploy, make live provider changes, or execute real Firefox/OAuth/Cloudflare acceptance without a current explicit Operator authorization.

This is an *operational index*, not a second requirement database. Normative authority: [revision 3](../../v0.3/REMEDIATION-AUTHORITY.md), [unified specification](../../v0.3/PERCH-MCP-V0.3-IMPLEMENTATION-SPEC.md), [original traceability index](REQUIREMENT-TRACEABILITY.md), and `AGENTS.md`. Consult the four existing atomic registers rather than inferring feature completion from test counts.

## A. Source of truth — observed 2026-11-28

| Field | Exact observed value |
| --- | --- |
| Default branch | `main`, `298f3b9619335364c668a69b6f04570ae530fcab` |
| Remediation branch checkpoint before this document | `1a859abcaf0787e3f35d3b29c9b0850207dab29a`, source tree `a17a704144a1132f535555434f7dda90cf7088a6` (R15 exact-code CI checkpoint; subsequent evidence commit is documentary) |
| Last independently offline-verified source/docs commit | `1a859abcaf0787e3f35d3b29c9b0850207dab29a` (R15 direct browser tests verified in CI) |
| Verified offline CI | [46161586058](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46161586058), SUCCESS at exact R15 source SHA: **737 PASS, 0 FAIL, 1 historical SKIP** |
| PR | [#25](https://github.com/Neb963/perch-mcp-userscript/pull/25): open, draft, unmerged |
| Release | **NOT ELIGIBLE**; neither complete offline qualification nor production acceptance |
| Native five-stage SQL lifecycle | **180 rows read, 44 written** at R11 verified experiment; required **≤120/40**; native deficit 60 reads and 4 writes |
| Measured stages (read/write) | admission 44/10; poll/dispatch 50/8; RUNNING 14/1; terminal/outbox 56/25; scoped status 16/0 |
| Legacy equivalent | **244 rows read, 74 written**; separately measured, not counted toward native target |
| Atomic requirement register | 1,317 total = **141 PASS + 4 FAIL + 1,133 NOT_STARTED + 24 DEFERRED_OWNER + 1 BLOCKED_FEASIBILITY + 14 SUPERSEDED** |
| Active FAIL requirement IDs | `S07-023` (actual unsaved-preview pixels); `S08-058`, `F13.01`, `F13.02` (native SQL budget) |
| Feasibility blocker | Actual authorized preview pixels lack a verified Firefox/Violentmonkey-only capture implementation |
| Package evidence | GitHub Actions artifact [perch-mcp-userscript-tested](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46161586058/artifacts/15270171961) at exact R15 source; candidate ZIP SHA-256 `af0c8182158288ccf0f2416fe10727dd34a5f42fc1b6867728f35062ce5c370d`; byte-identical userscript TXT/JS SHA-256 `363e96ca254329e10604c2b8287743b788a38e1806657e21a270ca80b85c7bb0` |

**Evidence limitations:** Historical passing tests cannot auto-qualify `NOT_STARTED` rows. The local Miniflare/Workerd operation benchmark is synthetic execution over actual Worker/Registry/Workspace and pinned SDK, not provider production. Source package recovered from the exact CI artifact agrees with the tested commit. In the present executor, the dependency registry is unreachable and `npm ci --offline` fails with `ENOTCACHED` for `zod@3.25.76`; installed Node is 22.16.0, while Babel 8 declares 22.18+ (or 24.11+). The existing CI is the last reproducible full offline verification until an environment with lockfile dependencies is available. Do not claim local test success from an attempted installation.

## B. Dependency-aware roadmap

| Workstream | State | Existing evidence | Next action | Blocking dependency |
| --- | --- | --- | --- | --- |
| W0 — Baseline/authority | VERIFIED_OFFLINE | Exact branch/PR, AGENTS, revision-3 authority, source archive, register, CI reconciled here | Keep this index synchronized with every meaningful verified source checkpoint | None |
| W1 — Correctness/recovery | IN_PROGRESS | R01/R02/R03/R05 findings and 727-test CI; direct assertions exist for selected F01–F27 | Prioritize unqualified P0 authorization, uncertainty and recovery paths; reproduce and test production-path assertions | Unproven clauses must not be marked PASS |
| W2 — Native database budget | IN_PROGRESS | [R11 SQL experiment](r11/SQL-EXPERIMENT.md), exact 180/44 lifecycle after seven verified status-read savings | Identify a structural 60-read/4-write reduction without weakening historical index, authorization or recovery fences | 60-read / 4-write deficit |
| W3 — Preview pixels | BLOCKED_FEASIBILITY | [Feasibility analysis](r05/FINAL-OFFLINE-STATUS.md) | Prepare minimal owner-authorized design or prove Firefox userscript-only surface identity/capture; never substitute DOM rasterization | Operator capture permission/component choice if required |
| W4 — Requirement verification | IN_PROGRESS | [Four registers](REQUIREMENT-TRACEABILITY.md); 141 directly qualified clauses | Qualify remaining P0 authorization/recovery clauses, original-operation status/cancel and historical compatibility with direct runtime assertions; five R15 clauses in [R15 evidence](r15/DIRECT-QUALIFICATION.md) | 1,133 individually unqualified |
| W5 — Integration/compatibility | IN_PROGRESS | Legacy/native preservation and scoped manager evidence in R05; original A01 only partly qualified | Test exact v2 catalog, revocation, Target isolation, historical readers, failure/restart paths | Real browser/provider tests reserved |
| W6 — Candidate/handoff | BLOCKED_OWNER | Exact 8d979e6 artifact hashes, build, Wrangler *dry-run* and CI already passed | Rebuild exact final source after engineering gates, preserve owners' acceptance checklist | W1/W2/W3/W4/W5; OWNER-01–04 |

`COMPLETE` is reserved for a workstream whose full acceptance conditions have been met. `VERIFIED_OFFLINE` for W0 means baseline reconstruction only, not product acceptance.

## C. Active work and immediately executable queue

**R15 completed direct qualification:** `S03-031/033/035/037/049` passed actual browser effect-boundary permission tests with matching positive/negative results, guarded transfer stage/commit, delete, rename, metadata list and QuickJS. Exact code [`1a859abc`](https://github.com/Neb963/perch-mcp-userscript/commit/1a859abcaf0787e3f35d3b29c9b0850207dab29a) passed [CI 46161586058](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46161586058), **737 PASS, 0 FAIL, 1 historical SKIP**. [R15 direct evidence](r15/DIRECT-QUALIFICATION.md). Exactly five atomic rows promoted. Native SQL 180/44 and owner screenshot remain failed.

**R14 completed direct qualification:** `S03-010`, `S03-020`, `S03-028`, `S03-029` passed typed image rejection/redaction, common wait-bound enforcement, selected 64-file browser reads/line/byte ranges and wrong READ_SOURCE denial at [`324fd2f`](https://github.com/Neb963/perch-mcp-userscript/commit/324fd2f348232b90830f8debbd1cf698e1d56fd0) / [CI 46160911551](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46160911551), **736 PASS/0 FAIL/1 historical SKIP**. [R14 evidence](r14/DIRECT-QUALIFICATION.md). Exactly four NOT_STARTED rows promoted. No screenshot, SQL or owner gate waived.

**R12 completed direct qualification:** Clauses `S03-011`, `S03-012`, `S03-014`, `S03-015`, `S03-021`, `S03-022`, `S03-023` pass direct real v2 tools/list Workerd and production parser assertions on exact source [`5451c65`](https://github.com/Neb963/perch-mcp-userscript/commit/5451c65b80cc0a0b25ac9905f03c15ddd7ccdfea) / [CI 46159246081](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46159246081), 733 PASS/0 FAIL/1 SKIP. [R12 evidence](r12/DIRECT-QUALIFICATION.md). Exactly seven `NOT_STARTED` rows promoted, no other row altered. Catalog cannot capture actual preview pixels yet; screenshot feasibility remains explicitly blocked.

**R10 completed direct qualification:** `S03-009` passed at [`cbef2a2`](https://github.com/Neb963/perch-mcp-userscript/commit/cbef2a233a1e3fdb21da2c315aa0d1eec80853c6) on [CI 46158172940](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46158172940), 731 PASS/0 FAIL/1 historical SKIP. Browser executor rejects malformed, altered and unauthorized standalone mutations before publication; positive write remains valid. See [R10 evidence](r10/DIRECT-QUALIFICATION.md). No SQL, screenshot or owner gate is waived.

**W2B rejected and reverted:** [CI 46159986488](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46159986488) passed tests and measured the same native lifecycle at **181/44**, one read **worse** than R11's **180/44**. The native-only admission indexed maintenance predicate cost more SQL reads than it eliminated; legacy remained **244/74**. Runtime change was **reverted in the next commit**, retaining original expiration semantics. Details: [R13 negative result](r13/SQL-EXPERIMENT-NEGATIVE.md). W2 next: optimize dominant Registry terminal/Workspace poll work structurally, not yet another expiration gate.

**W2 structural experiment (VERIFIED partial improvement):** [CI 46158850513](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46158850513), exact SHA `8cd13c464de346167d022b83a332d387e77aef5f`, passes offline suite after preserving image hydration, final ACL and original Grant/Target constraints. Identical native five-stage lifecycle changed **187/44 → 180/44**, exactly **7 fewer Registry reads during scoped status**; legacy **251/74 → 244/74**. W2 still FAIL against ≤120/40 (deficit **60 reads / 4 writes**). See [R11 benchmark evidence](r11/SQL-EXPERIMENT.md). Next inspect terminal write/index amplification and Registry/Workspace repeated read boundaries with fresh+historical schema; no more status-only cache experiments.

**R09 direct qualification:** `2e2f5221baddf0bf404accfe66ea8c3be230c46f`, [CI 46156403985](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46156403985) — 730 PASS, 0 FAIL, 1 SKIP. Explicit depth/node and serialized UTF-8 envelope limits reject malformed requests **before Registry or Workspace effects**; bounded positive inputs remain valid. S03-007 and S03-008 are independently qualified; [R09 evidence](r09/DIRECT-QUALIFICATION.md). The remaining 4 known failures and owner-only gates are unchanged.


**R08 verified checkpoint:** `e3b47a9d6ab69b65d71db1607bf496967b5a2b69`, CI [46155702456](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46155702456) (729 PASS/0 FAIL/1 SKIP). Exact Workerd Target/discovery and pre-admission validation tests directly qualified S02-009/012/020/023/024 and S03-002/003/004/005/006. See [R08 evidence](r08/DIRECT-QUALIFICATION.md). 10 PASS promotions are limited to actual assertions. No Cloudflare production, real Firefox or provider effects. The next technical task is a new structural SQL experiment against the still failing 180/44 lifecycle. [SQL triage](r08/SQL-COST-TRIAGE.md); [capture decision](r08/PREVIEW-CAPTURE-DECISION.md).


- **Working scope:** nondeploying remediation PR #25. At R10 entry GitHub HEAD was 8d979e6 and PR #25 remained draft; check actual branch HEAD before future changes.
- **Next technical priority:** W2 native SQL lifecycle (now 180/44 after seven verified status-read savings) plus distinct high-risk W1 recovery/authorization paths. Preserve previous 187/44 as a historical baseline.
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
2. Fetch *actual* PR #25 and `repair/v0.3-conformance` HEAD. Last exact-source verified implementation/tests checkpoint **1a859abcaf0787e3f35d3b29c9b0850207dab29a** ([CI 46161586058](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46161586058)), followed by documentary R15 qualification. Inspect newer commits and CI before continuing.
3. Inspect [R11 exact measured SQL results](r11/SQL-EXPERIMENT.md): native 180/44; legacy 244/74. Diagnose 60 reads and 4 writes still over required native budget. Candidate: fresh/historical `Operation`/`Activity` index amplification, plus repeated Registry/Workspace reads during admission and dispatch; only pursue a falsifiable structural experiment with unchanged denominator and negative regressions. Do not repeat rejected transaction-local read cache.
4. In parallel, identify the next distinct P0 `NOT_STARTED` authorization/recovery clause with direct positive/negative production-path evidence. Do not repeat R08–R15 validations. Current register: 141 PASS, 4 FAIL, 1,133 NOT_STARTED, 24 DEFERRED_OWNER, 1 BLOCKED_FEASIBILITY, 14 SUPERSEDED. Next candidate: S03-056/057 original operation status/cancel selectors and uncertain-effect behavior. Never upgrade on partial evidence.
5. Commit bounded changes with source and evidence, run full exact-head offline CI when appropriate, update the existing 1,317-clause register only with direct proof, and update this index and `todo.md`.
6. Leave draft PR unmerged and untouched by production/live actions. Deliver `.txt` userscript and exact artifact hashes only when rebuilt from the newly verified source.
