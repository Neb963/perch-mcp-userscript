# Resource implementation and evidence

2026-11-26. T1 verified; T4 fresh deployment and tool-only external-client retrieval remain required. No live inference, posting, upload, state restore or generator mutation was performed.

## API and authority

`packages/resource-library/src/index.ts` implements the versioned library as a pure transaction model. The gateway persists `snapshot()` under its serialized Registry storage transaction; constructing a library does not itself write storage. Await `seed`, `publish`, `restore`, `duplicate`, `previewImport` and `commitImport` before persisting. Mutations check both Resource and Library revisions, so overlapping asynchronous publishes cannot overwrite a committed update. Getters return copies.

| API | Contract |
|---|---|
| `seed(defaultResources)` | Idempotently initialize bundled records; update untouched defaults; preserve customized/deleted records |
| `list(context?, kind?)` | Admin with absent context sees all nondeleted records; Agent context resolves global, Workspace, then Agent enabled overrides in canonical ID order |
| `get(id, context?, revision?)` | Effective scope checked before historical access; missing/disabled records rejected |
| `publish(input, expectedRevision)` | Full validated replacement; absent creation uses string `absent`; append immutable revision |
| `history(id)` / `diff(id, from, to)` | Admin history and exact line changes for body/reference files; no mutation |
| `restore(id, historicalRevision, expectedRevision)` | Create a new revision from history; never move the counter backward |
| `duplicate(id, newId)` | Copy the selected active body/reference files into a new Resource |
| `assign(scopeType, scopeId, resourceId, enabled, expectedLibraryRevision)` | Admin-only caller responsibility; deterministic overrides; no model authority |
| `remove(id, expectedRevision)` | Tombstone after checking dependent Resources and assignments |
| `previewImport(bytes)` | Validate ZIP, manifest/flat mapping, metadata and UTF-8; return additions/conflicts/exclusions plus content digest and base revision |
| `commitImport(preview, decisions, expectedLibraryRevision)` | Reject stale/tampered preview; explicit replace/skip/fork conflict decisions; validate complete dependency graph before atomic publish |
| `exportZip()` | Resource definitions only, canonical metadata allowlist; no credentials or generator source |

Assignments control availability of a Resource ID, not gateway permissions. A disabled default may be enabled only for one Agent to make it private to that assignment; all Agent retrievals must pass authenticated Workspace/Agent context, never model-supplied IDs. Security permissions are not evaluated from Resource text. Exported bodies are operator-authored content; the library cannot infer whether an operator deliberately pasted a secret into document text. Administrative credential metadata has no accepted Resource field.

## Import and storage limits

ZIP32 only: at most 8 MiB compressed, 16 MiB expanded, 500 archive entries, 1 MiB per text entry, compression ratio 100. Paths must be canonical relative NFC names; traversal, encoded separators, backslashes, control characters, case aliases, duplicate names, symlinks, special files, encryption and ZIP64 fail before publication. Central/local names and method flags must agree. Streaming inflate checks actual output bounds and CRC; UTF-8 decoding is fatal. Explicit empty directory records are accepted.

Manifest imports map each resource body and reference path. Flat imports accept `<skill-id>.md`; README, reporting and OpenCode files are excluded from the active library and visible in preview. Unknown metadata is rejected. All import changes remain local to a candidate snapshot until graph validation and CAS succeed. Initial library limits: 250 Resource IDs, 100 revisions per Resource, 16 MiB total serialized history. No automatic history eviction. Export before explicit cleanup when a budget is reached.

## Bundled knowledge

Eleven expanded, independently authored domain skills, engineering instructions, generator-development Workflow and public-source review Document are bundled in `packages/resources/defaults.ts`. Regenerate after editing source Markdown with `node packages/resources/generate-defaults.mjs`. Install performs no external import.

Read-only public plugin code was retrieved using `/api/getGeneratorsAndDependencies` and public documentation templates using `/api/downloadGeneratorOutputTemplate`. The review records code-field hashes and provider timestamps in `packages/resources/documentation/public-source-review.md`; raw upstream code was not committed. Original explanations, examples and negative-case matrices were added for all eleven skills. Important corrections concern comments rule syntax, atomic object update callbacks, minimum upload retention, ineffective image-reference input and unsaved-only emulator aids. Music and production-state parity remain externally blocked; the skills do not disguise them as implemented capability.

## Verification

Command: `node --import tsx --test tests/unit/resources.test.ts` — 15/15 pass on Node 24.22.3. Focused strict TypeScript check passes for the library/defaults. Cases cover all eleven fresh defaults, repeated seed, custom edit preservation, immutable history/restore/diff/duplicate, concurrent compare-and-swap, scope isolation including history, dependency cycles, atomic import/fork decisions, manifest export roundtrip, malformed archive paths/case/CRC/encoding/expansion, stale preview, invalid persistent history, prototype-shaped IDs and unknown secret-bearing metadata rejection.

Higher tiers still needed: Registry storage integration/restart tests; manager import/editor interaction; deployed tool-only retrieval with real authenticated connectors; real browser update and rollback. T1 tests establish the transaction model, not those external outcomes.
