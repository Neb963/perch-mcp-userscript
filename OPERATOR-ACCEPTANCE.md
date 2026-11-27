# Perch MCP v0.3.0 offline verification candidate

Use the exact tested unmerged PR head, release manifest and SHA-256 checksums. Matching Worker and userscript versions are 0.3.0. The package's default configuration leaves v2 assignment, v2 execution, provider writes, push, and estimated admission policy disabled. Preserve already-established native storage authority.

All external acceptance is DEFERRED_OWNER. Review the [acceptance matrix](docs/verification/v0.3/ACCEPTANCE.md), [migration and rollback](docs/v0.3/MIGRATION.md), [capture feasibility](docs/v0.3/CAPTURE.md), and [measured capacity](docs/verification/v0.3/PERFORMANCE.md). Keep the development PR unmerged until the operator has chosen a deployment and acceptance path.

| Gate | Operator-only pass evidence |
|---|---|
| OWNER-01 | Firefox and Violentmonkey content isolation. Use authorized disposable fixtures to verify draft identity, path and byte readback, reload/manual-edit races, fenced rebind, preview freshness and precise diagnostics. Save only with explicit permission and intended native SourceRevision. Verify persisted source independently and reconcile uncertain dispatch without replay. |
| OWNER-02 | In actual MCP clients, approve exact Connector resource and PKCE client/callback. Verify one Connector with two simultaneous chats using explicit different Targets, plus a second Connector denied across both Workspaces. Confirm catalog refresh and old Grant denial after upgrade. |
| OWNER-03 | Capture actual pixels only after a positively verified preview surface, crop, Binding, epoch and revision can be established. Qualify standard image content and dimensions/digest in the actual MCP client. The packaged userscript currently reports unsupported. |
| OWNER-04 | Confirm current account configuration, preview build controls, exact Worker, preserved SQLite/DO/KV namespace IDs, supported hibernation and advisory HTTP fallback. Check actual quotas and completion/recovery reserve. Exercise staging and compatible rollback with existing storage modes and exact persisted receipts. |

Before any authorized rollout, archive native draft source and Resource customizations separately. Check ACTIVE, UNKNOWN and PARTIAL records. Preserve the pairing and current installation IDs. During testing, record exact commit and paths, measured counters, revision/digest proofs and terminal outcomes. Keep source and credentials out of diagnostic evidence. Restore a compatible reader or forward-repair after native or v2 authority cutover.
