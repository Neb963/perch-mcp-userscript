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

Supported official SDK transport profiles in this candidate are `2025-11-25` and `2025-06-18`. The handoff's `2026-07-28` transport profile is not implemented by the pinned published SDK. Unsupported transport versions fail rather than receiving a fabricated negotiation. Real ChatGPT, Claude and Gemini connector compatibility remains an external acceptance gate; their current account UI and plan availability were not verified.

No optional URL bearer-token mode is enabled. The OAuth client owns its access/refresh tokens; the manager never displays them. Do not paste a management credential into a connector.
