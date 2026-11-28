# F06 Binding storage evidence

Requirements affected include original specification §5.5 and §8.1, S08-014 and S08-062, and the storage portions of A10 and A11. The audited implementation wrote all prior local blob bytes again on each reconnect. It counted all Epochs toward the physical cap, but managed checkpoint visibility and collection within only the current Epoch.

## Epoch adoption and publication

The active lease verifies exact installation, Workspace, Assignment, Binding and native identity, then enumerates bounded retained records for that Binding. An earlier unresolved journal or unacknowledged stage blocks adoption. The receiver verifies the newest retained local root and all referenced bytes. Read-only adoption creates no additional durable root, blob or metadata. The next real local publication writes a version-3 root in the active Epoch. Each chunk reference specifies its physical owner Epoch. Hash and length are checked before referencing inherited bytes. These references can only resolve inside the exact Binding, and a root cannot reference a future Epoch. Version-2 roots still resolve their original implicit owner keys. A version-2 reader cannot interpret a version-3 root.

A PUT retains staged and previous roots until it verifies the current pointer. Stage inspection and recovery use the exact raw pointer digest for acknowledgement. Evidence export resolves both staged and previous bytes through their owner Epochs. A PUT checks the byte and key peak with both current and staged metadata present before writing. A scope that is already above its write budget can still read verified retained data.

## Collection boundary

The writer sweeps at most 32 unreferenced chunks physically owned by its own Epoch per step. It keeps roots and both sides of staged publication. A chunk whose prior local root could have been observed by a successor remains protected by an Epoch-owned inventory written before that root can be observed. Even a stale observer of an older verified local root cannot have its inherited bytes removed by the prior writer's ordinary sweep. This intentionally retains replaced local bytes. Routine collection does not delete historical blobs or reclaim the inventory because the userscript has not established a cross-tab freshness and exclusion primitive covering the GM store. Heavy churn can still reach the physical cap and require operator export or an independently qualified compaction procedure. The cap refuses new effects while preserving old evidence.

Web Locks are limited to a browser storage bucket and do not make Violentmonkey value reads fresh across tabs. The inspected Violentmonkey source uses a per-tab cache for both value getters and listing, and sends updates without waiting for suspended tabs. Synthetic tests use a shared deterministic store and cannot qualify VM notification timing, cross-container visibility, or provider disk accounting. [Web Locks scope](https://www.w3.org/TR/web-locks/#lock-scope) and [Violentmonkey value getters](https://github.com/violentmonkey/violentmonkey/blob/42a90ec0b21f73f6561c32a96a40b34aae184a33/src/injected/web/gm-api.js#L29-L53) and [Violentmonkey broadcasts](https://github.com/violentmonkey/violentmonkey/blob/42a90ec0b21f73f6561c32a96a40b34aae184a33/src/background/utils/values.js#L102-L125).

## Reproduction

```sh
node --import tsx --test tests/unit/binding-storage.test.ts tests/unit/historical-recovery.test.ts
node --import tsx tests/offline-storage/reconnect.mjs
```

| Decoded retained local source | Serialized GM-style keys and JSON values | Records | Reconnects | Set or delete calls during reconnect |
|---|---:|---:|---:|---:|
| 5 MiB | 7,001,026 bytes | 29 | 6 | 0 |
| 20 MiB | 28,002,827 bytes | 110 | 6 | 0 |

The test uses distinct content in each chunk, verifies the full original local root and measures the same physical keys across every reconnect. Additional tests verify reusing historical bytes after one change, isolated Assignment rejection, v2 read compatibility, forged future Epoch rejection, held root receipts after lost publication, and the physical byte and 4,096-record transient admission boundaries. The portable one-chunk fixture failed when copied into a clean R01 worktree at `506c3e5`. Its key count grew from 2 to 4 on reconnect. The same fixture passes in the remediation tree with 3 keys before and after reconnect. The third key records bytes that an explicitly verified successor may reference.
