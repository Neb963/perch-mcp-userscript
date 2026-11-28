# R00 baseline

| Item | Exact value |
| --- | --- |
| Starting main | `298f3b9619335364c668a69b6f04570ae530fcab` |
| Starting tree | `c07b3e7e25ea0e4d063ee11435cc58e3d524059b` |
| Audited PR #24 head | `57f26a63c26bd59e01cfa1e3460c3a703d1a0104`, same Git tree |
| Original specification SHA-256 | `7b28c0da2b9285fe3ece4e1687d2a47f012a9b639782d6ccbdb03babe87ae66f` |
| Design proposal SHA-256 | `6469a6e901cb122293cb09cc99f6e0115bdfded30089f28a010627ca45c54b12` |
| Revision 3 audit Markdown SHA-256 | `7bfe18ea11f8fb8214e097fa905ea171bf8ce04712522430eb467b900060d0d2` |
| Existing offline CI | [PR #24 run 46048905489](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46048905489) |
| Working branch | `repair/v0.3-conformance` |

All supplied archive entries covered by the audit's manifest verified. The baseline checkout passed the locked install, TypeScript, 574 tests with zero failures or skips, local packaging, and validation of 369 packaged files including byte-identical JS/TXT. Wrangler 4.168.0 completed a dry-run. Baseline packaging measured 3,091,227 userscript bytes and 924,346 Worker source bytes. The local baseline package SHA-256 is `5860dd1b7880d7437eeca538c8e85554b605eadde3ce6d25474a318526a35d3c`. This digest describes the local build from the merge commit, distinct from the CI build of its PR head.

| Findings | Reproducible baseline outcome |
| --- | --- |
| F01 | Shared validation and real local MCP accepted an invalid batch tail. Browser fixtures allowed an earlier effect boundary for nine invalid classes. |
| F02 | A transfer failing a stale precondition left an unresolved stage. Abort returned `EFFECT_UNKNOWN` with zero native setters. |
| F03 | Opened the next Epoch after a prior-Epoch local Hold. Adoption refused and the ordinary recovery path returned no Hold. |
| F04 | Advancing the clock during a durable checkpoint still allowed the first native setter. Setting cancellation after the first setter still allowed the second. |
| F05 | Losing the admission acknowledgement after commit projected `REJECTED/NONE` without the Operation key. Status by key recovered the committed admission. Losing a status acknowledgement projected `REJECTED/NONE` and dropped the supplied Operation ID. |
| F16 | Real SDK access token expired after 900 s, Registry and SDK Grants after 30 days, and dynamic registration after 90 days. Connector suspension returned `invalid_grant` on refresh; resuming allowed the same refresh credential. |
| F17 | The earlier confirmation dispatched a synthetic request for a different Workspace. |
| F21 | The pending approval row omitted Connector name, exact resource audience and application permissions. |
| F25–F27 | Library remained visible in legacy/default and cold outage. Cold outage blocked the Workspace panel. Warm outage retained enabled Workspace controls after switching to Connectors or Recovery. Chromium attempted zero external requests. |

Reproduce the shipped manager baseline with the clean baseline bundle and the tests in this branch. Python Playwright and a Chromium executable are required.

```sh
python tests/offline-manager/remediation.py --bundle /path/to/baseline/perch-mcp.user.js --output /tmp/perch-manager-baseline --expect-baseline
PERCH_REMEDIATION_EXECUTION=1 node --import tsx --test tests/unit/remediation-execution-baseline.test.ts
PERCH_REPRODUCE_F16=1 node --import tsx --test tests/integration/remediation-oauth-baseline.test.ts
```

Execution regression assertions describe required behavior and intentionally fail on the baseline. The OAuth baseline test asserts and documents the defect. The manager replay emits screenshots and operation summaries using the shipped manager's synthetic test seam with startup isolated and requests blocked. It does not simulate actual Firefox or Violentmonkey privilege behavior.

Prior performance logs remain in [v0.2 optimization evidence](../gateway-optimization-report.md) and [v0.3 performance evidence](../v0.3/PERFORMANCE.md). Run the baseline benchmark from the pinned baseline commit using locked dependencies and a synthetic local Worker.

```sh
BENCHMARK_NATIVE=true BENCHMARK_MULTI_CONNECTOR=true node --import tsx scripts/benchmark-development-v2.ts /tmp/perch-baseline-native.json
BENCHMARK_MULTI_CONNECTOR=true node --import tsx scripts/benchmark-development-v2.ts /tmp/perch-baseline-legacy.json
```

Production-readiness workflow execution and automatic deployment are reserved for the operator. The repository workflow probes production on a push to `main` or explicit dispatch. The owner previously reported Cloudflare preview builds disabled. The remediation PR workflow uses local package validation and a dry-run.

| Real local SDK and SQL sample | Native rows read/written | Legacy rows read/written |
| --- | ---: | ---: |
| Ordinary read lifecycle, 0/150/999/1,000 retained operations | 225–227 / 53–57 | 280–300 / 80–89 |
| Ten separate writes | 2,730 / 610 | 3,520 / 980 |
| One ten-file write | 273 / 61 | 352 / 98 |

Exact outputs include HTTP/DO/KV and per-invocation SQL counters for 1, 5, 10, 20, 30 and 50 Workspaces and issuance/discovery for 10 and 20 Connectors. The v0.3 native baseline exceeds the 120-read/40-write objective. Browser dispatch and receipts are synthetic in this workload.

- [Native benchmark](baseline/native-v2.json)
- [Legacy benchmark](baseline/legacy-v2.json)
- [Shipped manager baseline observations](baseline/manager-report.json)
