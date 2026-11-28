# R04 — SQL cost target, invariants, and architectural options

Evidence: local Miniflare/full SDK, exact source `34657b7a7795c4fad9e28787f522711ce33a673e`, [offline run 46105833686](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46105833686). Current ordinary native lifecycle **193 SQL rows read / 57 written**. The implementation specification §8.1 says **“Strive <=120 reads/40 writes native including amortized cleanup (v0.2 unmet); compare legacy/native and disclose misses; preserve correctness.”** It is an optimization objective, not permission to weaken security or durable truth.

## Measured causal budget

| Full lifecycle stage | Native SQL reads | Native SQL writes | Authority boundary |
| --- | ---: | ---: | --- |
| MCP admission | 43 | 13 | OAuth Grant/Target preflight, Workspace lease, idempotency and canonical ADMITTED |
| Browser poll/dispatch | 53 | 9 | Queue, exact lease and fresh Registry dispatch permit |
| Browser RUNNING acknowledgement | 15 | 1 | Exact operation + verified local intent |
| Terminal/Registry Activity | 59 | 34 | Durable terminal result, outbox, consumed permit, terminal notice, Activity and reconciliation |
| Scoped operation_status | 23 | 0 | Fresh Grant, exact Target and immutable result scope |
| **Total** | **193** | **57** | All five phases retained |

The remaining difference from aspirational 120/40 is **73 reads / 17 writes**, i.e. ~38% of current read rows and 30% of writes. Independent verification of each boundary is more important than a lower counter. A stage can be removed from the *workload* only if the real client no longer calls it, not by selectively omitting it from measurements.

## Low-complexity changes already completed

- Validated v2 tools/call skips only redundant generic ingress authorization; the exact permission/Target check remains.
- Synchronous nonimage result skips redundant post-hydration recheck; images retain a revocation fence after all asynchronous I/O.
- V2 browser RUNNING and terminal acknowledgements reconcile the exact operation deadline within a synchronous canonical transaction rather than scanning unrelated history; expired effects retain UNKNOWN or late observation.
- Known terminal notices avoid no-op Activity overlay reads.
- Admission uses one canonical stats snapshot for pending/hold caps instead of repeated reads.
- Registry/Workspace query-shape telemetry was added as **opt-in** offline diagnostic data, without SQL arguments or secrets; production remains off.
- These changes reduced full native read rows **225→193 (14.2%)** while retaining 57 writes. Legacy compatibility still passes.

## Structural options (not implemented, not approved as release changes)

| Candidate | Possible saving | Hard invariants and cost |
| --- | --- | --- |
| Coalesce additional read-only SQLite lookups within one synchronous transaction | A few reads; unlikely to close the target alone | Every raw write, trigger and nested call must invalidate the cache; no cache across async boundaries |
| Specialize v2 Registry ephemeral terminal/permit projections | Potentially several write rows per completion | Terminal/replay/hold/retention indexes must remain bounded; v1/unknown-effect compatibility, historical migrations, and rollback required |
| Combine native Activity and terminal-notice metadata into one canonical event store | Potentially material terminal write reduction | Requires new **schema version**, shadow projection, rebind/suspended-client replay tests and rollback plan; no sudden replacement of existing stores |
| Replace repeated registry authorization with stale positive cache or long-lived bearer authority | Might save SQL reads | **Prohibited**: revoked Grant must deny new effects, rebind must fence stale Target, and asynchronous image bytes must reauthorize |
| Remove RUNNING acknowledgment, status proof or terminal outbox | Would reduce lifecycle work | **Prohibited**: changes effect-truth, receipt loss, cancellation, or recovery semantics |
| Batch independent compatible actions on one Target | **Measured** 10 separate write lifecycles 2,330/570 vs one grouped write 233/57; heterogeneous gateway-only 2,130/550 vs 233/57 | Supported *today*, needs exact preflight and correct dependencies; these synthetic gateway measurements do not include real nested browser/native effect cost |

## Additive migration strategy for a new physical schema

A prospective v3 optimization is **not** a small implementation patch. If a measured index redesign demonstrates a credible path to <=120/40:

1. **Baseline and falsifiable hypotheses.** Record SQL query fingerprints, read/write rows, index plans, cold/warm 0/150/999/1000-history, v1/native comparable lifecycle and 10/20 Connector benchmarks. Specify expected savings per phase and affected indexes. Reject a proposal that just shifts work to a deferred cleanup or drops rare-event costs from the denominator.
2. **Shadow schema.** Introduce versioned native v3 schema alongside v2. All v2 writes remain canonical. Populate v3 with secret-safe derived projections; mirror mutations on a bounded fixture without changing v2 permission behavior. Validate exact equality of auth, Activity, terminal receipts, unknown holds, retention and sorted cursors.
3. **Read-only comparison.** Add a debug-only shadow read with mismatch incident logs that never affect operation outcome. Inject lost RPC, stale Binding, concurrent revocation, late image hydration, interrupted migration and quota faults. Verify bounded index query plans at history=1000 and 50 Workspaces.
4. **Operator-gated cutover.** Activate v3 only behind an explicit persistent schema marker and operator-approved flag, preserve v2 records and a one-way rollback contract if v3 wrote canonical data. Do not silently revert to v2 after v3 authority.
5. **Measured qualification.** Only after exact-head CI and operator-authorized live billing evidence report <=120/40 as achieved. A green unit suite, modelled amortization, or source code inspection is insufficient.

## Recommendation and release decision

The current system already realizes the largest grounded economic improvement through **amortizing independent work**: a grouped ten-file write consumed **233 reads / 57 writes** total, or 23.3/5.7 per logical file in synthetic Gateway accounting. This is not an ordinary per-operation result and not a substitute for the aspirational target.

Do **not** undertake an irreversible multi-table migration solely to hit 120/40 before comparing its security, maintenance, recovery, and deployment risk against the actual operator's free-tier quota pressure. The unresolved numeric target stays **UNMET**. Existing userscript, Worker, docs and offline CI remain on an unmerged branch; no cloud or Perchance live tests are authorized.

