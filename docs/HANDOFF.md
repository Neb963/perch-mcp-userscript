# Perch MCP implementation handoff

Start with [AGENTS.md](../AGENTS.md) and the [v0.3 implementation specification](v0.3/PERCH-MCP-V0.3-IMPLEMENTATION-SPEC.md). Follow the [coding prompt](v0.3/PERCH-MCP-V0.3-CODING-AGENT-PROMPT.md) and the dependency ledger in [todo.md](../todo.md). The [design proposal](v0.3/PERCH-MCP-V0.3-DESIGN-PROPOSAL.md) supplies rationale and risks. The repository includes the eleven existing knowledge sources and the complete v0.2.0 evidence. Prior archive references are provenance.

The runtime baseline remains v0.2.0 through V00. Implement and verify each eligible phase under the scope amendment before activating v2. Source and verification work stay offline. Production, preview, real-browser/provider testing and merging remain Operator-controlled. Preserve exact negative, restart, fencing and migration tests.

## Historical v0.1 handoff

Start here; then read AGENTS.md, CLIENT_SPEC.md, DESIGN.md, PROTOCOL.md, TOOLS.md, TOOL_PARITY_DETAILS.md, PERCHANCE_ADAPTER.md, VIOLENTMONKEY.md, SETUP.md, EVIDENCE.md, PARITY_NOTES.md, TEST_PLAN.md and todo.md. Default skills are in packages/resources/skills. The repository is the complete input; no additional archives are required from the Operator. Historical source citations/hashes are provenance, not files to retrieve from the Operator. Public provider documentation is available via the cited URLs; reverify at implementation time.

## Readiness audit
| Area | In-repo authority | Remaining task |
|---|---|---|
| Requirements/scope | CLIENT_SPEC C01–C21 | implement, test |
| Native editor, draft, files, Save, preview, lifecycle | PERCHANCE_ADAPTER + DESIGN | P01 authorized live probes; never assume candidate globals |
| Firefox/VM | VIOLENTMONKEY | verify isolated context and network; no CSP weakening |
| MCP/OAuth/Cloudflare | PROTOCOL/DESIGN/SETUP | P02 SDK compatibility, clean deployment, real connectors |
| Tool behaviors | TOOLS + TOOL_PARITY_DETAILS | P03 generated strict schemas and docs; 22 helper outcomes |
| Knowledge | packages/resources (11 original skills) + DEFAULT_WORKFLOW | P07 seed/version/edit/import/export; no mandatory ZIP |
| Fixtures | tests/fixtures | generate synthetic ZIP, binary, malformed and race fixtures |
| Verification | TEST_PLAN + todo | keep exact tier results, no false pass |
| Media/state | PARITY_NOTES + corresponding skills | find authorized alternatives and verify; no private session reuse |

## Autonomous execution
Resume actual remote state, not assumptions. P01 and P02 may proceed in parallel; create real diagnostic/prototype code with tests. Gate later production enablement by evidence. If browser, Cloudflare or connector credentials are not available, build and test against deterministic synthetic/native adapter fixtures and local Worker emulator, record missing live evidence, continue independent work, and supply a concise reproducible operator checklist only for irreducible external actions. Never ask for old archives; never claim synthetic evidence is live. Keep production writes gated until real proof. Commit/push each verified slice, maintain todo, use CI only when needed, merge reviewed verified work. If a live parity capability remains unavailable, finish all other eligible work, report it as a release blocker and propose authorized alternatives, not a silent scope change. Full release only after all required tiers pass.

## Limitations of handoff
The default skills are independently authored implementation-focused references, not verbatim original exported bodies or a claim of complete documentation equivalence. Expand against current public plugin source/docs and verified behavior as part of P07; retain provenance and no unauthorized redistribution. No external source file needed to implement the library itself. Real account authorization, Cloudflare deployment access, disposable generator and provider consent are runtime/test prerequisites rather than missing handoff files. Music generation, production state and exact preview capture are unresolved technical outcomes; no design document can prove their availability. Do not change repository visibility or publish raw captures.
