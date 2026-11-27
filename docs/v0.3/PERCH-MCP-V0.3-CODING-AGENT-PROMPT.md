# Autonomous coding-agent execution prompt — Perch MCP v0.3.0

You are the principal implementation engineer for `https://github.com/Neb963/perch-mcp-userscript`. Deliver the complete v0.3.0 offline release candidate, phase by phase, autonomously and end to end. Do not stop after scaffolding, a plan, partial implementation, or passing only focused tests. Maintain rigorous evidence and minimize unnecessary complexity.

## 1. Authority and inputs

Read both supplied handoff documents in full:

- `PERCH-MCP-V0.3-IMPLEMENTATION-SPEC.md` — normative product, security, interface, migration, phase and acceptance contract.
- `PERCH-MCP-V0.3-DESIGN-PROPOSAL.md` — source evidence, architectural rationale, research and 25-item risk register.

The operator has accepted the earlier minimal-development and multi-Workspace proposals. Their decisions are incorporated into the specification; use it to resolve illustrative-schema differences. No additional private historical archive, skill package or external user file is needed. The repository contains the existing skill sources and prior O01–O07 evidence. Do not request files already provided or invent unavailable credentials.

Verify actual GitHub `main`, branches, PR #23 and CI. Expected base is merged commit `9524583b04e480875011f3675a581357afe315c3`, with the same tree as offline-qualified head `3fd1e48630737a1defd96484a3af3d3d881c84a1` (v0.2.0, 553/553 tests reported, offline run 46029453050). If main has advanced, inspect changes and preserve them; do not reset or overwrite user work. Work from the approved optimized baseline on `development/v0.3.0` (resume existing branch if present after verifying provenance). Do not selectively reconstruct the gateway optimizations from the older main.

Read `AGENTS.md` and every document it names, `CLIENT_SPEC.md`, `docs/DESIGN.md`, `docs/PROTOCOL.md`, `docs/TOOLS.md`, `docs/CONNECTORS.md`, `docs/SETUP.md`, `docs/VIOLENTMONKEY.md`, `docs/PERCHANCE_ADAPTER.md`, `docs/HANDOFF.md`, `docs/EVIDENCE.md`, `docs/TEST_PLAN.md`, `todo.md`, O01–O07 optimization plan, `docs/optimization/STORAGE-MIGRATION.md`, `docs/verification/gateway-optimization-report.md`, `OPERATOR-ACCEPTANCE.md`, exact runtime/contracts/test source and release workflow. Treat historical full Helper parity as superseded only after V00 records the accepted scope amendment. Preserve all unaffected authority and security requirements.

## 2. Non-negotiable execution boundary

**STRICTLY OFFLINE.** Do not deploy, call production or preview Worker endpoints, run live Firefox/Violentmonkey tests, execute provider operations, access real generator/account data, activate production storage migration, run paid media, dispatch production-readiness workflow, trigger Cloudflare preview, or merge v0.3. A quota reset does not authorize live work. Operator disabled preview builds; production main Git integration may remain enabled. Inspect workflow triggers before pushing. Do not change production deployment controls or bypass authorization to make checks pass. A GitHub branch/PR push is allowed only on the nondeploying development branch; no main pushes or merges. Use local Miniflare/workerd and synthetic browser/provider fixtures; deny outbound runtime network. Public documentation research and normal source/dependency retrieval are permitted; no live service test. `wrangler deploy --dry-run --config apps/gateway/wrangler.jsonc` is permitted ONLY as local dry-run with Cloudflare metadata/metrics disabled. Never remove `--dry-run`.

Use local tests whenever possible. Use GitHub Actions sparingly, for focused unresolved verification and final exact-head artifact qualification; never use production readiness. Do not claim tests were run if your execution environment cannot run them. If local shell is unavailable, inspect source and use the offline-only CI workflow, preserving exact head evidence. If no executable test path exists, do not mark phase verified; commit clearly labeled unverified work only if safe, and report the blocking capability. Do not force-push, rewrite unrelated history or delete user data. Do not indiscriminately upgrade dependencies or run `npm audit fix --force`; v0.2 dependency vulnerabilities were deferred by operator for PR #23. Report new material reachable security issues and remediate within the current scope if justified, with focused tests and recorded decision.

## 3. Product outcome

Replace legacy full Helper parity with efficient remote Perchance development:

- Exactly 19 v2 MCP tools: `read`, `write`, `delete`, `rename`, `list_files`; `page_eval`, `page_refresh`, `preview_diagnostics`, `set_viewport_size`, `capture_page_image`; `execute_js`, `fetch_url`, `fetch_generator`; `workspace_status`, `generator_info`, `save_generator`; `operation_status`, `cancel_operation`; `batch`.
- One OAuth Connector authorizes multiple exclusively assigned Workspaces; explicit generation-bound Target in every execution request; no shared active Workspace or per-chat tracking; different Connectors strictly isolated. Same-Connector chats share principal authority, not independent security identities.
- One-click operator reassign to current verified tab in idle/clean case, stable endpoint and v2 Grant; stale Targets denied, no implicit native Save/discard; dirty/unknown/in-flight cases preserve recovery evidence and gate transition.
- Targeted multi-file reads, metadata-only listings, verified binary/text writes, bounded transfer for large files, staged local compute, single-Workspace typed batches, separate Save, strong revision/identity fencing, checkpoint dedup and recovery namespaces.
- Agent-local knowledge package, no resource retrieval calls, no runtime workflow engine, no media generation/production-state/legacy generator-lifecycle tools in v2. Preserve safe archive/export and unresolved effect reconciliation.
- Preserve v0.2 canonical operation/Activity storage, bounded maintenance, BLOB capture transport, push/HTTP fallback, SQL metering, fault containment and verified package pipeline. Recalibrate quota model after actual v0.3 measurement; never optimize away safety.
- Five preview tools including actual-pixel screenshot capture where supported; no screenshot interpretation or fake DOM image. Research supported APIs first. If no safe userscript-only path exists, document the precise gate and minimum viable operator-assisted path; do not add a companion extension or bypass consent without explicit authorization. Continue other phases. An offline candidate with unavailable required capture is not fully accepted.

## 4. Execution protocol (every phase)

Follow V00–V10 in dependency order from the normative specification. You own integration and verification, not just task decomposition.

1. Inspect current repository and prior checkpoints; resume incomplete/unverified work first. Read relevant source and actual tests before modifying anything. Identify affected invariants and failure domains.
2. Write the phase-specific plan and testable exit criteria in `todo.md` before implementation. Record phase dependencies, touched subsystems, migration constraints and evidence level.
3. Implement the complete bounded phase. Prefer small explicit interfaces and existing tested primitives; remove unnecessary indirection rather than duplicate. Use strict shared schemas, closed unions, no generic privileged RPC, no model-supplied routing authority. Use stable identifiers, exact error semantics and typed contracts.
4. Verify focused positive, negative, race, restart, version-skew, quota and partial-effect paths applicable to phase. Test actual local workerd/SDK ingress and bundled synthetic controller where relevant, not only mock unit behavior. Preserve existing safety tests; replace obsolete parity assertions only after documented scope amendment, with negative v2 access/retirement and migration tests.
5. Review diff, security boundaries, resource limits, observability, backward compatibility, rollback and unresolved effects. Fix root causes rather than relax assertions. Record measured evidence and limitations. If a numerical target is missed, investigate until reasonable avenues exhausted; never trade away authorization, durability or truthful effects to meet a target.
6. Commit coherent verified progress regularly, including `todo.md` and evidence. Push checkpoint to the nondeploying branch; verify remote commit/tree. Use descriptive phase-prefixed commits. Do not wait to commit until all phases finish. Keep code changes and generated release artifacts separate; no secrets or private source in Git.
7. Continue immediately to the next eligible phase. If a provider/real-browser gate is blocked by offline restriction, record `DEFERRED_OWNER` with precise test and required proof, then complete all independent offline work. If an engineering design assumption is disproven, make the smallest compatible correction, record it, test it and update normative docs. Ask the operator only for a decision that would materially change an accepted hard invariant or require authorization not granted here; otherwise proceed using the specification.

If subagents are available, delegate independent bounded audits/tests or disjoint implementation workstreams with explicit file ownership. Do not spawn multiple agents editing the same Registry/contracts/migration authority simultaneously. The lead engineer integrates and reviews all changes, verifies actual tests and owns final release. If no subagents are available, execute sequentially. Do not claim delegation that did not occur.

## 5. Phase checklist

| Phase | Required outcome |
|---|---|
| V00 | Authority amendment, pinned baseline, complete tool/permission/source disposition, migration decisions, benchmark baseline and todo plan |
| V01 | Connector-level Grant and assignment index, explicit Target and discovery, OAuth consent and strict v1/v2 schema coexistence |
| V02 | Durable rebind/transfer/fencing state, original-scope result ACL and management idempotency, races and recovery |
| V03 | Binding-scoped local storage, old data quarantine, epoch fencing, content-addressed checkpoints, bounded GC and crash consistency |
| V04 | Five filesystem tools, targeted reads/metadata list, bounded binary transfer, exact revision/precondition and mutation/rename semantics |
| V05 | Batch, operation keys, local execution plans, bounded permits, QuickJS read view and staged commit, external retrieval and result delivery |
| V06 | Preview epoch/freshness, viewport/diagnostics, actual-pixel capture investigation/implementation, explicit verified Save |
| V07 | Exactly 19 v2 tools, external knowledge package and safe Resource/media/legacy retirement |
| V08 | Compact manager and one-click rebind, full migration/version skew/rollback integration |
| V09 | Native/legacy benchmarks, SQL/requests/KV/payload/local reads, multi-Connector capacity, recalibrated admission and OAuth analysis |
| V10 | Complete offline release candidate, exact-head full tests/build/hash qualification, artifacts and final unmerged PR |

Use the specification's acceptance IDs A01–A34 and OWNER-01–04 as evidence traceability. Expand tests for discovered risks. Do not collapse multiple unverified phases into an unsupported completion statement.

## 6. Hard invariants to audit throughout

- Every route derives Connector identity from authenticated Grant, target authority from current Registry assignment and generations, browser routing from immutable validated envelope. No targetless v2 fallback, foreign metadata leak, scope union, stale result disclosure or arbitrary child tool privilege.
- Revoke denies new permits after authoritative commit. Consumed bounded permits may have effects; preserve exact unknown/partial records. Never claim distributed atomic cancellation or blindly replay unknown mutation, Save, POST or provider effect. Idempotency key expiry cannot turn an old key into a new execution.
- Rebind/transfer never follows a Slug automatically; no old-tab mutation after new Binding publication, no implicit Save/discard, no old scratch/checkpoints exposed through new Target, no reassignment while unresolved effects may execute.
- SourceRevision, LocalRevision, PreviewRevision and SavedRevision distinct. Never assume native file list or same size proves unchanged bytes. Use conservative fallback when generation/CAS unavailable, honest unknown freshness. No broad source scanning for targeted read/list. Preserve exact binary bytes/empty files, strict canonical paths, bounded input/output, checkpoint and readback integrity.
- QuickJS stays isolated; no page/GM/ambient network/credential access. Local read-view permits amortize per-read overhead; fresh exact publication/effect permits preserve current authority. Batch cannot invoke nested target, Save, arbitrary administration or new durable lifecycle per child.
- Preview untrusted, frame messages not authorization. Screenshot actual pixels only, scoped surface and crop, consent honored, no unrelated tabs or credentials, no placeholder success. Native Save independent full stored-source verification.
- Preserve legacy/prepare/native storage authority and readers; no incompatible rollback, database reset, secret rotation, or re-pair as workaround. Archive customized knowledge/legacy unresolved evidence before removal; no automatic data purge. No new infrastructure without demonstrated need.
- Bound all loops, queues, timeouts, bytes, retained results, logs, GC, polling and retries. Exempt terminal/recovery from estimated quota denial; actual quota failure retains local evidence. No unbounded session tracking or full-history hot-path scans. Retain redacted correlation IDs and exact effect classifications.

## 7. Evidence and final deliverables

Run full offline qualification on exact final tree using locked dependencies:

```sh
npm ci --no-fund
export CLOUDFLARE_CF_FETCH_ENABLED=false WRANGLER_SEND_METRICS=false
npm run typecheck
npm test
PERCH_REQUIRE_CLEAN_ARTIFACT=1 npm run build
PERCH_REQUIRE_CLEAN_ARTIFACT=1 npm run verify:artifacts
npx wrangler deploy --dry-run --config apps/gateway/wrangler.jsonc
```

Use existing benchmark scripts plus v0.3 workload harness; retain machine-readable raw data and report with actual counts, baseline comparisons, scope, hypotheses, unmet targets, assumptions and residual risks. Ensure no test uses real provider endpoints. For final offline CI verify exact PR head SHA and artifact manifest; no preview/live deployment. Do not promise future work, background testing or live acceptance. Final PR against main remains OPEN/UNMERGED with explicit `DO NOT MERGE OR DEPLOY — operator acceptance pending` and exact tested head.

Deliver:

1. Complete committed source, updated authoritative specs, AGENTS, todo, tool schemas/permissions, migration, operator recovery, test and setup documentation.
2. Evidence matrix per phase and acceptance ID, actual test commands/counts/results, local SQL and native read instrumentation, full workload capacity models, defects fixed and remaining numerical/feasibility gaps.
3. Standalone `perch-mcp.user.txt` byte-identical to `.user.js`, Worker ZIP, source ZIP, candidate ZIP, RELEASE.json, SHA256SUMS and download checksums. No generated source bundle committed unnecessarily; exact CI artifact links when available.
4. Versioned agent knowledge ZIP and individual Markdown files, manifest/digests, exact 19-tool reference, installation and prompt guidance, no secret/private archive.
5. Operator-only acceptance checklist, migration and compatible rollback procedure, explicit preview/production restrictions, owner tests required for OAuth clients, real Firefox/Violentmonkey source/preview/capture/Save, physical push/hibernation and account billing. List unsupported capture honestly if blocked.
6. Final concise status: branch/PR/commit, passed/failed/deferred gates, artifact links and hashes, decisions/deviations and any unresolved issue. Never claim fully accepted, live-tested or deployed based on offline evidence.

Begin with V00. Continue until every eligible phase has been completed and the exact release candidate is delivered. Do not stop at a progress report. Do not merge v0.3 or run any live operation.
