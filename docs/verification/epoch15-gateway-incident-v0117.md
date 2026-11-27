# Epoch 15 — Gateway-wide 500 recovery and independent incident evidence

## Operator evidence

Diagnostics16, 2026-11-27T02:17:21.098Z, userscript 0.1.16, paired:
- `/health`, `/api/v1/admin/state`, `/api/v1/admin/workspaces`, `/api/v1/admin/agents`, `/api/v1/admin/diagnostics`: **HTTP 500 `INTERNAL_ERROR`** across distinct trace IDs.
- `browser.bootstrapPhase=WORKSPACE_LOOKUP`, `bootstrapCode=INTERNAL_ERROR`, no lease, no selected Workspace.
- This establishes a common gateway/Registry failure domain; the underlying runtime exception is **not included** in the captured diagnostics. It would be unsound to attribute it to SQLite corruption, quotas, Cloudflare capacity or deployment without actual server logs.

## Findings

1. `/health` called the single Registry Durable Object. An outage in Registry also prevented readiness and diagnostic access. There was no independent liveness endpoint.
2. `observability.enabled=false`; Registry translated exceptions to generic HTTP errors without persistent exception classification. OAuth/management audit was also stored in Registry, which was the unavailable dependency.
3. `main.ts` bootstrap retry excluded `INTERNAL_ERROR` and therefore stopped after failed Workspace lookup. `controller.ts` only considered network timeout/unavailability transient; HTTP 500 from `/tab/poll` or `/tab/heartbeat` could stop a live editor connection.
4. Browser transport diagnostics were an in-memory 100-item ring; reload discarded them. A healthy manager's polling could evict the older failure before an export.

## Implementation

| Trigger | Actor | Result | Safety / limit |
|---|---|---|---|
| GET `/live` | Worker | `200`, minimal process liveness; no Registry call | **Not** proof of editor or Registry health |
| GET `/health`, Registry 5xx/unreachable | Worker | `503 GATEWAY_DEGRADED` with trace ID | Never returns healthy until Registry confirms; no writes |
| Unhandled Worker/Registry 5xx | Worker/Registry | Structured error category, trace ID and sanitized location in console and KV | No raw request, URL, OAuth header/body, source or error message; sampled KV entry at most once/minute per category; 7-day TTL; KV failure is isolated |
| Every five minutes | Worker scheduled handler | Read-only Registry health probe with incident on error | No source effects; no simulated editor; requires deployed cron trigger |
| Gateway HTTP 500/503 during bootstrap | Userscript | Retry with bounded 2–60s backoff and foreground/online expedite | Operator Stop fences retries; never replays an operation |
| Gateway HTTP 500/503 during poll | Controller | Retry **only** the read-only poll while lease remains valid | No repeat of executed tool or ACK |
| Gateway HTTP 500/503 during heartbeat | Controller | Degrade while lease valid; report offline and reconnect after expiry | No false lease extension or source writes |
| Failed request or bootstrap stage | Userscript | Preserve bounded 7-day last-256 redacted failure records in GM storage | No credentials, source, request body or full arbitrary paths; log storage failure cannot block connection |

## Operations and deployment

- Userscript v0.1.17 works with existing gateway v0.1.7 but only resolves client retry/persistence behavior.
- **Worker v0.1.8 must be deployed to the existing Cloudflare Worker and existing Durable Object/KV bindings** to enable server-side logs and cron checks. Do not deploy a second Worker, change binding names, rotate secrets, or reset the Registry. The account owner must apply this deployment; CI dry-run is not a deployment.
- Worker logs enabled with query-string redaction. Cloudflare log storage and cron/KV writes may incur usage depending on account tier; use the dashboard for monitoring. Crash log samples are additionally retained in existing `OAUTH_KV` with 7-day TTL.
- Cron triggers can take time to propagate after deployment; do not interpret an immediate lack of scheduled records as a failure.
- Browser scripts cannot execute JavaScript when Firefox suspends or closes the editor tab. Server-side health probes and logs operate independently. Recovery resumes when the browser and editor run again.
- Open the Worker dashboard, filter logs for `perch-mcp-registry-exception`, `perch-mcp-incident`, or `infra-incident-storage-unavailable`, and correlate trace IDs from the userscript export. Check DO capacity/limits and errors before choosing an actual repair. No credentials or source should appear in the log.

## Acceptance

- `/live` remains 200 if the Worker itself is serving while Registry is down. `/health` returns 503 and a trace; never 200 in that condition.
- When Registry recovers, `/health` returns actual Registry schema/version and the userscript reconnects without operator input after at most the current retry interval plus network time, while the editor tab is running.
- A 500 from `/tab/poll` and `/tab/heartbeat` does not kill a still-valid lease; expiry never causes a false-connected state.
- Failed local requests survive browser reload; credentials/source are absent from exported records.
- Full tests, typecheck, reproducible package hash verification and Worker Wrangler dry-run must pass. **Do not report live recovery or logging as verified without deployed production evidence.**
