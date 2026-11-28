# R10 — browser effect-boundary revalidation

**Directly verified source:** [`cbef2a233a1e3fdb21da2c315aa0d1eec80853c6`](https://github.com/Neb963/perch-mcp-userscript/commit/cbef2a233a1e3fdb21da2c315aa0d1eec80853c6). **Offline CI:** [46158172940](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46158172940): 732 tests = **731 PASS, 0 FAIL, 1 historical SKIP**.

| Clause | Direct observable proof |
| --- | --- |
| **S03-009** | The production `executeDevelopment` boundary independently reruns `parseDevelopmentCall` on an already admitted browser envelope before any filesystem effects. Modified content containing duplicate paths raised `PATH_DENIED`; malformed base64, injected Target/operationKey and unknown fields raised input errors; narrower permission ceiling denied publication. Every invalid case left the prior VFS contents unchanged and acquired zero publication permits. The valid bounded write acquired a source-publication permit and stored the expected bytes. Earlier `tests/unit/controller.test.ts` independently covers wrong Workspace, Epoch, tab/document and Binding revisions before native effects. |

**Test:** `tests/unit/development-v2.test.ts` — `S03-009 browser revalidates admitted standalone mutations before any effect`. Existing batch preflight and host policy checks remain; native BrowserController identity/deadline checks remain unchanged. No real Firefox/Perchance, production OAuth, deployment, or provider writes were performed.

**Register delta:** one `NOT_STARTED`→`PASS` for `S03-009`; 1,317 total = **125 PASS, 4 FAIL, 1,149 NOT_STARTED, 24 DEFERRED_OWNER, 1 BLOCKED_FEASIBILITY, 14 SUPERSEDED**. SQL 187/44, screenshot pixel feasibility, and owner gates remain open.
