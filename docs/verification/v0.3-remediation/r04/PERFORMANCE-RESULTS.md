# R04 measured Cloudflare cost and specification targets

**Evidence version**: exact clean CI head `e742f091d574a894c7bc07badb2ed61a53b3c176`, offline run [46095386706](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46095386706), artifact `perch-mcp-remediation-cost-evidence` (native/legacy JSON, uploaded independently before build). SourceDirty=false for both. Miniflare/local SDK only; browser execution was a synthetic terminal receipt, never real Perchance.

## Comparable measured lifecycles

All SQL rows count Registry + Workspace. Worker/DO request counts include the complete local SDK request cycle, not just a single MCP call.

| Workload | Native SQL reads | Native SQL writes | Legacy reads | Legacy writes |
| --- | ---: | ---: | ---: | ---: |
| One read operation (admit/poll/running/terminal/status) | 225 | 57 | 280 | 85 |
| Ten separate file writes | 2,660 | 570 | 3,260 | 840 |
| One ten-file write | 266 | 57 | 326 | 84 |
| Ten separate mixed read/write tool operations | 2,485 | 554 | 3,040 | 820 |
| One ten-action mixed batch | 266 | 57 | 326 | 84 |

Ten-file batching reduces native SQL reads/writes by **90.0%**. Heterogeneous *gateway lifecycle only* batching reduces native reads by **89.3%**, writes by **89.7%**. A synthetic browser did not actually execute the nested read/write/preview actions: no claim is made about real DOM or native source I/O, memory or latency.

**Normative target MISS**: Ordinary native lifecycle 225 reads/57 writes remains above suggested target <=120/40. Previous baseline v0.2 native 177–182/51–52. v0.3 conformance incurs additional exact Connector/Grant/Target and durable receipts. The remaining gap is **105 reads and 17 writes per complete operation**, with safety invariants intact.

### Per-stage native lifecycle

| Stage | Registry reads / writes | Workspace reads / writes | Worker requests |
| --- | --- | --- | ---: |
| MCP admission | 24 / 0 | 26 / 13 | 1 |
| Browser poll/dispatch | 8 / 3 | 45 / 6 | 1 |
| Browser running acknowledgment | 0 / 0 | 20 / 1 | 1 |
| Terminal acknowledgment and Registry projection | 34 / 24 | 32 / 10 | 1 |
| Exact scoped operation_status | 31 / 0 | 5 / 0 | 1 |
| **Total** | **97 / 27** | **128 / 30** | **5** |

Terminal and dispatch persistence dominate SQL writes. Status point lookup retains the old Workspace-specific <=5 SQL reads, but required Registry scope authorization adds 31 reads. It is unsafe to omit fresh Grant/revocation, operation receipts or late-result ACL to reach numerical targets. Optimizations must prove effect safety across fail/retry/rebind and use equal workload denominators.

### Bounded scale

- Owned discovery with **1/5/10/20/30/50 Workspaces** used **19/27/37/57/77/117 Registry SQL reads**, **zero writes**, one Worker request per discovery. This is linear in **owned Workspace count** and independent of unrelated history; 50 Workspaces returned ~68.5 KiB.
- **10 and 20 independent Connectors** discovered empty assignments with 18 Registry reads/client and 1 Worker request/client; no Workspace SQL.
- Issuing ten synthetic Connectors used 40 KV puts total and 80 Worker requests, including SDK DCR/PKCE/approval/token exchanges. Do not model this one-time setup as recurring token refresh. Next ten issued another 40 KV puts.
- OAuth access tokens: backed by permanent consent and refresh credentials. SDK validated 15m through 10 years. **Default now 24 days** because a single browser timer over 2^31-1 ms can overflow; 10 years remains an explicit unqualified override. OWNER-02 must test real client refresh; OWNER-04 must measure actual KV usage.
- New v2 local-compute admission no longer reserves 1,000 fictitious remote child calls. v1 retains conservative legacy budgeting. Completion/resolution retain existing reserves; admission remains disabled until operator live costs are established.

### Metrics covered and not covered

Covered: Worker requests, DO requests, measured SQL cursor rows read/written, alarm gets/sets, KV gets/puts, response bytes, local elapsed time, serializable operation receipts, indexed discovery and full synthetic lifecycle. Uncovered: account-wide Cloudflare billing, real browser GM IO/cost, native src content reads in these gateway benchmarks (separate source tests exist), paid CPU time, DNS/retry behavior of real OAuth client, multi-tenant concurrency outside fixture, 24h production idle.

### Release qualification

- F13.01 SQL-read target **FAIL** at 225>120.
- F13.02 SQL-write target **FAIL** at 57>40.
- 10-write amortization **PASS** under the same v2 measured semantics.
- Mixed gateway-only batch SQL reduction **PASS** for the measured synthetic case; complete native workload still requires separate qualification.
- Capacity/free-tier forecasts are models, not billable usage guarantees.
- No live calls or deployment. An offline-qualified candidate cannot imply production quota acceptance.

