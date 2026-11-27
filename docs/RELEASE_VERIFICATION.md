# Release verification record

For v0.3.0 use the [offline acceptance matrix](verification/v0.3/ACCEPTANCE.md) and the [operator checklist](../OPERATOR-ACCEPTANCE.md). The evidence below records the earlier v0.1 qualification and its historical parity contract.

## Historical v0.1 record

Date: 2026-11-26. Classification: **verification candidate, not release-ready and not full functional parity**. The accepted scope C01–C21 has not been reduced. A tool schema, a candidate adapter, or a synthetic provider receipt is not a passing live parity gate.

## HAR-confirmed native owner actions (v0.1.11 candidate)

The owner-provided 2026-11-26 HAR confirms native UI success for Listed/Unlisted, Generator URL change, and Save. Implementation and sanitized schemas are recorded in [Epoch 9](verification/epoch9-har-native-actions-v0111.md). The 0.1.11 userscript wires three existing MCP tools using fixed native interfaces and independently verified public state. Its gateway v0.1.6 selectively admits exactly SAVE, RENAME and LISTING via `NATIVE_ACTIONS_ENABLED=true` without enabling broad provider mutation. Local automated tests do not establish live MCP execution of these actions. Real disposable-generator acceptance, special rename handoff reconciliation and gateway upgrade remain required. No owner generator was modified during implementation.

## Implemented and locally exercised

- Single bundled userscript plus byte-identical TXT mirror; bundled isolated compute Worker and original default knowledge; no runtime package/CDN import.
- One Worker deployment with SQLite Registry/Workspace Durable Objects and OAuth KV. Official pinned OAuth/MCP libraries, exact Agent audiences, S256/client approval, revocation overlay, binding/permission snapshots and isolated tab leases.
- Strict schemas for all 22 mandatory helper names and product additions; tool-only skill/workflow/instruction/document discovery.
- Native source/VFS adapters, binary/empty files, exact preflight patch/edit, RE2 search, parser-based definitions, revision conflict detection, checkpoints, complete saved-source reader and gated Save/lifecycle candidates.
- Actual public native preview message/refresh adapter implemented from current public source and simulated native-format fixtures; no privileged evaluation or native Helper session reuse.
- Dedicated QuickJS Worker with bounded memory/time/output, no ambient network/DOM/GM, staged filesystem effects and fresh permission-preserving child dispatch.
- Resource CAS/version/history/diff/restore/scoped assignment, safe ZIP preview/import/export and eleven expanded original domain skills with current public-source provenance.
- Manager setup, exact connector copies, OAuth decisions, Resource editing, separate backups, trusted fetch hosts, kill/pause, credential recovery and explicit operator uncertainty resolution. Local Worker manager journeys and bundled startup are exercised; DOM tests do not establish rendered geometry; a separate real Chromium 158 synthetic renderer now verifies both target sizes and keyboard behavior.
- Optional explicit paid music adapter: fixed official provider endpoint, secrets retained in Worker environment, durable no-replay intent, scoped chunks, MP3 framing, private local retention and draft revision checks. No paid provider call or listening test was executed.

Final local aggregate: **263 tests passed; zero failed or skipped**. Strict typecheck, build, archive verification and extracted Worker startup pass. Actual Chromium 158 manager geometry/keyboard checks pass at both target sizes. Locally generated PNG tests preserve alpha pixels, reduce noisy images within the transfer budget and reject corrupt bytes. Detailed records: [local results](verification/local-results-20261126.json), [manager geometry](verification/manager-layout-20261126.json), [image pixels](verification/image-normalization-20261126.json).

Commands: `npm run check`, `npx wrangler deploy --dry-run --config dist/cloudflare/wrangler.json`, and the installed-browser harnesses under `tests/e2e/`. Per-module commands and precise coverage are in BROWSER_IMPLEMENTATION.md, EXECUTION_IMPLEMENTATION.md, GATEWAY_IMPLEMENTATION.md, RESOURCE_IMPLEMENTATION.md and MANAGER_IMPLEMENTATION.md. The current run totals and soak measurements are recorded in todo.md and the checked-in verification results.

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
| A13 / C02/C04/C17 | DOM accessibility/focus, literal previews, actual Chromium 158 single-scroll geometry at 1024×768 and 1920×1080, keyboard/resize/native-after-close checks | Real Firefox/Violentmonkey installation/prompt/Xray-isolation walkthrough, clean dashboard install and actual external client copy/pair flow; synthetic Chromium geometry/keyboard checks now pass. |
| A14 / C21 | Eleven seeded skills, custom revision preservation and export roundtrip | Fresh deployed installation and real Violentmonkey isolation across top/preview contexts. |

## Explicit unresolved outcomes

The production server plugin exposes emulator operations publicly but does not provide an established general production-state backup/restore API. An owner-designed backup RPC is useful for compatible generators; it is not arbitrary-generator parity. Private Helper credentials/session reuse and modifying production code merely to extract state remain excluded.

The public image plugin is an authorized candidate when intentionally imported in the assigned preview; real output and fixed-asset extraction are not verified. Music uses a separately authorized paid API; no subscription entitlement or free access is assumed. Costs and control differences remain explicit in PARITY_IMPLEMENTATION.md.

Firefox can offer human-initiated display capture, but source selection/cropping cannot be silently attested to the current preview. An approximate DOM renderer is not a screenshot. Real pixel parity remains open.

The legacy SDK was replaced with the current official `@modelcontextprotocol/server@2.4.0`. Actual local Worker tests now pass the 2026-07-28 per-request wire format and both 2025 legacy profiles, including header mismatch rejection. This corrects the earlier investigation limitation; no current-protocol blocker remains in the implementation. Real web-client interoperability is still unverified.

Firefox connector information and tab listing returned internal errors in this session. The initial local Chromium launcher had no executable, the official browser download returned HTTP 403, and a separate cloud browser could not reach the local fixture. An isolated npm-packaged Chromium 158 runtime subsequently enabled actual synthetic rendering and revealed/fixed a 2 px textarea overflow. No T3/T4 evidence is inferred from Chromium tests or the failed Firefox attempts. No Cloudflare production deployment, sign-in, CAPTCHA, production generator mutation, inference billing or private capture was performed.

## Operator qualification

Use an explicitly authorized disposable environment and maintain a cleanup ledger. Run docs/TEST_PLAN.md A01–A14 in order of dependencies, recording exact Firefox/Violentmonkey versions, deployed commit/config, fixture identity, expected/actual result and redacted operation IDs. Start read-only. Do not enable native provider writes before source identity, guard, draft and independent Save verification pass. Do not mark a gate passed because a capability is disabled. Full release requires all mandatory outcomes and evidence tiers or an explicitly revised client specification.

## Final cross-boundary repairs

Production manager UI uses a closed ShadowRoot and rejects untrusted click/key/input/change/submit events. Bootstrap and recovery values are collected through an isolated native browser-prompt callback, not password fields in page DOM. Tests prove synthetic page actions cannot invoke management calls; real Firefox Xray/native-prompt isolation remains an explicit T3 gate. Unpublished Resource drafts have separate document ownership and a separate export, preserving concurrent edits across tabs.

Manifest publication uncertainty compares exact old/new pointers and immutable chunk digests; unknown state preserves both generations and held import intent. Source decoding preserves UTF-8 BOM. Terminal operation notifications use a durable outbox and idempotent Registry upserts, so deadline expiry, provider-written UNKNOWN and lost notification receipts remain visible and recoverable.

The 20-Workspace 30-minute local workerd soak completed 6,120 operations with 0 failures; p50 = 827.10 ms, p95 = 1215.85 ms, p99 = 1368.24 ms, max = 1895.33 ms; final Node RSS 355,631,104 bytes. This synthetic run exercises SQLite queues/leases and synthetic native replies, not real Firefox, deployed CPU/quotas or real OAuth web clients. It began before the final transport/UI hardening; source bundle hash was not recorded for that historical run, so it does not alone satisfy the final-commit release evidence requirement. Exact final-code tests and the reproducible soak harness remain checked in.

Image results now use authenticated operation-scoped chunks before terminal persistence. The local SQLite Worker test transfers a 768 KiB signature fixture, verifies exact bytes in standard MCP image blocks, and rejects another Agent/binding and revoked policy. This tests transport integrity rather than image decoding or provider pixels. Idle Workspace alarms physically delete result bodies and image/music bytes at ten-minute expiry while preserving uncertain operation metadata. Generated-image normalization retains PNG alpha and reduces dimensions within the 1 MiB image budget.

Rebinding and detach refuse consumed operation permits and unresolved terminal notices. Credential recovery preserves an inert previous binding solely for exact reconciliation; it cannot claim a tab or execute a tool. Agent operation-handle reads/cancels require the original Agent and binding revision. These regressions pass against the local SQLite gateway.

### Browser-side bridge liveness remediation (v0.1.5, 2026-11-26)

The corrected userscript fixes a 15-second fetch abort applied to a gateway long poll that can legitimately wait 25 seconds. It introduces a 45-second poll budget, bounded same-lease network recovery, nonfatal transient heartbeat, explicit liveness diagnostics and exact native-Binding-only reconnection after reload. Grant revocation is confirmed by authoritative readback, not by a silent POST. Automated verification does not prove a live LibreWolf/PersonaMonkey connection; deployed T3/T4 gates remain open. Browser v0.1.5 is schema-v1 compatible with existing Cloudflare gateway v0.1.4; no Worker deploy or data migration is needed.
