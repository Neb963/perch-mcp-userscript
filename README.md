# Perch MCP

Perch MCP connects external AI web clients to independent Perchance editor tabs through remote MCP. One Firefox userscript, one Cloudflare Worker deployment; no daemon, extension development, VPN or Tailscale.

**Status: implemented verification candidate; full-parity release blocked by explicit external and provider capability gates.** Local verification and limitations are recorded in [release verification](docs/RELEASE_VERIFICATION.md). No production deployment or live provider mutation has been performed.

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

The repository is the complete coding handoff. Start with [HANDOFF.md](docs/HANDOFF.md), [Perchance adapter reference](docs/PERCHANCE_ADAPTER.md), and [Violentmonkey contract](docs/VIOLENTMONKEY.md). The 11 independently authored [default skills](packages/resources/skills/) ship with the product and require no owner-supplied archive. Optional imports remain supported. Historical raw captures and original third-party skill texts are not redistributed.

## Candidate installation
Deploy a released gateway using the Cloudflare dashboard/Deploy to Cloudflare workflow; install the single released userscript in Firefox; pair using the gateway URL and one-time bootstrap secret; attach a workspace; copy its MCP URL into the AI client's connector configuration; approve OAuth from the manager. See the setup contract for exact intended behavior. The candidate can be built and packaged locally. The clean-account dashboard path and real client authorization still require external qualification; follow [installation](docs/INSTALLATION.md), [connector configuration](docs/CONNECTORS.md) and [recovery](docs/RECOVERY.md).

## Scope
No native AI Helper inference or session automation, PCMS account orchestration, platform bug-report submission, or OpenCode runtime dependency. External agents run in their own clients. The full development capability baseline is required, with reporting explicitly excluded.

## Build and verification

```sh
npm ci
npm run typecheck
npm test
npm run build
```

The build creates `dist/perch-mcp.user.js`, its identical `.txt` mirror, `perch-mcp-cloudflare.zip`, and `perch-mcp-candidate.zip`. Do not call these a full-parity release. Current native source, preview, Save/lifecycle and media availability is explicit; unverified external effects fail closed. The operator can always close the manager and continue ordinary Perchance editing.

Generated tool reference: [human-readable contracts](docs/GENERATED_TOOL_REFERENCE.md) and [machine schemas](docs/TOOL_SCHEMAS.json). Runtime records: [gateway](docs/GATEWAY_IMPLEMENTATION.md), [browser](docs/BROWSER_IMPLEMENTATION.md), [execution](docs/EXECUTION_IMPLEMENTATION.md), [Resources](docs/RESOURCE_IMPLEMENTATION.md), [manager](docs/MANAGER_IMPLEMENTATION.md), [parity](docs/PARITY_IMPLEMENTATION.md).
