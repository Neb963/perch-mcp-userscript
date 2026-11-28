# R09 — bounded input depth and wire bytes, directly qualified

**Exact verified source:** [2e2f5221baddf0bf404accfe66ea8c3be230c46f](https://github.com/Neb963/perch-mcp-userscript/commit/2e2f5221baddf0bf404accfe66ea8c3be230c46f). **Exact-head offline CI:** [46156403985](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46156403985); **731 tests = 730 PASS, 0 FAIL, 1 historical SKIP**. Tests execute the production `parseDevelopmentCall` implementation called by `apps/gateway/src/index.ts#mcpDevelopment` before Registry authorization or durable Workspace admission.

| Clause | Direct positive/negative observations |
| --- | --- |
| **S03-007** | 18 nested levels and a raw tree exceeding 16,384 nodes raised `LIMIT_EXCEEDED`; bounded input passed. Iterative structural traversal runs prior to Zod shape validation. |
| **S03-008** | 512 KiB inline field passed individual field shape but exceeded serialized 512 KiB transport envelope minus reserved overhead, raising `LIMIT_EXCEEDED`; 200 KB inline write passed. |

Input structural fence: maximum 16 levels and 16,384 nodes; repeated object references (non-JSON input) fail closed; no recursive user-object traversal. Exact encoded byte limit is enforced on standalone parsed args before effects. Existing batch preflight retains its prior independently measured 512 KiB envelope cap. No new grants, permissions or source mutations were performed by these tests.

**Requirement register delta:** 1,317 clauses = **124 PASS, 4 FAIL, 1,150 NOT_STARTED, 24 DEFERRED_OWNER, 1 BLOCKED_FEASIBILITY, 14 SUPERSEDED_BY_OWNER_AMENDMENT**. Both new PASS rows reference the actual test and CI. No SQL/capture/owner gate is reclassified. See [R08](../r08/DIRECT-QUALIFICATION.md) for the earlier ten direct qualifications.
