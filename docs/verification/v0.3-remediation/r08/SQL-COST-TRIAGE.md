# R08 — measured native five-stage SQL cost triage

**Evidence:** source `d9906633467e72d3ecb1364fb60139b5110a3698`, successful offline [CI 46150920907](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46150920907), native/legacy cost-evidence workflow artifacts and per-route `perch-mcp-sql-usage` query profiles. R08 code changes modify development request preflight only, **not** the Worker SQL execution paths. No new database optimization is claimed.

| Five-stage lifecycle | Registry read/write | Workspace read/write | Combined read/write |
| --- | ---: | ---: | ---: |
| MCP admission | 18/0 | 26/10 | **44/10** |
| Browser poll/dispatch | 9/2 | 41/6 | **50/8** |
| RUNNING receipt | 0/0 | 14/1 | **14/1** |
| Terminal receipt/outbox | 31/16 | 25/9 | **56/25** |
| Scoped status | 18/0 | 5/0 | **23/0** |
| **Same one-operation denominator** | **76/18** | **111/26** | **187/44** |

Required **≤120/40**; shortfall **67 read and 4 written rows**. Legacy workload **251/74**, tracked separately. Terminal is 25 of 44 writes; Registry canonical Activity inserts and retention/receipt reconciliation are important; Workspace operation/stats/index updates and repeated authoritative poll/authorization reads dominate. Most are not removable without recovery or revocation consequences.

**Next falsifiable experiments (no change yet):** (1) profile each current native Operation/Activity write's physical index amplification on new and historical schema and validate all keyset/recovery queries with `EXPLAIN QUERY PLAN`; (2) isolate repeated same-boundary Registry reads, preserving fresh Grant/Target checks across separate requests; (3) test specific structural combining of Workspace lease, operation stats and maintenance metadata without caching authority across async/revocation boundaries; (4) measure idle/background amplification separately. Use exact Workerd five-stage denominator plus restart, uncertain Hold, historical-reader and cross-Connector denial regressions. Revert non-improvements.

**Rejected historical trial:** transaction-local SQL caching on `6a25baf` yielded **zero** reduction (native 187/44), and was reverted. Do not repeat without new hypothesis. Multi-file batch amortization and passing CI do not waive native SQL acceptance. S08-058/F13.01/F13.02 remain FAIL.
