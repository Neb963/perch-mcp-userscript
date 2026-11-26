# Native browser safety audit — 2026-11-26

Evidence tier T0: anonymous public-source inspection. T1: original deterministic fixtures. No logged-in account, native Helper session, generator mutation, Firefox execution or disposable provider experiment was used. Public scripts stayed in scratch and are not redistributed.

## Public-source provenance

| Primary source | Retrieved bytes | SHA-256 |
|---|---:|---|
| `https://perchance.org/minimal` public editor shell | 101433 | `d75f8b1a118007f7df0353cacbe306740e7909fa087aa78e14524c5bc8e2e433` |
| `https://perchance.org/lib/editors.bundle.min.js?v=d34980caf7f211b0` | 864335 | `06b9232cacd20c4511e0bcf871b4a93965b2cbcdb47b042fd6abbdfdc8dbe7ff` |
| `https://perchance.org/lib/appExtras.js?v=a02092e9a533bd267dec3c9f-d34980caf7f211b0-mwwb21pu-a3824c4c327f7bcdc416a8b7065c8e8af6d434474f337974dc2d74455aed42f9` | 300153 | `272b3afc0b48b0df9ee0718e4940a2472d684a1f46b4b5ad4cac1c9e24038d19` |
| `https://perchance.org/lib/aiAgentClient.js?v=mwwb21pu-a3824c4c327f7bcdc416a8b7065c8e8af6d434474f337974dc2d74455aed42f9` | 747854 | `7c4b006a193205d4caf5ea969fc3251952210ee066c6ed7b031f6e6e30f72d30` |
| `https://perchance.org/lib/srcFiles.js?v=mwwb21pu-a3824c4c327f7bcdc416a8b7065c8e8af6d434474f337974dc2d74455aed42f9` | 297565 | `6b4ab7307d389e92fe6372dc97ca5bc5d81aa9699d86b32ca52a5d8bfc10e7f4` |

The shell supplies exact versioned module URLs. The first local anonymous request returned 403; an ordinary subsequent GET with a browser User-Agent returned the public documents. Firefox connector attempts returned an internal tool error, so no T3 evidence is claimed.

## Native write admission

| Native observable | Required state | Inverse branch |
|---|---|---|
| `currentInterfaceMode` | `edit` | Missing, `view`, `edit-loading` or another value disables native mutation |
| `__editorReady`, `__draftChoiceSettled` | Both `true` | Missing/false readiness disables native mutation |
| Both editor `state.readOnly` | Boolean `false` | Missing status disables native mutation; `true` reports busy |
| `aiAgentActivityState()` | Known shape, `active:false`, `unknown:false`, empty `reason` | Missing/invalid/throwing status disables native mutation; active/unresolved status reports busy |
| `__aiGeneratorGuard.blocked()` | Boolean `false` | Missing/invalid/throwing status disables native mutation; `true` reports busy |
| `__generatorIdentityTransition`, `__draftHandoffClosed` | Inactive | Active handoff blocks native mutation |
| `editorCollabInitialSyncIsPending`, `__collabRoomFailed`, `yjsProvider` | Inactive | Pending/failed/active collaboration blocks native mutation |
| `perchanceSaveState` | Not `saving` | Native Save in progress blocks mutation |

The public client status function performs status reads. The cross-tab guard reads its lock/rename state. The adapter projects only bounded status reasons and identity; it does not inspect session IDs, account objects, tokens, chat state or Helper workspaces. It does not call `__generatorAiMutationBlock`: the current implementation can wake a native Helper boot check. No Helper wake/resume/cancel/automation method is called.

`NativeAdapter.assertMutationReady()` checks these conditions immediately before source setters, undo/redo and the gated Save/lifecycle candidates. A mid-batch readiness change preserves already committed files as PARTIAL rather than rewriting history as a known rejection. Missing guard interfaces leave read-only source inspection and the ordinary native editor available. `probe.sourceWriteBlocked` explains why native remote writes are unavailable. This status check does not establish a distributed lock against every independent native browser; final readback and the required real-browser race tests remain necessary.

## Local-state repairs

| Defect | Repair | Deterministic evidence |
|---|---|---|
| Source read/edit could drop UTF-8 BOM | Source decoders preserve BOM; JSON transport decoding stays separate | Native panel and scratch read/edit/write byte equality |
| Read-only observation could rewrite a stale local manifest and erase an imported snapshot | Persist observation hash/generation separately; serialize observations; never rewrite payloads during reads | Concurrent snapshots make no local-payload writes and retain updated immutable imports |
| Orphan cleanup could remove a concurrent staged checkpoint chunk | Durable pending-generation marker protects in-flight staging; unresolved publication markers never expire automatically | Collector runs between chunk write and manifest publication without corrupting the result |
| Human acknowledgement falsely changed UNKNOWN into REJECTED | Preserve original phase; append `resolvedByOperator`, exact `inspectedRevision`, and resolution time | Stale acknowledgement rejected; original UNKNOWN retained after explicit resolution |

Reproduce with `node --import tsx --test tests/unit/browser-core.test.ts tests/unit/browser-lifecycle.test.ts`: 40 passing T1 tests at this checkpoint. No test substitutes for the Firefox/Violentmonkey content-context, actual draft, pending native viewer, Save receipt, provider challenge or cross-tab T3 gates.

## Duplicate control follow-up

The current settings duplicate method copies owner draft panels and can prepare dirty src uploads. It supplies an automatic new Slug through the scoped native duplicate-status link and does not return a receipt object. Consequently the saved-source candidate rejects a dirty draft that differs from the independently read saved source before dispatch. A normalized status-link Slug is only a target hint; success still requires complete independent new-ID/source/owner/Unlisted readback. A custom duplicate-name field was not found in the inspected current script; requested custom names fail closed when that optional control is absent. Native delete retains its own human prompt; Perch MCP does not override or auto-answer it. These source-derived constraints remain live acceptance blockers. Browser candidate suite now contains 42 passing T1 cases.

## Storage publication acknowledgement audit

`ChunkStore.put` now distinguishes staging from manifest publication. A durable PUBLISHING marker names both the intended generation and the previous generation before the pointer write is dispatched. If the pointer promise rejects, exact authoritative pointer readback selects the branch:

| Readback | Outcome |
|---|---|
| Exact intended manifest and all chunks/hash verify | Committed; return success despite lost acknowledgement |
| Exact previous manifest remains authoritative | Rejected publication; QUOTA_EXCEEDED; no compensation write |
| Pointer unreadable, invalid, different, or intended chunks unverifiable | EFFECT_UNKNOWN; retain previous/new chunks and publication marker; no retry or rollback |

The recovery path never sets the manifest pointer. A competing pointer remains unchanged. Orphan collection stops on corrupt live metadata and protects unresolved generations without timeout-based eviction. Retention can consume storage until explicit reconciliation/cleanup; storage pressure is preferable to deleting unresolved bytes.

Imports persist a local intent before pointer publication. Unknown import publication/readback leaves a durable UNKNOWN import journal and blocks later writes; a lost acknowledgement with exact successful readback completes only once. Complete readback also checks the intended Workspace source/cache digest against the preflight revision. Added tests cover commit-then-throw, exact unchanged old pointer, unavailable readback, invalid pointer, competing pointer, both-generation retention and import holds. Browser suite at this checkpoint: 47 passing T1 tests.
