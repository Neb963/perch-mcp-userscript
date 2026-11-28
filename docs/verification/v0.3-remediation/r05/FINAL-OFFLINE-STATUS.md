# R05 — Offline takeover exit, exact-head evidence and unresolved gates

**Verified code and docs head:** `a736513b20d8ae44060e9454eb78e60e70c11b54`  
**Verified source tree:** `528cdf9572d360f0a302aa18fd48415c1de94d40`  
**CI:** [run 46143344849](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46143344849), successful: **705 unit/integration tests passed, 0 failed, 1 historical skipped**; locked installation, strict typechecking, local Workerd/Miniflare benchmark, deterministic inventory, release build/hash verification and Wrangler **dry-run only**.

The shipped `perch-mcp.user.txt` and `perch-mcp.user.js` are byte-identical, SHA-256 `93685686ff9990058fbed4014955cd67d2c3018e1d7186b114ca873f61e4e70e`. Downloaded candidate ZIP: SHA-256 `d65ee9a248fc4901975c01297c8d16602775704a7dc7a2ef5dc208812c34c9d7`. `RELEASE.json` records this exact sourceCommit/tree and `sourceDirty:false`.

## Source-level changes and directly checked paths

| Area | Verified result / trade-off |
|---|---|
| F09 compute native read view | Metadata-only directory enumeration, selected-path on-demand byte hydration, independent per-file hash/race checks, 100 reads without 100 gateway permits; a write-only guest records affected native before-images before execution |
| F12 public imports | Immutable revision-addressed verified files and exact manifest under `imports/<slug>/perch-revisions/<sha256>/` alongside current Slug aliases; old revision retained and collision rejected pre-effect; local GM physical budget constrains retention |
| F02/A15 staged transfer | Changed native destination rejects commit without effect and retains abortable stage; no false UNKNOWN after known no-effect |
| A10 old-Epoch Holds | Local-only historical scope inspection/reconciliation works without Gateway; stale admission fenced and proven new Epoch adopts only after resolved Hold |
| OAuth F16 | Real pinned SDK/local-workerd permanent Registry Grant, refresh credential and DCR persistence with finite access-token renewal; ten-year candidate proven offline, default 24 days pending real client interoperability |
| Manager F18/F19/F22/F25/F26/F27 | Actual compiled synthetic Chromium UI: urgent approval remains visible despite Connector filter; six conflicting actions disabled during transition; filter/disclosure 0 remote requests; local Recovery/Settings survive remote hang; no Library in v1/v2/unpaired/offline; stale responses cannot replace selected view |
| Manager S10-004 | Source, preview, saved revision: SHA256 only when explicitly verified; otherwise UNKNOWN; last observed Workspace action scoped to installation and labeled as historical; Hold unknown unless positively evidenced |
| S09-003 Resource clean install | Skip inactive Resource schema/trigger writes with no legacy `library` authority while retaining compatible migration and historical export/quarantine; real SqlRecords test exercised legacy/prepare/native |

Offline exact-install UI evidence: **30 screenshots**, 5 tabs × 30/50 Workspaces × three viewports (1440×900, 1024×768, 390×844). Complete Workspace rows **10/8/2**, zero horizontal overflow and zero outbound requests. This is **not** actual generator preview capture or Firefox/Violentmonkey acceptance.

## Quantitative regression, not resolved

**Hard target requested: ≤120 SQL read rows and ≤40 written rows per ordinary native full lifecycle.** Local Miniflare/workerd exact source benchmark reports:

| Boundary | Registry R/W | Workspace R/W | Combined R/W |
|---|---:|---:|---:|
| MCP admission | 18/0 | 26/10 | **44/10** |
| Browser poll/dispatch | 9/2 | 41/6 | **50/8** |
| Browser RUNNING receipt | 0/0 | 14/1 | **14/1** |
| Browser terminal receipt/outbox | 31/18 | 25/9 | **56/27** |
| Scoped operation status | 18/0 | 5/0 | **23/0** |
| **Five-stage total** | **76/20** | **111/26** | **187/46** |

Legacy equivalent: **249/76**. This is a real improvement over the earlier **225/57**, but remains **67 reads and 6 writes above the specified native budget**. The denominator is one operation across these five exact boundaries, not individual files. Grouping ten related actions into one admitted operation yields ~90% amortized savings relative to ten separate operations; it does **not** establish the per-operation acceptance criterion. A successful CI run cannot replace native SQL target evidence. Registry fresh authorization, publication fence, terminal receipt/outbox and result ACL must not be removed merely to reduce rows. Further work requires evidence-equivalent memoization/point-lookup changes or a coordinated operation lifecycle redesign with concurrency/failure proof, measured at the original denominator.

## Actual preview screenshot feasibility

The required screenshot is **pixels of the bound unsaved preview**, not DOM reconstruction or the management panel. The documented Violentmonkey GM surface exposes no privileged tab capture; Firefox's `tabs.captureVisibleTab` belongs to an authorized extension. `getDisplayMedia` requires genuine operator activation and user-selected surface; surface/crop identity is not established by programmatic selection. Mozilla's [2026 WPT tracking](https://bugzilla.mozilla.org/show_bug.cgi?id=2082849) reports `CropTarget is not defined` because Firefox does not implement Region Capture. Without positive surface identity/crop proof, transmitting a screenshot risks leaking unrelated tabs, screens or credentials. No hidden alternative or unauthorized companion extension was installed. `capture_page_image` truthfully remains `UNSUPPORTED_INTERFACE`, not a fake success. An owner-approved additional capture component or an independently proven compatible browser/gesture/surface selection path would be needed to close the gate.

## Exact requirement status (verification records, not feature-completeness counts)

| Status | Clauses |
|---|---:|
| PASS | **88** |
| FAIL | **4** |
| IMPLEMENTED_UNVERIFIED | **0** |
| NOT_STARTED | **1,186** |
| DEFERRED_OWNER | **24** |
| BLOCKED_FEASIBILITY | **1** |
| SUPERSEDED_BY_OWNER_AMENDMENT | **14** |
| **Total** | **1,317** |

The four FAIL rows are **S07-023, S08-058, F13.01, F13.02**. One separate requirement flags screenshot feasibility. The 24 owner-only requirements, including **OWNER-01–04**, need authorized live Firefox/native Perchance, real client OAuth/image interoperability, real capture, and real Cloudflare bill/migration observation. The **1,186 NOT_STARTED** remain independently unverified and are *not* proven complete by 705 passing tests; the strict release gate correctly remains **NOT ELIGIBLE**.

## Change control

Preserve [PR #25](https://github.com/Neb963/perch-mcp-userscript/pull/25) **draft, open and unmerged**; no live provider, production OAuth, Cloudflare endpoint, preview/deployment, or main branch merge. Production deployment and native generator modification remain operator-only. No historical archive, credential or unresolved Hold was deleted to simplify the release gate.

**Required next engineering exits:** (a) safety-preserving full-lifecycle SQL reduction and equivalent workerd measurements to ≤120/40; (b) genuinely supported preview-pixel capture under privacy/permission checks or authorized architecture amendment; (c) individually reproducible acceptance of the remaining 1,186 offline requirement records; (d) OWNER-01–04 real acceptance. The release is not qualified until those gates are satisfied.
