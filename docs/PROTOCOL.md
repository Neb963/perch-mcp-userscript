# Protocol and persistence supplement — v1 design

Normative supplement to DESIGN.md and TOOLS.md. Runtime candidate implementation and verification status are recorded in RELEASE_VERIFICATION.md and todo.md. Values are proposed initial defaults; change only through versioned configuration and tests. Security policy cannot be weakened by Resource content.

## 1. Management API
All management writes require admin credential in Authorization header, JSON content type, explicit expected entity revision (creation uses absent ID), and client-generated idempotency key (128-bit). Gateway verifies credential and revocation before parsing expensive payload. Registry persists idempotency result and request digest atomically with mutation; conflicting key reuse returns 409. Never accept IDs in request body that contradict path. Every list returns cursor and snapshot revision; no unbounded list. Public setup status never reveals IDs, users or secrets.

| Method and route (under /api/v1) | Request / outcome |
|---|---|
| POST /admin/pair | bootstrap secret, browser installation public ID; one-time management credential and separate execution credential; atomically consume secret |
| GET /admin/state | registry revision, counts, gateway/config compatibility, paused state |
| GET/POST /admin/workspaces | list / create label and permission preset; returns stable ID and revision |
| PATCH /admin/workspaces/:id | expected revision; label, scope change or pause; cannot edit Binding via generic patch |
| POST /admin/workspaces/:id/bind | proposed tab tuple, explicit replace flag, expected revision; updates binding, fences previous epoch; old Grant revoked |
| POST /admin/workspaces/:id/detach | expected revision; fence, hold uncertain operation, invalidate grant |
| GET/POST /admin/agents | list / create label and Workspace ID, only one active Agent per Workspace |
| PATCH /admin/agents/:id | expected revision and label or suspend; change target via detach/create or explicit rebind |
| POST /admin/grants/:id/revoke | expected revision; mark revoked, no future admission |
| GET /admin/approvals | pending OAuth and external-effect approvals; no token or raw secret |
| POST /admin/approvals/:id/decision | approve/deny exact digest, expires at server time; one use |
| POST /admin/pause | expected global policy revision; stop new dispatches; explicit resume |
| GET/POST /admin/resources | list / create validated Resource draft or revision |
| PUT /admin/resources/:id | expected revision, body, metadata; immutable revision + atomic pointer |
| POST /admin/resources/:id/restore | expected revision, historical revision; creates a new active revision |
| POST /admin/resources/import | validated staged package, expected library revision, explicit conflict decisions; atomic publication |
| GET /admin/resources/export | scoped package; excludes secret fields and private generator data |
| GET /admin/activity | redacted events with cursor, status filter, Workspace filter |
| POST /admin/recover | dashboard-provisioned recovery secret, one-use; credential epoch increment, fence all, revoke grants |

Deletes tombstone references until no active assignment depends on them, then explicit purge. API uses 401 missing/invalid auth, 403 insufficient scope/revoked, 409 stale/conflict, 413 size, 429 capacity, 503 unavailable, 400 invalid schema. Error envelope {code,message,traceId,retryable,details?}; no provider credentials. Recovery flow must not expose state to unauthenticated callers. No API for arbitrary Cloudflare account access. No admin credentials in MCP URLs, HTML, frame messages, Resource records or model tool results.

## 2. Tab transport
GET health is public; all other operations require separate execution credential or short-lived lease credential. Initial attach uses admin authorization, not self-asserted browser claims. Store secrets only in userscript manager isolated storage; top-frame code retrieves them, preview code must not. Do not use sessionStorage as sole identity or assume container separation of GM storage. One installation can have multiple tabs; each Workspace uses distinct lease credential.

| Route | Contract |
|---|---|
| POST /tab/claim | workspaceId, binding tuple, tabInstanceId, adapterVersion; validate approved binding and current owner proof from adapter; return epoch, lease secret, expiry |
| POST /tab/ticket | authenticated lease; mint short-lived one-use WSS ticket, bind to epoch and Tab Instance ID |
| GET /tab/socket | WSS upgrade; challenge/first-frame authentication within 5s; unverified socket cannot receive data |
| POST /tab/poll | authenticated lease; last acknowledged operation cursor; bounded long poll, same envelope as WSS |
| POST /tab/reply | authenticated lease, operation ID, epoch, typed ACK/result; reject stale identity |
| POST /tab/release | explicit lease release; do not clear outstanding unknown effect |

Heartbeats renew only matching active lease; use server time, not client wall clock, for expiration. On reload, lease credentials are invalidated; new document claims fresh epoch after previous lease resolves. Socket close alone does not imply release of writer reservation. WSS and long poll must not both consume the same queue concurrently; switch transport explicitly, increment transport generation, old replies rejected except read-only reconciliation. Per-document sequence monotonic; separate preview epoch after iframe reload. Native Save operations hold writer reservations through reconciliation.

## 3. Linearization and recovery
Registry is the sole authority for grant, binding, policy and generator writer reservation. Workspace DO owns execution state, not policy. A dispatch permit is created by Registry in one transaction after checking grant, binding revision, global pause, permission revision and generator reservation. Permit records operation digest and epoch, short deadline (target 5s); consuming it linearizes admission to dispatch. If revoke wins before permit consumption, reject; if permit consumption wins, operation may execute and is tracked as in-flight. Revocation guarantees no new permits after commit; it cannot undo a previously authorized in-flight effect. UI distinguishes admitted versus dispatched. Do not claim atomic cancellation across network boundaries.

| Failure boundary | Recovery |
|---|---|
| Before durable ADMITTED | no admitted operation; safe new request if known |
| ADMITTED before dispatch permit | expire/cancel safely; no provider effect |
| Permit consumed but no browser ACK | effect unknown; read-only reconciliation, no automatic replay |
| Browser durable intent before native call | if durable record proves not dispatched, reject/cancel; otherwise unknown |
| Native call returns, verification pending | resume verification only |
| Terminal recorded, reply lost | same operation handle retrieves terminal result; no duplicate mutation |
| Worker restart/hibernate | reconstruct from DO rows and socket attachment; no in-memory-only pending state |
| Tab lost, local journal missing | unknown; preserve reservation; operator resolves after independent readback |
| Operator manual edit during compensation | refuse compensation; preserve snapshots and hold |
| Expired result artifact | metadata remains; explicit RESULT_EXPIRED, never re-execute mutation to recreate result |

Use idempotent admission keys for tool invocations where client supplies one; MCP JSON-RPC ID is not a durable cross-conversation idempotency key. For tools called without a prior revision, read current native state at admission and compare immediately before commit; exact edit anchors must still match. For bulk writes and save_generator require explicit expected/intended revision. Operator direct edits outside userscript cannot be prevented; verify immediately before and after, native stale checks retained.

## 4. Storage and budgets
Registry SQLite tables: schema_meta, agents, workspaces, bindings, grants, approvals, admin_credentials, execution_credentials, generator_reservations, resources, resource_revisions, assignments, admin_idempotency. Workspace SQLite: meta, leases, operations, operation_events, transient_artifacts. OAuth library KV is separate; token verification not sufficient for grant authorization. No unbounded blobs in DO row; split binary payloads into <=256KiB chunks with ordered index, byte length and SHA-256. For v1, inline text <=256KiB, inline image <=1MiB after normalization, transport message <=512KiB; bigger payload use explicit chunk transfer with declared length, digest, TTL, ACL, range validation and bounded memory. Artifact store target 8MiB per Workspace active budget; larger outputs stay local and transfer on explicit request through bounded streaming/chunks; no promise arbitrary 2GB transfer. Provider upload may have stricter limit; local storage capacity negotiated by diagnostics. Scratch persistence across browser reload; explicit operator cleanup. All timeouts, retention, quotas and max sizes visible in Settings. No automatic eviction of unresolved mutation metadata or pinned checkpoints; reject new work with storage reason if necessary.

Artifact URLs are not public bearer query links. Prefer MCP image/text content, resource handle via tool, or authenticated gateway download through manager. For web clients that cannot render artifacts, show human-readable artifact ID and local download action. Operator can explicitly create short-lived share URL only via separate consent and documented exposure; disabled by default. User-provided attachments enter via manager import to scratch, no requirement for client-specific upload API.

## 5. Permission classes
READ_SOURCE, WRITE_SOURCE, PREVIEW_CONTROL, PREVIEW_EXECUTE, COMPUTE, FETCH_PUBLIC, FETCH_POST, SAVE, CREATE, RENAME, DUPLICATE, LISTING, DELETE, MEDIA, UPLOAD_PUBLIC, PRODUCTION_READ, PRODUCTION_RESTORE, EXPORT_ARTIFACT, READ_RESOURCES. Every tool maps to all required classes (e.g. fetch_url GET requires FETCH_PUBLIC + appropriate write; POST additionally FETCH_POST). Scratch-only tools can use WRITE_SOURCE but do not imply Save. Workspace permissions bound to Grant scope, current policy, native access and operation-specific approval; intersection, never union. Operator approvals bind exact action, target identity, epoch, input digest, source revision, expiry; no generic confirm=true from model. Rebinding revokes old Grant, including access to prior artifacts. Scope change narrowing immediate; expanding requires new approval or reauthorization. Resource instructions may recommend operations but cannot grant them.

## 6. Browser lifecycle safety
A page message from the expected preview WindowProxy and origin is still generator-controlled; cannot authenticate it as privileged. Never accept unsolicited privileged requests; parent initiates narrow operation, matches request ID and preview epoch, treats response as untrusted data; page results may not trigger privileged actions without fresh independent checks. No top-frame arbitrary evaluation. Use native console/preview facilities only if no credential or control bridge exposure. Avoid listening on generic window.perchanceAutomation as older discovery proposes. If preview role shares GM grants via same script metadata, enforce code role split and verify page cannot invoke GM, read closure state or induce privileged handlers; if isolation fails, stop release. Browser background/discard tests are mandatory; userscript cannot prevent all suspension. Real editor readback independent of preview assertions.

## 7. Deployment configuration design
Worker root config in deployable release declares entry point, explicit compatibility date tested at release, workers_dev true, bindings REGISTRY and WORKSPACES to exported SQLite DO classes with initial new_sqlite_classes migration, OAUTH_KV for OAuth library, required BOOTSTRAP_SECRET and optional RECOVERY_SECRET through dashboard. One deployment only. No fabricated KV namespace IDs in committed config; Deploy workflow provisions them or setup guide supplies dashboard fallback. Canonical issuer derived from configured exact URL, initialized through trusted deployment configuration or first secret-authenticated pairing; never trust arbitrary Host/forwarded headers. Health validates binding readiness without disclosing secrets. Use official SDK/provider library release with tested exact resource routing. Pin all versions and package lock in implementation. Config is design only until P02 supplies actual working Worker and verifies deployment.

## Implementation decision: operation permission ceiling (2026-11-26)
Every browser request envelope includes `permissions`, produced only by the gateway as the intersection of the current Grant and Workspace policy. The gateway persists this ceiling at admission and may narrow it at dispatch; the gateway never expands an admitted operation's authority. The browser intersects the envelope ceiling with the active lease for the parent tool and every compute/tool-broker child call. Child calls retain the original binding, Epoch, deadline and immutable execution context. A model cannot supply or override this ceiling through a tool argument. This prevents a COMPUTE-only Grant from inheriting broader file/media/upload permissions merely because the Workspace permits them. Unknown permission names or a missing ceiling reject the envelope before execution.

## Final boundary and recovery amendments (2026-11-26)

- Agent operation-result access binds to Agent ID and Binding revision, as well as Workspace ID. Administrative reconciliation retains a separately authorized view of older uncertain operations.
- Rebinding or detaching refuses consumed dispatch permits and unresolved terminal notices, including read operations, so no effect or result is stranded by a concurrent target change.
- Credential recovery unbinds and pauses execution, invalidates credentials/Grants/leases, and retains only an inert previous Binding tuple for exact old-operation reconciliation. This tuple cannot claim a lease; explicit new binding/authorization remains mandatory.
- Operator resolution preserves UNKNOWN/PARTIAL history, records the inspected source revision/digest and acknowledgement, and releases only the corresponding reservation. Local recovery can reuse an already recorded resolution only when current complete source still matches its exact observed revision.
- Production manager UI uses a closed ShadowRoot and rejects untrusted UI events. Credentials enter through the isolated native browser-prompt callback, never page-DOM fields. Firefox content-world/Xray/native-prompt behavior still requires real-browser qualification.
