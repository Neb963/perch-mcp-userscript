# R07 — direct documentation contract qualification, exact-head CI

**Source/CI authority:** [code 5cf2aa7](https://github.com/Neb963/perch-mcp-userscript/commit/5cf2aa7fa1346d7b1a4df4f6578dca29fa4d38f3), [offline run 46150545750](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46150545750): **727 PASS, 0 FAIL, 1 historical SKIP**. All eleven named documentation assertions passed at recorded test numbers 337–347. Locked typechecking, native/legacy synthetic workload, requirements audit, release package/hash verification and Wrangler dry-run (no deployment) succeeded. An earlier candidate b636555 failed typecheck because test fixtures used an untyped array of pairs; 5cf2aa7 corrected that test typing and passed the complete rerun. No runtime logic was modified in R07.

| Requirement | Directly examined source and observation |
| --- | --- |
| S00-003 | docs/DESIGN.md: full authority boundary table, source/saved Revision separation, preserved historical architecture; explicit CLEAN-INSTALL-01 authority restated in the accompanying documentation-only register commit |
| S00-010 | DESIGN/PROTOCOL/TOOLS/SETUP/HANDOFF historical sections remain present; revision-3 explicit preservation |
| S00-011 | v0.3/TOOL-DISPOSITION.md: 52 unique original tool names, Retain/Retire maps, active v2 and original permission separation |
| S00-012 | v0.3/REMEDIATION-AUTHORITY.md and REQUIREMENT-TRACEABILITY.md preserve A01–A34 and F01–F27 outside explicit amendments |
| S00-013 | BASELINE.md pins main/tree/PR/CI/574-pass reference, measured divergence, and nine regression groups |
| S00-015 | todo.md records R00–R05 plans, independent phase commits/tests, blockers and owner boundary |
| S00-016 | All A01–A34 have exactly one normative §12 source row, matrix section and atomic case. Independently inspected all **1,317** register entries: every entry has a nonempty authority/requirement/acceptance criterion; no duplicate row ID. These checks do **not** qualify any scenario's runtime behavior |
| S02-049 | agent-knowledge/AGENT-INSTRUCTIONS.md and START-HERE.md forbid first/old Target fallback and demand explicit operator selection |
| S02-101 | docs/CONNECTORS.md describes same-resource reconnect, explicit re-consent, 19-name catalog comparison, scoped discovery, second attempt and fail-closed final state. Real external-client UI acceptance remains OWNER-02 |
| S04-016 | Agent instructions forbid replaying UNKNOWN by generating a new operation key |
| S04-080 | Agent instructions state cross-segment partial outcomes and separate final Save; they do not assert batch effect atomicity |

**Strict inventory following these eleven T0-only promotions:** **1,317 total; 112 PASS, 4 FAIL, 1,162 NOT_STARTED, 24 DEFERRED_OWNER, 1 BLOCKED_FEASIBILITY, 14 SUPERSEDED_BY_OWNER_AMENDMENT, 0 IMPLEMENTED_UNVERIFIED**. The claims are confined to document authority. No additional runtime behavior, actual native screenshot, production billing or OAuth client interoperability was qualified.

**Remaining named hard gaps:** S07-023 unsaved exact pixel evidence; S08-058/F13.01/F13.02 native SQL ≤120/40 target (measured **187 read/44 written**, legacy251/74), and the many unqualified rows. The document fixes do not reduce that cost. Owner-only real browser, OAuth, preview, quota/deployment and cutover tests were not executed. Draft PR #25 remains unmerged.
