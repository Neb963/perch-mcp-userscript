# Gateway implementation and local evidence

Implementation date: 2026-11-26. This is a tested candidate, not a deployed or full-parity release.

## Runtime

One Worker exports `Registry` and `Workspace` SQLite Durable Object classes. `Registry` owns bootstrap consumption, independently hashed administration/execution credentials, Agent/Workspace assignments, binding revisions, OAuth approval records, Grant policy, writer reservations, the Resource library, and management idempotency. Each `Workspace` owns its document lease, monotonic Epoch, eight-operation queue, dispatch/terminal journal, transient results, and unresolved-effect holds. SQLite records are chunked without splitting Unicode surrogate pairs. Compound storage changes use `transactionSync`; newer schema versions reject downgrade.

The pinned official `@cloudflare/workers-oauth-provider` 1.4.0 supplies client registration, PKCE code exchange, audience validation, refresh rotation and token cryptography. Its `OAuthAuthorizationServer` and `OAuthResourceServer` run in the same Worker with one exact `/mcp/{agentId}` resource per Agent. The Registry overlay rechecks assignment and revocation on every admission, dispatch, child permit, and token exchange. Pausing does not reassign a Grant. Rebind or permission change revokes old Grants. Pending approvals snapshot the binding revision, permission set and policy revision; drift rejects approval or completion.

The official `@modelcontextprotocol/server` 2.4.0 supplies both the current 2026-07-28 per-request protocol and legacy 2025-11-25/2025-06-18 serving. One low-level Server factory uses the shared strict tool catalog. The SDK's `isLegacyRequest` classifier routes legacy requests to its JSON Streamable HTTP transport; its `createMcpHandler` serves modern requests with per-request envelopes and standard header checks. Authenticated `server/discover`, `tools/list`, tool-only knowledge retrieval, header mismatch and missing-envelope branches pass in local workerd. OAuth remains the independent Cloudflare library. MCP resource/prompt user interfaces are optional; knowledge remains available through tools. Cloudflare's non-code-generating JSON Schema validator avoids an eval dependency.

An earlier implementation note checked only the legacy `@modelcontextprotocol/sdk` 1.32.2 package. The stable v2 package is published and closes that proposed protocol blocker. Package versions and current primary references were verified directly: [SDK v2 entry](https://ts.sdk.modelcontextprotocol.io/v2/), [2026 protocol migration](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28), [web-standard hosting](https://ts.sdk.modelcontextprotocol.io/v2/serving/web-standard.html), and [legacy routing](https://ts.sdk.modelcontextprotocol.io/v2/serving/legacy-clients.html). No client identity or envelope field authorizes a Workspace; the Grant determines routing.

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

The focused suite passes seventeen gateway/storage tests containing positive/negative assertions for bootstrap replay, separated credentials, administration idempotency, duplicate-tab claims, actual S256 OAuth/code/token flow, exact resource audience, tool-only eleven-skill retrieval, forbidden routing arguments, strict replies, persisted operation retrieval, queued revocation, origin policy, 1/5/10/20 concurrent SQLite Workspaces, queue overload/fairness, heartbeat, retired lease terminal handling, UNKNOWN resolution, pending authorization drift, child revocation, Unicode chunk boundaries, transaction rollback and schema downgrade rejection.

The soak runner defaults to 20 synthetic Workspaces for 30 minutes and emits latency quantiles, failure count and Node process memory. It simulates browser replies in local workerd; it does not measure Firefox memory, actual external connector behavior, deployed Worker CPU, Cloudflare billing or live provider effects. The caller records the executed duration and exact source checkpoint separately.

Remaining evidence: T3 Firefox/Violentmonkey and disposable Perchance operations; T4 deployed dashboard installation and real external clients; real 5–10-tab T5 capacity; WSS feasibility; exact media/production-state/screenshot parity; paid provider output only with explicit authorization. These are release blockers where mandatory, not tests that passed through this local suite.

## Optional authorized music adapter

The candidate can admit `generate_music` only when the Operator provisions `ELEVENLABS_API_KEY` as a Worker secret, explicitly sets `PAID_MEDIA_ENABLED=true`, enables the independently gated provider-effect policy, and grants MEDIA plus WRITE_SOURCE to that exact Agent/Workspace. No key is delivered to the browser, model, Resource library or export. This option may incur provider charges; it remains disabled by default.

The running browser operation starts `/api/v1/tab/music` without supplying new arguments: the gateway derives them from the admitted operation. The handler records durable intent before one fixed, redirect-rejecting ElevenLabs request. Restart or lost outcome cannot trigger regeneration. Output remains in authenticated, operation-scoped 192 KiB chunks under an 8 MiB active-artifact budget and ten-minute expiry. `/api/v1/tab/music-result` reads only that operation's chunks after a fresh Registry check; complete SHA-256 acknowledgement consumes the artifact. Browser scratch commit and byte hash are separate from provider outcome. Unknown paid effects hold the original operation. Requested duration defaults to 120 seconds; operation admission allows ten minutes.

The provider and durable-handler synthetic suites pass twenty further tests, including framing/duration, permission denial, revoked Grant, concurrent admission, retained restart intent, stale lease, chunk alignment, size/expiry, digest acknowledgement and post-dispatch ambiguity. No paid request, real playback, lyrics-fidelity test or provider consent was performed. The implementation is an authorized alternative to investigate, not evidence of completed native music parity. See PARITY_IMPLEMENTATION.md for provenance and current documentation.

## Registry capacity budgets

`REGISTRY_WORKSPACE_BUDGET` and `REGISTRY_GRANT_BUDGET` are validated deployment budgets (default 1000 each; configurable positive integers through 100000), rather than a fixed Agent-count product limit. The management state response exposes their effective values along with queue, lease, polling and transient-byte budgets. Increasing a budget does not establish measured capacity or bypass Cloudflare quotas. `OAUTH_REGISTRATIONS_PER_HOUR` defaults to 100 (configurable through 10000) and bounds unauthenticated dynamic-registration storage pressure; rejected attempts consume that hourly admission budget. Ordinary Agent tools and existing connector refreshes do not consume registration admissions. These are initial operational bounds; deployed capacity remains unverified.

Authorization completion bounds the actual form stream to 4096 bytes, requires exactly one opaque ID/handle, and redirects an explicitly denied request back to the validated client with `access_denied`. It never interpolates credentials or unvalidated client metadata into HTML. Import preview returns its digest and conflict metadata, without retransmitting all archive bodies.

## Durable terminal notification and deadline recovery

Every terminal Workspace row is also a durable notice outbox until Registry acknowledgement. HTTP completion and Durable Object alarms drain it; a lost acknowledgement is retried through an idempotent Registry upsert keyed by Workspace/Operation ID. Duplicate delivery does not append duplicate Activity or bump its snapshot revision. First delivery records only phase, tool, exact binding/Epoch, trace ID, duration, timestamp and bounded error code; source/result bytes and credentials are absent.

Admission schedules the next operation deadline. An alarm expires unconfirmed dispatched work to UNKNOWN, then publishes its notice even when no browser returns. This also discovers UNKNOWN written directly by the paid-media handler. Backoff is bounded at 60 seconds, and a full pending-notice budget rejects new work. No notice retries a provider effect. Unacknowledged terminal rows remain protected from retention eviction.

Registry keeps unresolved UNKNOWN/PARTIAL notices outside its rolling 1000-event history; Activity prioritizes them and supports Workspace/status filters and snapshot cursors. Operator resolution persists independently, updates the original notice/Activity metadata, and leaves the original phase intact. Tests cover receipt loss after Registry commit, instance restart, automatic deadline expiry, provider-written UNKNOWN and an old unresolved hold surviving 1000 newer events.

Tool-operation handles use 120-second default execution lifetimes for preview evaluation, isolated computation, public fetch, image generation and upload; music uses 600 seconds, source operations 30 seconds. Explicit supported timeouts remain exact (up to 500 seconds for preview evaluation and one hour for compute/fetch). HTTP serving never silently shortens those execution budgets.
