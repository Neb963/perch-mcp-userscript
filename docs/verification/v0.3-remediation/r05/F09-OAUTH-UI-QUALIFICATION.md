# R05 — Exact-head F09, OAuth and manager requirement qualification

**Verified code commit:** `5c045bc74b9be3c5c6bb970a6f0934d5a6cc7c88`  
**Offline workflow:** [46140138366](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46140138366) — 701 unit/integration tests passed, 0 failed, 1 previously skipped; typecheck, offline gateway benchmarks, build, checksum verification and Wrangler dry-run passed. Local tests use synthetic Perchance/editor responses and a pinned SDK; no live provider, preview deployment or Cloudflare mutation.

## F09 direct-code acceptance (eight atomic clauses)

The `scopedCompute` implementation now uses a native metadata manifest and demand-driven file reads. A 100-src fixture requests only `src/file-0.txt`; 100 QuickJS reads retrieve that native content once and use one read-view permit. Independent PJS-only fixture reads no unrelated src content. Existing positive/negative tests validate module versioning and separate read authority, oversized declaration rejection, explicit tight byte-cap refusal before execution, staged-write revocation and same-size manual-edit rejection. No per-read gateway permit is issued. Applicable tests: `tests/unit/development-v2.test.ts` and `tests/unit/remediation-compute.test.ts`, including all `F09` named cases.

Demand-driven reads have a deliberate safety cost: when a new distinct native file is requested, previously selected files are re-read to disprove known same-size edits. Native writes always verify the full current source and recheck a before-image of declared writable paths. Without a provider-native immutable generation/CAS, this does **not** provide absolute protection against an edit racing a setter; OWNER-01 remains necessary.

## SDK OAuth persistence (four atomic clauses)

`tests/integration/remediation-oauth-persistence.test.ts` exercises real pinned SDK registration, issuance, refresh, Connector suspension/resume and revocation in local workerd at ten finite access lifetimes (900 seconds to ten years). New v2 Grant and SDK client/refresh records have null/no expiry, whereas the access token is finite. Revoked grants cannot refresh. Actual external-client interoperability remains OWNER-02. The configurable 24-day default is maintained to avoid long single-timer overflow.

## Bundled manager, synthetic Chromium (four atomic clauses)

The **exact installer from run 46140138366** was isolated and rendered in Chromium with network interception denying outbound requests. `python tests/offline-manager/visual-qualification.py --bundle <installer> --output <screenshots> --chromium /usr/bin/chromium` succeeded: 30 screenshots (5 tabs × 30/50 Workspaces × 3 viewports), zero external requests or horizontal overflow.

| Viewport | Complete rows | Required | Result |
|---|---:|---:|---|
| 1440×900 | 10 | 8 | PASS |
| 1024×768 | 8 | 6 | PASS |
| 390×844 | 2 | 1 | PASS |

The first collapsed desktop Workspace row measured **52 px**, under the **64 px** limit. Separately, `tests/offline-manager/remediation.py --check-local-recovery` reproduced none of F17, F21, F25, F26 or F27 and made zero external requests. These are *offline synthetic manager* observations, not real Firefox/Violentmonkey or actual preview-pixel acceptance.

## Current measured gateway economics

The exact-head benchmark JSON from run 46140138366 (local Miniflare, actual SDK/Registry/Workspace; synthetic browser receipts) reports **native 187 reads / 46 writes**, **legacy 249 / 76** for the original five-stage denominator. Native stage rows: admission 44/10, dispatch 50/8, running 14/1, terminal 56/27, status 23/0. The normative optimization objective **≤120/40 remains FAILED** (67 reads and 6 writes over). No authorization, durability, terminal-outbox or revocation check was removed to lower counters.

## Traceability outcome and limits

This checkpoint independently promotes exactly **19** clauses with direct named production-code tests and/or exact-bundle synthetic browser observations: F09.01–08, F16.01–04, F20.02–05, S06-016, A18-hundred-reads and A18-targeted-view. Remaining inventory states are not silently upgraded. Following this change, expected reconciliation is 1,317 total: PASS **73**, FAIL **19**, NOT_STARTED **1,186**, DEFERRED_OWNER **24**, BLOCKED_FEASIBILITY **1**, SUPERSEDED_BY_OWNER_AMENDMENT **14**. Strict release gate is **not eligible**.

Unsaved preview pixels remain BLOCKED_FEASIBILITY. OWNER-01–04 and independently unverified normative clauses remain outstanding; successful CI is not proof of complete product acceptance.
