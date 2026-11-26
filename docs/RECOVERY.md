# Recovery and upgrades

| Situation | Required action | Outcome that must not be assumed |
|---|---|---|
| Gateway offline | Close the manager and keep using native editing. Inspect Activity after reconnect. | Closing a request did not undo a provider effect. |
| Lost tab / reload / duplicate | Reconnect only the exact Generator ID + Draft ID after lease release/expiry. Duplicate active claims fail. | A matching URL did not prove identity or transfer a lease. |
| Unknown / partial operation | Inspect current draft, checkpoint, saved source and provider usage. Use Activity's explicit operator resolution with inspection evidence. The original status remains uncertain; reconnect explicitly. | Do not replay the operation or rewrite UNKNOWN as success. |
| Source conflict | Read the current complete source and compare the checkpoint. Preserve the Operator's edits. | A blind rollback or repeated patch is not safe. |
| Missing result | Use `operation_status`, paged source reads or local attachment download. Results expire after bounded retention. | Expiry never authorizes re-executing a mutation. |
| Bootstrap response lost | Check `/health` setup state and use credential recovery. | The bootstrap secret is not reusable. |
| Credentials lost | Rotate `RECOVERY_SECRET` in Cloudflare to a new high-entropy value, then use Settings → Credential recovery. | Changing a secret alone does not reset stored authority. |
| Recovery completed | Credentials/leases/Grants are invalidated, Workspaces are paused/unbound, Resources persist. An inert prior Binding tuple is retained only to inspect/resolve old held operations; it cannot claim execution. Rebind and authorize fresh connectors explicitly. | Old tokens or copied settings do not restore access. |
| Paid music interrupted | Inspect provider usage and retained artifact metadata. Retrieve existing bytes under the authorized operation; do not regenerate for recovery. | A timeout did not prove that billing or generation did not occur. |
| Library conflict | Keep the recovered local draft, refresh canonical revision, inspect diff, then publish explicitly. | The latest asynchronous response cannot replace a newer editor selection. |
| Quota exhausted | Export retained data, clean up explicitly or adjust a measured budget. | Pinned checkpoints and unresolved intent must not be evicted automatically. |

Resource/settings exports exclude credentials and generator source. Source backups are separate, contain the complete native draft, and may contain private data: keep them private. Restoring source verifies Generator/Draft identity, digest and current Revision, creates a checkpoint and stages changes without Save. Imports never reactivate old Grants.

Before updating, pause new work, settle or hold active effects, export the Resource library and source backups separately, and retain the current userscript and Worker version. Version/schema mismatch disables remote execution while native editing remains available. Registry schema version 1 rejects an unsupported newer persisted schema. SQLite migration and downgrade behavior is covered by local fixtures, not a deployed rollback rehearsal.

A Cloudflare Worker version rollback does not roll back Durable Object/KV data. Do not downgrade a reader that cannot interpret the persisted schema. Use a compatible version or an explicitly reviewed data migration. The package does not promise an automatic destructive data rollback.

The native Save/lifecycle, preview preamble/evaluation, screenshots and production-state gates remain listed in RELEASE_VERIFICATION.md. Read-only observation is permitted during recovery; enabling an unverified provider mutation is not a recovery shortcut.
