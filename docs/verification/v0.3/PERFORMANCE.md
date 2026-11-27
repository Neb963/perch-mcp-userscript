# v0.3 offline performance evidence

The benchmark drives the production SDK OAuth/MCP ingress in local workerd, with actual consumed SQL cursors, Registry/Workspace invocations, alarms, KV, and response-byte instrumentation. It simulates browser dispatch and terminal replies. Runtime outbound access is denied. The Meter replay commit and clean-source flag are recorded in each JSON file. Local wall time is a proxy and does not establish provider CPU or billed duration.

| Lifecycle, total Registry and Workspace SQL | v0.2 legacy | v0.3 legacy | v0.2 native | v0.3 native |
|---|---:|---:|---:|---:|
| Ordinary read, 0/150/999/1,000 retained | 232–255 reads, 78–87 writes | 280–300 reads, 80–89 writes | 177–182 reads, 51–52 writes | 225–227 reads, 53–57 writes |
| Ten separate v0.3 writes | — | 3,520 reads, 980 writes | — | 2,730 reads, 610 writes |
| One ten-file v0.3 write | — | 352 reads, 98 writes | — | 273 reads, 61 writes |

Both modes reduce measured rows by 90% for one ten-file tool call against ten individual calls, including scoped segment permissions. This is a transport and ledger comparison. Synthetic native adapter fixtures separately verify selected reads, exact write paths and coherent staged source publication. A mixed write/preview/eval workload still needs metered comparison.

Ordinary native lifecycle misses the 120-read/40-write target. The v2 denominator adds scoped authorization at request, replay, dispatch, and result delivery, plus durable key lookup. Separate workerd phases in the raw files show the overhead. Admission remains off by default. Combining result authorization with safe readback and minimizing duplicate request-local authentication are avenues for reducing reads, subject to revoke and late-result races.

| Assigned Workspaces | 1 | 5 | 10 | 20 | 30 | 50 |
|---|---:|---:|---:|---:|---:|---:|
| Total SQL reads for one scoped discovery page | 19 | 27 | 37 | 57 | 77 | 117 |
| SQL writes | 0 | 0 | 0 | 0 | 0 | 0 |

There are four combined Worker/DO requests, one KV get and zero KV puts for each page in the measured fixture. Discovery only loads owned indexed rows. Additional Workspaces do not create per-chat heartbeats or background pollers.

## Capacity projection

These figures are scenario budgets, separate from actual account billing. Cloudflare shares allowances across the account. Billed DO requests and duration include provider activity that this harness cannot reproduce exactly, such as physical hibernation, lease timers, cold eviction and non-test storage. No account usage was queried.

| Meter | Workers Free | Workers Paid included |
|---|---:|---:|
| Worker requests | 100,000/day | 10 million/month |
| Durable Object requests | 100,000/day | 1 million/month |
| Durable Object duration | 13,000 GB-s/day | 400,000 GB-s/month |
| SQLite rows read | 5 million/day | 25 billion/month |
| SQLite rows written | 100,000/day | 50 million/month |
| SQLite storage | 5 GB | 5 GB-month |
| KV gets | 100,000/day | 10 million/month |
| KV writes | 1,000/day | 1 million/month |

Sources [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [KV pricing](https://developers.cloudflare.com/kv/platform/pricing/). Paid Standard starts at $5/month, with usage charges above included limits.

Using 57 SQL writes plus two worst-sampled alarm sets per ordinary native read lifecycle, 100,000 writes supports a theoretical 1,694 operations/day before idle/recovery costs and other account traffic. With 20 Workspaces the same arithmetic is about 84 each. Legacy at 89 SQL writes plus two alarm sets supports about 1,098/day. Ten-write batches make the ratio of useful source changes to durable operations much higher. No capacity guarantee follows from these floors.

Five actual immediate v1 SDK refresh rotations measured two KV gets and two KV writes each. The v2 Connector shares that pinned SDK. If every active client refreshes once per TTL around the clock, the model is:

| Access TTL | 10 Connectors KV writes/day | 20 Connectors KV writes/day |
|---|---:|---:|
| 15 min, retained default | 1,920 | 3,840 |
| 30 min, modeled | 960 | 1,920 |
| 60 min, modeled | 480 | 960 |
| 120 min, modeled | 240 | 480 |

Early/concurrent refresh, issuance, and unrelated KV writes consume additional budget. Neither verified elapsed alternate TTL behavior nor actual client refresh schedules were measured. The deployment retains 900 s access tokens, rotating refresh, exact resource audience and fresh Registry checks. No operational guarantee for ten continuously refreshing Free Connectors. OWNER-04 must verify real billing, hibernation and completion/recovery reserve.
