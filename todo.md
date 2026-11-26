# Implementation ledger

Status: executable verification candidate implemented. Local static/unit/emulator/rendered tests and packaging are in place; full product acceptance remains blocked by the explicitly listed real-browser/cloud/provider gates. No production deployment or live provider mutation has occurred.

| Phase | Dependency | Deliverable / exit criteria | Status |
|---|---|---|---|
| P00 | — | Client spec, architecture, tool parity, evidence, setup, verification and governance | Complete (design documents only) |
| P01 | P00 | Firefox/Violentmonkey disposable diagnostic userscript; feature-detect editor/src/draft/preview/native Save and frame boundaries; F01/F02/F04/F05 evidence; read-only first then authorized disposable tests | Candidate + current public native audit; T3 open |
| P02 | P00 | Minimal deployable Worker OAuth/Registry/Workspace transport; clean dashboard setup; two named web connectors isolated; current/legacy MCP; F03/F08 | Implemented; local current/legacy OAuth/MCP verified; T4 open |
| P03 | P01/P02 | Shared contracts + strict schemas + typed adapters; state machines, fencing, authorization, error mapping, local emulator, deterministic tests | Implemented and locally verified contracts/state boundaries |
| P04 | P03 | Core VFS, source tools, scratch/imports, revision checks, checkpoint/restore; native draft preserving | Implemented and locally verified; native T3 open |
| P05 | P04 | Preview/eval/refresh/diagnostics/viewport/capture; isolated compute, bounded fetch; F05/F06 | Isolated compute/fetch and native preview candidate verified locally; pixels/T3 open |
| P06 | P04 | Native save, generator lifecycle, upload, independent verification, unknown effect reconciliation; disposable tests | Gated Save/lifecycle/upload candidates; creation and live outcomes open |
| P07 | P03 | Resource registry/editor/import/export/version/diff/assignment; bundled eleven domain skills and provider-neutral workflows; synthetic optional import fixtures, tool-only delivery | Implemented and locally verified; deployed/client T4 open |
| P08 | P05/P06 | Image/music, authorized production state backup/restore/emulator, artifacts; F07/F08, record unresolved parity | Media/artifact candidates implemented; real output and production-state parity open |
| P09 | P04/P07 | Full manager UI setup wizard, OAuth management, diagnostics, backup/restore, pause/rebind/kill, accessibility | Implemented; actual Chromium layout/keyboard + local Worker verified; Firefox/T4 open |
| P10 | P05–P09 | Security, concurrency, fault injection, interoperability, upgrades, quotas and real end-to-end acceptance; F09 | Local security/recovery/concurrency and 30-minute T2 soak verified; external gates open |
| P11 | P10 | Release .user.js and .txt, Worker deployment package, verified dashboard walkthrough, parity report, rollback guide | Verification-candidate artifacts prepared; full release blocked |

P01 and P02 may proceed independently. No production feature activation before relevant feasibility gates. P08 may investigate early without blocking core progress; full parity release still blocked by unresolved mandatory capabilities. No live browser or cloud deployment conducted for P00.

## Current blockers
- Need real Firefox manager and disposable generator tests (F01/F02/F04/F05).
- Need deployment/connector interoperability proof (F03/F08).
- Need authorized real image/music output and arbitrary production server-state parity (F07). Optional fixed public/paid adapters are implemented without unauthorized inference calls.
- Historical exports remain private; the original authored skill library, adapter reference and synthetic fixtures are checked in. No external attachment dependency.
- Candidate executables/deployment package now build. Full release remains blocked; see docs/RELEASE_VERIFICATION.md.

## Intended repository layout
apps/gateway (Worker + DO + OAuth), apps/userscript (top controller, frame executor, native adapter, UI, local VFS), packages/contracts (schemas and types), packages/resources (our original defaults), tests/{unit,integration,fixtures,e2e}, docs, scripts (build/package/deploy validation). Single workspace package manager lockfile. Actual packages/scaffold created in P01–P03 with tested dependencies, no fake runtime.

## P00 evidence checkpoint
- Initial repository was empty. Initialized main and committed the design baseline and protocol supplement.
- Archive integrity and SHA-256 checked locally; relevant platform documents, original tool schemas, skill export manifest and selected captured frontend source inspected. Public primary-source MCP and Cloudflare docs consulted.
- No CI triggered, no production code, no live provider mutation, no deploy performed. P01/P02 are the next eligible feasibility phases.

## P00 handoff amendment
Operator selected Violentmonkey, and requested a standalone coding handoff. Read docs/HANDOFF.md and the checked-in implementation references. All phases may be planned from repository alone. P01/P02 still require real environments for final proof; implement test harnesses and other independently eligible work without waiting for owner attachments. Unresolved authorized media/state integrations are parity blockers, not missing input files.

## Implementation session — 2026-11-26

Remote baseline: main `9b018fb44423b8d00e1ec90afebb0a9b42da6c9e`; only main exists, no PRs or Actions runs. All required handoff files and default fixtures inspected. Runtime work uses `implement/runtime`; no production mutations/deployment authorized or attempted.

### Active P01/P02 plan
- Build a read-only native capability probe and injectable native adapter with deterministic editor/draft/src fixtures; record unsupported live interfaces explicitly.
- Build gateway using pinned official OAuth/MCP implementations, SQLite Durable Objects, isolated assignments, management credential pairing, grant revocation, fenced tab leases and durable operations.
- Run local positive/negative and emulator tests before any external enablement. Browser feature detection must not infer live verification.
- Independent contract/schema, resource and manager modules may be implemented alongside these feasibility harnesses; their higher-tier acceptance remains pending.
- Test dependencies are pinned in one lockfile. Production writes remain gated until their native proof gates pass. Preserve full product requirements when reporting unavailable capabilities.

Historical planning checkpoint: P01/P02 were still in progress at this point. The phase table above and final verification checkpoint below now describe the candidate; external acceptance gates remain open.

## Candidate integration plans and evidence — 2026-11-26

The following independently achievable slices were implemented alongside the P01/P02 feasibility work. These statuses do not satisfy external dependency acceptance by themselves. Each remaining integration step below is bounded and must be verified before its status changes.

| Phase | Implemented slice | Integration/verification plan and remaining gate |
|---|---|---|
| P01 | Read-only installed manager probe, native source adapter, current public native guard detection | Check pure native guard/draft/access interfaces, retain read-only use when unknown; complete real Firefox/Violentmonkey and disposable fixture proof. |
| P02 | Official OAuth/MCP gateway, SQLite Registry/Workspace, pairing, management, lease polling, durable handles | Verify current published profiles, exact resource isolation/revocation, dashboard package dry-run; deployed clean-account/real connector evidence stays pending. |
| P03 | 52 strict tool contracts, permission ceilings, schemas and typed error/state envelopes | Run schema boundary/security tests and actual controller→local Worker integration; freeze effective Grant intersection for composed calls. |
| P04 | Complete source/scratch/binary tools, exact patch preflight, safe regex/parser, imports, checkpoints/recovery | Run default/nondefault draft and manual-edit/partial-effect/BOM fixtures; preserve exact bytes and unresolved history. Real native semantics require T3. |
| P05 | Actual native preview protocol candidate, isolated QuickJS Worker and allowlisted public fetch | Verify worker isolation/termination/child permits, source/preview generation fencing and actual protocol-shaped fixtures; real pixel capture/source lint remain open. |
| P06 | Gated Save/lifecycle candidates and exact independent complete saved-source reader | Exercise lost receipt/stale/empty/binary/owner/listing/delete cases; qualify actual creation/upload/native effects only in authorized disposable provider environment. |
| P07 | Versioned scoped Resource library, safe ZIP preflight/import/export and expanded eleven original skills | Verify seed preservation, ACL/history/CAS, hostile imports, paged tool-only delivery and real local Worker manager journeys. |
| P08 | Optional paid music adapter and durable scoped chunk handler; public media investigation | Integrate bounded browser artifact download/decoding/revision commit and no-replay recovery. No paid call authorized/executed; production-state/general screenshot parity remains blocked. |
| P09 | Complete manager setup, Workspaces/Agents/OAuth, Library, Activity, Settings/recovery | Connect actual transport/controller, separate source/settings restore, trusted fetch hosts, explicit UNKNOWN resolution; verify keyboard/focus/failed-save cases. Synthetic Chromium rendering now passes; native Firefox proof remains missing. |
| P10 | Cross-boundary security review, 1/5/10/20 synthetic concurrency, fault/recovery fixtures | Run final complete suite, dry-run packaged Worker, and 30-minute 20-Workspace local soak. Do not infer deployed quotas/browser memory from local metrics. |
| P11 | Reproducible single-script/TXT + deployment/candidate ZIP packaging | Verify build startup, identical mirrors, package manifests/checksums, operator instructions and acceptance gaps; publish only a verification candidate until all mandatory gates pass. |

Verified checkpoints include contracts `1bb0107`, Resource library `8b47387`/`9dc30fd`, manager `6e0398c`/`324d816`, source `dba7226`/`6c34525`, isolated compute `5b629e2`, native preview protocol `1c0986d`, gateway `8755a8a`, paid media journal `1e2fc5b`, and browser controller `4d0b691` (local commit identifiers; remote checkpoint commits may aggregate equivalent trees).

The full suite reached 194 tests with one integration assertion failure caused by the new metadata-only Resource catalog. The test had compared detailed metadata to an intentionally omitted catalog field; the corrected test fetches full canonical detail and asserts exact body/metadata preservation (`b191ae9`). The focused genuine local Worker manager journey passes. Final aggregate results will follow; no failed run is described as passed.

Current external proof limits: Firefox connector calls failed internally; local Chromium binary missing; official browser download403; cloud browser cannot reach local fixture. No production deployment, native account mutation, native Helper session, CAPTCHA bypass or paid inference occurred. Real Firefox/Cloudflare/web-client/provider gates remain open. Candidate instructions: docs/INSTALLATION.md, CONNECTORS.md, RECOVERY.md and RELEASE_VERIFICATION.md.

### Final image and retention integration plan
- Replace oversized inline image payloads with operation-scoped, digest-verified chunks; hydrate standard MCP image content only after current Agent/binding authorization.
- Schedule physical deletion of terminal result bodies and retained image/music bytes at their ten-minute expiry, including idle Workspaces. Preserve uncertain operation metadata for reconciliation.
- Normalize generated images through the same bounded image renderer; retain committed source effects if later display transfer fails.
- Run targeted boundary tests, complete local checks, rendered manager checks, packaged Worker dry-run and deterministic archive verification before the final GitHub checkpoint.

### Final local verification checkpoint — 2026-11-26
- `npm run check`: 263 unit/integration tests passed, zero failed/skipped; strict typecheck, build and packaged archive/Worker checks passed.
- Actual installed Chromium 158 synthetic manager: all five tabs at 1024×768 and 1920×1080, keyboard/focus/resize, expanded long text and native editing after close passed. No screenshots or private data are required to resume.
- Actual browser image normalization: original alpha pixel `[255,0,0,128]` preserved; locally generated noisy 1024×1024 PNG (3,608,592 bytes) reduced to 512×512 / 871,856 bytes; malformed bytes rejected. This is local pixel evidence, not a provider screenshot or media-output claim.
- Packaged Cloudflare dry-run passed with Wrangler 4.168.0; 1,574.26 KiB raw / 332.54 KiB gzip. No deployment or Actions run performed.
- Image transport: 14 focused tests pass, including a 768 KiB actual local SQLite route, exact standard MCP image blocks, policy revocation, integrity, concurrency, budgets, scope and expiry.
- Physical result/image/music cleanup is scheduled for idle Workspaces; unresolved operation metadata remains available. Rebinding/detach cannot abandon consumed permits; recovered credentials retain an inert binding only for reconciliation.
- Evidence: docs/verification/local-results-20261126.json and linked detailed records. Historical soak: 6,120 operations / 0 failures over 30 minutes and 20 Workspaces; exact final bundle provenance is not available for that run.
- All independently implementable candidate integration and packaging work is complete. Full release remains blocked by the unchanged A01–A14 external/native/provider outcomes in docs/RELEASE_VERIFICATION.md; the next phase is authorized disposable qualification, not a claim of completed parity.

### Live ChatGPT OAuth/Cloudflare remediation — 2026-11-26

- Incident: After attaching `aleph-alpha`, ChatGPT's exact OAuth approval appeared too late in Agents. Live browser then returned `GATEWAY_UNAVAILABLE` and `SCOPE_DENIED: Origin is not allowed` during setup.
- Root causes: blanket Worker CORS/origin restriction applied to public OAuth/MCP routes; costly Resource-library loading on ordinary admin GET; manual-only approval list refresh coupled to unrelated Grants failures; early Continue discarded the HTML form; retries lacked clear read-only separation.
- Remediation: allow exact ChatGPT origins solely on public OAuth/MCP endpoints, leave privileged admin/tab routes origin-restricted, eliminate unnecessary Resource-library coupling, auto-refresh pending approvals serially every four seconds, preserve a retryable early-Continue form, provide explicit expiration instructions, bound GET-only network retry with unchanged POST/long-poll timeouts, and verify v0.1.2 delivery.
- Evidence: new real local Worker OAuth/PKCE flow with `Origin: https://chatgpt.com`, private-route CORS denial tests, browser manager auto-approval regression despite Grants failure, transport no-mutation-replay test, full TypeScript/test/build/checksum/Wrangler dry-run in GitHub Actions, independent Chromium synthetic UI click workflow on generated v0.1.2 artifact. Keep precise CI SHA and output checksums in final PR report.
- Still external/unverified: actual Cloudflare redeployment into operator's account and its current `/health` version; live Firefox/Violentmonkey/ChatGPT OAuth retry; existing provider/native mutation gates. Do not mark these as passed without real evidence.

### Live OAuth form completion and diagnostics remediation — 2026-11-26

- Verified root cause: gateway's `Referrer-Policy: no-referrer` changes form navigation `Origin` to `null`; global `allowedOrigin` and `/authorize/complete` reject the browser despite approved Registry state. MDN Referrer-Policy docs confirm. Root-cause fix adjusts only authorization form policy plus narrow privacy-mode fallback; preserves opaque handle and PKCE/Grant security.
- OAuth diagnostic export previously contained an empty MCP Activity array (~39 bytes) by design; no OAuth trace. Separate read-only report includes bounded gateway OAuth audit, transport failures/latencies, health, schema/version and server errors by trace ID. No credentials, code, source, request body, raw URL or raw Origin stored.
- Verification: exact null-Origin and hostile/cross-site Completion paths in local Worker OAuth flow; diagnostic ring and secret exclusion; offline report; complete strict typecheck, tests, artifact hashes, Worker dry-run and real compiled-userscript UI smoke. Live deployed Firefox/ChatGPT account gate remains external until operator confirms.

### OAuth redirect recovery (2026-11-26)

- Live v0.1.3 diagnostics showed POST /authorize/complete 302 then subsequent consumed POST 200, no observed /token request, and several local transport failures while PersonaMonkey was enabled; user observed improvement with PersonaMonkey disabled. Prevent interpreting gateway 302 as complete client authorization.
- Root-cause repair: persisted sealed callback behind original 256-bit handle and original expiry, exact callback URI defense-in-depth, no second grant/code upon retry; manual script-free fallback navigation for blocked redirects; fail-closed revocation for incomplete code issuance, expired and revoked checks; distinguish redirect issued, fallback and token exchange in redacted audit.
- Required verification: local full OAuth PKCE + blocked-redirect replay integration, hostile handle replay rejection, identical grants before/after replay, no secret logging, browser fallback link navigation, typecheck, tests, build, artifact hash, Wrangler dry-run; only then merge. Live LibreWolf+PersonaMonkey routing and ChatGPT consent callback cannot be asserted from synthetic tests.

### Browser bridge liveness and Grant UI incident — 2026-11-26 (userscript v0.1.5)

- Report: Cloudflare v0.1.4 OAuth connected to ChatGPT, 52 tools and library operational, but all browser tools returned `TAB_OFFLINE`. Manager showed Workspace Active alongside local offline. Grant revoke appeared inert.
- Confirmed: idle Worker long poll holds 25s; userscript non-signaled POST abort incorrectly hardcoded at 15s; controller never retries/reconciles transient poll or heartbeat failure and startup does not reconnect a still-exact bound editor after reload. Grant revocation did not require local confirmation/readback or show a clear terminal outcome.
- Code changes: 30s normal POST timeout in both branches; 45s tab poll, same-lease bounded retry/backoff, degraded state and diagnostic signal, nonfatal transient heartbeat, local exact-binding startup/BFCache reconnect without takeover, scoped operator Stop marker; inline Grant confirmation and authoritative verification/no replay.
- Test gates: strict TypeScript, full unit and local Miniflare/manager integration suite; actual transport signal budgets, poll recovery with same lease, revoked heartbeat fail-closed, native identity matching ambiguity, unknown Grant POST and terminal revoked state, build artifact hashes, Worker dry-run; final distribution userscript TXT.
- External: real LibreWolf/Violentmonkey polling, PersonaMonkey routing and a read-only live `workspace_status` still require operator's existing browser session. No provider writes have been enabled or tested.

### Preview/runtime/tool-contract remediation — 2026-11-26 (userscript v0.1.6)

- Evidence: paired gateway v0.1.4 and browser v0.1.5 transport/lease healthy; live MCP source reads pass. Native preview execution was deliberately blocked by hardcoded `verified: {}` despite an implemented fixed native protocol bridge. Preview observations were incomplete; list_files missed sizes/types, generator_info reused generic status.
- Change: runtime proof by correlated exact-origin preview postMessage constant before page_eval, structural preview refresh + receipt attestation before reporting appliedRevision, explicit diagnostics evidence limitations, byte-accurate list_files entries with backward compatible paths, native metadata known/unknown distinctions, bounded sanitized preview error timeline in diagnostics export. No Worker changes or external Save enablement.
- Verification required: typecheck, native-protocol synthetic forgery tests, source metadata tests, redaction tests, full unit/integration CI, artifact SHA and byte equality, Chromium runtime smoke where feasible. Live LibreWolf + genuine Perchance preview execution and console/refresh behavior remains an explicit external acceptance gate until observed.

## Live integration defect remediation (v0.1.7) — 2026-11-26

Baseline: Operator-provided Image Studio defect report MCP-01–MCP-14 and redacted userscript v0.1.6 diagnostics. Gateway v0.1.4 and live browser lease are healthy. Source revision 6 was unsaved when reported. This remediation changes the userscript and contracts only, not Cloudflare configuration, authorization, native Helper, OAuth, Workspace Binding or the operator's live draft.

| Finding | Code outcome / remaining acceptance |
|---|---|
| MCP-01 Save gate | F04 preflight now supplies independently fetched exact saved-base and complete post-Save public readback behind unchanged two acceptance gates. Effective gated reason visible. Real authorized disposable Save and gateway-provider enablement **remain blocked**; user must manually Save native editor before reloading unsaved draft. |
| MCP-02 fetch_generator | Respects public `getGeneratorPageData` envelope variants without relying on AI Helper; validates optional manifest forms, double-read drift, source assets and panel-only fallback. Live plugin slug retry pending. |
| MCP-03 viewport reset | Real iframe `innerWidth/innerHeight` must match requested dimensions; after native reset, measured width/baseline conflict is reported as PARTIAL instead of false VERIFIED. Live fixed-pane 917→390→917 still pending. |
| MCP-04 real pixels | Browser/userscript has no accepted native pixel capture interface; remains unavailable, no DOM-based fake images. |
| MCP-05 syntax | Reads `getEditorSyntaxErrors` only if native method exists, fences source revision, preserves path/line-provenance uncertainty and independent preview console/warnings channels. Disposable deliberate syntax failure acceptance pending. |
| MCP-06 generator metadata | Adds native public ID with conflict validation, explicit unknown saved/base revision (not fabricated). Ownership/edit/listing remain unknown unless positively detectable. |
| MCP-07 effective status | Lease fencing, claim-permission ceiling, source/preview and Save acceptance matrix including exact reasons. Policy snapshot cached and diagnostic only; Registry remains admission authority. |
| MCP-08 checkpoints | Immutable full-draft checkpoint creation reads back encoded bytes and SHA256 before success; exact digest/bytes/identity/pin/count receipt. Restore now validates stored digest/full-source revision/identity/paths/sizes before effects. |
| MCP-09 writes | Verified `write`/`save_b64_file` receipts include path/UTF-8 byte size/SHA256 while retaining partial and unknown outcomes without fabricated proofs. |
| MCP-10 errors | Bounded known-domain, tool-specific terminal messages; public metadata vs asset/HTTP/network classifications. No raw private HTTP responses in replies or diagnostics. |
| MCP-11 effects boundary | Ordinary generator preview runtime may request public services; this is NOT an MCP privileged Save, lifecycle or upload grant. Existing privileged gates remain. |
| MCP-12 readiness | Preview availability remains verification-dependent; `workspace_status` adds reasoned matrix. T3 live readiness transitions outstanding. |
| MCP-13 envelopes | User-script failure messages improved; ChatGPT host's immediate rejection wrapping requires gateway/host assessment and is not represented as fixed. |
| MCP-14 warning channels | Native warnings and preview console are explicitly separate. Empty warnings/syntax lists do not attest no errors. |

Verification: full TypeScript + deterministic tests + build + userscript/TXT byte identity + Worker dry-run required on the final versioned head; no deployment needed. Real Firefox/Violentmonkey T3, disposable authorized Save and actual-pixel capture remain explicit release gates. Never claim T1/T2 mocks as T3 evidence. Preserve last native source and local Workspace cache, and test on a separate disposable generator before enabling provider effects.

## Epoch-5 reconnect incident / v0.1.8 remediation — 2026-11-26

Source evidence: operator's `Perch-MCP-Epoch-5-Regression-Report-2026-11-26.md`, `Perch-MCP-Save-Gate-Appendix.md` and `perch-mcp-diagnostics5.json`. Gateway live v0.1.4 returns HTTP 409 `EFFECT_UNKNOWN` on `/api/v1/tab/claim`, with healthy OAuth/pairing and Registry. The blocker is terminal `PARTIAL` operation `b5d2a44c-4a28-43a0-8edc-de3a178cdc84`, tool `set_viewport_size`, epoch 5. The original operation result expired but its terminal phase and Activity record persist. Browser lease is absent. Read-only status operations admitted after the hold expired without dispatch. This is not a bootstrap/OAuth failure.

Remediation in `fix/viewport-hold-reconnect-v018`:
- A terminal `PARTIAL/UNKNOWN` **CSS-only viewport operation** cannot retain the new document's lease or block source edits; a still-`RUNNING/DISPATCHED` viewport operation remains fenced. Other uncertain operations (including page_eval, Save, src writes and uploads) remain held.
- Registry no longer reserves a generator writer for `set_viewport_size`. A legacy v0.1.4 reservation is reaped only from an exact matching authenticated terminal notice. The old outcome and Activity record are retained, never rewritten to SUCCEEDED.
- Browser controller remains connected but degraded on future viewport-only uncertainty. It no longer stops its poll loop, and clears the degraded state after verified reset.
- Viewport API accepts `reset:true` without ignored dimensions; bounded post-layout measurement compares actual iframe dimensions and reports specific numeric mismatches. No CSS-only success proof.
- `fetch_generator` now distinguishes argument validation, public API metadata/assets and local cache-commit failures without raw private content.
- Activity distinguishes view-only uncertainty from source/provider uncertainty; automatic reconnect error on old gateway points to exact operation resolution instead of re-pair.
- Safety invariant: no auto-acknowledgement of an arbitrary unknown effect; no provider policy or privileged Save activation; no production mutation in tests.

**Rollout ordering:** v0.1.8 userscript includes a Worker change. Deploy the packaged Worker **v0.1.5** to the existing Cloudflare deployment first, preserving Durable Object bindings, KV and secrets. Then replace the existing Violentmonkey script with the tested v0.1.8 `.user.txt`. If Worker remains v0.1.4, auto-reconnect still rejects the old viewport PARTIAL: use Activity → Resolve uncertain operation after inspecting the source/preview, then Workspaces → Reconnect. Do not re-pair, detach or rebind.

Acceptance T1/T2: strict typecheck; deterministic effects/legacy Registry unit tests; Miniflare epoch-5 partial viewport→release→claim→read-only status→write end-to-end; negative source/Save/provider effect holds; build/archive checksum and Worker dry-run. T3 real Firefox/Violentmonkey and T4 deployed Cloudflare+ChatGPT retest remain necessary. Fetching public plugin slugs and native geometry restoring still require fresh live positive tests. Save gate, real-pixel capture, supported media/provider-state/lifecycle tools remain independently unaccepted; do not claim full product parity.
