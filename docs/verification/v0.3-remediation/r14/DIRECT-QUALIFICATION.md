# R14 — result projection, wait bounds and selected-file read authorization

**Exact tested source:** [`324fd2f348232b90830f8debbd1cf698e1d56fd0`](https://github.com/Neb963/perch-mcp-userscript/commit/324fd2f348232b90830f8debbd1cf698e1d56fd0). [CI 46160911551](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46160911551) **SUCCESS — 736 PASS, 0 FAIL, 1 historical SKIP**. Typecheck, full unit/Workerd integration suite, native/legacy benchmark, package/hash integrity and non-deploying Wrangler build passed.

| Clause | Direct observed production behavior |
| --- | --- |
| S03-010 | `projectMcpImages` rejects a supplied image with inconsistent MIME via typed `INVALID_INPUT`. Production `omitDevelopmentResult` fallback retains the original successful operation identity/status, substitutes `resultAvailability=UNAVAILABLE`, and strips image bytes, nested original source, `resolution` and `lateObservation` fields. Original terminal summary before/after is identical, so projection cannot rewrite admitted effects. |
| S03-020 | Every one of 16 applicable tools through actual `parseDevelopmentCall` accepts 0 and 10,000 millisecond delivery waits, rejects negative, greater than 10,000, fractional and textual values, and leaves execution inputs/timeouts unchanged. `operation_status` separately accepts bounded wait. `cancel_operation` rejects a wait field. |
| S03-028 | Actual `executeDevelopment`→`FilesystemV2.read` returned 64 selected existing private files, only their requested bytes, with byte and line ranges; parser rejects 65 requests. Matching `expectedLocalRevision` succeeded; stale revision was rejected. The read acquired no publication permit. |
| S03-029 | The same browser executor denied read with only `WRITE_SOURCE` and no `READ_SOURCE` (`SCOPE_DENIED`) before bytes were returned or any permit was acquired; exact `READ_SOURCE` positive control returned selected data. |

**Direct selectors:** `tests/unit/gateway-media.test.ts` — `S03-010 rejected image projection keeps the original success receipt and hides all raw bytes`. `tests/unit/development-v2.test.ts` — `S03-020 bounds delivery wait independently of every applicable tool execution timeout`, `S03-028/029 selected local read bounds, ranges, consistency and READ_SOURCE ceiling`.

**Register delta:** four `NOT_STARTED`→`PASS` in `SPEC-00-05.md`; **1,317 total = 136 PASS, 4 FAIL, 1,138 NOT_STARTED, 24 DEFERRED_OWNER, 1 BLOCKED_FEASIBILITY, 14 SUPERSEDED**. No real-provider or browser acceptance attempted. Screenshot pixel requirement `S07-023` remains FAIL. Native SQL five-stage 180/44 remains above ≤120/40 (60 reads/4 writes over).

**Exact-head artifact:** [CI artifact 15269398458](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46160911551/artifacts/15269398458). Candidate ZIP SHA-256 `ba530578dec10ffa3d503405443c6ede39b2f40e0121899cf040aa1b56a0ff49`; byte-identical userscript TXT/JS SHA-256 `363e96ca254329e10604c2b8287743b788a38e1806657e21a270ca80b85c7bb0`.
