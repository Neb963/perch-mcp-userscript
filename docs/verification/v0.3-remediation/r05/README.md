> **Latest clean-install Resource proof:** Production `resourceStorageMaintenance` now skips schema/trigger creation when there is no legacy `library`, and real `SqlRecords` tests confirm zero writes while preserving subsequent historical migration. [R05 Resource-retirement proof](RESOURCE-RETIREMENT-EVIDENCE.md) promotes S09-003 after independent UI and gateway-surface checks. Reconciled register: 1317 total, 87 PASS, 5 FAIL, 1186 NOT_STARTED, 24 DEFERRED_OWNER, 1 BLOCKED_FEASIBILITY, 14 SUPERSEDED. Release still NOT ELIGIBLE.

> **R05 2026-11-28 exact-code qualification:** [CI 46141689975](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46141689975) at `b7daa005b6b3a4e6166a2ac97159cb708a402c29` passed 703/704 tests (1 historical skip) and artifacts/dry-run. [F12, old-Epoch, transfer and UI-race evidence](F12-HISTORICAL-AND-MANAGER-EVIDENCE.md) closes four additional FAIL clauses. Current register: 1,317 total, **86 PASS, 6 FAIL, 1,186 NOT_STARTED, 24 OWNER, 1 capture blocked, 14 superseded**. Release NOT eligible. Historical checkpoints below are dated and not current.

> **R05 UI/digest reconciliation (2026-11-28):** The [bundled manager closure report](MANAGER-CLOSURE.md) and reproducible Playwright script verify nine additional previously failed atomic rows, with downloaded bytes checked against PR #25. Inventory now 82 PASS, 10 FAIL, 1186 NOT_STARTED, 24 DEFERRED_OWNER, 1 BLOCKED_FEASIBILITY and 14 SUPERSEDED_BY_OWNER_AMENDMENT (1317 total). Historical snapshot numbers below refer only to their original source SHA and are preserved as such. Strict release gate remains blocked.

> **Newer exact-head check (2026-11-28):** [5c045bc, CI 46140138366](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46140138366) passed 701 tests, 0 failures, 1 skip. The [F09/OAuth/UI qualification](F09-OAUTH-UI-QUALIFICATION.md) supports 19 specific atomic status changes, not a blanket release approval. Native benchmark 187/46 remains over 120/40; actual preview capture and OWNER gates remain open. Historical baseline sections below stay labeled by source SHA.

# R05 exact-head requirement inventory and release gates

## Authority and method

The [four atomic matrices](../REQUIREMENT-TRACEABILITY.md) are the accepted implementation, audit, and A01–A34 acceptance record. `npm run audit:requirements` validates and enumerates **every** row into JSON; `npm run audit:requirements:strict` exits nonzero until all requirements are qualified. It does not infer a PASS from generic successful CI.

The baseline at `c9832cc84a8fd8128e08cd951b7de5263f4c8088` contains **1,317 distinct clauses**: 54 recorded PASS, 1,196 NOT_STARTED, 28 FAIL, 24 DEFERRED_OWNER, 1 BLOCKED_FEASIBILITY, 14 SUPERSEDED_BY_OWNER_AMENDMENT. The baseline inventory has zero duplicate/invalid IDs and zero PASS-without-evidence heuristic violations. The inventory records the actual `git rev-parse HEAD` and tree and rejects a mismatched `PERCH_EXPECTED_COMMIT`. GitHub's `GITHUB_SHA` can refer to a synthetic merge commit for a pull-request event and is not exact-source evidence. The coverage is **not** release-complete: recording a small test suite's 682+ passing cases is not equivalent to discharging 1,317 independently testable invariants. Newly implemented tests do not silently change atomic statuses until evidence, exact SHA and criterion are reviewed.

## Verified offline checkpoints

- [26dc15e](https://github.com/Neb963/perch-mcp-userscript/commit/26dc15e54e831f9c12de5e2a6e38539e448c2628), [CI run 46095737951](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46095737951): strict typecheck, 682 tests pass, 0 fail, 1 historical skip, native/legacy capacity benchmarks, generated candidate, hash check and Wrangler dry-run. No preview, production or external provider access.
- Exact-bundle Chromium synthetic manager at e742f091: 11/8/2 complete Workspace rows at 1440×900, 1024×768, and 390×844 (required 8/6/1), no overflow, no external requests; 30/50 Workspaces in five tabs.
- [R04 performance results](../r04/PERFORMANCE-RESULTS.md): Native complete source-read lifecycle **225 SQL reads, 57 writes**, compared with normative <=120/40. A ten-tool mixed gateway batch required 266/57 instead of 2,485/554 for ten separately admitted tools; this represents *gateway admission and receipt processing*, not a real browser workload.
- Access-token default is 24 days, to avoid a single 32-bit browser timer overflowing; permanent Connector consent survives refresh. Any 10-year override remains an unqualified external-client experiment.

## Hard release blockers

| Gate | Current outcome | Required closure |
| --- | --- | --- |
| Full spec traceability | NOT QUALIFIED | Resolve each atomic row by criterion with exact code/test or authorized deferral; strict audit must pass |
| Ordinary lifecycle SQL <=120/40 | FAIL (225/57) | Measured same-denominator offline lifecycle, without weakening revoke, replay, Target, or terminal checks |
| Unsaved preview pixels | BLOCKED_FEASIBILITY | Verified authorized pixel capture with real browser evidence or explicit approved contract revision |
| OWNER-01/02 | DEFERRED_OWNER | Firefox+Violentmonkey and actual MCP Connector/OAuth acceptance by the operator |
| OWNER-03/04 | DEFERRED_OWNER | Real unsaved preview capture and Cloudflare migration/quota/billing gates under operator authorization |
| Production operation | PROHIBITED | No deployment, preview builds, endpoint calls, live provider tests or merge before operator approval |

## Fail-closed release decision

An offline CI-successful, checksum-consistent candidate is suitable as **an unmerged review artifact**, not an accepted or deployable 0.3.0 release. PR #25 remains draft and unmerged until the authority's acceptance criteria are met, or the owner explicitly changes them. A standalone installer may be made available for owner's later testing but not auto-deployed.

## Reproduce

```sh
npm ci --no-fund
npm run typecheck && npm test
npm run audit:requirements
npm run audit:requirements:strict  # intentionally fails while unresolved rows exist
npm run build && npm run verify:artifacts
npx wrangler deploy --dry-run --config apps/gateway/wrangler.jsonc
```
