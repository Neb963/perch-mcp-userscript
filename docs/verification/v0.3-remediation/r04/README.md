# R04 gateway economics — bounded admission and comparable local measurements

Authority: audit revision 3, §§9–11 of the v0.3 specification, F13 and approved quota targets. No account-wide quota claims.

## Code change

- v1 `execute_js` retains its existing 1,000-child-call pessimistic reservation.
- v2 `execute_js` uses one bounded local QuickJS execution with a declared read view and at most one publication rather than 1,000 remote MCP child invocations. The local computation remains bounded independently by the broker.
- v2 `batch` reserves cost by 1–32 declared nested actions. Missing/oversized action lists fail before admission. Each nested step incurs conservative SQL/write/DO estimates, but no synthetic per-read remote fanout.
- UTC rollover carries the original operation's retained reservation; no completion-time refund is introduced. Admission stays disabled by default until OWNER-04 usage confirmation.

## Verification

```sh
node --import tsx --test tests/unit/admission-budget.test.ts
BENCHMARK_HISTORIES=0 BENCHMARK_NATIVE=true BENCHMARK_MULTI_CONNECTOR=true node --import tsx scripts/benchmark-development-v2.ts dist/remediation-native.json
```

The offline workflow executes the native local SDK/Registry/Workspace benchmark after successful tests, before build, and stores `remediation-native.json` in the artifact. It includes 0-history full lifecycle, ten separate writes vs one ten-file mutation, 10 mixed individual actions vs one 10-step batch, 1/5/10/20/30/50 Workspace discovery, and 10/20 Connector setup/discovery. Miniflare outbound requests are denied. `BENCHMARK_NATIVE=false` exercises the legacy storage path using the same script and must be run for release qualification.

## Interpretation and unresolved gaps

- The historical v0.3 native lifecycle cost was 225–227 SQL reads and 53–57 writes per read operation. Normative target ≤120 reads/≤40 writes remains **unmet** unless the *new* report measures a passing lifecycle. No authorization, result ACL, durable receipt or state verification is removed to optimize costs.
- Local estimates are scoped to one Workspace, not Cloudflare account-wide. They do not establish billing, KV schedule, DO duration, operator real workload, client refresh timing or free-tier guarantees.
- One-year and ten-year access-token expiry behavior are SDK workerd evidence. Actual ChatGPT connector support for ten-year tokens is OWNER-02 and real Cloudflare KV admission is OWNER-04.
- Further SQL read/write consolidation is only acceptable when exact revocation, replay, stale Binding, native Save and late-result races are verified by direct regression tests.
