# Perch MCP

Perch MCP connects external AI web clients to independent Perchance editor tabs through remote MCP. One Firefox userscript, one Cloudflare Worker deployment; no daemon, extension development, VPN or Tailscale.

**Status: v0.3.0 offline development verification candidate.** The 19-tool v2 contract is staged behind explicit assignment and execution settings. Review [offline evidence](docs/verification/v0.3/ACCEPTANCE.md) and the [operator acceptance gates](OPERATOR-ACCEPTANCE.md).

## Authority
- [Client specification](CLIENT_SPEC.md) — product contract.
- [Architecture](docs/DESIGN.md) — implementation design.
- [Tool contract](docs/TOOLS.md) — current v2 tools and compatibility inventory.
- [Protocol and persistence](docs/PROTOCOL.md) — management routes, transport, fencing and persistence contracts.
- [Parity investigation addendum](docs/PARITY_NOTES.md) — additional evidence and blockers.
- [Default development workflow](docs/DEFAULT_WORKFLOW.md) — editable, client-neutral workflow seed.
- [Deployment and operator UX](docs/SETUP.md) — setup and maintenance contract.
- [Evidence](docs/EVIDENCE.md) — provenance, assumptions and feasibility gates.
- [Verification](docs/TEST_PLAN.md) — release evidence.
- [Implementation phases](todo.md) — current execution ledger.
- [Agent governance](AGENTS.md).

The repository is the complete coding handoff. Start with [HANDOFF.md](docs/HANDOFF.md), [Perchance adapter reference](docs/PERCHANCE_ADAPTER.md), and [Violentmonkey contract](docs/VIOLENTMONKEY.md). The release builds the agent-local knowledge package from the eleven independently authored [default skills](packages/resources/skills/) and generated tool schemas. Existing Resource archives remain available for operator recovery during compatibility rollout. Historical raw captures and original third-party skill texts are not redistributed.

## Candidate installation
Deploy a released gateway using the Cloudflare dashboard/Deploy to Cloudflare workflow; install the single released userscript in Firefox; pair using the gateway URL and one-time bootstrap secret; attach a workspace; copy its MCP URL into the AI client's connector configuration; approve OAuth from the manager. See the setup contract for exact intended behavior. The candidate can be built and packaged locally. The clean-account dashboard path and real client authorization still require external qualification; follow [installation](docs/INSTALLATION.md), [connector configuration](docs/CONNECTORS.md) and [recovery](docs/RECOVERY.md).

## Scope
No native AI Helper inference or session automation, PCMS account orchestration, platform bug-report submission, or OpenCode runtime dependency. External agents run in their own clients. The v0.3 development contract supersedes historical full Helper parity. The local agent knowledge package includes all eleven original skills.

## Build and verification

```sh
npm ci
npm run typecheck
npm test
npm run build
```

The build creates `dist/perch-mcp.user.js`, its identical `.txt` mirror, `perch-mcp-cloudflare.zip`, and `perch-mcp-candidate.zip`. Do not call these a full-parity release. Current native source, preview, Save/lifecycle and media availability is explicit; unverified external effects fail closed. The operator can always close the manager and continue ordinary Perchance editing.

Generated tool reference: [human-readable contracts](docs/GENERATED_TOOL_REFERENCE.md) and [machine schemas](docs/TOOL_SCHEMAS.json). Runtime records: [gateway](docs/GATEWAY_IMPLEMENTATION.md), [browser](docs/BROWSER_IMPLEMENTATION.md), [execution](docs/EXECUTION_IMPLEMENTATION.md), [Resources](docs/RESOURCE_IMPLEMENTATION.md), [manager](docs/MANAGER_IMPLEMENTATION.md), [parity](docs/PARITY_IMPLEMENTATION.md).
