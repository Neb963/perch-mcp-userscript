# R01 execution and operator intent

- The Worker and browser share whole-batch static validation. The browser also checks its local approved-host policy before the first action. Dynamic revision proof remains at the relevant publication boundary. Preflight reserves 4 KiB in the existing 512 KiB browser envelope.
- Browser operations recheck deadline, lease, readiness and cancellation immediately before native setters and local pointer publication. An active-only five-second heartbeat can report cooperative cancellation. A fenced permit is checked before the next segment. An effect already dispatched retains its known, partial or unknown outcome.
- MCP classification separates a proven rejection from a potentially committed admission, cancellation or status request. Terminal receipts retain exact effects independently of result bytes, and delivery rechecks scope after hydration.
- A batch records ordered per-action and per-path effects, unpublished staging, explicit skips, and bounded read data or digest-pinned continuation. Output targets 192 KiB including the step ledger.
- The manager binds a single confirmation to the captured Workspace, action, owner and destination. Navigation invalidates old controls and responses. Transition locators retain exact keys in isolated installation-scoped storage. An unresolved transition can reconcile its original receipt following remount.
- OAuth approval displays the exact Connector, audience, application permission ceiling, client, callback, code, expiry and digest. Unverifiable v2 requests cannot invoke approval.

The [manager report](manager-report.json) records one POST for the original confirmation, zero writes from a detached confirmation, a disabled mismatched-audience approval and a single rebind POST across lost acknowledgement and remount. All browser requests were synthetic. The [receipt cases](receipt-cases.json) record real SDK and workerd results with outbound network blocked.

```sh
node --import tsx --test --test-name-pattern='F01|F04|F08' tests/unit/remediation-execution-baseline.test.ts tests/unit/remediation-batch.test.ts tests/unit/execution-native-preview.test.ts
node --import tsx --test tests/integration/remediation-receipt.test.ts tests/integration/image-transfer.test.ts
npm run build
python tests/offline-manager/remediation.py --output /tmp/perch-r01-ui --finding F17 --finding F21 --finding F27
```

F25 and F26 are still reproduced in the R01 renderer. The conditional Library and fully local manager are R03 work. F02/F03 execution regressions remain opt-in pending R02. The F16 test currently detects the baseline expiry and suspension defects rather than asserting corrected behavior.
