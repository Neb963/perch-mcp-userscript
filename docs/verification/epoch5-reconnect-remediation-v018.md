# Incident report — Epoch-5 viewport PARTIAL blocks reconnect (2026-11-26)

## Proven incident

Userscript 0.1.7 + deployed gateway 0.1.4. `/health` and administrative APIs return HTTP 200; OAuth and pairing work; Registry is not paused. The document has no lease. Two `/api/v1/tab/claim` requests return HTTP 409 `EFFECT_UNKNOWN`. Their paired trace IDs appear in the redacted diagnostic export.

Durable `operation_status(b5d2a44c-4a28-43a0-8edc-de3a178cdc84)` identifies terminal `PARTIAL`, tool `set_viewport_size`, epoch 5. Detailed result bytes have expired. Its existing Activity record remains unresolved. The operator report confirms this was an iframe width reset that failed geometric verification. No source, upload, Save or generator mutation was issued by that viewport tool. The manual scratch write/delete returned exactly to the original byte hash. Current physical viewport and source state *after* the failed reset cannot be inferred from a timed-out read.

The old gateway (1) held a generator writer reservation for every mutating tool, including iframe CSS; (2) rejected every new browser lease while any PARTIAL record remained; (3) admitted read-only requests but no browser could poll them. The userscript also stopped polling on all PARTIAL results, including viewport-only geometry. These policies formed an avoidable liveness cycle.

## New effect boundaries

| Operation | Pending/RUNNING | Terminal UNKNOWN/PARTIAL | Reclaim? | Source/provider writes? |
|---|---|---|---|---|
| `set_viewport_size` (fixed JS read-only dimension probe and iframe CSS) | Fenced | Durable outcome retained; no persistent writer reservation | **Yes**, when prior lease ended | No |
| `page_eval` (arbitrary generator JS) | Fenced | Held for reconciliation | No | Possibly external |
| `write`, `patch`, `save_generator`, upload, media, restore | Fenced | Held for reconciliation | No | Possible |
| `workspace_status`, `read`, `list_files` | Read-only | Dispatch under a newly reclaimed lease | Yes, unless a persistent effect blocks claim | No |

The Registry may free an old v0.1.4 reservation only after verifying an exact terminal notice with matching operation ID, Workspace, binding revision, epoch, tool and phase. The original PARTIAL record is never marked successful, removed or replayed. This migration is idempotent: absent/mismatched notices leave the writer held.

The userscript keeps the lease active after a future viewport-only partial and advertises degraded preview geometry. A verified `reset:true` clears the degraded UI state. Actual geometry checks wait for layout and verify iframe identity; failures include bounded expected/actual dimensions. Reset accepts `{reset:true}` and older `{width,height,reset:true}`.

## Deployment and recovery

**Worker and userscript must both be updated for unattended recovery.** Deploy Worker 0.1.5 to the existing configured Worker and Durable Objects; do not reset or replace the database/secret, create a second Worker, or re-pair. Replace the existing Violentmonkey entry with userscript 0.1.8 and reload the native editor.

If the old Worker is still deployed and refuses a claim, open Activity, find the `set_viewport_size` PARTIAL operation above, inspect source and native preview, select *Resolve uncertain operation…*, record only actual observations, acknowledge uncertainty, then Reconnect. This is the existing authenticated operator recovery mechanism. It does not claim the viewport reset succeeded.

Do not automatically resolve other types of effects. Do not relax providerWritesEnabled or native adapter acceptance. Live required verification includes `/health` Worker 0.1.5, existing pairing/Workspace/Grant unchanged, successful epoch-6+ lease claim, read-only status dispatch, source revision identity, and viewport set/reset readback with a fixed editor pane.

## Verification and limits

CI tests, strict typecheck, artifact hash verification and Worker dry-run are required before release. Do not infer Cloudflare production deployment or Firefox runtime behavior from CI. The public generator fetch failure now has exact safe failure-stage messages but positive live fetch success remains unverified. External media, Save, screenshot and production-state parity remain separate acceptance gates.

## Production Worker identity and binding safety (critical rollout guard)

The checked-in `apps/gateway/wrangler.jsonc` and packaged `perch-mcp-cloudflare.zip/wrangler.json` default to `name: "perch-mcp-gateway"`. **This operator's installed gateway is a different Worker: `perch-mcp-userscript.peterconemannn.workers.dev`**, whose Worker name is inferred from that workers.dev subdomain. This difference is not a license to create a new service.

**Never execute `npm run deploy`, `npx wrangler deploy`, or the stock Git-connected deploy configuration blindly for this operator.** Those commands could target `perch-mcp-gateway` instead of the existing `perch-mcp-userscript`, and the package's generic `OAUTH_KV` binding may not carry the existing namespace ID. Merely passing `--name perch-mcp-userscript` is not sufficient evidence that persisted OAuth KV and SQLite Durable Object namespaces will be preserved.

Before upgrading, the Cloudflare account owner must inspect the *existing* Worker's settings, bindings, route and deployment source, and make a backup/export where supported. Deploy the exact tested `worker.mjs` / version 0.1.5 through **that existing Worker's deployment pipeline**. The effective Wrangler configuration, if CLI is used, must have the existing Worker name and **existing** `OAUTH_KV` namespace ID, Durable Object binding/migration names and environment, existing secrets, and any existing routes/custom domains. Preserve `BOOTSTRAP_SECRET`, Registry/Workspace DO state, OAuth grant/refresh storage, Worker URL and bindings. Do not perform an unauthorized migration or recreate a KV namespace. Check settings/diff before deployment.

Post-upgrade acceptance: existing URL `/health.version == "0.1.5"`, `paired:true`, `configured:true`; Workspaces/Agents/Grants remain unchanged; exact existing Generator/Draft binding can reclaim the lease after terminal viewport-only PARTIAL. A good dry-run and matching health version do not by themselves prove state continuity. If any binding or OAuth continuity check fails, stop and restore the existing Worker code/config without deleting durable state, and retain the original operation record.

The GitHub CI job does **not** deploy to Cloudflare. The v0.1.8 userscript and v0.1.5 Worker package are deliverables for the operator's existing configured deployment, not an auto-activated fix. The userscript alone cannot override the old v0.1.4 gateway's `/tab/claim` hold. Until Cloudflare is upgraded, use the inspected, explicit Activity resolution path described above.
