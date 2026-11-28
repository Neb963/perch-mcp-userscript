# R03 implementation and offline qualification

Authority: audit revision 3, original v0.3 contract and explicit owner amendments.

## Verified checkpoints

- 84242a5, CI [46091943832](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46091943832): actual pinned OAuth SDK DCR/PKCE/token/refresh/revoke across nine finite TTLs (15 minutes–10 years), persistent v2 Registry Grants, refresh and client registration, suspend/resume without reconsent, fail-closed revocation. 665 tests passed, one skipped historical reproduction.
- b125c32, CI [46093489526](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46093489526): active Library removed from manager; clean v2 storage does not seed it; historical Resource export read-only. Per-installation redacted cached summaries are never mutation authority. Local filtering/sorting; native identity, diagnostics, stop and scoped recovery survive Gateway failure. Exact-bundle Chromium fixtures observed zero outbound requests.

## Reproduction on the exact built artifact

```sh
npm run check
python tests/offline-manager/remediation.py --bundle dist/perch-mcp.user.js --output /tmp/perch-r03-manager --finding F17 --finding F21 --finding F25 --finding F26 --finding F27 --check-local-recovery
python tests/offline-manager/visual-qualification.py --bundle dist/perch-mcp.user.js --output /tmp/perch-r03-visual
node --import tsx --test tests/integration/remediation-oauth-persistence.test.ts tests/integration/remediation-resource-retirement.test.ts tests/integration/remediation-status.test.ts tests/unit/development-v2.test.ts tests/unit/public-generator.test.ts
```

The visual script renders Workspaces, Connectors, Activity, Recovery and Settings in Chromium at 1440×900, 1024×768 and 390×844 with 30 and 50 Workspaces. It rejects dialog/body overflows, active Library, selected-view mismatch, missing rows, or fewer than eight complete desktop Workspace rows, and aborts external requests.

## Remaining limitations

- Ten-year access tokens pass local workerd issuance/refresh/revoke, not real ChatGPT connector compatibility (OWNER-02).
- Binding-local historical root reuse is verified. F06 cross-tab physical compaction is not qualified with stale Violentmonkey GM caches. Do not discard protected bytes based on synthetic exclusion.
- F11 actual generator preview pixel capture lacks a qualified pure userscript API; remains BLOCKED_FEASIBILITY, notwithstanding screenshots of the manager.
- R04 performance targets and the full requirements register remain open. No live test or deployment is authorized.
