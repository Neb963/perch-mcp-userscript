# Perch MCP — client specification v0.1

Status: accepted v0.1 contract; candidate implementation and external acceptance status are tracked in todo.md and docs/RELEASE_VERIFICATION.md. Unverified platform dependencies remain explicit. Product owner decisions: single Firefox/Violentmonkey userscript + Cloudflare Worker; no local bridge/Tailscale; per-tab agent isolation; OAuth managed in userscript; editable/importable/exportable skills, workflows, instructions and documentation; full functional parity except platform reporting. Web UI AI clients are the target; operator reports testing custom connectors in ChatGPT, Claude and Gemini. Their exact tool/media/OAuth behaviors still require interoperability tests. No OpenCode dependency.

## 1. Lexicon
| Identifier | Meaning |
|---|---|
| Operator | Human administrator of one deployment |
| Agent | Named external connector assignment, not a model or conversation identity |
| Workspace | Persistent authorization and development context, bound to at most one active editor document |
| Binding | Explicit operator-approved mapping from Workspace to Generator ID and Draft ID |
| Generator ID | Native server id; stable over rename; not Slug or Public ID |
| Slug | Current generator address |
| Public ID | Native publicId; separate from Generator ID |
| Draft ID | Native srcState draft identifier, including legitimate empty default |
| Tab Instance ID | Random identifier for current top-level document; never a browser-provided tab ID |
| Epoch | Monotonic Workspace fencing generation, assigned by gateway |
| Revision | Local source version; separate from provider saveCount, sourceRevision and editorPayloadRevision |
| Operation ID | Server-generated unique identifier for one admitted tool operation |
| Grant | OAuth authorization for exactly one Agent and Workspace |
| Resource | Skill, Workflow, Instruction or Document; versioned content |
| Checkpoint | Local immutable snapshot of complete draft source and metadata |

## 2. Scope and acceptance
| ID | Actor / trigger / required outcome | Verification |
|---|---|---|
| C01 | Operator installs one distributable userscript; instances initialize in matching Firefox documents without local services. | Fresh supported Firefox profile, no daemon. |
| C02 | Operator deploys one Worker using dashboard-based guided setup; all storage bindings and migrations supplied by repository; no CLI required for normal install. | Clean Cloudflare account guided install; fallback documented. |
| C03 | Operator pairs userscript with gateway once using URL + one-time secret; gateway never accepts default credentials. | Wrong/replayed secret denied; copied URL alone grants nothing. |
| C04 | Operator creates named Agent and Workspace, attaches current editor, copies endpoint and approves OAuth. | Two connectors using same provider account access separate tabs; no manual Cloudflare changes. |
| C05 | Gateway binds every MCP request to authenticated Grant and current assignment. | Swapped endpoint, guessed IDs, changed tool args, stale grants denied. |
| C06 | Operator suspends, revokes, renames, reconnects or explicitly rebinds without affecting other Workspaces. | Independent operations continue; rebind invalidates old grants/epoch; no silent access transfer. |
| C07 | Userscript reads and edits unsaved PJS, HTML, src files and isolated scratch using documented virtual paths. | Real native draft edits, undo, readback, binary/empty files, preservation of unrelated files. |
| C08 | Agent refreshes and evaluates current preview, inspects console/errors and changes viewport without saving. | Disposable generator verifies unsaved source, line numbers, images/results and stale preview errors. |
| C09 | Agent performs isolated computation and external resource retrieval through bounded explicit capabilities. | No credentials, privileged network or other Workspace escape; termination and partial-effect tests. |
| C10 | Agent saves only with permission and current identity, base and explicit intent. | Native Save + independent complete source comparison; uncertain effects held. |
| C11 | Agent can create generators and manage needed lifecycle actions within explicitly authorized scope. | Disposable create, rename, duplicate, listing, readback; deletion requires per-action human approval. |
| C12 | Agent uses equivalent file/media, production-state and attachment tools with documented differences. | Each included helper tool in TOOLS.md passes behavioral parity; unavailable backend blocks full parity release. |
| C13 | Operator edits, duplicates, enables/disables, imports, exports, versions, compares, restores and deletes Resources in manager. | Fresh install exposes 11 bundled original skills without import; synthetic flat ZIP import, custom edits survive upstream update; atomic import failure. |
| C14 | Gateway supplies Resources as searchable tools and optional MCP resources/prompts. | Web clients can retrieve all applicable instructions even if resource/prompt UI absent. |
| C15 | Operator can assign Resources globally, to Workspace or Agent; security policy is not a Resource. | Deterministic resolution; unauthorized private resource inaccessible. |
| C16 | Independent Workspaces run concurrently, with no hardcoded global agent count; capacity limited by measured configurable budgets. | 1/5/10/20 synthetic plus 5–10 real browser target, overload explicit. |
| C17 | Userscript and gateway expose actionable state and redacted operation history. | Inject offline, expired grant, stale revision, challenge, quota, busy, wrong target and unknown result; each has distinct status and recovery. |
| C18 | Operator can export/import Resource library and settings separately from Workspace source backups. | Secrets excluded; restore produces new installation credentials and requires rebind. |
| C19 | Operator can update compatible userscript/Worker independently; incompatible versions disable remote execution without blocking normal editor use. | Upgrade and rollback tests with dirty draft and active operation. |
| C20 | Operator can disable remote execution immediately for one or all Workspaces. | New admissions denied; already-dispatched effects reconciled, no false cancellation claims. |

## 3. Operator workflows
Setup wizard: deploy Worker, install script, enter HTTPS gateway URL, validate health/version, enter single-use bootstrap secret, establish management credential, initialize bundled skills (optional import), attach current editor, create named Agent, copy MCP URL, approve exact pending OAuth request, run read-only workspace probe. Each step displays completed/blocked with remedy; refresh resumes from authoritative state. No credential copied unless explicit operator action. Optional manual OAuth client details shown only when necessary; OAuth access/refresh tokens are client-owned, not displayed. A separately scoped connector bearer token is optional compatibility mode, disabled by default, only for clients supporting Authorization headers; show once, expire/revoke, never embed in URLs. No token query parameters.

Manager from every top editor: compact header with current Workspace/Agent, connected/paused/offline/blocked and dirty indicator; single-scroll global overlay with Workspaces, Agents, Library, Activity, Settings. Tables sortable/searchable; keyboard navigation, accessible names, visible focus, escape closes, no nested page scrolling. Workspace row shows binding, grant status, last heartbeat, in-flight operation, current revision and copy endpoint. Actions: attach, pause, reconnect, detach, switch with explicit confirmation; revoke separate from delete. Resource editor shows file list, plain text/Markdown editing, sanitized preview, revision diff and explicit publish. Unapplied changes remain drafts; failed saves preserve edits. Import preview lists additions/conflicts/rejections and sizes before commit. Activity shows operation ID, type, outcome, timestamp, duration, redacted error and recovery action. No decorative dashboard dependency.

## 4. Access and failure rules
Default grant: source read/write and preview development; no remote save, external upload/media, arbitrary preview execution, production restore, or delete until operator enables corresponding permissions. Development preset offers explicit opt-in to preview execution and Save; no confirmation on each ordinary source edit. Publish/listing, production restore and delete require fresh operation-bound approval. Agent cannot administer grants, credentials, resource policies or other tabs. Operator editing is allowed; concurrent mutation detects revision changes and rejects rather than overwrites. Native Helper busy or collaboration unsynced blocks mutations. Native collaboration write support is not promised. Account inventory only when explicitly needed for target identity; never expose account secrets.

No implicit publication. Stage and Save separate. Unlisted is not private; creation may briefly be Listed, so create inert initial content and confirm Unlisted before staging sensitive content. Never represent Perchance as private storage. Source on gateway transient by default; no routine generator source logging. Resource text intentionally cloud-persisted by operator. Offline browser allows ordinary Perchance editing and local resource drafts; no offline queue of remote mutations. Reconnect requires identity verification and fresh Epoch. Closing tab does not close external conversation. Agents may continue reasoning and knowledge retrieval offline; browser tools return TAB_OFFLINE.

## 5. Non-goals and release status
No model hosting, inference proxy, native AI Helper control/history, PCMS accounts/routing/scheduling/Recent management, browser account management, general remote desktop, arbitrary OS files, workflow automation engine, platform_bug_report or report skill. OpenCode-specific guidance replaced by provider-neutral MCP usage guidance only. No guarantee of provider subscription access or model following instructions. Functional parity is defined by observable generator development outcomes, not implementation copying; all 22 included helper tools plus relevant additional observed browser capabilities are tracked. Release cannot claim full parity if any mandatory outcome is blocked.

## Self-contained installation and coding (C21)
The release initializes the repository's eleven independently authored Perchance skills, provider-neutral instructions and editable workflow seeds without requiring an archive from the Operator. Verify fresh install, skill retrieval and update preservation. Original third-party imports are optional. The coding agent must not depend on historical archives; public live documentation and observed provider behavior may be investigated autonomously. No assumption of live credentials, billing authorization or private backend access. Primary supported manager is Violentmonkey on Firefox; other managers are out of acceptance scope until separately verified.
