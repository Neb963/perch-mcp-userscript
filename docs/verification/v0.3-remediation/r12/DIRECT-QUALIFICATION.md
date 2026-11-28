# R12 — v2 public catalog and development input direct qualification

**Exact tested source:** [`5451c65b80cc0a0b25ac9905f03c15ddd7ccdfea`](https://github.com/Neb963/perch-mcp-userscript/commit/5451c65b80cc0a0b25ac9905f03c15ddd7ccdfea), tree `22955f1c19828fa0f2a8cb14a880fbd28a042e03`. **Offline CI:** [46159246081](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46159246081), **733 PASS/0 FAIL/1 historical SKIP**, typecheck, full offline builds, artifact verification, SQL benchmarks and nondeploying Worker dry-run passed. Source inputs remained synthetic, with no production operations.

| Requirement | Direct production-path assertion and observed outcome |
| --- | --- |
| **S03-011** | Real Workerd v2 SDK `tools/list` returned precisely the 19 accepted tool names; unavailable `capture_page_image` remained present. Legacy `skill`, `read_image`, `generate_image`, `get_workflow` absent |
| **S03-012** | The same actual `tools/list` response advertised capture but its description disclosed that the current userscript lacks a verified exact-preview pixel interface and returns `UNSUPPORTED_INTERFACE` |
| **S03-014** | The actual SDK catalog returned `readOnlyHint=false` for 11 enumerated effectful, mixed or open-world tools, including `batch`, `execute_js`, `page_eval`, `fetch_url`, `save_generator` |
| **S03-015** | Real `parseDevelopmentCall` accepted a bounded `read`→`write` batch; rejected nested privileged management/Save/status/cancel/recursive batch, unknown tool and network POST |
| **S03-021** | Production parser rejected effectful `write`, `page_refresh`, `save_generator`, mutating `batch` without outer `operationKey`; positive mutation with canonical key succeeded |
| **S03-022** | Production parser accepted the same pure `read` with no operation key and with a valid canonical key |
| **S03-023** | Production parser rejected nested `target`, `operationKey` and `waitMs` delivery fields inside a valid outer batch |

**Selectors:** `tests/integration/result-scope-v2.test.ts` — `W2 v2 result and cancel enforce original Grant/Target at Workspace before releasing or mutating` (includes real SDK tools/list assertions); `tests/unit/development-v2.test.ts` — `S03-015/021/022/023 wire input enforces closed batch and exact delivery fields`.

**Register delta:** exactly seven `NOT_STARTED`→`PASS`: 1,317 total = **132 PASS, 4 FAIL, 1,142 NOT_STARTED, 24 DEFERRED_OWNER, 1 BLOCKED_FEASIBILITY, 14 SUPERSEDED**. No evidence of actual unsaved-preview screenshot pixels was produced; `S07-023` stays FAIL. Native SQL 180/44 remains above the 120/40 requirement, and all owner-reserved real-provider acceptance remains outstanding.

**Offline artifacts:** [CI artifact 15268593134](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46159246081/artifacts/15268593134). Candidate ZIP SHA-256 `45d1b7c4bb5689e9e7abaa40bbca37a683c83653e64e90dfed74a80799989048`; byte-identical userscript TXT and JS SHA-256 `363e96ca254329e10604c2b8287743b788a38e1806657e21a270ca80b85c7bb0`.
