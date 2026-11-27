# Epoch 14 — v0.1.16: continuous source development and journal convergence

## User-visible failure and authoritative evidence

2026-11-27, userscript v0.1.15, deployed gateway v0.1.7. The live operator diagnostics15 show a healthy connected lease, normal poll/heartbeat/reply traffic and successful preview evaluation. The live `workspace_status` result for the SynthPin editor identifies the exact local source record:

- Generator slug `f9zmb9p4rn`; native draft saved at revision 33, `dirty:false`, `snapshotVerified:true`; the native source and editor identity are readable.
- Local intent `4e01ad79-d630-42ab-809e-110fce6e9bce`, state `UNKNOWN`, affected `src/synthpin.css`, base revision 32. Native revision 33 was saved and the operator independently verified the extracted stylesheet.
- The browser-local ID correctly returns gateway `operation_status` **NOT_FOUND** because it is not a gateway operation ID. The previous tool/UI advice incorrectly implied these IDs could be reconciled through gateway lookup.
- `sourceWrite` and `saveGenerator` were unavailable solely because `UNRESOLVED_LOCAL_WRITES` was used as a global Workspace write gate.

An exact live readonly connector call confirmed these values. No SynthPin source mutation was performed as part of the investigation.

## First-principles design decision

The canonical mutable state is the **currently observed native editor source** (Generator/Draft identity plus full bytes and revision). A local journal records an *attempted command* and whether its receipt was known. It does not own the source indefinitely. The current source is a safe new baseline after two independently matching complete snapshots and a native editor readiness/guard check. Adopting a baseline never proves an earlier command succeeded, never replays it, and never changes the source.

This is an incremental, backward-compatible amendment; no gateway, OAuth, Durable Object, KV, user Grant, resource API or file-path change is required. It deliberately reduces journal influence on unrelated developer operations without weakening native ownership, selected Workspace identity, source revision CAS, external-effect idempotency or preservation of prior checkpoints.

## Operational state matrix

| Condition at tool invocation | Userscript action | Effect/receipt | Agent remains usable? |
|---|---|---|---|
| No outstanding local intents; native readback available | Read/modify at exact current revision | New operation journal, checkpoint, native readback | Yes |
| Historical local intent, intended post-write digest matches full current source | Mark journal `SUCCEEDED` from exact bytes; do not replay | `VERIFIED_INTENDED_BYTES` | Yes |
| Historical local intent, intended digest unknown/mismatched; source stable, guard idle, >=15s old | Retain `UNKNOWN` history, mark `resolvedByReadback`, adopt current editor as new baseline | `ADOPTED_CURRENT_SAVED_SOURCE` or `ADOPTED_CURRENT_DRAFT` | Yes |
| Historical import-cache intent | Adopt current manifest or scope temporary conflict to same import prefix | `ADOPTED_CURRENT_IMPORT_CACHE` | Source tools yes |
| Previous journal belongs to a different identity, source stable | Preserve old outcome; supersede old binding metadata | `SUPERSEDED_BINDING` | Current binding yes |
| New intent <15s old, same source path or Save may still be pending | Do not replay; bounded path-specific conflict until quiet/rechecked | `NATIVE_CONFLICT` with retry instruction | Other paths, reads, preview yes |
| New intent <15s old, disjoint path | New fresh snapshot + checkpoint + CAS; leave earlier intent unchanged | New operation receipt | Yes |
| Native source bytes inaccessible/unstable or native guard active | No source mutation; preserve all prior data | Explicit source-readback/native status | Independent tools yes |
| Wrong Generator/Draft, stale revision, missing writer lease | Do not write | Explicit identity/revision/lease error | Read-only/other Workspace yes |
| Local journal metadata corrupt or unreadable | Preserve raw record, disallow unsafe write reconciliation | Explicit `STORAGE_CORRUPT` or local store issue | Transport and other tools yes |

The 15-second quiet interval applies to source effects whose exact intended bytes cannot be proven. It bounds a new potential overlap rather than permanently blocking the Workspace. An agent can refresh `workspace_status` and retry a **new command** against its latest revision. The old uncertain command is never automatically replayed.

## Source paths and Gateway IDs

All new native source mutation journals record the associated Gateway `operationId` separately from their local journal UUID. The native Save journal records both explicitly. Controller gateway reconciliation only acknowledges a local journal whose `gatewayOperationId` matches the resolved gateway operation. Checkpoint restoration propagates the same ID. Historical local UUIDs are never sent through gateway operation lookups; background Activity pagination is skipped when no journals have a gateway ID.

## Tool and UI behavior

`workspace_status` performs best-effort read-only local convergence **before reporting effective source capabilities**. It reports the remaining recent path restrictions and recent adoption evidence, so an external agent can safely proceed. Old historical journals are retained as audit records; only outstanding journals are presented as write restrictions. The Recovery screen also invokes the same read-only convergence before presenting human actions. Optional history failures do not invalidate an otherwise verified native source.

An existing `UNKNOWN` result remains `UNKNOWN` when its original effect cannot be proven; new source operations use a fresh operation ID. Never report old operation success purely because a later human Save occurred. Production Save/Create/Delete/Restore and other external provider effects keep their existing permission, confirmation, authorization and no-blind-replay boundaries.

## Verification and limitations

Targeted native VFS tests cover (1) the exact SynthPin legacy journal and saved current source, (2) independent source changes, (3) multiple old native/Save intents, (4) exact intended-hash recovery, (5) recent overlap isolation, (6) import-cache isolation, (7) readback failure and identity change. Existing full unit/integration suites validate revisions, manual edits, native bridge, OAuth/Workspace isolation and Gateway release compatibility. CI typecheck, 314+ artifact hashes and Worker dry-run are required for release.

This change has **not** been installed into the owner's Firefox from this development environment. User-data editing or Save on SynthPin is not performed as an acceptance shortcut. The first real v0.1.16 `workspace_status` response should show no unresolved hold for the old CSS operation and should list a recent `ADOPTED_CURRENT_SAVED_SOURCE` record; a successful ordinary source edit and new Save must still be independently checked in the operator's environment. Claims about live mutation acceptance remain deferred until evidenced.
