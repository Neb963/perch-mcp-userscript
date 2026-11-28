# R13 — rejected native admission maintenance predicate

**Experiment commit:** [`5eaaed8a97f17a23298bbcad38708fa9a3f10ac4`](https://github.com/Neb963/perch-mcp-userscript/commit/5eaaed8a97f17a23298bbcad38708fa9a3f10ac4), CI [46159986488](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46159986488). The run passed typechecking, offline tests and the native/legacy five-stage benchmark. The measured benchmark is from this exact experimental code, not production deployment. Baseline R11 [CI 46158850513](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46158850513), source `8cd13c464de346167d022b83a332d387e77aef5f`.

| Same five-stage fixture | Baseline R11 | Experiment R13 | Delta |
| --- | ---: | ---: | ---: |
| Native admission SQL rows read/written | 44/10 | 45/10 | **+1 read** |
| Native total SQL rows read/written | **180/44** | **181/44** | **+1 read** |
| Legacy total SQL rows read/written | 244/74 | 244/74 | no change |

**Hypothesis:** A native-only synchronous indexed `SELECT CASE WHEN EXISTS(...)` check could skip `Workspace.expire()` when no operation deadline, retention excess, dirty maintenance record or incomplete storage-preparation state existed, saving SQL query rows at admission. The admitted operation's authorization, lease, Target, original Grant, idempotency and terminal receipt paths were not changed.

**Disproof:** The conditional SQL predicate itself required more rows than the cleanup work saved in the unchanged Workerd fixture. The experiment was not effective against the user-specified per-operation SQL objective; maintaining two code paths would add complexity and failure modes for no benefit. No security relaxation was used, and legacy workload was unchanged.

**Disposition:** Reverted runtime change by restoring `apps/gateway/src/workspace.ts` to the parent R12 version. Original expiration behavior is preserved, including overdue operation and historical maintenance branches. Do not repeat predicate variants without an independently measured reason to expect net savings. Focus next on material Registry terminal and poll stage read/write amplification and validated index opportunities. **SQL remains FAILED**: native 180/44 vs ≤120/40.

No live provider operations, Cloudflare deployment or PR merge occurred.
