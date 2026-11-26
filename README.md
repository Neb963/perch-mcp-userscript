# Perch MCP

Perch MCP connects external AI web clients to independent Perchance editor tabs through remote MCP. One Firefox userscript, one Cloudflare Worker deployment; no daemon, extension development, VPN or Tailscale.

**Status: design baseline v0.1; implementation and live verification not started.** No deploy button is active until a deployable release exists.

## Authority
- [Client specification](CLIENT_SPEC.md) — product contract.
- [Architecture](docs/DESIGN.md) — implementation design.
- [Tool contract](docs/TOOLS.md) — functional parity inventory and semantics.
- [Protocol and persistence](docs/PROTOCOL.md) — management routes, transport, fencing and persistence contracts.
- [Parity investigation addendum](docs/PARITY_NOTES.md) — additional evidence and blockers.
- [Default development workflow](docs/DEFAULT_WORKFLOW.md) — editable, client-neutral workflow seed.
- [Deployment and operator UX](docs/SETUP.md) — setup and maintenance contract.
- [Evidence](docs/EVIDENCE.md) — provenance, assumptions and feasibility gates.
- [Verification](docs/TEST_PLAN.md) — release evidence.
- [Implementation phases](todo.md) — current execution ledger.
- [Agent governance](AGENTS.md).

The owner supplies the Perchance discovery and skills archives separately. This public repository does not redistribute raw provider captures or original third-party skills without established redistribution permission. Import is a first-class product feature.

## Intended installation
Deploy a released gateway using the Cloudflare dashboard/Deploy to Cloudflare workflow; install the single released userscript in Firefox; pair using the gateway URL and one-time bootstrap secret; attach a workspace; copy its MCP URL into the AI client's connector configuration; approve OAuth from the manager. See the setup contract for exact intended behavior. These steps are not yet executable.

## Scope
No native AI Helper inference or session automation, PCMS account orchestration, platform bug-report submission, or OpenCode runtime dependency. External agents run in their own clients. The full development capability baseline is required, with reporting explicitly excluded.
