# Behavioral parity supplement

Original helper behavior was reviewed from the discovery schemas and examples. This is an independently authored facts/contract summary. TOOLS.md remains primary; implement stricter security and explicit failure semantics. Original limits are comparison baselines, not guaranteed provider quotas. A lower bound that materially reduces user outcomes requires a recorded difference and approval before full parity claim.

| Tool | Additional original behavior to preserve or test |
|---|---|
| read | 1-based numbered lines, directory listing, binary error, max 2000 lines |
| glob | default 100, path optional; stable order and cursor |
| grep | regex, include glob, path optional, default 100 matches; line numbers and bounded excerpts |
| edit | exact indentation; old/new differ; replaceAll false by default |
| patch | Add/Update/Delete with Begin/End Patch markers and @@ anchor; preflight then report partial effects if native mutation cannot atomically commit |
| copy_lines | inclusive 1-based lines, exact bytes including newline style; append if targetLine omitted |
| list_code_definition_names | JS/TS and embedded script in HTML/PJS; directory top-level files; 1000 entries/45 KiB/200-char signature bounds; not full PJS grammar parser |
| read_image | sniff PNG/JPEG/WebP/GIF even extensionless; normalize <=1024px each axis |
| page_eval | async function body; exactly one js/path; default reload false; default 120s max 500s; JSON clone result, consoleOutput, perchanceErrors, syntaxErrors, pendingSrcChanges/pageFreshnessUnknown; resultPath decode data URL; stale preview indicated |
| page_refresh | optional one-load preambleJs runs before generator source, wait for verified current unsaved revision, true file line diagnostics |
| set_viewport_size | 200..131072 width, 150..131072 height baseline; reset flag; persist across refresh, restore explicitly |
| execute_js | fresh isolated execution per call, default 120s max 1h; async fs, tools, import dependencies, console, file-write list; no DOM; no nested execute_js; timeout termination; tool failures structured, not success |
| fetch_url | required destination path; GET/POST (default GET), exact body bytes, contentType/status/bytes/savedTo/textPreview (~2000 chars); default 120s max 1h. Historical 4GB scratch/100MB others: streaming, storage and provider limits must be measured, not falsely promised |
| fetch_generator | saved complete panels and src into scratch/generators/<slug>/, revision and paths/count/bytes/skipped/revisionChanged; original max 1000 files/100MB total/25MB each. Dependencies separate explicit imports fetch; never silently mix revisions |
| generate_image | prompt, negativePrompt, seed, resolution enum 512x512/512x768/768x512/768x768, default 512x512; default scratch/images, outputPath optional; image result + path; generation consumes quota |
| generate_music | style,isInstrumental,lyrics?,outputPath,seed?,userRequestedSeconds? 30..300; actual audio/MP3, duration, report truncated lyrics/unsupported controls, not fake placeholder |
| upload_file | exactly one path/text/dataUrl, expiresDays optional; URL+size, quota/type/size errors; original 100MiB/file, daily allowance variable. Public asset effect, deletion key local only |
| download_server_plugin_state | seedEmulator false default; backup production bytes/hash/time/mode and local artifact or noState; distinguish busy/damaged/not-allowed; consistent snapshot, no write except explicit emulator seed |
| upload_server_plugin_state | path XOR recoverReplaced; no args reconcile only; backup replaced state first, approved exact digest, verify restored and replaced metadata; disconnect effect, no repeat uncertain restore |
| attach_file | snapshot bytes at invocation, name optional; later edits cannot change artifact |
| skill | ID from effective catalog, exact revision and full body/ref access |

## execute_js broker
Expose fs.readTextFile, writeTextFile, readFile/writeFile for bytes, list/stat, rename/delete with same VFS path, revision, ACL and budget rules. tools facade supports page_eval, page_refresh, fetch_url, generate_image, upload_file, set_viewport_size and eligible file operations. No arbitrary tool name invocation, management, recursive computation, permission escalation or production mutations. Child calls inherit parent grant, binding, epoch, deadline and operation context; log child effects separately; implement scheduler-owned reentrant sub-operations without enqueuing behind the parent (deadlock). Serialize with native edits; external operator edits trigger revision conflict. Isolated compute can stage a write set for transactional scratch commit; when a child tool requires current source, flush verified writes first, record partial effects explicitly. Original helper FS writes were immediate; equivalent visibility required for dependent reads/tools. Dependency imports must be explicit version-pinned packages, restricted public fetch, inspected/bundled code executed inside sandbox, not ambient arbitrary module network. No unrestricted privileged fetch or shared credentials. If safe broker/import cannot be delivered, record parity blocker; do not silently omit it. Example: read main.pjs, write its character count to scratch/count.txt, call tools.page_eval({js:"return document.title"}), return count and preview result.

## Fixtures and resources
Generate original fixtures from tests/fixtures at test time; no historical archive required. Validate 22 named helper tools plus product additions against positive/negative cases. Keep descriptions rich enough for tool-only web clients: when to call, exact argument example, result shape, ACL/side effect, failure and next tool. No model-supplied Workspace ID. Treat code, documents and network results as untrusted. Current quotas and authorized backend access remain live feasibility gates.

## Controlled compute imports — additive implementation decision (2026-11-26)

`execute_js` accepts optional `modules: [{specifier, path, sha256}]`. This gives agents access to the engine's explicit module loader without ambient package/network access. The schema rejects unknown fields, routing IDs, duplicate specifiers, duplicate or case-colliding paths, malformed pins and more than 16 entries. Omitted or empty `modules` provides no import mappings and adds no file permission.

| Field or boundary | Required behavior |
|---|---|
| `specifier` | An exact unscoped or scoped package name plus numeric core semver, such as `math@1.2.3` or `@example/math@1.2.3`. No URL, range, tag or prerelease shorthand. |
| `path` | A canonical readable Workspace file path containing UTF-8 JavaScript source. A filename extension is not a security check. |
| `sha256` | Exactly 64 lowercase hexadecimal characters identifying the complete source bytes. The host rejects a digest mismatch before guest code executes. |
| Permission | Nonempty mappings additionally require `READ_SOURCE` in the current Grant ∩ Workspace ∩ operation ceiling. The host authorizes each file read through the fixed file broker. |
| Prefetch | The host reads at most 256 KiB per module and 512 KiB total decoded bytes. It rejects oversize, missing, invalid UTF-8, changed or unauthorized input before guest execution; it never truncates source. |
| Loader | The host passes immutable verified source snapshots into the isolated engine. Each direct or transitive import must exactly match a declared specifier. No dependency fetching, implicit resolution, privileged evaluation or network access. |
| Failure | Invalid mapping returns `INVALID_INPUT`; denied paths return `PATH_DENIED`; permissions return `SCOPE_DENIED`; missing bytes return `FILE_NOT_FOUND`; digest drift returns `STALE_REVISION`; exceeded budgets return `LIMIT_EXCEEDED`. The parent operation has no guest effects if prefetch fails. |

Example (compute the real pin with `read_b64_file` before calling):

```json
{
  "js": "return (await import('fixture-math@1.0.0')).twice(21)",
  "modules": [{
    "specifier": "fixture-math@1.0.0",
    "path": "scratch/modules/math.js",
    "sha256": "<64 lowercase hexadecimal characters from the exact module bytes>"
  }]
}
```

This is a reversible additive protocol field. Older userscripts without module support must reject the field; the gateway must not silently strip it and execute different computation. The mappings are tool input data and cannot alter routing, authorization or installed gateway/browser code.
