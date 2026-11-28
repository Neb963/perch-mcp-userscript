# Perch MCP v0.3 conformance authority

The accepted audit revision 3 governs remediation on `repair/v0.3-conformance`. Apply its explicit owner amendments first, the [unified specification](PERCH-MCP-V0.3-IMPLEMENTATION-SPEC.md) second, the remaining audit acceptance criteria third, and the [design proposal](PERCH-MCP-V0.3-DESIGN-PROPOSAL.md) fourth. Preserve unaffected requirements. The original specification remains available with its original hash.

| Amendment | Requirement | Superseded guidance |
| --- | --- | --- |
| OAUTH-PERSIST-01 (§9) | Connector Grants, refresh authorization, and dynamic client registrations persist across inactivity, restarts, reassignment, zero Workspaces, pause, suspension and temporary failure. Preserve explicit revocation, exact audience/client binding, permission ceilings and fresh execution authorization. | Finite 30-day refresh authorization, expiring application consent, and refresh dependence on current execution authorization. |
| OAUTH-PERSIST-02 (§11.1) | Qualify 15, 30, 60 and 120 minutes and the audit's longer candidate values with the pinned SDK. Select the longest finite value supported by **SDK and browser/client scheduling evidence**, not SDK alone. Default 24 days remains below the 2^31-1 ms timer limit; 10 years is an explicit experimental override until OWNER-02 proves real external-client refresh safety. Record KV and real-client interoperability as OWNER-02/04. | A fixed 900-second or 120-minute recommendation. |
| CLEAN-INSTALL-01 (§11.2) | Provide a clean v2 installation with explicit first consent and preserve existing credentials, native drafts, storage and unresolved evidence for operator-controlled retirement. | Mandatory in-place migration of legacy OAuth credentials under OAUTH-05. |
| UI-LIB-01 (§11.3) | Remove active Library and Resource controls under every Gateway/version state, including first render. Provide bounded read-only legacy export when data exists. | Conditional hiding after a successful v2 status response. |
| UI-OFFLINE-01–04 (§11.4) | Render local manager views independently. Keep exact local recovery, export, probe, diagnostics and stop available. Scope stale summaries to the installation, disable remote mutations without current authority, and coalesce bounded retries. | Gateway bootstrap as a prerequisite for local rendering or recovery. |
| UI-STATE-01 (§11.5) | Converge selected tab, panel, focus and action scope immediately. Invalidate obsolete handlers and confirmation tokens. Bind remote actions to current authority, immutable intent and the original idempotency key. | Reusing a prior view's actionable controls or replacing a pending confirmation callback. |

Audit §§10–11 also require the approved compact Workspace and Connector views, visible urgent approvals, local filters and sorting, and evidence across 390×844, 1024×768 and 1440×900 with 30- and 50-Workspace fixtures. Audit findings F01–F27 and original acceptance A01–A34 remain in scope. Capture still requires actual authorized preview pixels. OWNER-01–04 remain operator-only.

[Verification index](../verification/v0.3-remediation/REQUIREMENT-TRACEABILITY.md)
