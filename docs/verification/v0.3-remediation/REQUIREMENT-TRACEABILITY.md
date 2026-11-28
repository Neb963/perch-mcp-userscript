# Perch MCP v0.3 remediation requirement traceability

[Revision 3 amendments](../../v0.3/REMEDIATION-AUTHORITY.md) govern the implementation. The matrices below form one requirement register. Each row carries its authority, owner phase, implementation location, exact verification, acceptance criterion, observation, evidence, status and commit. A planned test remains pending until its result is observed. Historical CI and audit results describe the baseline tree.

| Matrix | Scope |
| --- | --- |
| [Specification §§0–5](SPEC-00-05.md) | Authority, architecture, authorization, catalog, operation lifecycle and filesystem |
| [Specification §§6–11, 13](SPEC-06-13.md) | Compute, retrieval, preview, limits, retained v0.2 invariants, economics, manager and release |
| [Acceptance A01–A34](ACCEPTANCE-TRACEABILITY.md) | Original acceptance scenarios and independently testable branches |
| [Findings and amendments](AUDIT-TRACEABILITY.md) | F01–F27, OAuth, clean installation, local manager, approved redesign and OWNER-01–04 |

[Baseline and replay instructions](BASELINE.md)

The release gate requires direct evidence for each offline PASS at its recorded commit. Remaining failures and incomplete evidence block offline qualification. OWNER rows apply only to acceptance requiring explicitly owner-controlled infrastructure or external clients.
