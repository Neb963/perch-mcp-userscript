# R06 direct S00 documentation authority qualification

Scope: **T0 only**. These eight clauses require documentation content, not a functioning provider or runtime. Each is independently asserted in `tests/unit/document-authority.test.ts` against the actual on-disk documents. The original canonical authority is `docs/v0.3/PERCH-MCP-V0.3-IMPLEMENTATION-SPEC.md` with revision 3 amendments in `docs/v0.3/REMEDIATION-AUTHORITY.md`.

| Requirement | Source of truth examined | Direct acceptance observation |
| --- | --- | --- |
| S00-001 | `CLIENT_SPEC.md` | Explicitly links normative v0.3 spec, states 19 tools and requires Operator activation |
| S00-002 | `AGENTS.md` | Revision 3, repair branch, unmerged PR, and offline/no-preview/production boundary explicit |
| S00-004 | `docs/PROTOCOL.md` | v2 Target, legacy v1 profile, mismatch denial and retained Grant readers separated |
| S00-005 | `docs/TOOLS.md` | First v2 table has **exactly 19 unique ordered names**: read, write, delete, rename, list_files, page_eval, page_refresh, preview_diagnostics, set_viewport_size, capture_page_image, execute_js, fetch_url, fetch_generator, workspace_status, generator_info, save_generator, operation_status, cancel_operation, batch; historical v1 section is separate |
| S00-006 | `docs/CONNECTORS.md` | Canonical audience, Connector Grant, explicit Assignment and same-Connector conversation reuse stated |
| S00-007 | `docs/SETUP.md` | Clean v2 staged rollout, one-time new consent, retained bindings/KV and Operator-only activation documented |
| S00-008 | `docs/EVIDENCE.md` | Exact historical tested head and CI, separate v0.3 authority, baseline numbers and new evidence requirements described |
| S00-009 | `docs/TEST_PLAN.md` | T0/T1/T2/T5 evidence tiers and explicitly deferred OWNER-01–04; pixel versus stored-source proofs separated |

**Verified exact-head execution:** [commit d78a023](https://github.com/Neb963/perch-mcp-userscript/commit/d78a023ad0f2171cbf0732d24fdb0b73b9ea85dc), [offline CI 46149708275](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46149708275), **716 passed / 0 failed / 1 historical skip**. CI log explicitly reports eight passing S00 tests (numbers 329–336); full typecheck, native/legacy benchmark, build/checksums and Wrangler dry-run succeeded. All eight document-only T0 rows are promoted to PASS in SPEC-00-05.md; no runtime/provider behavior is inferred. Initial CI 46149463624 uncovered an over-escaped *test regex* (715 passed / 1 failed / 1 skip). The corrected test at d78a023 uses exact Markdown table-row parsing; it passed in the complete rerun. No browser, endpoint, preview, provider mutation, deployment or merge occurred.

**R06 negative optimization result:** on exact commit `6a25baf85809ddd9d204c8c8a610ea97b8f00f64` [offline CI 46148963399](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46148963399) passed 713/0 with one historical skip, full build/hashes/dry-run. The tested bounded transaction-local SQL read cache saved **zero** rows: native admission44/10, poll50/8, running14/1, terminal56/25, status23/0 = **187/44**; legacy **251/74**. Compared to the implementation without the cache `0c4a44e`: native 187/44, legacy251/74. The cache was rejected and removed in the succeeding corrective commit; the five isolated cache tests were removed with it. There is no performance promotion and the three numeric target FAIL rows remain FAIL.

**Unresolved:** unsaved verified native preview pixels S07-023; native SQL objective S08-058/F13.01/F13.02 ≤120/40; all other individually unqualified rows; 24 OWNER items, and the feasibility-blocked item. No live tests, Cloudflare deployment, Cloudflare preview or merge occurred.
