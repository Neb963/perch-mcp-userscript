# Epoch 12 — connection state diagnosis and operator repair (v0.1.14)

## Evidence (diagnostics13, 2026-11-27 00:30 UTC)

Userscript 0.1.13, gateway 0.1.7, paired true; gateway health and management GETs 200, Registry paused false, 3 Workspaces and 3 Agents. The manager reported `connection:paused` but `workspaceSelected:false`; the browser reported stopped/no lease; no `/api/v1/tab/claim` request or preview calls appeared in the diagnostic sample. Therefore this capture **does not** establish Gateway rejection, source corruption, or provider Save failure. It establishes an editor-side no-lease state with an insufficient explanation.

Repository analysis identified a concrete causal failure: `BrowserController.attach()` called `pause()` *before* probing native editor identity and local Workspace readiness. A native preflight failure left the browser status `paused` with no Workspace ID, overwriting the actual error. A subsequent manual Stop could also race a pending lease claim, allowing a late claim reply to reconnect after the operator stopped. The initial bootstrap suppressed auto-connect if an operator-stop marker existed but omitted the matched Workspace ID from the paused status, leaving no direct resume affordance.

## Repair

- Preflight native readiness, canonical ID/Draft/Slug, installation ID, and local journal before releasing any existing lease. Block binding mismatches before the server claim. Report exact stage and stable error code; retain the target Workspace in failed status and diagnostics. Preserve an existing verified lease when preflight to another Workspace fails.
- Monotonic attachment generation: Stop fences queued health checks, native preflight, and late claim acknowledgements. A late already-issued lease is released best-effort using its own scoped credential and never installed in controller state.
- Add a prominent **Connect the current editor** panel in Workspaces. For one exact native match, one button resumes a paused Workspace (or clearly states if it resumes gateway-wide policy) and connects. Lost PATCH acknowledgements receive read-only GET reconciliation; never resend a mutation. A changed installation/Slug requires **explicit** rebind and warns that Grants are revoked; unbound single Workspace can be explicitly linked. Ambiguous matches cannot silently pick a Workspace.
- Disallow the misleading Reconnect button on an unbound Workspace. For multiple Workspaces, Recovery selects the one matching the current native editor (when unique), otherwise requires explicit selection; one Workspace may be selected by default.
- Bootstrap phase/reason tracking includes native readiness, Workspace matching, operator stop and Gateway claim. Diagnostics now include stable `failureStage`, `attachFailureCode`, `bootstrapPhase`, `bootstrapCode`, whether a target was selected and reconnect pending/attempt counter, without raw source, credentials, or provider messages.
- When native editor initialization exceeds the bounded first probe window, schedule read-only retry instead of staying offline indefinitely. No automatic rebind or execution-policy changes.

## Verification matrix

Tests cover: missing native editor does not cause phantom pause/claim; mismatched binding stops before claim; Gateway rejects PAUSED with exact stage and Workspace; Stop during an in-flight claim releases its late reply without reconnecting; operator-paused exact binding surfaces one primary Connect button; paused Workspace resumes exactly once even when the PATCH response is lost; changed installation displays explicit rebind rather than claiming a mismatched lease; prior tests and package/Worker release integrity.

## Limits and rollout

The supplied diagnostic does not include the exact editor readiness or remote individual Workspace pause flags. The new manager must run on the user's Firefox page for a definitive live diagnosis. It is intentionally unsafe to silently select among multiple Workspaces or to auto-clear an uncertain provider effect. Gateway 0.1.7 does not require redeployment. A successful test suite is not live Firefox acceptance.
