# Gateway implementation and local evidence

Implementation date: 2026-11-26. This is a tested candidate, not a deployed or full-parity release.

## Runtime

One Worker exports `Registry` and `Workspace` SQLite Durable Object classes. `Registry` owns bootstrap consumption, independently hashed administration/execution credentials, Agent/Workspace assignments, binding revisions, OAuth approval records, Grant policy, writer reservations, the Resource library, and management idempotency. Each `Workspace` owns its document lease, monotonic Epoch, eight-operation queue, dispatch/terminal journal, transient results, and unresolved-effect holds. SQLite records are chunked without splitting Unicode surrogate pairs. Compound storage changes use `transactionSync`; newer schema versions reject downgrade.

The pinned official `@cloudflare/workers-oauth-provider` 1.4.0 supplies client registration, PKCE code exchange, audience validation, refresh rotation and token cryptography. Its `OAuthAuthorizationServer` and `OAuthResourceServer` run in the same Worker with one exact `/mcp/{agentId}` resource per Agent. The Registry overlay rechecks assignment and revocation on every admission, dispatch, child permit, and token exchange. Pausing does not reassign a Grant. Rebind or permission change revokes old Grants. Pending approvals snapshot the binding revision, permission set and policy revision; drift rejects approval or completion.

The official `@modelcontextprotocol/sdk` 1.32.2 uses its Web Standards Streamable HTTP transport in stateless mode with JSON responses. Its published supported protocol versions include 2025-11-25 and 2025-06-18; it does **not** implement the handoff's proposed 2026-07-28 transport. The server negotiates supported versions using the SDK and reports them in health. No claim of 2026-07-28 transport compliance is made. MCP resource/prompt user interfaces are optional; all effective knowledge is available through tools. Cloudflare's non-code-generating JSON Schema validator avoids an `eval` dependency.

## Wire contracts

All `/api/v1/admin/*` writes except pair/recover require JSON, administration bearer authorization and a fresh `Idempotency-Key` header. Repeating the same key/request retrieves the previous result; changing its request returns 409. Entity edits require `expectedRevision`. Lists contain `items`, `revision`, and `cursor`; the state response includes `libraryRevision`. No credential appears in these URLs.

| Route | Request | Response / constraint |
|---|---|---|
| POST `/api/v1/admin/pair` | `bootstrapSecret`, `browserInstallationId`, optional canonical `issuer` | One-time `adminCredential`, separate `executionCredential`; replay denied. `ISSUER_URL`, when provisioned, overrides first-pair issuer selection. |
| POST `/api/v1/tab/claim` | Execution bearer; `workspaceId`, complete approved `binding`, `tabInstanceId`, `adapterVersion:"1"` | `epoch`, `bindingRevision`, `leaseCredential`, `expiresAt`, `permissions`. Duplicate live claims denied. |
| POST `/api/v1/tab/poll` | Lease bearer; `workspaceId`, `epoch`, `tabInstanceId` | Zero or one typed envelope and lease expiry; authenticated HTTPS long poll up to 25 seconds. |
| POST `/api/v1/tab/heartbeat` | Same lease context | Renews to 180 seconds only if current credential epoch, binding and policy match. |
| POST `/api/v1/tab/reply` | Lease context, `operationId`, `phase`, optional strict terminal `result` | RUNNING acknowledgement or validated terminal result; stale document/epoch rejected. |
| POST `/api/v1/tab/permit` | Lease context, running parent `operationId`, allowlisted `tool`, exact `args` | Current permission intersection; each child is checked against original Grant ceiling and current policy. |
| POST `/api/v1/tab/release` | Same lease context | Removes dispatch authority. A retired credential may submit only an exact outstanding terminal observation for 24 hours; it cannot poll, renew or obtain permits. |
| POST `/api/v1/admin/workspaces/:id/resolve` | Current Workspace revision, exact `operationId`, original `epoch`/`bindingRevision`, `observedRevision`, SHA-256 `observedDigest`, short `evidence`, `acknowledgeUncertainty:true` | Records operator resolution, fences lease and releases matching writer. Original UNKNOWN/PARTIAL outcome remains unchanged. Unknown effects never become success through this action. |

Browser tools return a durable ADMITTED operation handle. Agents call `operation_status` until terminal. This avoids assuming a web client's long-request timeout or MCP Tasks support. Repeating a timed-out mutation as a new tool call is unsafe. `cancel_operation` cancels queued work only; dispatched effects require reconciliation. Tool replies have an inline size ceiling; larger data requires paged reads or local artifact download.

Transport uses authenticated HTTPS long polling. WSS ticket/socket transport is not implemented or advertised. Firefox isolated-context native fetch uses exact CORS origins, omitted credentials and rejected redirects; the real Violentmonkey/CSP feasibility gate remains open. There is no generic privileged proxy or HTTP fetch service. A gateway outage never alters the native editor.

## Recovery

Lease expiry after dispatch produces UNKNOWN and prevents mutation replay. Late terminal observations cannot overwrite UNKNOWN; they remain observations for reconciliation. An operator must inspect the bound native source, record its current revision/digest, settle any provider work, and acknowledge uncertainty through the management resolution action. The operation retains its original outcome and resolution metadata. Reconnect then claims a fresh Epoch. Cloudflare rollback changes Worker code, not stored data; schema checks reject incompatible readers.

`RECOVERY_SECRET` is a distinct, high-entropy dashboard secret. Explicit recovery consumes its hash once, replaces administration/execution credentials, revokes Grants, detaches/fences Workspaces and pauses execution while preserving the Resource library. The next recovery requires a different secret. Changing an environment variable alone never resets an installation.

## Deployment preparation

`apps/gateway/wrangler.jsonc` declares both SQLite migrations, the OAuth KV binding, required bootstrap secret, `nodejs_compat`, and `global_fetch_strictly_public`. It contains no account IDs, namespace IDs or credentials. Current Wrangler can provision the declared binding when deploying; actual clean-account dashboard provisioning remains T4 evidence to obtain. The optional canonical `ISSUER_URL` is an HTTPS origin. Provider effects default disabled until authorized live adapter acceptance (`PROVIDER_WRITES_ENABLED=false`). This is independent of ordinary unsaved-source edits.

Verified command:

```sh
npm exec -- wrangler deploy --dry-run --config apps/gateway/wrangler.jsonc --outdir /tmp/perch-gateway-dry-run
```

The local dry run succeeded with both DO classes and OAuth KV declarations (approximately 1.20 MiB uncompressed / 258 KiB gzip before subsequent small hardening changes). It made no deployment and proves neither clean-dashboard setup nor production quotas. Routine source/prompt/credential logging is absent; observability is disabled by default. Activity contains bounded redacted operation metadata.

## Verification

```sh
node --import tsx --test tests/integration/gateway*.test.ts tests/unit/gateway-storage.test.ts
node --import tsx tests/integration/gateway-soak.ts
```

The focused suite passes nine tests containing positive/negative assertions for bootstrap replay, separated credentials, administration idempotency, duplicate-tab claims, actual S256 OAuth/code/token flow, exact resource audience, tool-only eleven-skill retrieval, forbidden routing arguments, strict replies, persisted operation retrieval, queued revocation, origin policy, 1/5/10/20 concurrent SQLite Workspaces, queue overload/fairness, heartbeat, retired lease terminal handling, UNKNOWN resolution, pending authorization drift, child revocation, Unicode chunk boundaries, transaction rollback and schema downgrade rejection.

The soak runner defaults to 20 synthetic Workspaces for 30 minutes and emits latency quantiles, failure count and Node process memory. It simulates browser replies in local workerd; it does not measure Firefox memory, actual external connector behavior, deployed Worker CPU, Cloudflare billing or live provider effects. The caller records the executed duration and exact source checkpoint separately.

Remaining evidence: T3 Firefox/Violentmonkey and disposable Perchance operations; T4 deployed dashboard installation and real external clients; real 5–10-tab T5 capacity; full MCP 2026-07-28 transport; WSS feasibility; exact media/production-state/screenshot parity; paid provider output only with explicit authorization. These are release blockers where mandatory, not tests that passed through this local suite.
