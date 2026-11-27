# O01 offline baseline — 2026-11-27

Authority/source: fb998f890e7870afac011f0c54f5035018cfe208, Worker0.1.12/userscript0.1.18. Actual remote main matches. Local locked npm ci succeeded. Node tests use pinned Miniflare4.20260730.0/workerd1.20260730.1, compatibility2026-07-30.

First invocation was stopped by automatic approval review: default Miniflare tried fetching Request.cf metadata. No production acceptance occurred. All emulator fixtures now set cf:false and reject outbound Worker requests. Corrected invocation: `CLOUDFLARE_CF_FETCH_ENABLED=false WRANGLER_SEND_METRICS=false npm test` (the explicit `cf:false` fixture setting enforced isolation in the recorded baseline; the pinned runtime environment override is `CLOUDFLARE_CF_FETCH_ENABLED`). Result377/377 pass,0 failed/skipped,27.1s local wall proxy. Pure test instrumentation changes do not change product authority.

| Warm path | SQL reads | SQL writes |
|---|---:|---:|
| Idle, empty/history150 |10|0|
| Active waiting |25|0|
| Status |19|0|
| Invalid well-formed lease |2|0|
| Lifecycle Workspace, first/last |150/152|43/42|
| Lifecycle Registry, first/last |42/44|32/28|
| Both DO lifecycle |192/196|75/70|
| Activity100 first page |108|0|

Real consumed SQL cursor rows, not mock row counts. Same fixture and sample ordering as existing gateway-capacity test; tiny read main.pjs args, tiny marker result, no source bodies. Lifecycle includes authorization/admission/poll/RUNNING/terminal/status and synchronous receipt drain. It excludes actual OAuth/MCP ingress, later retention/alarm, media, renewal, cold initialization. Those costs require separate measurement and must not be attributed zero.

Production counters, billing, physical hibernation, Firefox/Violentmonkey and provider evidence: DEFERRED_LIVE. No deployment/preview, remote Wrangler, production endpoint or provider operation authorized. Branch PR remains unmerged.

Full-ingress extension uses a test-only subclass entrypoint, consumes actual SQL cursors, and counts every underlying Registry/Workspace fetch, alarm API call and OAuth KV method. Fixture metrics routes bypass accounting and perform no SQL. Test-only entrypoint has no release import. Actual local SDK registration, S256, approval, code/token exchange and legacy MCP HTTP are exercised; Worker outbound denied. Cold bootstrap/setup aggregate is reported separately, not attributed to steady idle. Wall time includes fixture instrumentation and response-byte measurement; it is not CPU or GB-s billing.

| Retained history before call | Full MCP lifecycle SQL reads | Writes | Worker requests | Registry/Workspace requests |
|---|---:|---:|---:|---:|
|0|218|72|5|8/5|
|150|225|70|5|8/5|
|999|239|70|5|8/5|
|1000|249|84|5|8/5|

Includes actual bearer validation, one status retrieval, RUNNING, terminal and synchronous notice drain. OAuth acquisition is separate. Each operation retrieval validates OAuth KV; exact method counts, statements, alarms, bytes and startup are in gateway-optimization-baseline.json. Later TTL cleanup remains separate and requires synthetic time/alarms. The 1000 boundary exposes rolling Activity serialization/retention cost that clean idle excludes. Reproduce with `node --import tsx scripts/benchmark-gateway.ts <output>`; for baseline use detached fb998f8 with the exact test-only harness/fixture/script copied from this branch (no product-source changes).
