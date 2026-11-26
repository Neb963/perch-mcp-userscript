# Implementation ledger

Status: design baseline prepared; no runtime code, no live deployment, no live verification. Each phase starts by reading actual repository state and writing detailed plan/evidence here. No phase marked complete from design alone.

| Phase | Dependency | Deliverable / exit criteria | Status |
|---|---|---|---|
| P00 | — | Client spec, architecture, tool parity, evidence, setup, verification and governance | Complete (design documents only) |
| P01 | P00 | Firefox disposable diagnostic userscript; feature-detect editor/src/draft/preview/native Save and frame boundaries; F01/F02/F04/F05 evidence; read-only first then authorized disposable tests | Pending |
| P02 | P00 | Minimal deployable Worker OAuth/Registry/Workspace transport; clean dashboard setup; two named web connectors isolated; current/legacy MCP; F03/F08 | Pending |
| P03 | P01/P02 | Shared contracts + strict schemas + typed adapters; state machines, fencing, authorization, error mapping, local emulator, deterministic tests | Pending |
| P04 | P03 | Core VFS, source tools, scratch/imports, revision checks, checkpoint/restore; native draft preserving | Pending |
| P05 | P04 | Preview/eval/refresh/diagnostics/viewport/capture; isolated compute, bounded fetch; F05/F06 | Pending |
| P06 | P04 | Native save, generator lifecycle, upload, independent verification, unknown effect reconciliation; disposable tests | Pending |
| P07 | P03 | Resource registry/editor/import/export/version/diff/assignment; default provider-neutral skills/workflows, tool-only delivery | Pending |
| P08 | P05/P06 | Image/music, authorized production state backup/restore/emulator, artifacts; F07/F08, record unresolved parity | Pending |
| P09 | P04/P07 | Full manager UI setup wizard, OAuth management, diagnostics, backup/restore, pause/rebind/kill, accessibility | Pending |
| P10 | P05–P09 | Security, concurrency, fault injection, interoperability, upgrades, quotas and real end-to-end acceptance; F09 | Pending |
| P11 | P10 | Release .user.js and .txt, Worker deployment package, verified dashboard walkthrough, parity report, rollback guide | Pending |

P01 and P02 may proceed independently. No production feature activation before relevant feasibility gates. P08 may investigate early without blocking core progress; full parity release still blocked by unresolved mandatory capabilities. No live browser or cloud deployment conducted for P00.

## Current blockers
- Need real Firefox manager and disposable generator tests (F01/F02/F04/F05).
- Need deployment/connector interoperability proof (F03/F08).
- Need authorized equivalent music and production server-state interfaces (F07).
- Original skills and raw evidence supplied privately; import during testing, do not publish third-party assets until rights verified.
- No actual executable source or deployable release yet.

## Intended repository layout
apps/gateway (Worker + DO + OAuth), apps/userscript (top controller, frame executor, native adapter, UI, local VFS), packages/contracts (schemas and types), packages/resources (our original defaults), tests/{unit,integration,fixtures,e2e}, docs, scripts (build/package/deploy validation). Single workspace package manager lockfile. Actual packages/scaffold created in P01–P03 with tested dependencies, no fake runtime.

## P00 evidence checkpoint
- Initial repository was empty. Initialized main and committed the design baseline and protocol supplement.
- Archive integrity and SHA-256 checked locally; relevant platform documents, original tool schemas, skill export manifest and selected captured frontend source inspected. Public primary-source MCP and Cloudflare docs consulted.
- No CI triggered, no production code, no live provider mutation, no deploy performed. P01/P02 are the next eligible feasibility phases.
