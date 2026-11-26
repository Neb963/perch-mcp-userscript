# Parity investigation addendum

## Archive identities
SHA-256, computed from actual supplied bytes:
- discovery-v3.zip: 65c52533702bc210556acadd2f39f9d848e302644f6c17652e5bc9066e7a9080
- perchance-discovery.md: 4715147a38bbdc07c9c4b39d14439b6cfe4c6e86e383cad507a9900eeef305ec
- Userscript-Perchance-MCP-Discovery.zip: 660da075a51acbe4c7283577416aaa091bf28eee2c003be50194761342fd988c
- skills-all.zip: f942851cc0706b631f490653f802d911999888232865998628185df353170551

Additional static inspection of discovery-v3 evidence/libs/aiAgentClient.js, srcFiles.js, appExtras.js:
- Native client distinguishes legacy auto-apply eval from newer explicit refresh semantics. Adopt explicit freshness: page_eval without reload must not silently apply unsaved changes; report pendingSrcChanges and preview revision.
- Native client documents internal vision and generate_music as server-side session tools. This is evidence of a backend dependency, not permission to call it independently. No native Helper session reuse.
- Native client retains capture_page_image for backward compatibility; later tool semantics use vision or page_eval+resultPath. Product still tracks real preview image capability as separate acceptance target; do not equate DOM screenshot reconstruction with rendered pixels.
- Native client source documents preview preamble carried alongside native output update; a potential adapter hook exists. Treat as static candidate only. Verify that no private inference session is needed and that startup order, cleanup, frame identity and CSP behavior work on Firefox before use.
- Native srcFiles implementation documents getDraftId returning empty string for default; do not coerce it into another draft identifier. Native CodeMirror setter can route through applyBulkEdit in collaborative context. Base-checked bulk edit is candidate, not a verified Firefox implementation.
- Native compute snapshots workspace and applies writes back. New implementation can use staged write set with preflight/revision validation; unlike ordinary Worker JS execution, sandbox must explicitly prevent ambient network and credential access.
- Internal browser put_files/save_b64_file/read_b64_file/workspace_snapshot are observed bridge mechanisms, not necessarily model-facing public tools. Provide equivalent explicit capabilities without exposing native protocol.

## High-risk capabilities
| Outcome | Preferred path | Alternative and gate |
|---|---|---|
| Image generation | Public text-to-image-plugin, native verification and quotas | User-configured authorized media provider; no undocumented token harvesting, compare output parameters |
| Music generation | Authorized external provider if public Perchance API not established | User supplies provider credential/authorization; paid subscription does not imply API access; document cost, duration, vocals, seed fidelity; unresolved until actual output |
| Production server state | Documented authorized platform export/restore interface if available | For generators explicitly designed with backup RPC, use owner-authorized versioned export/restore; not equivalent for arbitrary existing generator, cannot claim full parity; no modifying production server code merely to gain access |
| Screenshot | Browser-supported capture with explicit consent or validated native facility | DOM snapshot/approximate renderer as separately labeled tool, not automatic parity |
| Fetch URL | Safe bounded public fetch | Approved host allowlist when DNS/redirect guarantees unavailable; no unrestricted proxy |
| execute_js | Isolated engine with staged FS broker | Worker with proven restrictive isolation; native browser Worker alone insufficient |
| Attachment | MCP content + local artifact download | Client-specific richer UI optional; no private source public hosting |

Original server-plugin skill explicitly calls for backup before editing existing server code, and reconcile-only call following interrupted restore; preserve this in default Workflow and tool contract. Music skill documents output paths and composition, not an externally authorized backend. Public server documentation: https://perchance.org/doc-server-plugin . Current research did not establish a documented general-purpose production-state endpoint or public Perchance music API. These are implementation feasibility blockers, not reasons to narrow the product contract without owner approval.

Cloudflare additional references: https://developers.cloudflare.com/changelog/post/2026-07-09-restrict-new-kv-backed-namespaces/ (new DO namespaces SQLite); https://developers.cloudflare.com/durable-objects/platform/pricing/ (request accounting separate from Worker); https://developers.cloudflare.com/durable-objects/platform/limits/ (message and storage limits). Hibernation does not guarantee an active MCP HTTP operation incurs no duration. Measure realistic long calls, heartbeat writes and poll fallback in P02/P10. Avoid per-heartbeat durable write unless needed for fencing; persist only authoritative lease updates at bounded cadence with conservative expiration.

## Scope clarification
Production-state access, music, screenshot and isolated computation must be demonstrated in real authorized environments; no placeholder successful result, hidden scope reduction or automatic paid provider selection. Default skills include 11 independently authored domain skills seeded from the repository (report and OpenCode excluded). Optional third-party imports are not prerequisites. The original exports remain outside this public repo. Optional OpenCode reference import is not runtime dependence; our default workflow is client-neutral.
