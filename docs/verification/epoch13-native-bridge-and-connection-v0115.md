# Epoch 13 — v0.1.15: native byte boundary and nonblocking connection recovery

## Originating production evidence

Operator diagnostics14 generated 2026-11-27 00:44:52 UTC (userscript v0.1.14, gateway v0.1.7): paired gateway healthy, Registry revision 367, manager `offline`, browser `stopped:true`, no lease, stage `LOCAL_JOURNAL`, error `UNSUPPORTED_INTERFACE`. All sampled management requests succeeded (200), including a Workspace bind. No `/api/v1/tab/claim` request occurred. The full authenticated content and account credentials are not included in this public report.

The actual v0.1.14 implementation enters `syncResolvedLocal()` before a gateway claim. If any old local operation journal exists, it eagerly calls `vfs.snapshot()`, which calls native `srcState.readFile()`. The native provider's bundled `srcFiles.js` returns page-realm ArrayBuffers; Firefox content context may expose these as cross-compartment wrappers. Previous `nativeBytes()` accepted only locally branded buffers, structured clones, or values with an `.arrayBuffer()` method. The explicit previous operator `Native file result is not exact bytes` error agrees with that chain. We cannot infer the private native file's precise bytes/type from the sanitized diagnostic.

## Concrete fixes

1. **Connection liveness**: local journal presence or source readback failure no longer prevents a valid `tab/claim`. Exact native identity/binding and gateway authentication remain mandatory. Local journals remain durable and source writes are still fenced by VFS. The controller records pending local intents and background reconciliation failures separately from its lease.
2. **Native buffer bridge**: unchanged local ArrayBuffer and view readers remain the fast path. For Firefox-wrapped source buffers, attempt the page's own `Uint8Array` constructor and read every byte into a fresh content-realm array, bounding maximum length and rejecting phantom zero-length views. Compare native manifest sizes when authoritative, reread full bytes independently, verify all source paths and revisions. Never replace exact binary content with text approximation.
3. **Truthful capability status**: `workspace_status` / `generator_info` can report identity and capabilities even when the *complete source snapshot* is unavailable. Set `snapshotVerified:false`, `revision:null`, the bounded source error, and effective read/write availability=false. Local journal storage failure is a separate `localJournalError`; it blocks source write availability. An unavailable preview or source interface does not kill a healthy transport connection.
4. **Recovery visibility**: the Recovery UI exposes pending local journal rows even if native file readback is unavailable. A resolution action appears only after exact source readback is available. Fail-closed on malformed journal records without deleting or reinterpreting them.
5. **Proactive readback check**: after a lease is held, perform a best-effort complete source snapshot and report its actual availability in diagnostics, without dropping the connection.

## Acceptance and evidence boundaries

Automated fixture coverage includes page-realm ArrayBuffers, zero/binary files, opaque wrapped buffers, independent two-pass snapshot, malformed local journals, local store unavailability, no-lost-lease after source readback failure, and truthful status capability states. Existing unit, gateway-emulator and packaging suites must pass on the candidate. Worker v0.1.7 source remains unchanged; no deployment or schema migration needed.

**T3/T4 are not yet accepted:** A synthetic Firefox-like wrapper does not prove successful execution in the actual operator Firefox/Violentmonkey window. No live production generator or previous journal was modified, cleared or replayed. Real-browser validation must inspect `browser.sourceReadback` (verified vs unavailable) plus the exact `workspace_status` result after replacing the userscript. If it fails, the new lease should remain up and independent agent operations continue, while source edits stay blocked; use the next recorded failure for a targeted native interoperability fix.
