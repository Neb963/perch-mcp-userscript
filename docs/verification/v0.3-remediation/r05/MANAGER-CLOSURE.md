# R05 bundled manager closure and release checksum qualification

**Code/artifact commit:** `5c045bc74b9be3c5c6bb970a6f0934d5a6cc7c88`; [offline CI 46140138366](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46140138366) (701 pass, 0 fail, 1 historical skip). The rendered JavaScript is the same bit-identical installer distributed in that run, not a hand-created mock UI. Chromium uses synthetic v1/v2/outage/unpaired manager responses; no Cloudflare, Firefox or real Perchance calls were made.

## Reproduce

```sh
python tests/offline-manager/closure-r05.py \
  --bundle dist/perch-mcp.user.js --output /tmp/perch-r05-manager-closure
# The Python environment must include playwright and local Chromium.
```

The script extracts the real bundled `mountManager`, supplies the repository's existing `fixture.js`, denies all outbound network routes and checks rendered dialog controls. The about:blank fixture supplies an RFC4122-v4 UUID using Web Crypto entropy because ordinary `crypto.randomUUID` is available only to secure origins; this is not a permission bypass in the shipped manager. Artificial 1,000ms mutation delay and 60,000ms indefinitely pending remote reads allow deterministic in-flight inspection. The output `closure-results.json` and screenshots F18/F19/F22/F26 are generated during execution.

## Observed explicit results

| Requirement | Production-bundle fixture evidence |
|---|---|
| F22.03 | Local Workspace search filtered 30→3→3→30 rows with **0 additional management requests** |
| F18.01 | Approval belonging to Connector c-1 remained actionable when filtering for Connector c-12; **0 new requests** |
| F19.01, S10-019 | While the clean one-click reassignment POST remained pending, all six buttons Reassign, Reconnect, Detach, Pause, Transfer, Unassign were disabled |
| F26.01 | Remote reads held for 60s; Recovery and Settings panels rendered locally, and no stale Reassign was available |
| F25.01, S10-002 | v1, v2, outage and unpaired fixtures each displayed only Workspaces, Connectors, Activity, Recovery, Settings; no active Library or media destination |
| F24.02, S13-022 | Downloaded candidate SHA-256 `0f0121f5740328ffdbfc3834d10eebb39d771678f5100cb72b6ca7b9b5d20076` matches PR #25; standalone JS/TXT digest `7eeb0c71a050bc040cd820b93db51c01ad6a46a7f68e9896e839398c141f2059` identical; artifact verification passed |

**Limits:** Chromium synthetic UI validation does not prove actual Firefox/Violentmonkey behavior or operating-system screenshot capture. These tests do not establish S09-003 (no Resource startup/database writes), S10-004 (all native revision evidence), S10-021 (all asynchronous ordering cases), or external OWNER gates. No entries are marked PASS solely on source inspection.

**Inventory after these nine exact changes:** 1,317 total; 82 PASS, 10 FAIL, 1,186 NOT_STARTED, 24 DEFERRED_OWNER, 1 BLOCKED_FEASIBILITY, 14 SUPERSEDED. Strict release qualification remains NOT ELIGIBLE. Native five-stage SQL remains 187 reads/46 writes versus target ≤120/40, and unsaved preview pixels remain blocked.
