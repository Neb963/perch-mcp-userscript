/** Optional real-renderer QA. Never visits a provider or uses an account. */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const moduleName = process.env.PLAYWRIGHT_MODULE ?? 'playwright-core';
const { chromium, firefox } = await import(moduleName);
const engine = process.env.BROWSER_ENGINE === 'firefox' ? firefox : chromium;
const binary = process.env.BROWSER_EXECUTABLE;
if (!binary) throw new Error('Set BROWSER_EXECUTABLE to an installed Chromium/Firefox executable. This harness does not download or install browsers.');
const dir = await mkdtemp(join(tmpdir(), 'perch-manager-layout-'));
let browser;
try {
  await build({ entryPoints: ['tests/e2e/manager-fixture.ts'], bundle: true, outfile: join(dir, 'fixture.js'), format: 'iife', logLevel: 'silent' });
  await writeFile(join(dir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;font:14px sans-serif}main{padding:24px;height:100%;box-sizing:border-box;background:#eff2f6}textarea{width:80%;height:70%}</style></head><body><main><h1>Synthetic native editor</h1><textarea aria-label="Native fixture source">Untouched native draft</textarea></main><script src="fixture.js"></script></body></html>');
  browser = await engine.launch({ headless: true, executablePath: binary, ...(process.env.BROWSER_ENGINE === 'firefox' ? {} : { args: ['--no-sandbox', '--disable-dev-shm-usage'] }) });
  const report = [];
  for (const viewport of [{ width: 1024, height: 768 }, { width: 1920, height: 1080 }]) {
    const page = await browser.newPage({ viewport });
    await page.goto(pathToFileURL(join(dir, 'index.html')).href);
    await page.getByRole('dialog').waitFor();
    for (const tab of ['Workspaces', 'Agents', 'Library', 'Activity', 'Settings']) {
      await page.getByRole('tab', { name: tab, exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Updated.' }).waitFor();
      const metrics = await page.evaluate(() => {
        const s = document.querySelector('[data-perch-mcp-manager]').shadowRoot;
        const d = s.querySelector('dialog'), b = s.querySelector('.body');
        return { dialog: { scroll: d.scrollHeight, client: d.clientHeight, width: d.clientWidth }, body: { scroll: b.scrollHeight, client: b.clientHeight, width: b.clientWidth, scrollWidth: b.scrollWidth }, viewport: { width: innerWidth, height: innerHeight } };
      });
      assert.ok(metrics.dialog.scroll <= metrics.dialog.client + 1, `${tab}: dialog double scroll ${JSON.stringify(metrics)}`);
      assert.ok(metrics.body.scrollWidth <= metrics.body.width + 1, `${tab}: horizontal overflow`);
      if (tab === 'Library') {
        await page.getByRole('button', { name: 'Resource 1', exact: true }).click();
        await page.getByRole('textbox', { name: 'Resource text', exact: true }).waitFor();
        const areas = await page.evaluate(() => { const a = document.querySelector('[data-perch-mcp-manager]').shadowRoot.querySelector('textarea'); return { scroll: a.scrollHeight, client: a.clientHeight }; });
        assert.ok(areas.scroll <= areas.client + 1, 'textarea creates nested scrolling');
        if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, `manager-library-${viewport.width}.png`), fullPage: false });
      }
      report.push({ viewport, tab, metrics });
    }
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('textbox', { name: 'Native fixture source' }).fill('Native editor remains operable');
    assert.equal(await page.getByRole('textbox', { name: 'Native fixture source' }).inputValue(), 'Native editor remains operable');
    await page.close();
  }
  console.log(JSON.stringify({ tier: 'T2 synthetic rendered layout; no provider evidence', report }, null, 2));
} finally {
  await browser?.close();
  await rm(dir, { recursive: true, force: true });
}
