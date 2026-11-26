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
  const screenshot = async (page, name) => { if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, `${name}.png`), fullPage: false }); };
  const geometry = page => page.evaluate(() => {
    const s = document.querySelector('[data-perch-mcp-manager]').shadowRoot;
    const d = s.querySelector('dialog'), b = s.querySelector('.body');
    return { dialog: { scroll: d.scrollHeight, client: d.clientHeight, width: d.clientWidth }, body: { scroll: b.scrollHeight, client: b.clientHeight, width: b.clientWidth, scrollWidth: b.scrollWidth }, viewport: { width: innerWidth, height: innerHeight } };
  });
  const checkGeometry = (metrics, label) => {
    assert.equal(metrics.dialog.scroll, metrics.dialog.client, `${label}: dialog double scroll ${JSON.stringify(metrics)}`);
    assert.ok(metrics.body.scrollWidth <= metrics.body.width + 1, `${label}: horizontal overflow`);
  };
  const checkTextarea = async (page, name) => {
    const value = await page.getByRole('textbox', { name, exact: true }).evaluate(a => ({ scroll: a.scrollHeight, client: a.clientHeight, width: a.clientWidth, scrollWidth: a.scrollWidth, height: a.offsetHeight, styleHeight: a.style.height, computedHeight: getComputedStyle(a).height, boxSizing: getComputedStyle(a).boxSizing }));
    assert.ok(value.scroll <= value.client + 1, `${name}: nested vertical scrolling ${JSON.stringify(value)}`);
    assert.ok(value.scrollWidth <= value.width + 1, `${name}: nested horizontal scrolling ${JSON.stringify(value)}`);
    return value;
  };
  for (const viewport of [{ width: 1024, height: 768 }, { width: 1920, height: 1080 }]) {
    const page = await browser.newPage({ viewport });
    await page.goto(pathToFileURL(join(dir, 'index.html')).href);
    await page.getByRole('dialog').waitFor();
    for (const tab of ['Workspaces', 'Agents', 'Library', 'Activity', 'Settings']) {
      await page.getByRole('tab', { name: tab, exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Updated.' }).waitFor();
      const metrics = await geometry(page);
      const verification = {};
      checkGeometry(metrics, tab);
      await screenshot(page, `manager-${tab.toLowerCase()}-${viewport.width}`);
      if (tab === 'Library') {
        await page.getByRole('button', { name: 'Resource 1', exact: true }).click();
        const area = page.getByRole('textbox', { name: 'Resource text', exact: true });
        await area.waitFor();
        await page.waitForFunction(() => document.querySelector('[data-perch-mcp-manager]').shadowRoot.activeElement?.getAttribute('aria-label') === 'Resource text');
        verification.initialText = await checkTextarea(page, 'Resource text');
        const editorGeometry = await geometry(page);
        checkGeometry(editorGeometry, 'Library editor');
        await screenshot(page, `manager-library-editor-${viewport.width}`);
        // Input growth, long-line wrapping and viewport resizing must not create another scroll area.
        await area.fill('Unbroken line: ' + 'a'.repeat(800) + '\n' + Array.from({ length: 60 }, (_, i) => `Edited line ${i}`).join('\n'));
        verification.editedText = await checkTextarea(page, 'Resource text');
        const alternate = viewport.width === 1024 ? { width: 1920, height: 1080 } : { width: 1024, height: 768 };
        await page.setViewportSize(alternate);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        verification.resizedText = await checkTextarea(page, 'Resource text');
        checkGeometry(await geometry(page), 'Resized Resource editor');
        await page.setViewportSize(viewport);
      }
      if (tab === 'Settings') {
        for (const name of ['Recover installation credentials', 'Approved public fetch hosts', 'Execution limits and recovery']) await page.locator('summary').filter({ hasText: name }).click();
        const hosts = page.getByRole('textbox', { name: 'Exact approved public hostnames', exact: true });
        await hosts.waitFor();
        verification.initialHosts = await checkTextarea(page, 'Exact approved public hostnames');
        await screenshot(page, `manager-settings-expanded-${viewport.width}`);
        await hosts.fill(Array.from({ length: 64 }, (_, i) => `assets-${i}.trusted.net`).join('\n'));
        verification.expandedHosts = await checkTextarea(page, 'Exact approved public hostnames');
        checkGeometry(await geometry(page), 'Expanded Settings');
        await screenshot(page, `manager-settings-hosts-${viewport.width}`);
      }
      report.push({ viewport, tab, metrics, verification });
    }
    await page.evaluate(() => document.getElementById('native-source')?.focus());
    assert.notEqual(await page.evaluate(() => document.activeElement?.id), 'native-source', 'Native modal focus remains inside the open manager');
    // Native keyboard traversal: section shortcuts, focus trap, Escape and editor recovery.
    const settingsTab = page.getByRole('tab', { name: 'Settings', exact: true });
    await settingsTab.focus();
    await settingsTab.press('Home');
    await page.getByRole('tab', { name: 'Workspaces', exact: true }).getAttribute('aria-selected').then(value => assert.equal(value, 'true'));
    await page.keyboard.press('ArrowRight');
    await page.getByRole('tab', { name: 'Agents', exact: true }).getAttribute('aria-selected').then(value => assert.equal(value, 'true'));
    await page.keyboard.press('End');
    await page.getByRole('tab', { name: 'Settings', exact: true }).getAttribute('aria-selected').then(value => assert.equal(value, 'true'));
    await page.getByRole('status').filter({ hasText: 'Updated.' }).waitFor();
    await page.getByRole('button', { name: 'Close', exact: true }).focus();
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.querySelector('[data-perch-mcp-manager]').shadowRoot.activeElement?.textContent), 'Stop this document immediately');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.querySelector('[data-perch-mcp-manager]').shadowRoot.activeElement?.textContent), 'Close');
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog').count(), 0);
    await page.getByRole('textbox', { name: 'Native fixture source' }).fill('Native editor remains operable');
    assert.equal(await page.getByRole('textbox', { name: 'Native fixture source' }).inputValue(), 'Native editor remains operable');
    await page.getByRole('button', { name: 'Open Perch MCP manager', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    assert.equal(await page.evaluate(() => document.querySelector('[data-perch-mcp-manager]').shadowRoot.activeElement?.getAttribute('aria-label')), 'Open Perch MCP manager');
    await page.close();
  }
  console.log(JSON.stringify({ tier: 'T2 synthetic rendered layout and keyboard; no provider evidence', browserVersion: browser.version(), report }, null, 2));
} finally {
  await browser?.close();
  await rm(dir, { recursive: true, force: true });
}
