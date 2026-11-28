# A01 — Exact production Registry discovery qualification

**Verified code:** `0c4a44e9c1006f329f2efe3cf9813a712c1c4425` (tree `6346f68e81e0f2fa1e4d8d96b03f5ff372984943`). [CI 46147393916](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46147393916), successful. Full suite 709 tests: 708 pass, 0 fail, 1 historical skip.

Named test: `A01 exact owned targets, isolated discovery trace, 50-Workspace pagination and stale cursor` in `tests/integration/assignment-contract.test.ts`. Local workerd uses real Registry routes, actual SQLite storage and synthetic authorized operator/Grant setup, no network/provider deployment. The test is reported as ok 12 in the exact run.

| Atomic clause | Direct observed test assertion |
| --- | --- |
| A01-connector-a | Exact canonical Target Workspace IDs are W1 and W2; terminal cursor null. |
| A01-connector-b | Exact canonical Target Workspace ID is W3 only; terminal cursor null. |
| A01-empty-connector | C workspaces empty, cursor null. |
| A01-no-fanout | Request-local fixture trace sees every SQL statement (overflow fails, not truncates); each is the exact canonical keyed read. Only the current core, Grant, Connector, assignment index and selected Workspace keys are allowed, and returned Workspace rows equal the Workspace-read key multiset. Workspace namespace get/getByName count is zero. |
| A01-bounded-cursor | Fifty assigned records returned in stable canonical order in pages of at most seven, no omissions/duplicates; first page repeat identical cursor; real unassignment invalidates old cursor with STALE_CURSOR; fresh page returns remaining 49. |

Trace is explicitly enabled only in the synthetic fixture entrypoint, not the deployed Worker. No foreign source or production identifiers are inspected. Actual client interoperability remains OWNER-gated. This qualifies these five specific clauses, not all F10 or A01-adjacent requirements.

Separate test `Canonical record integrity refuses missing, noncanonical and oversized parts without mutation` (ok 583) qualifies the defensive read change: valid JSON orphan/gap, negative/fractional part and oversized chunk reject, preserve original data, and legitimate multi-part Unicode records round-trip. It does not establish cryptographic integrity for arbitrary same-length valid JSON modifications.

Native workerd lifecycle 187/44 and legacy 251/74 retain the performance FAIL records. This evidence commit changes documentation only; artifacts for the verified implementation commit remain labeled with their actual source SHA.
