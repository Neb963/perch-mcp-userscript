# Implementation ledger

Status: design baseline prepared; no runtime code, no live deployment, no live verification. Each phase starts by reading actual repository state and writing detailed plan/evidence here. No phase marked complete from design alone.

| Phase | Dependency | Deliverable / exit criteria | Status |
|---|---|---|---|
| P00 | — | Client spec, architecture, tool parity, evidence, setup, verification and governance | Complete (design documents only) |
| P01 | P00 | Firefox/Violentmonkey disposable diagnostic userscript; feature-detect editor/src/draft/preview/native Save and frame boundaries; F01/F02/F04/F05 evidence; read-only first then authorized disposable tests | Pending |
| P02 | P00 | Minimal deployable Worker OAuth/Registry/Workspace transport; clean dashboard setup; two named web connectors isolated; current/legacy MCP; F03/F08 | Pending |
| P03 | P01/P02 | Shared contracts + strict schemas + typed adapters; state machines, fencing, authorization, error mapping, local emulator, deterministic tests | Pending |
| P04 | P03 | Core VFS, source tools, scratch/imports, revision checks, checkpoint/restore; native draft preserving | Pending |
| P05 | P04 | Preview/eval/refresh/diagnostics/viewport/capture; isolated compute, bounded fetch; F05/F06 | Pending |
| P06 | P04 | Native save, generator lifecycle, upload, independent verification, unknown effect reconciliation; disposable tests | Pending |
| P07 | P03 | Resource registry/editor/import/export/version/diff/assignment; bundled eleven domain skills and provider-neutral workflows; synthetic optional import fixtures, tool-only delivery | Pending |
| P08 | P05/P06 | Image/music, authorized production state backup/restore/emulator, artifacts; F07/F08, record unresolved parity | Pending |
| P09 | P04/P07 | Full manager UI setup wizard, OAuth management, diagnostics, backup/restore, pause/rebind/kill, accessibility | Pending |
| P10 | P05–P09 | Security, concurrency, fault injection, interoperability, upgrades, quotas and real end-to-end acceptance; F09 | Pending |
| P11 | P10 | Release .user.js and .txt, Worker deployment package, verified dashboard walkthrough, parity report, rollback guide | Pending |

P01 and P02 may proceed independently. No production feature activation before relevant feasibility gates. P08 may investigate early without blocking core progress; full parity release still blocked by unresolved mandatory capabilities. No live browser or cloud deployment conducted for P00.

## Current blockers
- Need real Firefox manager and disposable generator tests (F01/F02/F04/F05).
- Need deployment/connector interoperability proof (F03/F08).
- Need authorized equivalent music and production server-state interfaces (F07).
- Historical exports remain private; the original authored skill library, adapter reference and synthetic fixtures are checked in. No external attachment dependency.
- No actual executable source or deployable release yet.

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

P01 and P02: **in progress**, not accepted. P03–P11: independently achievable implementation work queued behind tested local contracts; external acceptance gates remain open.

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
| P09 | Complete manager setup, Workspaces/Agents/OAuth, Library, Activity, Settings/recovery | Connect actual transport/controller, separate source/settings restore, trusted fetch hosts, explicit UNKNOWN resolution; verify keyboard/focus/failed-save cases. Rendered browser proof remains missing. |
| P10 | Cross-boundary security review, 1/5/10/20 synthetic concurrency, fault/recovery fixtures | Run final complete suite, dry-run packaged Worker, and 30-minute20-Workspace local soak. Do not infer deployed quotas/browser memory from local metrics. |
| P11 | Reproducible single-script/TXT + deployment/candidate ZIP packaging | Verify build startup, identical mirrors, package manifests/checksums, operator instructions and acceptance gaps; publish only a verification candidate until all mandatory gates pass. |

Verified checkpoints include contracts `1bb0107`, Resource library `8b47387`/`9dc30fd`, manager `6e0398c`/`324d816`, source `dba7226`/`6c34525`, isolated compute `5b629e2`, native preview protocol `1c0986d`, gateway `8755a8a`, paid media journal `1e2fc5b`, and browser controller `4d0b691` (local commit identifiers; remote checkpoint commits may aggregate equivalent trees).

The full suite reached194 tests with one integration assertion failure caused by the new metadata-only Resource catalog. The test had compared detailed metadata to an intentionally omitted catalog field; the corrected test fetches full canonical detail and asserts exact body/metadata preservation (`b191ae9`). The focused genuine local Worker manager journey passes. Final aggregate results will follow; no failed run is described as passed.

Current external proof limits: Firefox connector calls failed internally; local Chromium binary missing; official browser download403; cloud browser cannot reach local fixture. No production deployment, native account mutation, native Helper session, CAPTCHA bypass or paid inference occurred. Real Firefox/Cloudflare/web-client/provider gates remain open. Candidate instructions: docs/INSTALLATION.md, CONNECTORS.md, RECOVERY.md and RELEASE_VERIFICATION.md.
