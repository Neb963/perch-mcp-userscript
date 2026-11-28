import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core');
const hostOrigin = 'https://127.0.0.1';
const previewOrigin = 'https://127.0.0.2';
const hostPage = hostOrigin + '/capture-fixture';
const previewPage = previewOrigin + '/preview';

const browser = await chromium.launch({executablePath:process.env.BROWSER_EXECUTABLE,headless:true});
try {
  const page = await browser.newPage();
  const outbound = [];
  await page.route('**/*', route => {
    switch (route.request().url()) {
      case hostPage: return route.fulfill({contentType:'text/html',body:`<!doctype html>
        <iframe id="exact-preview" style="isolation:isolate" src="${previewPage}"></iframe>`});
      case previewPage: return route.fulfill({contentType:'text/html',body:`<!doctype html>
        <html style="isolation:isolate;transform-style:flat"><p>Synthetic preview
        <script>
        window.addEventListener('message', async event => {
          if (event.origin !== ${JSON.stringify(hostOrigin)} || event.source !== parent ||
              event.data?.type !== 'fixture-only-mint') return;
          const target = await RestrictionTarget.fromElement(document.documentElement);
          parent.postMessage({type:'fixture-only-target', caller:event.data.caller, target}, event.origin);
        });
        </script>`});
      default: outbound.push(route.request().url()); return route.abort();
    }
  });
  await page.goto(hostPage);
  await page.evaluate(() => { globalThis.RestrictionTarget = undefined; });
  const cdp = await page.context().newCDPSession(page);
  const {frameTree} = await cdp.send('Page.getFrameTree');
  const {executionContextId} = await cdp.send('Page.createIsolatedWorld',{
    frameId:frameTree.frame.id,worldName:'offline-capture-isolated',grantUniveralAccess:false,
  });
  const {result, exceptionDetails} = await cdp.send('Runtime.evaluate',{
    expression:`(async () => {
      const frame = document.querySelector('#exact-preview');
      const view = frame.contentWindow;
      let childDocumentAccessDenied = false;
      try { void view.location.href; }
      catch (error) { childDocumentAccessDenied = error.name === 'SecurityError'; }
      const exactFrameToken = await RestrictionTarget.fromElement(frame);
      const previewOrigin = ${JSON.stringify(previewOrigin)};
      const caller = crypto.randomUUID();
      const childTarget = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('Synthetic transfer timed out')),3000);
        const listener = event => {
          if (event.origin !== previewOrigin || event.source !== view ||
            event.data?.type !== 'fixture-only-target' || event.data.caller !== caller) return;
          window.removeEventListener('message',listener);
          clearTimeout(timer);
          resolve(event.data.target);
        };
        window.addEventListener('message',listener);
        view.postMessage({type:'fixture-only-mint',caller},previewOrigin);
      });
      return {
        secureContext:isSecureContext,
        childDocumentAccessDenied,
        available:[typeof navigator.mediaDevices?.getDisplayMedia,
          typeof BrowserCaptureMediaStreamTrack?.prototype?.restrictTo],
        exactFrameToken:exactFrameToken instanceof RestrictionTarget,
        crossOriginChildToken:childTarget instanceof RestrictionTarget,
        jsonRepresentation:JSON.stringify(childTarget),
      };
    })()`,
    contextId:executionContextId,awaitPromise:true,returnByValue:true,
  });
  assert.equal(exceptionDetails,undefined);
  assert.deepEqual(result.value,{secureContext:true,childDocumentAccessDenied:true,
    available:['function','function'],exactFrameToken:true,crossOriginChildToken:true,jsonRepresentation:'{}'});
  assert.deepEqual(outbound,[]);
  console.log(JSON.stringify({chromium:browser.version(),observed:result.value,outbound,
    displayChooserOpened:false,pixelsSampled:false},null,2));
} finally {
  await browser.close();
}
