# Self-contained Perchance adapter reference

Historical observations extracted from the supplied discovery material; independently summarized here for implementation. Use current native feature detection and authorized disposable tests, not blind assumptions. No external archive is required. Product authority is CLIENT_SPEC.md; this document supplies candidate provider interfaces.

## Identity / readiness
Top editor https://perchance.org/<slug>#edit requires document navigation; changing hash alone is insufficient. /minimal#edit:new starts a fork. app.goToEditMode()/goToViewMode() available in some versions. Wait for app.data.generator, modelTextEditor, outputTemplateEditor, srcState and srcState.ready(); inspect currentInterfaceMode, __editorReady, __draftChoiceSettled if exposed. Pending draft choice, native save, identity transition, busy Helper or unsynced collaboration blocks mutation. app.data.generator.id is stable Generator ID; name = Slug; publicId is distinct. srcState.getDraftId() may return empty string, getDraftKey()/getWorkspaceId() separate. Never infer ownership solely from URL. app.store.data.user contains loggedIn/email/sessionToken; secrets must stay native, not copied into bridge, telemetry, MCP or page eval. userOwnsThisGenerator and userCanSaveThisGenerator() differ; edit keys/collaboration are not ownership. Use native owner check and access policy for lifecycle effects. Save/native operation buttons are scoped to visible enabled native panel.

## Source and drafts
| Operation | Candidate interface / evidence |
|---|---|
| PJS read/write | modelTextEditor.getValue()/setValue(text) |
| HTML read/write | outputTemplateEditor.getValue()/setValue(text) |
| Selection | CodeMirror 6 state.selection, dispatch |
| Undo/redo | editorUndoManagers; feature detect per-panel methods |
| Dirty | editor.isClean() where exposed, window.perchanceSaveState (saved/unsaved/saving/error), srcState.isDirty()/hasPending(); recomputeSaveState() if available |
| List files | await srcState.ready(); srcState.list() path map {key,size,pending,rev,unsaved} fields may vary |
| File bytes | srcState.readFile(relativePath); writeFile(relativePath,bytes); renameFile(from,to); deleteFile(path); await srcState.idle() if present |
| Draft | getDraftId(), getDraftKey(), getWorkspaceId(), getDraftPanels(), listDrafts(), newDraft(), switchDraft(id), setDraftPinned(id,pinned) |
| Exit | app.hasUnsavedWorkForExitWarning() if exposed, native dirty state |
| Files panel | #aiAgentSrcFilesBtn; native viewer may debounce pending text; settle or ask Operator, never assume buffer equals srcState |

Native file path segment begins alphanumeric; remainder alphanumerics/dot/underscore/hyphen; reject traversal and collisions. Binary exact bytes. Zero-byte uploads historically could return nonempty stored bytes: verify and reject mismatch. Do not markClean or bypass draft picker. Capture intended source revision independently of provider revisions; preserve unrelated files. srcState.prepareForSave() is native upload preparation, not stand-alone commit. Dirty draft may survive reload via native IndexedDB/OPFS. Never use page store for credentials.

## Save and independent readback
Native app.saveGenerator() or [data-ref="saveButton"]. Check exact identity, permissions, draft, base, complete intended panels and src bytes, pending buffers and writer reservation before dispatch. Native POST /api/save carries generator object with name/modelText/outputTemplate/settings and top-level srcManifest, native lastKnownSaveTime/lastKnownSaveCount, credentials/challenge. Do not call direct mutation API to bypass native orchestration. Receipts may include name,time,saveCount,sourceRevision,editorPayloadRevision; do not conflate. /api/saveGeneratorDerivedData is separate metadata effect.

| Provider outcome | Handling |
|---|---|
| saved | verify complete stored source independently and match identity |
| created | expected only for fork; otherwise HOLD |
| clean/no request | ALREADY_MATCHES only after complete readback |
| stale | HOLD; never auto override |
| session-token-error/invalid-edit-key | native permission recovery |
| captcha-needed/challenge | wait for Operator native verification |
| too-many-requests/too-big | honor limits, no blind repeat |
| generator-does-not-exist | reconcile ID/slug/ownership |
| src-* / server-error / unknown / timeout after dispatch | preserve draft + operation intent, reconcile read-only |

POST /api/getGeneratorPageData JSON {generatorName:slug} returns status success, generator and dependencies. Confirm generator.id, name, modelText, outputTemplate and srcManifest; distinguish absent manifest from empty if schema uncertain. Manifest entries {key,size} or string key. Read exact bytes at https://user.uploads.dev/file/<key>, compare path set, byte length and SHA-256. GET /api/generatorPageDataVersion/<slug> may supply id,lastEditTime,saveCount,editorPayloadRevision,isPrivate,schema. An early previous-source match does not establish no late commit; unknown effects remain held. HTTP 200, clean editor, resolved click and URL change are not receipt evidence. Keep previous snapshot.

## Lifecycle
Create inert initial content via /minimal#edit:new and native fork Save; confirm created slug/new ID and owner; explicit Unlisted via native listing before staging sensitive work (Unlisted is accessible by link). Rename through app.openSettingsModal(), settingsModal.refs.newGeneratorName, settingsModal.changeGeneratorName(); verify same ID at new slug and rebind. Listing via app.openListingMenu(), #listingMenuEl button[data-value="listed"] or [data-value="unlisted"]; provider isPrivate true=Unlisted. Native duplicate/delete through settings controls, explicit source choice and approval, confirm new ID or owner inventory absence respectively. Native requests observed /api/changeGeneratorName, /api/changeGeneratorPrivacy, /api/duplicateGenerator, /api/deleteGenerator; references only, not mutation bypass. Owner inventory /api/getGeneratorsByUser, ownership /api/checkGeneratorOwnership use native credentials; expose only necessary boolean/identity. Slug available only explicit native missing-generator signal; reserved distinct; challenges/contradiction Unknown. Never infer deletion from one failed read.

## Preview
#outputIframeEl on variable sandbox subdomain. Editor reload control or editor.handleReloadButtonClick(); native console #console-input / editor.evaluateText() runs output context, not top page. codeWarningsUpdate and [data-ref="warningsModalOpenButton"] support warnings. Runtime #perchance-error-indicator may be inside preview; lint asynchronous. Observe native bridge in disposable environment; correlate frame WindowProxy, actual origin, request ID, source/preview revision. Never trust generator message as authorization. Eval executes async body, persists page state until refresh, returns result+console+errors; reload explicit, pendingSrcChanges/freshness flags; preamble must execute before generator startup if supported. Do not claim full screenshot from DOM approximation; test actual pixels. No native Helper session use or private inference token. Native Helper read-only/busy and collaborative sync block writes. Background tabs may be suspended/discarded; revalidate document.

## Public references and uploads
GET /api/getGeneratorsAndDependencies?generatorNames=<comma-list> returns success and generators map with code/imports, transitive dependencies. POST /api/getGeneratorPageDependencies {generatorName}; GET /api/getGeneratorHtml?generatorName=... and /api/downloadGeneratorOutputTemplate?generatorName=... raw HTML; GET /api/downloadGenerator?generatorName=... listsOnly=true PJS or runtime package; not complete src backups. GET /api/getGeneratorScreenshot?generatorName=... saved screenshot, NOT unsaved preview capture. GET /api/getDynamicMetaData?__generatorName=<slug>&... authoritative saved dynamic metadata. Fetch public plugin source through saved generator read and dependency API; rendered docs may be JS shells, inspect source or rendered page rather than shell text. Core public tutorial https://perchance.org/tutorial ; examples https://perchance.org/examples ; plugin directory https://perchance.org/plugins ; server documentation https://perchance.org/doc-server-plugin . Plugin slugs match resource IDs except platform/music. See bundled skills.

Standalone upload uses native embed https://upload.perchance.org with init, uploadEmbedIsReady, anonUploadRequest, anonUploadResponse, request IDs and native verification. Native upload service supports chunking and returns URL/size/file ID/deletion key; keep deletion credentials isolated; public upload explicit permission. Verify returned bytes, do not treat upload as generator Save. No CAPTCHA bypass. Saved revision controls app.openRevisionsModal(); /api/getGeneratorDiffPatches and /api/getGeneratorSrcRevisions are owner operations; reconstruct panels and matching manifest only when verified. Avoid private native AI Helper attachment store. Use our own scratch/attachment mechanisms.

## First probe sequence
Read-only capability report (type/existence, not raw global dumps): mode, identity, draft, editors, src API, save state, preview frame, VM injection, transport. No credentials. Then authorized disposable fixture: stage panel edit, src text/binary/empty, preview refresh+eval, manual edit conflict, reload draft picker, Save and independent exact readback, native stale test, rename identity and clean up only with explicit permission. Record expected/actual and versions. Do not send raw provider captures to public repository. No PCMS scheduler/Recent/account routing or native AI Helper automation.
