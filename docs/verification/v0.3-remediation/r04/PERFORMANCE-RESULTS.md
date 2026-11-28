> **Latest benchmark cross-check (2026-11-28):** Exact code `b7daa005b6b3a4e6166a2ac97159cb708a402c29` (offline [CI 46141689975](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46141689975)) retains **187 read/46 write native**, **249/76 legacy** over the identical five-stage lifecycle. The ≤120/40 native objective remains unmet by 67 read rows and 6 written rows. Earlier baselines below are preserved for comparison.

> **Newer verified native/legacy measurement (2026-11-28):** Exact commit `5c045bc74b9be3c5c6bb970a6f0934d5a6cc7c88`, [run 46140138366](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46140138366), is **187 SQL reads / 46 writes native** and **249 / 76 legacy** across the identical five-stage lifecycle. Both remain above the native ≤120/40 objective. Historical tables below intentionally preserve their earlier source SHA and numbers; do not treat them as current.

# R04 measured Cloudflare cost and specification targets

**Current evidence**: exact clean CI head `34657b7a7795c4fad9e28787f522711ce33a673e`, offline run [46105833686](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46105833686), artifact `perch-mcp-remediation-cost-evidence` (native/legacy JSON, uploaded independently before build). SourceDirty=false for both. Miniflare/local SDK only; browser execution was a synthetic terminal receipt, never real Perchance. The original [e742f091 baseline](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46095386706) is preserved.

## Comparable measured lifecycles

All SQL rows count Registry + Workspace. Worker/DO request counts include the complete local SDK request cycle, not just a single MCP call.

| Workload | Native SQL reads | Native SQL writes | Legacy reads | Legacy writes |
| --- | ---: | ---: | ---: | ---: |
| One read operation (admit/poll/running/terminal/status) | 193 | 57 | 246 | 85 |
| Ten separate file writes | 2,330 | 570 | 2,910 | 840 |
| One ten-file write | 233 | 57 | 291 | 84 |
| Ten separate mixed read/write tool operations | 2,130 | 550 | 2,695 | 820 |
| One ten-action mixed batch | 233 | 57 | 291 | 84 |

Ten separate writes versus one grouped ten-file write reduce native SQL rows by **90.0%** (2,330→233 reads; 570→57 writes). Ten heterogeneous actions within one **synthetic Gateway lifecycle** reduce native read rows by **89.1%** (2,130→233) and write rows by **89.6%** (550→57). A synthetic browser did not execute nested native file or DOM actions: do not treat the estimate as real provider effect overhead or a quota guarantee.

**Aspirational target MISS:** Ordinary native lifecycle **193 reads / 57 writes** remains above the specification's *Strive ≤120/40* objective (original v0.2 also unmet). The original v0.3 baseline was 225/57; verified successive optimizations removed 32 reads (14.2%) without removing fresh Grant/Target, durable operation receipts, retry evidence, or late-result revocation. The remaining difference is **73 reads and 17 writes per full lifecycle**. The document expressly says preserve correctness and disclose misses; this target is not authorization to weaken a hard safety invariant.

### Per-stage native lifecycle

| Stage | Registry reads / writes | Workspace reads / writes | Worker requests |
| --- | --- | --- | ---: |
| MCP admission | Included below | Included below | 1 |
| Browser poll/dispatch | Included below | Included below | 1 |
| Browser running acknowledgment | Included below | Included below | 1 |
| Terminal acknowledgment and Registry projection | Included below | Included below | 1 |
| Exact scoped operation_status | Included below | Included below | 1 |
| **Total** | **Combined: 193 reads / 27 writes** | **Combined: 30 writes** | **5** |

Per-stage combined measured reads/writes: admission **43/13**, poll/dispatch **53/9**, RUNNING **15/1**, terminal **59/34**, status **23/0**. Full total **193/57**. Historical provider-by-DO stage splits (97/27 Registry, 128/30 Workspace) were measured at the original 225/57 baseline and must not be mixed with new per-stage totals.

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

- F13.01 suggested SQL-read objective **UNMET** at 193>120.
- F13.02 suggested SQL-write objective **UNMET** at 57>40.
- 10-write amortization **PASS** under the same v2 measured semantics.
- Mixed gateway-only batch SQL reduction **PASS** for the measured synthetic case; complete native workload still requires separate qualification.
- Capacity/free-tier forecasts are models, not billable usage guarantees.
- No live calls or deployment. An offline-qualified candidate cannot imply production quota acceptance.

