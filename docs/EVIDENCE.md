# Evidence register and decision record

Review date 2026-11-26. Inputs supplied in conversation, retained externally (public repository). Archive integrity checks passed for all three. discovery-v3.zip: 89 entries (includes directories); canonical report claims 94 capabilities, 78 tested. Userscript-Perchance-MCP-Discovery.zip: 93 entries, 23 tool schema descriptions. skills-all.zip: 15 files, 13 skill bodies plus README and manifest. perchance-discovery.md: consolidated newer platform reference, 340 lines. Do not copy raw captures or third-party source into public repository without verified rights and redaction. These are historical external research, not live results of Perch MCP.

## Platform evidence extraction
| Contract | Evidence location | Adopted conclusion |
|---|---|---|
| E01 | discovery-v3 DISCOVERY.md §§1–3; perchance-discovery.md §§1–2,5 | Top-level editor has app/editor/CodeMirror/srcState; preview separate origin; full load for #edit; readiness/draft checks required. |
| E02 | FINAL_DELTA.md §1A; raw3/srcsave.json; perchance-discovery.md §§5–6 | srcState.writeFile stages bytes, native Save uploads, top-level srcManifest committed, readback exact bytes. |
| E03 | IMPLEMENTATION_READINESS.md §§1–3; state-machine.md; consolidated §§5–6 | native setters/undo, async lint, draft picker, file viewer debounce, staleness and unknown write reconciliation. Prefer native Save over direct API despite older strategy A recommendation. |
| E04 | consolidated §§3–4,6 | stable Generator ID vs slug/Public ID, owner checks, create/fork, listing, rename, duplicate, delete. Unlisted not private; initial fork may be Listed. |
| E05 | state-machine.md §§4–6; consolidated §10 | preview iframe #outputIframeEl, native reload/evaluate, warnings/runtime errors, varying sandbox host; no verified Firefox cross-frame agent bridge. |
| E06 | original discovery tools/schemas, v3 state-machine browser tool calls | 23 transcribed tools + observed internal calls; functional contract not exact native implementation. |
| E07 | original skill archive README and server-plugin/music-generation | 13 exported skills, report excluded, OpenCode unnecessary; two supplemental YAML files absent, platform examples trimmed; production state and music backend not established. |
| E08 | consolidated §§9,11 | upload verification via native flow, zero-byte anomaly, shared asset storage, revision downloads, background throttle/unknown outcomes. |
| E09 | FINAL_DELTA.md attachment section | native attachment download from OPFS; new implementation must not depend on native chat session store. |

Exclude research on PCMS account routing, native AI sessions/queue/history transport, Recent ranking, refresh markers, folder management, account changes. No reuse of native Helper protocol or its credentials. Older MCP_TOOL_SPEC.md is a different project proposal, not our tool authority. Research contains contradictory older/newer claims (public directory query params, save confirmation); consolidated reference takes precedence where directly relevant, actual live feature detection ultimately decides. All provider interfaces unofficial/subject to drift.

## External verification sources
- Cloudflare Deploy buttons: https://developers.cloudflare.com/workers/platform/deploy-buttons/ — supports declared bindings, secret prompts; actual clean deploy not tested.
- Cloudflare DO limits and hibernation: https://developers.cloudflare.com/durable-objects/platform/limits/ ; https://developers.cloudflare.com/durable-objects/best-practices/websockets/ — SQLite DO Free supported, hibernation reduces idle duration.
- Workers pricing/limits: https://developers.cloudflare.com/workers/platform/pricing/ ; https://developers.cloudflare.com/workers/platform/limits/ — current Free Workers 100k requests/day, 10ms CPU/invocation; measure DO quotas separately.
- OAuth library: https://github.com/cloudflare/workers-oauth-provider ; https://github.com/cloudflare/workers-oauth-provider/blob/main/docs/authorization-server.md — supports resource audiences, PKCE, DCR/CIMD profiles; library version and exact route behavior require prototype.
- MCP current protocol: https://blog.modelcontextprotocol.io/posts/2026-07-28/ ; https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28 — stateless current protocol, required headers; legacy handshake compatibility needed. Do not bind Workspace to MCP transport session.
- Firefox userscript: https://violentmonkey.github.io/api/gm/ ; https://violentmonkey.github.io/api/metadata-block/ ; https://violentmonkey.github.io/posts/inject-into-context/ ; https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/connect-src — privileged GM requests and page CSP distinction; WSS path not proven.
- Worker version rollback: https://developers.cloudflare.com/workers/versions-and-deployments/ — data storage not included.

## Feasibility gates (unresolved)
| Gate | Needed proof | Failure decision |
|---|---|---|
| F01 | Firefox manager top editor page access, native setters, unsaved preview, src CRUD, draft identity, reload/reconnect | Adjust adapter/manager; no privileged eval fallback |
| F02 | WSS from sandbox or GM long poll with no global CSP changes; tab duplication, background suspend | Select safe transport; measure quota |
| F03 | Clean dashboard deploy and exact per-Agent OAuth resource with all target web clients | Adjust standards adapter, document UI constraints; no URL tokens |
| F04 | Real native Save receipt and complete readback incl. empty/binary file and conflict | Hold writes until verified |
| F05 | Preview preamble, capture pixels, viewport and frozen eval behavior | Authorized alternative or parity blocker |
| F06 | Isolated compute with bounded FS, no ambient networking; large local storage | Vetted engine/explicit storage cap; no privileged eval |
| F07 | Authorized image/music backends and production-state backup/restore/emulator | Provider-supported alternatives; no private session extraction; block full parity if absent |
| F08 | Web client attachments, binary result, long operation handle, resource retrieval | Standard text/image/artifact fallback; disclose limits |
| F09 | 5–10 concurrent real tabs, free-tier CPU/quotas and operational budget | Tune transport/limits; paid option explicit, no auto-upgrade |

Operator explicitly selected Violentmonkey first. Decisions without direct owner instruction: Registry+Workspace DO split, OAuth library/KV, per-Agent resource URL, 1 writer per Generator ID, permission presets, local storage budgets, declarative workflow, no public redistribution, phase-first rollout. Reversible except externally published source, production restore and credential leaks. All limits provisional until measured. No live Perchance/Firefox/Cloudflare tests performed in this design task.

Self-contained handoff amendment: original attachments are historical provenance only. See PERCHANCE_ADAPTER.md and TOOL_PARITY_DETAILS.md for extracted implementation facts, and packages/resources for independently written default skills. Do not infer verification from their presence.
