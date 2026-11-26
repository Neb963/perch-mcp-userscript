# Tool catalog and parity contract

The original 23 tool descriptions are transcribed in the owner-supplied discovery archive, not formal validated JSON Schema. Exclude platform_bug_report by owner decision; no report skill. Preserve names and core arguments where useful, but strict schemas and safety semantics take precedence. Additional browser calls observed in discovery-v3 (workspace_snapshot, capture_page_image, put_files, save_b64_file, read_b64_file) are tracked separately; aliases browser_eval/browser_refresh not necessary when equivalent tool exists. No native Helper session APIs. All tools return MCP content plus structured result where client supports; text fallback includes operationId, status, revision, concise guidance. Images use standard image content, artifact download fallback. Do not depend on client support for MCP resources/prompts, binary uploads, progress, Tasks or elicitation. Tool descriptions specify scope, prerequisites, arguments, side effects, error remedy, examples and follow-up tool. Machine-readable schema implementation required in P03, with additionalProperties false and exactly-one checks. No model-controlled routing parameters.

| Tool | Input contract (optional marked ?) | Outcome and acceptance | Authority / gap |
|---|---|---|---|
| skill | id, revision? | Full applicable skill and references, content hash; unknown ID explicit | Resource read |
| read | path, offset? >=1, limit? 1–2000 | Numbered UTF-8 lines or paged directory; binary explicit error | Workspace read |
| write | path, content, expectedRevision? | Exact UTF-8 replacement/new file; revision and readback | Source/scratch write |
| edit | path, oldString, newString, replaceAll? false | Unique exact match or all explicit matches, unequal strings, no mutation on ambiguity | Source/scratch write |
| patch | patchText, expectedRevision? | Begin Patch / Update/Add/Delete File / End Patch, anchor/context exact; validate entire patch before any effect; known partial enumerated, not silent | Source/scratch write |
| glob | pattern,path?,limit? <=100,cursor? | Stable paged path set; reject traversal | Workspace read |
| grep | pattern,path?,include?,limit?,cursor? | Bounded regex search, real line numbers; safe regex engine/time budget | Workspace read |
| list_code_definition_names | path | JS parser signatures and exact ranges; bounded 1000/45KiB, parse error explicit | Workspace read |
| copy_lines | sourcePath,sourceStartLine,sourceEndLine,targetPath,targetLine? | Inclusive one-based range; insert or append; snapshot source first | Source/scratch write |
| read_image | file_path | PNG/JPEG/WebP/GIF decoded, normalize max 1024px; invalid image error | Workspace read |
| page_eval | js XOR path,reload?,resultPath?,timeoutMs? | Async body, return cloned data + console/errors/freshness; resultPath binary data URL decoded; no top-frame execution | Preview execute; bridge gate |
| page_refresh | preambleJs? | Fresh current unsaved source applied and diagnostics; preamble before startup | Preview execute; preamble gate |
| execute_js | js,timeoutMs? (max 3600000) | Isolated compute with bounded workspace APIs, result, console, filesWritten; termination | Compute+applicable file ACL; sandbox gate |
| set_viewport_size | width,height,reset? | Logical viewport and scale; requested helper range 200–131072 x 150–131072 subject to measured browser limits; explicit rejection if unsupported | Preview control |
| fetch_url | url,path,method? GET/POST,body?,timeoutMs? | Bytes saved, status/type/count/text preview; no credential forwarding; SSRF defenses | Network + file write |
| fetch_generator | generatorName | Saved complete source + imports snapshot, exact revision/bytes; revision change flagged, read-only imports | Public read |
| generate_image | prompt,outputPath?,resolution?,negativePrompt?,seed? | Authorized image backend, workspace image; document seed/resolution fidelity and quota | Media; plugin/provider gate |
| generate_music | style,isInstrumental,lyrics?,outputPath,seed?,userRequestedSeconds? 30–300 | Authorized music backend, playable file/duration; no native private Helper inference | Media; backend unresolved |
| upload_file | exactly one path/text/dataUrl,expiresDays? | Public asset URL and verified length; deletion capability stored locally, not logged; native verification and quotas | External upload |
| download_server_plugin_state | seedEmulator? false | Authorized consistent production snapshot, path, stateBytes/fileBytes/storedBytes/hash/time/mode or noState; optional emulator seed | Production read; provider gate |
| upload_server_plugin_state | path? XOR recoverReplaced?, neither = reconciliation only | Backup first, explicit approved replacement, verified digest, previous backup; no reapply after interruption | Production restore; provider gate |
| attach_file | path,name? | Operator-accessible authenticated artifact, no public URL by default; client content fallback | Artifact export |

22 included helper tools. Original page_eval default 120s/max 500s and fetch_url/execute_js max 1h; interactive gateway timeout separate. Limits default bounded, long operation handles when client deadline short. Original patch attempts later ops after failure; product chooses preflight first to avoid avoidable partial effects, report differences. Original helper absolute paths intentionally unsupported. Media differences and client rendering support tracked.

## Additional tools (product and observed browser capability)
| Tool | Contract |
|---|---|
| workspace_status | identity, binding, dirty state, lease, revision, permissions, blocked reason; no secrets |
| workspace_snapshot | current main.pjs/index.html + src manifest and revision; paged large payload |
| put_files | array path + encoding + bytes, bounded batch, checkpoint/preflight and per-file results |
| save_b64_file / read_b64_file | exact binary bytes, chunked large payload, size/digest |
| capture_page_image | actual preview pixels where feasible; viewport + image artifact; if only approximate capture available mark unsupported until approved alternative |
| list_files / rename_file / delete_file | exact local virtual paths; no implicit remote asset deletion |
| checkpoint_create / checkpoint_list / checkpoint_restore | local complete draft, expected revision, preserve current; restore does not Save |
| save_generator | explicit intendedRevision, native Save, independent full-source verification and receipt |
| generator_info / create_generator / rename_generator / duplicate_generator / set_listing / delete_generator | identity-bound lifecycle; create and new binding only operator approved; publish/delete fresh approval; no arbitrary account inventory |
| list_skills / list_workflows / get_workflow / get_instructions / search_documentation / read_documentation | effective scoped Resource revisions, pagination and examples |
| operation_status / cancel_operation | scoped operation handle; terminal/unknown/partial; cancel not retroactive |
| editor_undo / editor_redo | native per-panel undo manager, revision check |
| preview_diagnostics | console, runtime errors, warnings, settled lint and preview revision |

## Error and result contract
JSON structured result {operationId,status,revision?,effectState,data?,error?:{code,message,retryable,recovery}}. Status SUCCEEDED/REJECTED/PARTIAL/UNKNOWN/CANCELLED; protocol/auth failures HTTP/JSON-RPC per SDK; operational errors isError true. Codes: AUTH_REQUIRED, SCOPE_DENIED, REVOKED, APPROVAL_REQUIRED, TAB_OFFLINE, TAB_BUSY, BINDING_MISMATCH, STALE_EPOCH, STALE_REVISION, NATIVE_CONFLICT, UNSUPPORTED_INTERFACE, INVALID_INPUT, PATH_DENIED, LIMIT_EXCEEDED, QUEUE_FULL, QUOTA_EXCEEDED, CHALLENGE_REQUIRED, PROVIDER_REJECTED, TIMEOUT, CANCELLED, EFFECT_UNKNOWN, PARTIAL_EFFECT, RESOURCE_CONFLICT, INCOMPATIBLE_VERSION. Error retryable only for safe known-no-effect conditions; UNKNOWN always reconcile first. MCP annotations truthful: destructiveHint for external replace/delete, readOnlyHint only genuinely read-only, openWorldHint for external interactions. Annotations not authorization.

Examples: read({path:"main.pjs",limit:50}); edit({path:"index.html",oldString:"<h1>Old</h1>",newString:"<h1>New</h1>"}); page_eval({js:"return document.title"}); save_generator({intendedRevision:"<revision from workspace_status>"}). Full generated schema/examples and tool docs required prior to release. Never advertise nonfunctional tools as enabled; catalog can expose availability with reason. Mandatory parity remains incomplete until verified, even if tool is hidden.

The self-contained supplement [TOOL_PARITY_DETAILS.md](TOOL_PARITY_DETAILS.md) records additional original behavioral requirements, limitations and example calls. It is mandatory input for implementation and schema generation. The supplied original archive is not needed by the coding agent.
