# Epoch 9 — operator HAR / native-action implementation (0.1.11)

## Evidence and privacy boundary

The operator supplied a Perchance browser HAR captured on 2026-11-26. The raw HAR contains account credentials/session tokens and MUST NOT be committed, logged, attached to public CI, or echoed in MCP results. Only the following redacted protocol facts were extracted.

| Native UI action | Observed provider endpoint | Request shape (private values omitted) | Response and independent evidence |
| --- | --- | --- | --- |
| Set Listed | `POST /api/changeGeneratorPrivacy` | `email`, `sessionToken`, `generatorName`, `isPrivate:false` | `status:success`, `isPrivate:false` |
| Set Unlisted | Same | Same with `isPrivate:true` | `status:success`, `isPrivate:true` |
| Change URL | `POST /api/changeGeneratorName` | `currentName`, `newName`, `generatorId`, `expectedRenameRevision`, `operationId`, `editorClientId`, existing native credentials | `status:success`, stable native public ID; next slug's `GET /api/generatorPageDataVersion/...` returned the original Generator ID |
| Save | `POST /api/save` | current Generator source, imports, source manifest, last-known save revision/count and native credentials | `status:saved`, `saveCount` incremented, `sourceRevision`, `srcManifest` |
| Ownership | `POST /api/checkGeneratorOwnership` | `generatorName`, native credentials | `status:is-owner` |
| Read-only verification | `GET /api/generatorPageDataVersion/<slug>` | no mutation | `status:success`, stable Generator ID, boolean `isPrivate`, saveCount, revision metadata |

The same HAR contains native editor JavaScript evidence: `window.userOwnsThisGenerator` and `window.userCanSaveThisGenerator()` are globals on the native page (not `app` fields); `app.openListingMenu()` schedules an asynchronous `listingMenu` load; `app.openSettingsModal()` lazily loads `settingsModal`; native rename uses `settingsModal.changeGeneratorName()` and the native `__renameHandoff` protocol with cross-tab draft and URL navigation.

## MCP mapping (no duplicate tools)

- `save_generator({intendedRevision})`: native owner + Save predicate, exact assigned Generator/Draft/lease/Grant, independent complete pre-Save base, durable dispatch journal, one native `app.saveGenerator()` invocation, independent exact persisted bytes, read-only settlement; UNKNOWN holds on ambiguous dispatch and never replays.
- `set_listing({listing:'listed'|'unlisted'})`: exact bound owner, LISTING Grant and synchronous isolated Operator confirmation bound to action, source revision, epoch and identity; click actual enabled native menu choice after delayed UI readiness; verify stable ID, stored source and public `isPrivate` via read-only provider version/data endpoints.
- `rename_generator({newName})`: exact bound owner/RENAME Grant and source revision; use native settings and `__renameHandoff` via `settingsModal.changeGeneratorName()`, not an unaudited direct credential-bearing POST. Confirm same ID and source through public readback when the old tab survives. Native handoff may navigate before MCP acknowledgement: preserve uncertain effect and require new-URL rebind/reconciliation, rather than inventing success.

`change-url` is the native UI action name; `rename_generator` is the canonical existing MCP tool. Listed/Unlisted are two values of the single existing `set_listing` tool. No aliases added.

## Server admission

The packaged Worker is v0.1.6 and sets `NATIVE_ACTIONS_ENABLED=true`. Only the above three exact tool names and corresponding required permission tuples are admitted through this selective flag. Broad `PROVIDER_WRITES_ENABLED=false` remains unchanged. All other provider-writing and unavailable actions retain the previous gates, including CREATE, DELETE, DUPLICATE, MEDIA, UPLOAD_PUBLIC and PRODUCTION_RESTORE. Registry revalidates on both MCP admission and Workspace dispatch. Tool listing advertises gateway enablement accurately; local owner/feature/lease status is still required. No generic browser, API or native-helper RPC was added.

## Verification and acceptance

Automated gates: strict TypeScript; native owner/nonowner; lazy listing/settings readiness; immutable exact source; HAR-shaped read-only version/listing; stable ID; stale/mismatched states; operator confirmation; admission permission matrix; lost receipts/no auto replay; complete unit/integration suite; compiled TXT/JS byte equality and release checks; bundled Worker dry-run.

Provider evidence in the supplied HAR proves that **the native UI** performed the three operations. It does **not** prove the new MCP request-to-native-adapter integration until 0.1.11 is installed with Worker 0.1.6 and real actions are verified. This project will not mutate the operator's existing generator as a test fixture. URL change may terminate the old document before the MCP response; its outcome must be reconciled using the new URL/Generator ID and explicit Workspace rebind. Never automatically retry native rename or Save.

## Deployment ordering

Upgrade the existing Worker under its **existing Cloudflare deployment identity**, preserving Durable Object migrations/bindings, OAuth KV and every secret, not by creating a new Worker or re-pairing. Verify `/health`: gateway version `0.1.6`, `nativeActionsEnabled:true`, `providerWritesEnabled:false`. Then replace the existing Violentmonkey userscript with v0.1.11. If the older v0.1.5 gateway remains deployed, the new userscript reports unavailable actions and the Registry rejects provider effects; client-side code cannot override server policy.
