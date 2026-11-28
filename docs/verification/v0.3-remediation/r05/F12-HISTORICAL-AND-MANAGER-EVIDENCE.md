# R05 — F12 immutable imports, historical recovery, and UI race closure

**Exact tested source:** `b7daa005b6b3a4e6166a2ac97159cb708a402c29` (tree `c0663df4d673c316be7f28787f928fee177ad518`), [offline run 46141689975](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46141689975). TypeScript, **703 tests passed, zero failed, one historical skipped**, release build, checksum verification, native/legacy gateway benchmarks and Wrangler dry-run passed. No live infrastructure, provider or production mutation.

## Direct production-code evidence

| Requirement | Production-code regression | Result |
|---|---|---|
| S06-048 / F12 | `tests/unit/development-v2.test.ts`: original public readback, `F12 immutable snapshots retain prior public revisions while advancing only current Slug`, `F12 conflicting archive bytes fail before publication and leave active receipt unchanged` | Immutable `imports/<slug>/perch-revisions/<sha256>/manifest.json` and `files/` persist; changing current alias retains earlier revision; corrupt identical revision address fails prior to publication |
| A15-commit-stale-destination / F02 | `tests/unit/remediation-execution-baseline.test.ts`: `F02 stale destination before transfer publication leaves a safely abortable transfer` | STALE_REVISION with unchanged native destination and 0 native writes; subsequent abort successful |
| A10-prior-epoch-hold / F03 | `tests/unit/historical-recovery.test.ts`: `F03 rejected adoption fences the old Epoch and exact offline resolution preserves original outcome` | New lease fails, historical scope can be inspected without Gateway; stale acknowledgement denied, reviewed resolution survives lost ack, old UNKNOWN evidence remains, new Epoch adopts scratch only afterward |
| S10-021 / F27 | `tests/unit/manager.test.ts`: `UI-STATE-01: late stale Gateway response never replaces the currently selected manager view`; `tests/offline-manager/remediation.py --check-local-recovery` | Delayed old Workspace response cannot overwrite selected Connectors view; simulated obsolete confirmation click after tab switch adds 0 writes; no stale Workspaces controls in unrelated tabs |

The **exact b7daa installed bundle** was additionally exercised with hermetic local Chromium scripts: `visual-qualification.py` generated 30 screenshots with no outbound requests; `closure-r05.py` covered OAuth filtering, remote-effect conflicts and offline local shell with zero external requests; `remediation.py --check-local-recovery` reproduced none of F17/F21/F25/F26/F27. These observations are synthetic-browser evidence, not owner Firefox acceptance.

## Distribution and economics

Verified downloaded GitHub artifact `perch-mcp-userscript-tested` contains `RELEASE.json` pointing to `b7daa005b6b3a4e6166a2ac97159cb708a402c29` and `sourceDirty:false`; `perch-mcp.user.txt` and `perch-mcp.user.js` are byte-identical SHA-256 `07ff58df8ad30f2248d97738ddb203a3d1ce7f0e0e048dd43245eaba82734763`. Candidate internal ZIP SHA-256 `b83ea9f1405c68b0e610865a8412c15595671dcb552c98c5a994c2953747bdc6`.

The exact-head local-workerd native five-stage SQL lifecycle still measures **187 reads / 46 writes** versus normative strive **≤120/40**. Performance remains FAILED, including actual work for Registry fresh authorization, dispatch permits, terminal receipts, outbox and result checks. No cost target is waived.

## Requirement status

This source supports promotion of four previously FAIL atomic clauses, independently corroborated by their named tests. Count across four matrices: **1,317 total, PASS 86, FAIL 6, NOT_STARTED 1,186, DEFERRED_OWNER 24, BLOCKED_FEASIBILITY 1, SUPERSEDED_BY_OWNER_AMENDMENT 14**. Strict release gate remains not eligible. Remaining FAIL: S07-023 screenshot, S08-058 and F13.01/F13.02 SQL, S09-003 clean Resource retirement, S10-004 manager revision/outcome projection. Do not infer the other unverified requirements from a passing suite.
