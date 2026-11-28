# R11 — scoped result authorization cost experiment

**Verified code checkpoint:** `8cd13c464de346167d022b83a332d387e77aef5f`. **Offline [CI 46158850513](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46158850513)** passed all jobs, including F05 image hydration, post-hydration revocation and the new original-Grant authorization/cancel test. Comparison source [`cbef2a2`](https://github.com/Neb963/perch-mcp-userscript/commit/cbef2a233a1e3fdb21da2c315aa0d1eec80853c6), [CI 46158172940](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46158172940). The five-stage Workerd/SDK denominator and fixture are unchanged.

| Stage | Before native reads/writes | After native reads/writes |
| --- | ---: | ---: |
| MCP admission | 44/10 | 44/10 |
| Browser poll/dispatch | 50/8 | 50/8 |
| RUNNING acknowledgement | 14/1 | 14/1 |
| Terminal receipt/outbox | 56/25 | 56/25 |
| Scoped status | **23/0** | **16/0** |
| **Total** | **187/44** | **180/44** |

Registry read count for scoped status decreased **18 → 11**; Workspace status remained **5/0**. Legacy read/write changed **251/74 → 244/74**. Exact result: 7 fewer Registry read rows per operation, no change to writes. Required native **≤120/40 is still FAILED**, with 60 reads and 4 writes remaining over target. This optimization does not change lifecycle denominator, test conditions, or requirement statuses.

**Structural change:** The previous Worker `mcpDevelopment` result/cancel path performed a generic Registry Target authorization, then Workspace independently performed the *original Operation scope* authorization at `authorizeScopedResult`. The first call duplicated Registry reads but did not qualify original-Grant/Operation ownership. The Worker now forwards authenticated request scope to Workspace. Workspace checks original Connector, Grant, Target and permissions with fresh Registry authority; it reuses returned Workspace bindingRevision for both the exact operation revision fence and image hydration, and rechecks revocation after asynchronous image hydration. This retains unknown-result, cancellation and historical compatibility semantics.

**Negative regression and correction:** First experiment CI [46158519983](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46158519983) was red (3 F05 failures). The removed Worker authorization had supplied the bindingRevision required by image hydration. The corrected `workspace.ts` uses the mandatory fresh authorizer's bindingRevision and retains the separate image transport and post-hydration authorization. The synthetic fixture's revocation hook now arms on its third rather than fourth Registry authorization, preserving the actual revocation-after-hydration assertion. Second CI passed.

**Remaining falsifiable work:** Measure Registry/Workspace repeated reads on admission and dispatch and physical `Operation`/`Activity` index write amplification across newly prepared and historical schemas, with explain plans and all original recovery/authorization regressions. Revert future changes that do not improve this exact workload. Do not interpret aggregate CI PASS as SQL acceptance.
