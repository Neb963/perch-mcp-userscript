# Userscript execution model — continuous Perchance development

This is the authoritative boundary and recovery policy for local developer operations. It refines the generic failure-safety design in `DESIGN.md` without changing Gateway operation idempotency or permission enforcement.

## Authorities

| Component | Owns | Does not own |
|---|---|---|
| Gateway Workspace DO | Agent assignment, grant, lease, operation admission and remote effect status | Canonical unsaved Perchance source or browser-local journal IDs |
| BrowserController | Exact tab/editor binding and lease lifecycle; disconnect/reconnect | Source bytes, final outcome of native writes |
| NativeAdapter | Read, apply and verify the currently bound Perchance editor's exact source | Remote Gateway permissions, speculative provider methods |
| VirtualFileSystem | Canonical local snapshot and revision; checkpoints; command-specific local audit journals | Indefinite Writer lock from a historical `UNKNOWN` record |
| SourceTools | Schema validation, exact read/patch/write, new operation receipts and actionable status | Blind replay of an uncertain command or override of human source changes |
| Manager | Connection status and rare manual remediation | Operational coordination for routine successful development |

## Normal command flow

`Gateway admission → current Writer lease → exact Generator/Draft → native snapshot → expected revision match → checkpoint → durable intent → native effect → readback → terminal receipt`.

An interrupted receipt is handled as a **source observation problem**, not a connection outage. The next read-only status or write attempt verifies the current source and either (a) verifies intended exact bytes, (b) adopts stable current source as a new baseline with old UNKNOWN retained, or (c) identifies a recent overlapping effect and suggests a bounded retry. Independently scoped work continues in (b) and (c).

Source changes are not automatically retried. External effects with irreversible or public outcomes remain subject to the Gateway's established permission/approval gates and idempotent resolution. A dirty native draft, unknown earlier command, or an imported cache record alone is not a justification to strand an otherwise authenticated agent session.

## Failure budget and rollback

- Local convergence is read-only with two matching complete snapshots. A failed probe or unstable revision preserves all existing journal data and does not disconnect the agent.
- Old intents are never deleted merely to unblock the UI. A resolution record includes original intent, historical state, current inspected revision, resolution mode and timestamp.
- A new write still captures a full checkpoint and checks the native revision. If either preflight fails, it does not mutate the native source.
- Recent conflicting intents retain a short overlap fence; other paths may be edited. If no reliable native readback is available, source writes remain disabled, but connection, resource reads and independent tools continue.
- Upgrade/rollback are file-only on the userscript: v0.1.15 can read the same original journals and will show the older conservative behavior; no schema rewrite, data loss or Cloudflare migration occurs. No gateway changes are required.
