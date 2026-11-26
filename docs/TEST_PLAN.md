# Verification and release gates

Evidence tiers: T0 static contract/schema review; T1 deterministic unit/fixture tests; T2 local Worker emulator and browser synthetic integration; T3 real Firefox with disposable generator and explicitly authorized provider operations; T4 deployed Cloudflare + real external web connectors; T5 concurrency and recovery run. No tier substitutes for higher-tier provider evidence. Record command, versions, fixture, expected/actual, sanitized logs, commit, date. No private captures. No GitHub Actions for design-only docs; implementation uses local tests first, focused CI as needed.

| Test | Requirements | Required evidence |
|---|---|---|
| A01 | C01–C03 clean deploy/install, no daemon, bootstrap replay/invalid/rotation | T3/T4 |
| A02 | C04–C06 2 Agents same provider, swapped path, cross-token, duplicate registration, refresh/revoke, rebind, stale grant, redirect/PKCE/CSRF, resource mismatch, public bearer denial | T2/T4 |
| A03 | C07 exact PJS/HTML/source bytes, manual edit race, duplicated tab, default/nondefault draft, native Helper busy, undo, binary, zero-byte, path traversal, case collision, partial patch | T1/T3 |
| A04 | C08 unsaved preview, changing sandbox origin, forged message, wrong frame/epoch, preamble ordering, warning/console/lint settle, pixel capture, viewport/reset, frozen page | T2/T3 |
| A05 | C09 execute_js infinite loop/memory, denied network/GM/DOM, workspace escape, cancellation, fetch private/redirect/DNS rebinding/oversize, regex ReDoS | T1/T2/T3 |
| A06 | C10 native saved/stale/clean/challenge/timeout/lost receipt/created-on-update, exact independent source readback, late provider commit, no replay | T2/T3 |
| A07 | C11 disposable create inert then Unlisted, same ID rename, duplicate new ID, owner mismatch, delete approval, uncertain lifecycle effect | T3 |
| A08 | C12 per-tool positive and negative case for every TOOLS.md row; image/music authorized output, server-state backup/restore/seed on disposable fixture, attachment across clients | T3/T4 |
| A09 | C13–C15 import supplied flat ZIP, exclude report, custom fork conflicts, revision rollback, corrupt ZIP/zip bomb/traversal, dependency cycles, resource ACL and tool-only clients | T1/T2/T4 |
| A10 | C16 1/5/10/20 simultaneous independent synthetic workspaces, 5–10 Firefox tabs; same Generator ID writer contention, overload/queue, slow peer, fairness, free-tier measurement | T2/T5 |
| A11 | C17/C20 close tab, sleep, reload, expired lease, late reply, duplicate frame, worker hibernation/restart, revoke while executing, kill switch, redacted logs | T2/T3/T4 |
| A12 | C18/C19 resource export/import and local checkpoint backup, no credentials, schema migration interrupted, compatible rollback, mismatched versions, dirty draft preserved | T1/T2/T3/T4 |
| A13 | C02/C04/C17 UI setup walkthrough and keyboard-only, 1024x768/1920x1080, no double scroll, no blocked native editor on outage, exact copy values | T3/T4 |

### Release rules
All C01–C20 and 22 helper capability outcomes must have passing required tiers; additional observed browser tool outcomes tracked separately. A disabled or unavailable mandatory feature is a blocker, not a pass. Explicitly approved scope changes require client specification revision. Do not call a core preview/source milestone full parity. No live paid API or production state tests without disposable environment and operator authorization. Fixture cleanup verified; unresolved effects remain recorded and isolated. CI static/unit checks can run without secrets; deployment and OAuth interoperability manual or controlled integration environment.

### Capacity targets (provisional)
At 10 connected idle Workspaces, no cross-routing; interactive local read p95 <=2s under normal network, excluding provider/network delays; queue full explicit within 1s of admission; one slow workspace cannot delay unrelated operations beyond baseline + 1s under synthetic load. 20 synthetic concurrent sessions soak 30 min, record p50/p95/p99, disconnects, CPU, request counts, storage, memory, browser process footprint. No absolute promise until measured. Failure injection at every state transition; no silent data loss or unknown->success without reconciliation.
