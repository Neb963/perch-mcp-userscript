# Release verification record

Date: 2026-11-26. Classification: **verification candidate, not release-ready and not full functional parity**. The accepted scope C01–C21 has not been reduced. A tool schema, a candidate adapter, or a synthetic provider receipt is not a passing live parity gate.

## Implemented and locally exercised

- Single bundled userscript plus byte-identical TXT mirror; bundled isolated compute Worker and original default knowledge; no runtime package/CDN import.
- One Worker deployment with SQLite Registry/Workspace Durable Objects and OAuth KV. Official pinned OAuth/MCP libraries, exact Agent audiences, S256/client approval, revocation overlay, binding/permission snapshots and isolated tab leases.
- Strict schemas for all 22 mandatory helper names and product additions; tool-only skill/workflow/instruction/document discovery.
- Native source/VFS adapters, binary/empty files, exact preflight patch/edit, RE2 search, parser-based definitions, revision conflict detection, checkpoints, complete saved-source reader and gated Save/lifecycle candidates.
- Actual public native preview message/refresh adapter implemented from current public source and simulated native-format fixtures; no privileged evaluation or native Helper session reuse.
- Dedicated QuickJS Worker with bounded memory/time/output, no ambient network/DOM/GM, staged filesystem effects and fresh permission-preserving child dispatch.
- Resource CAS/version/history/diff/restore/scoped assignment, safe ZIP preview/import/export and eleven expanded original domain skills with current public-source provenance.
- Manager setup, exact connector copies, OAuth decisions, Resource editing, separate backups, trusted fetch hosts, kill/pause, credential recovery and explicit operator uncertainty resolution. Local Worker manager journeys and bundled startup are exercised; DOM tests do not establish rendered geometry.
- Optional explicit paid music adapter: fixed official provider endpoint, secrets retained in Worker environment, durable no-replay intent, scoped chunks, MP3 framing, private local retention and draft revision checks. No paid provider call or listening test was executed.

Commands: `npm run typecheck`, `npm test`, `npm run build`, `npx wrangler deploy --dry-run --config apps/gateway/wrangler.jsonc`. Per-module commands and precise coverage are in BROWSER_IMPLEMENTATION.md, EXECUTION_IMPLEMENTATION.md, GATEWAY_IMPLEMENTATION.md, RESOURCE_IMPLEMENTATION.md and MANAGER_IMPLEMENTATION.md. The current run totals and soak measurements are recorded in todo.md and the checked-in verification results.

## Open acceptance matrix

| Gate | Available evidence | Missing evidence / required next action |
|---|---|---|
| A01 / C01–C03 | T0/T1/T2 pairing/replay/auth; build and deploy dry-run | Real supported Firefox+Violentmonkey installation and clean-account Cloudflare dashboard provisioning/pairing. |
| A02 / C04–C06 | Local official OAuth S256/token/resource isolation, revoke/approval drift | Deployed exact-resource authorization with real external web clients and refresh/revoke behavior. |
| A03 / C07 | Exact binary/empty/source/draft/race fixtures and actual controller→local SQLite gateway | Real native default/nondefault drafts, native editor/guard ownership, manual edit/undo/reload and source buffers in Firefox. |
| A04 / C08 | Current public protocol inspection and synthetic sender/origin/revision/preamble/generation tests | Live native preview, line diagnostics, warning settle, preamble order, frozen frame recovery and actual preview pixels. Source-panel lint availability is not established. |
| A05 / C09 | Actual separate-thread QuickJS isolation and deterministic safe fetch/broker fixtures | Firefox Worker/WASM/CSP/memory and approved-host networking proof; large transfer parity remains bounded by documented budgets. |
| A06 / C10 | Gated native Save and complete independent saved-source verification fixtures | Disposable live Save receipts, stale/challenge/late-commit behavior and exact CDN readback. Default native provider writes remain disabled. |
| A07 / C11 | Gated fixed-control rename/listing/duplicate/delete and uncertainty fixtures | Authorized disposable live lifecycle outcomes; generator creation still needs a verified native document/ownership transition. |
| A08 / C12 | Media provider/handler fixtures, local artifact storage | Actual authorized image/music output, real decoding/listening and fidelity; standalone native public upload; arbitrary production-state backup/restore and emulator parity; real web-client attachments. |
| A09 / C13–C15 | Seed/version/CAS/ACL/import hostile-input tests; local Worker tool-only access | Deployed storage and real tool-only client Resource retrieval/import/export. |
| A10 / C16 | 1/5/10/20 simultaneous local Workspaces, overload/isolation tests; separate synthetic soak | 5–10 real Firefox tabs, browser memory/background suspension, deployed CPU/storage/request quotas. Local Node RSS is not browser memory. |
| A11 / C17/C20 | Epoch/replay/revoke/pause/heartbeat/retired reply/UNKNOWN resolution fixtures | Real browser sleep/discard, deployed hibernation/restart, in-flight revoke and native effect reconciliation. |
| A12 / C18/C19 | Separate backup/export, digest/conflict/schema-downgrade fixtures | Real dirty-draft upgrade/rollback, browser storage quota and deployed schema coexistence. |
| A13 / C02/C04/C17 | DOM accessibility, focus, no active-markup preview, single-scroll CSS and reproducible renderer harness | Actual 1024×768/1920×1080 rendered keyboard walkthrough, clean dashboard install and exact real client copy/pair flow. |
| A14 / C21 | Eleven seeded skills, custom revision preservation and export roundtrip | Fresh deployed installation and real Violentmonkey isolation across top/preview contexts. |

## Explicit unresolved outcomes

The production server plugin exposes emulator operations publicly but does not provide an established general production-state backup/restore API. An owner-designed backup RPC is useful for compatible generators; it is not arbitrary-generator parity. Private Helper credentials/session reuse and modifying production code merely to extract state remain excluded.

The public image plugin is an authorized candidate when intentionally imported in the assigned preview; real output and fixed-asset extraction are not verified. Music uses a separately authorized paid API; no subscription entitlement or free access is assumed. Costs and control differences remain explicit in PARITY_IMPLEMENTATION.md.

Firefox can offer human-initiated display capture, but source selection/cropping cannot be silently attested to the current preview. An approximate DOM renderer is not a screenshot. Real pixel parity remains open.

The pinned official MCP transport SDK supports 2025-11-25/2025-06-18, not the handoff's proposed 2026-07-28 transport profile. Unsupported versions are rejected. This candidate does not claim present/future client compatibility from documentation alone.

Firefox connector information and tab listing returned internal errors in this session. The local Chromium launcher pointed to a missing executable; official browser download returned HTTP403; a separate cloud browser could not access the local fixture. No T3/T4 evidence is inferred from these attempts. No Cloudflare production deployment, sign-in, CAPTCHA, production generator mutation, inference billing or private capture was performed.

## Operator qualification

Use an explicitly authorized disposable environment and maintain a cleanup ledger. Run docs/TEST_PLAN.md A01–A14 in order of dependencies, recording exact Firefox/Violentmonkey versions, deployed commit/config, fixture identity, expected/actual result and redacted operation IDs. Start read-only. Do not enable native provider writes before source identity, guard, draft and independent Save verification pass. Do not mark a gate passed because a capability is disabled. Full release requires all mandatory outcomes and evidence tiers or an explicitly revised client specification.
