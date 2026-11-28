# R02 scoped storage and recovery

- Transfer startup and chunks retain exact identities and verification after lost acknowledgements. Known pre-publication faults release capacity. Unknown or partial commits retain the original Operation key, ID and scoped evidence. Recovery-only dispatch under a Hold cannot obtain a publication permit or invoke a new native effect.
- Local recovery enumerates the exact installation, Workspace, Assignment, Binding and Epoch. Operator export and selected journal inspection do not require the Gateway. Acknowledgement checks current readback and a proven superseding lease. It preserves the original outcome. Gateway-correlated Holds still require authoritative reconciliation.
- Verified adoption references already stored immutable bytes across Epochs within one Binding. It uses neither another Assignment's chunks nor cross-tab deletion of previously adoptable bytes. See [F06 storage evidence](../F06-STORAGE.md) for the remaining historical reclamation limit.
- Operator recovery exposes checkpoint inspection and export by exact scope. Private stage records preserve bytes and provenance separately from active imports. Offline native publication requires a safe alternative such as export or manual editing. The manager locks restore actions without authoritative state. Native restore holds an exact Workspace and Generator reservation until a terminal receipt. The SDK fixture checks that an uncertain restore retains its Hold.

```sh
node --import tsx --test tests/unit/filesystem-v2.test.ts tests/unit/binding-storage.test.ts tests/unit/historical-recovery.test.ts
node --import tsx --test --test-name-pattern='F02|F03' tests/unit/remediation-execution-baseline.test.ts
node --import tsx --test tests/integration/remediation-operator-fence.test.ts tests/unit/operator-recovery.test.ts
npm run build
python tests/offline-manager/remediation.py --output /tmp/perch-r02-ui --finding F17 --finding F21 --finding F27 --check-local-recovery
```

The [offline manager report](manager-report.json) records zero Gateway requests for scoped evidence and checkpoint exports, blocked restore during outage, and local private staging. Chromium used synthetic data with external requests denied.
