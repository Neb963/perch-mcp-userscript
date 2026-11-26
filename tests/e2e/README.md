# Optional rendered manager check

The fixture contains only original synthetic Workspace/Agent/Resource records. It never visits Perchance, deploys a Worker, reads credentials or mutates a generator. It verifies rendered manager geometry at 1024×768 and 1920×1080, long Resource editing, no horizontal overflow, one manager scroll area and native fixture editing after close.

Run from the repository root with a locally available browser and Playwright Core module:

```
BROWSER_EXECUTABLE=/path/to/chromium PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs node tests/e2e/manager-layout.mjs
```

For Firefox, also set `BROWSER_ENGINE=firefox`. Set `SCREENSHOT_DIR` to an existing directory for optional synthetic screenshots. No browser/package download occurs. Failures must be fixed before treating this as a passing rendered-layout check.

This is T2 synthetic UI evidence. It does not replace T3 Firefox/Violentmonkey integration, native editor isolation, background suspension, native draft behavior or T4 Cloudflare/connector setup evidence.

Attempt on 2026-11-26: `/usr/bin/chromium` was a launcher without `/usr/lib/chromium/chromium`; launch failed before page load. No geometry measurements or screenshots were obtained in that attempt. Browser download fallback was unavailable in the task environment.

A later 2026-11-26 run used isolated Chromium 158.0.8127.0 and passed both target viewports. The real renderer exposed a two-pixel textarea overflow caused by border-box height calculation; the manager now includes measured borders and the unchanged scrolling checks pass. The harness also covers long-line wrapping, input growth, responsive resizing, expanded Settings with 64 hosts, keyboard section navigation/focus trapping/Escape and native editor use after close. This establishes Chromium T2 synthetic layout evidence; Firefox T3 remains a separate gate.
