# Epoch 8 live regression / 0.1.10 remediation

## Evidence provenance
Operator's Epoch-8 live appendix, installed 0.1.9, assigned \`aleph-alpha\`, and separately exported redacted gateway diagnostics (0.1.5). An additional read-only \`workspace_status\` confirmed Epoch 8 source revision \`12:3b5baa5c2917146528c44eb1ac0072b0b35034cc546438356c713c43ede32df2\`, dirty/unsaved, no unresolved operations, lease connected. Gateway provider writes disabled, local native acceptance disabled. No provider effect was attempted by this patch.

## Positive live regression evidence retained
Public imports text-to-image-plugin and minimal: complete verified snapshots; viewport 390x844 and native reset 1249x505; source write/checkpoint/digest; capability discovery transition; read-only metadata saved-base digest; preview refresh and eval; no post-reset lockout. These are T3 observations of 0.1.9, not claims that 0.1.10 has already run live.

## Fixed in source / tested synthetically
1. Safe Save dispatch: persist \`DISPATCHED\` before calling the native method. A lost/ambiguous receipt becomes \`UNKNOWN\`; it blocks new writes until operator reconciliation, including after reload. Native Save never automatically replays.
2. Distinct revisions: when independent stored bytes match the intended revision, report the saved revision separately from the latest Workspace draft. A newer native draft cannot be implicitly claimed saved.
3. CDN eventual consistency: retry only read-only public-source readback on a bounded schedule; never repeat native Save.
4. Native boolean metadata: asynchronous native predicate results must resolve to strict booleans within a deadline; truthy strings and unresolved/throwing values remain unknown. Contradictory listing signals remain unknown.
5. Cross-realm buffers: accept genuine foreign-realm ArrayBuffer bytes and reject spoofed tags. Explicit zero-length public assets with absent response streams remain valid.

## Accepted limitations / release gates
- **Save still unavailable:** local \`externalWritesVerified=false\` and deployed \`PROVIDER_WRITES_ENABLED=false\` are intentional acceptance barriers. Changing userscript alone cannot activate privileged Save; live disposable-generator verification and explicit operator policy change remain required. Dirty production source is not a permitted substitute test target.
- **Capture:** no verified pixel capture interface. A DOM rendering substitute would be inaccurate; do not synthesize screenshots as actual pixels.
- **Syntax:** the reported native syntax getter returned \`null\`; distinguish unavailable native lint from missing errors. Deliberate syntax-break testing requires a disposable generator.
- **Generator metadata:** missing authoritative native fields remain unknown. Boolean readiness alone cannot prove account ownership or public listing.
- **MCP envelopes:** the gateway emits the inner \`UNSUPPORTED_INTERFACE\` structured code with \`isError: true\`. The client connector presents a separate outer \`INVALID_ARGUMENT\` classification. Do not falsify success or weaken error semantics to disguise this client wrapper behavior.
- **Other declared unavailable tools:** media, upload, capture, server-plugin production state and lifecycle tools remain disabled pending verified provider integration. Discoverability does not imply real execution failure or implementation success.

## Verification contract
Full CI typecheck, unit/integration tests, userscript/TXT identity, archived-file digest verification, and Worker dry-run are mandatory on the final head. These do **not** establish live Firefox or native-provider parity. Read-only live status checked; source and Save remain untouched. No deployed gateway change is necessary for this source-only candidate.
