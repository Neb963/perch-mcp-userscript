# Agent connectors

1. In the intended native editor, create a Workspace and select Attach current editor. Confirm Generator ID and Draft ID; an empty default Draft ID is valid. Workspace identity is not inferred from a Slug alone.
2. Create a named Agent for that Workspace. Copy its exact `https://<gateway>/mcp/<agentId>` URL. Each Agent has a separate protected resource audience. Do not add tokens to URLs.
3. Add a remote/custom MCP connector in the chosen AI web client. Use OAuth; there is no external OAuth application registration required per Agent. This implementation uses official OAuth server/resource handlers and dynamic client registration where supported.
4. Complete the client authorization redirect. The authorization page displays the Agent, Workspace, validated redirect, requested scope and matching short code. In Perch MCP → Agents, approve the exact request and code; never approve a different pending client.
5. Call `workspace_status`, `get_instructions`, `list_skills`, and `skill` before changing source. Retrieve the `generator-development` workflow. All knowledge is available through tools, including clients without Resource/Prompt interfaces.
6. Source and preview actions return durable operation handles. Poll `operation_status` to retrieve their terminal results. An MCP conversation/request ID is not a durable idempotency key. Do not repeat a mutation whose outcome is unknown.

MCP transport sessions do not identify a Workspace. The authenticated Grant, exact Agent endpoint and current binding do. A connector reused in several conversations shares its Grant and queue; it does not acquire conversation identity. Use one connector assignment per independent agent task.

Rebinding revokes old Grants and advances fencing. A pending authorization cannot silently follow a new binding or expanded permission policy. Reauthorize after changes. Revocation denies new dispatches and child permits; already consumed permits may have effects that must be reconciled.

The default policy includes source read/write, preview control and Resource reads. Preview JavaScript, computation, public fetch, Save, public upload, media and production state each require their own classes. Publish/delete/production replacement require operation-bound human approval as well. Resource text cannot grant permissions.

The pinned official SDK v2.4.0 serves the `2026-07-28` per-request profile and the `2025-11-25` / `2025-06-18` legacy profiles. These wire formats and mismatch rejection pass local Worker integration tests. Unsupported or mismatched protocol versions fail explicitly. Real ChatGPT, Claude and Gemini connector compatibility remains an external acceptance gate; their current account UI and plan availability were not verified.

No optional URL bearer-token mode is enabled. The OAuth client owns its access/refresh tokens; the manager never displays them. Do not paste a management credential into a connector.

## ChatGPT OAuth troubleshooting and verified rollout (v0.1.2)

The Cloudflare Worker **and** the Violentmonkey userscript must be updated. If Git-connected auto-deployment is enabled, verify it succeeded instead of creating a second Worker or destroying the existing KV namespace. Open `https://YOUR-WORKER.workers.dev/health` and confirm `version: "0.1.2"`. Install the matching v0.1.2 `perch-mcp.user.txt` using Violentmonkey and reload the Perchance editor. Existing pairing, Workspace bindings, and library contents remain unchanged.

Start a **new** ChatGPT OAuth authorization after upgrading; any five-minute code from the old build is expired. Keep Perch MCP → Agents open: pending authorizations poll automatically every four seconds. Verify the Agent, Workspace, client, callback and code before selecting `Approve exact request`, then return to ChatGPT's authorization page and choose `Continue after approval`. If Continue is pressed too early, the gateway provides a `Check approval again` button rather than losing the one-time authorization handle.

The gateway allows the exact ChatGPT web origin on the **public OAuth/MCP** protocol endpoints; it does not allow ChatGPT access to private `/api/v1/admin/` or `/api/v1/tab/` routes. Browser/OAuth clients must still complete PKCE, exact approval and bound Grant checks. No raw bearer secrets belong in URLs.

A Gateway error on a read-only GET may be retried automatically once; ambiguous management writes are never replayed. Distinct `GATEWAY_TIMEOUT` and `GATEWAY_UNAVAILABLE` diagnostics identify timeout versus connectivity/CORS/CSP failure. On failure, check the browser Console and the deployed Worker version before reauthorizing. The previous Cloudflare `OAUTH_KV` resource should be reused in upgrades—never delete it to fix a failed build.

## OAuth form Origin and diagnostics (v0.1.3)

**Root cause of the live `SCOPE_DENIED` at Continue:** the gateway HTML originally set `Referrer-Policy: no-referrer`, which causes browsers to send `Origin: null` on normal HTML form POSTs. The gateway then rejected `POST /authorize/complete`. Version 0.1.3 uses `Referrer-Policy: origin` for the OAuth form pages (only the gateway origin is sent, never the URL query or approval handle) and accepts a privacy-mode null Origin only for the exact POST completion route, with a non-cross-site Fetch Metadata condition and the existing one-time 256-bit handle, server-side approval, expiry, PKCE S256, exact client, and binding verification. Explicit foreign-origin/cross-site completion is denied. Privileged admin and tab origin checks are unchanged; no CORS read access is given to null origins.

**Diagnostics:** In Perch MCP → Settings or Activity select **Export complete diagnostics (OAuth + network)**. The JSON contains userscript/gateway version, health, paired/scope counts, bounded local request timing/errors, and a server-side OAuth audit ring (max 100 events over seven days, max 120/minute). Every event contains route class, method, origin category, status, code and trace ID, excluding source, tokens, credentials, private headers, URLs/queries, OAuth request payloads, handles or auth codes. Audit capture is best-effort and cannot block authorization. The old Activity-only export remains separate; zero MCP operations cannot diagnose OAuth setup. A gateway outage still produces a useful partial diagnostic report with failure codes.

Upgrade the **existing** Cloudflare Worker to v0.1.3 (verify `/health.version === "0.1.3"`) and update the Violentmonkey script to matching v0.1.3. Do not reset BOOTSTRAP_SECRET, KV namespace, Registry, Workspaces or pairing. Restart ChatGPT OAuth from the beginning because prior five-minute authorization codes expire. After approval, Continue should navigate back to the OAuth callback. If not, export diagnostics (no need for console screenshots) and correlate the trace IDs without sharing secrets.
