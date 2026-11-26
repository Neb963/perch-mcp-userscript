# Preview, compute and public retrieval implementation

Implemented 2026-11-26. Evidence below is T1/T2; no Firefox or provider verification is implied.

## Execution boundaries

| Component | Authority | Limits and failure behavior |
|---|---|---|
| `compute-worker.ts` | Fixed bundled Worker; starts one QuickJS runtime per call | Parent terminates on deadline/cancellation; Worker CSP failure returns `UNSUPPORTED_INTERFACE`; native editor remains active |
| QuickJS guest | No browser, DOM, fetch, sockets, GM, process, require or host eval | 32 MiB guest heap by default (configurable 1–64 MiB); 512 KiB guest stack; interrupt handler and parent deadline; max 1 hour |
| Filesystem broker | Injected by controller for the authenticated Workspace | Controller must intersect per-operation Grant permissions with lease permissions for every read/write. Guest filesystem paths never select Workspace identity |
| Child tool broker | Explicit facade of eligible file/preview/fetch/image/upload tools | Controller repeats permissions, binding, epoch, deadline and revision checks; no management, Save, lifecycle, production restore or recursive computation |
| Module loader | Explicit inspected/version-pinned source map supplied by trusted controller | 32 modules, 256 KiB each; unknown specifiers reject; no ambient package resolution or module networking |
| Public retrieval | Exact Operator-approved trusted public hostname list | HTTPS only; no credentials, IP literals, alternate ports, fragments, cookies, referrers or redirects; no agent headers; CORS failures explicit |
| Preview | Fixed native methods or separately verified injected adapter | No top-frame arbitrary JavaScript evaluation and no unsolicited page-message privilege handler |

Engine source, result and each broker message are bounded to 256 KiB. Logs are bounded to 64 KiB. Calls are bounded to 1000. Staging defaults to 2 MiB/500 files (trusted controller can select a 1 byte–16 MiB budget). Inline byte arrays consume the JSON message budget; use paged binary tools for larger files. A single pathological computation cannot block the controller because the production controller uses a dedicated Worker; the direct engine export exists for deterministic tests and the Worker entry only.

Filesystem writes remain staged until successful return or an eligible child tool needs them. Reads see staged values. Before a child tool, one `writeBatch` with the original revision commits staged changes. Native multi-file atomicity remains the VFS adapter's responsibility. Later failures enumerate prior committed files/tools as `PARTIAL` or `UNKNOWN`; no automatic rollback overwrites manual edits. A failed computation with only staged changes commits nothing. Timeout during a dispatched child effect means `UNKNOWN`, not cancellation of that effect. Fire-and-forget guest broker calls admitted before the result are drained; disposed guest state receives no further callbacks.

Public fetch uses normal credential-free fetch. It returns exact bytes, status, content type and a bounded text preview; the controller writes bytes using the VFS permission/revision broker. Default maximum response is 4 MiB; hard configurable maximum is 16 MiB; body maximum is 256 KiB. Streaming bounds apply even without Content-Length. POST requires the separate permission; an interrupted POST is an unknown external effect. This adapter does not independently attest DNS: the Operator must approve trusted hosts they control or trust, never attacker-controlled DNS. A general arbitrary-host fetch outcome remains outside the verified restricted-host implementation and cannot be called full parity.

## Native preview gates

`createNativePreviewBridge(page, {host, frame, revision})` now uses the actual public native preview protocol. `editor.evaluateText` returns rendered Perchance expression text; it is not a JavaScript evaluator and is deliberately unused. The candidate instead sends the native `evaluateJs` command to the exact current output `WindowProxy` and `https://<Public ID>.perchance.org` origin. It accepts only the matching cryptographic caller ID and `evaluateJsResponse`; native ACK/heartbeat messages do not extend the admitted deadline. A frame load fences pending replies. Wrong sender, origin and caller IDs have no effect. Generator responses remain untrusted data and never authorize privileged actions.

Native refresh uses `hardReloadOutputIframe()`, whose return is only a completion signal. The adapter supplies an original bounded diagnostics preamble through the public native `__aiAgentPreambleJs` startup hook, and restores its exact prior property descriptor in `finally`. It refuses an existing hook or in-flight native reload. The code is a string passed to the native preview startup path and executes solely in the unprivileged generator frame. No private Helper session or credential is read or reused.

The adapter independently computes the native panel revision as SHA-256 of `[Slug, PJS, HTML]`, and the native src revision as SHA-256 of sorted `[path, key]` pairs. After startup it reads `document.__perchanceInternal.renderReceipt` through the fixed native preview protocol and compares both hashes, pending-src state, startup nonce and render epoch, then rechecks the complete local Workspace revision and native source stamp. Source changes or an absent/wrong receipt reject; neither a resolved native reload nor an iframe load alone proves freshness. This is an implemented candidate based on current public source plus synthetic wire fixtures; Firefox execution remains a T3 gate.

Evaluation does not refresh by default. Results include captured console output, bounded runtime errors/native warnings, `pendingSrcChanges`, `pageFreshnessUnknown`, preview revision and preview generation. A changed preview generation during evaluation rejects as unknown effect. `resultPath` decodes a bounded data URL only after checking source revision. Source-panel lint diagnostics are not yet mapped: `diagnosticsAvailability.syntax` is explicitly `unavailable`, rather than presenting an empty array as proof of no lint errors. Native preview refresh may retain the platform's own derived-metadata update behavior; it does not invoke source Save.

Actual-pixel capture remains unavailable. An automatic remote `getDisplayMedia` picker cannot satisfy browser user-activation requirements; a generic selected screen/tab cannot be reliably identified as the current Perchance tab across Firefox versions. No approximate DOM screenshot or silently selected display substitutes for preview pixels. A future operator-initiated capture can be added after real consent, exact selected-surface identification and cropping are verified; this is a capability gap, not an implementation success.

Viewport changes operate on the native output iframe only and restore the exact prior style on reset/detach. Provisional supported logical maximum is 16384 per dimension; the original helper's 131072 maximum remains a parity gap pending browser measurement. The result explicitly reports that the browser limit is unmeasured. No generator Save occurs.

## Verification

Run:

```sh
node --import tsx --test tests/unit/execution.test.ts tests/unit/execution-native-preview.test.ts tests/integration/execution-worker.test.ts
```

Tests cover absent ambient capabilities, async staged filesystem visibility, exact binary bytes, traversal/read-only import rejection, discarded writes after failure, revision races, child-tool visibility and partial effects, interruption of infinite loops, out-of-memory failure, fresh runtime recovery, explicit pinned module resolution and denial of ambient imports, absence of recursive/admin facade, Worker protocol and termination, exact-host fetch restrictions, redirect/private-address rejection, streaming byte bounds, uncertain POST, native preview activation gates, exact current evaluateJs wire behavior, wrong sender/origin/caller rejection, real-shaped panel/src receipts, one-load preamble restoration, manual source and manifest mismatch, native hook ownership, frame-load fencing, freshness, viewport/reset and preview generation changes.

The T2 Worker test bundles the actual engine with embedded WASM and runs it in a separate thread with runtime fetch disabled. It verifies file RPC and controller timer progress during an infinite guest loop. Browser CSP/Violentmonkey behavior remains T3 work.

## Primary implementation references

- QuickJS embedding, host-function and promise rules: https://github.com/justjake/quickjs-emscripten
- QuickJS runtime limits: https://github.com/justjake/quickjs-emscripten/blob/main/doc/quickjs-emscripten-core/classes/QuickJSRuntime.md
- Single-file browser variant: installed `@jitl/quickjs-singlefile-browser-release-sync@0.32.0` README and type declarations; WASM included in the fixed bundled source.
- Fetch credential and redirect controls: https://developer.mozilla.org/en-US/docs/Web/API/Request/credentials and https://developer.mozilla.org/en-US/docs/Web/API/Request/redirect

No original third-party skill bodies or provider credentials are included.

## Current public preview investigation

Anonymous public source was inspected on 2026-11-26 using an ordinary browser User-Agent. Only original factual summaries and synthetic fixtures are committed; raw third-party source remains scratch-only.

| Public source | SHA-256 of inspected bytes | Extracted contract |
|---|---|---|
| `https://perchance.org/lib/appExtras.js?v=a02092e9a533bd267dec3c9f-d34980caf7f211b0-mwwb21pu-a3824c4c327f7bcdc416a8b7065c8e8af6d434474f337974dc2d74455aed42f9` | `272b3afc0b48b0df9ee0718e4940a2472d684a1f46b4b5ad4cac1c9e24038d19` | `evaluateText` is PJS text; native hard reload, source revision and startup-preamble forwarding |
| Public output of `minimal` on its Public ID subdomain | `6c4b7f79340843994bfd6998e1434c55d28b479e853dec2e578e7600dff4ebab` | `evaluateJs` request/reply, bounded diagnostics query candidate, source/src receipt hashes, preamble before generator startup |

The public frontend is an unofficial mutable interface. Method/protocol drift fails closed. No production source mutation, account sign-in, private AI Helper session, inference access or provider restriction bypass occurred.
