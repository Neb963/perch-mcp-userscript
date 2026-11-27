# v0.3 operator migration and rollback

The default packaged Worker leaves v2 assignment and execution disabled. Existing Connector URLs, DO names, OAuth KV, installation credentials and native draft storage remain in place.

1. Export the operator Resource archive and native draft backups separately. Inspect Activity and local recovery for unsettled effects. Preserve old credentials, current authority markers, deployment versions and exact release checksums.
2. Deploy compatible readers only when owner acceptance authorizes it. Keep DEVELOPMENT_CONTRACT_V2_ENABLED and DEVELOPMENT_CONTRACT_V2_EXECUTION_ENABLED unset initially. Keep the existing canonical storage mode until its separate migration plan is verified.
3. Configure assignment preparation explicitly and update the userscript to the matching version. Start with a disposable Workspace and an independent Connector. Verify the editor, current installed version, old adapter rejection and scoped lease. The setup screens remain available before v2 MCP execution is enabled.
4. Choose one legacy fixed-scope Connector only after checking for outstanding effects. The upgrade fences old work, preserves its native Binding and stable OAuth URL, advances generations and revokes old Grants atomically. The Connector then requires new consent. This causes bounded operator-controlled downtime. Never approve a mismatched code, client, callback or resource.
5. Follow the owner acceptance checklist and verify both new-token isolation and old-token denial before broadening assignments. Allow v2 execution only within the operator-authorized acceptance plan. A binding change advances Target while preserving valid Connector-level Grants to the current assignment. Never Save or discard a draft as part of rebind.
6. Keep v0.2 legacy Resource data and held operations. Use the archive action under Settings for export. Physical purge requires a separate explicit decision. Migrating Resource data to native storage is independent of Connector upgrade.

## Recovery

- A returned management error may leave a persisted transition. Inspect Activity, exact Workspace, operation and receipt. Resume the same management idempotency key when supported. Cancel a pending Binding transition only after the old effect settles and its retained evidence is reconciled. A new generation cannot restore old access.
- If the Binding commit succeeds but the lease cannot be acquired, inspect the current exact identity and reconnect. Preserve the old draft. Do not retry against a replacement Target implicitly.
- Local v2 files and catch-up evidence live in an installation, Workspace, Assignment, Binding and Epoch namespace. Legacy Workspace-only data remains quarantined. A fresh Binding never imports it implicitly.
- Pause or turn off v2 admission to contain an incident. Preserve the compatible Worker/userscript readers and unresolved authority. A pre-v2 binary cannot read Registry schema 3. After native or v2 cutover, use a compatible prior reader or forward repair. Do not reset the Registry, restore stale grants, or replace canonical source and policy with an old snapshot.
- Imported source instructions remain data. Keep any public fetch allowlist restricted to operator-trusted exact hosts. The browser does not independently attest DNS.
