# R03 exact-bundle manager visual qualification

**Exact test source/installer**: release artifact of commit `e742f091d574a894c7bc07badb2ed61a53b3c176`; offline CI [46095386706](https://github.com/Neb963/perch-mcp-userscript/actions/runs/46095386706). `tests/offline-manager/visual-qualification.py` extracted the actual bundled `mountManager` without modifying its UI implementation and exercised the actual 30/50-Workspace synthetic fixtures. All browser networking was aborted. Chromium 1440×900, 1024×768 and 390×844; no Firefox/live Perchance acceptance claimed.

| Viewport | 30 Workspaces fully visible | 50 Workspaces fully visible | Required | Result |
| --- | ---: | ---: | ---: | --- |
| 1440×900 | 11 | 11 | >=8 | PASS |
| 1024×768 | 8 | 8 | >=6 | PASS |
| 390×844 | 2 | 2 | >=1 | PASS |

Thirty exact screenshots (five tabs × three viewports × two fixture sizes) plus a full metrics JSON were generated locally. Archive SHA-256: `9f102148cc2b7403f20d21957d86d069a7ea2d6179a5a9117c945ff049c6dea2`, filename `PERCH-MCP-V0.3-CONFORMANCE-UI-EVIDENCE-e742.zip`. Every generated screenshot corresponds to the actual release bundle; no single viewport was simulated by CSS abstraction.

**All 30 measurements**: `dialogOverflow=false`, `bodyHorizontalOverflow=false`, `viewportHorizontalOverflow=false`, exact selected tab matched visible pane, five tabs `Workspaces`, `Connectors`, `Activity`, `Recovery`, `Settings`, zero external network requests. Library never appeared. Targeted regression suite also verifies local stop, identity, Gateway 429/503 outage, stale-response suppression, old-confirmation invalidation, read-only cached summaries and disabled mutations.

**Boundary**: this screenshot qualification observes synthetic management data in Chromium. It is distinct from actual unsaved Perchance generator pixels (F11.07: BLOCKED_FEASIBILITY) and from OWNER-01 Firefox+Violentmonkey live acceptance.

## Reproduction

```sh
npm run build
python tests/offline-manager/visual-qualification.py --bundle dist/perch-mcp.user.js --output /tmp/perch-r03-visual
```

Review generated metrics.json and screenshots at 1440×900, 1024×768 and 390×844. Do not bypass the script's zero-network or exact-bundle assertions.
