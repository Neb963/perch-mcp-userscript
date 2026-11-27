# O01 offline baseline — 2026-11-27

Authority/source: fb998f890e7870afac011f0c54f5035018cfe208, Worker0.1.12/userscript0.1.18. Actual remote main matches. Local locked npm ci succeeded. Node tests use pinned Miniflare4.20260730.0/workerd1.20260730.1, compatibility2026-07-30.

First invocation was stopped by automatic approval review: default Miniflare tried fetching Request.cf metadata. No production acceptance occurred. All emulator fixtures now set cf:false and reject outbound Worker requests. Corrected invocation: `MINIFLARE_DISABLE_CF_FETCH=1 WRANGLER_SEND_METRICS=false npm test`. Result377/377 pass,0 failed/skipped,27.1s local wall proxy. Pure test instrumentation changes do not change product authority.

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
