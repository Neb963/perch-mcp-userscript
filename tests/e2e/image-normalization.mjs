/** Optional installed-browser QA; generates original pixels locally and never contacts a provider. */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
const { chromium, firefox } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core');
const engine = process.env.BROWSER_ENGINE === 'firefox' ? firefox : chromium;
if (!process.env.BROWSER_EXECUTABLE) throw new Error('Set BROWSER_EXECUTABLE to an installed browser.');
const bundle = await build({ stdin: { contents: 'export {readImage} from "./apps/userscript/src/runtime-tools.ts";', resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife', globalName: 'perchImageTest', platform: 'browser', logLevel: 'silent' });
const browser = await engine.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE, ...(process.env.BROWSER_ENGINE === 'firefox' ? {} : { args: ['--no-sandbox', '--disable-dev-shm-usage'] }) });
try {
  const page = await browser.newPage();
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const result = await page.evaluate(async () => {
    const encode = async canvas => new Uint8Array(await (await canvas.convertToBlob({type:'image/png'})).arrayBuffer());
    const canvas = new OffscreenCanvas(8,8), context = canvas.getContext('2d');
    context.fillStyle = 'rgba(255,0,0,0.5)'; context.fillRect(0,0,8,8);
    const original = await encode(canvas), normalized = await perchImageTest.readImage(original, 'scratch/alpha.png');
    const raw = atob(normalized.content[0].data), data = Uint8Array.from(raw,c=>c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([data],{type:'image/png'}));
    const decoded = new OffscreenCanvas(8,8), pixels = decoded.getContext('2d'); pixels.drawImage(bitmap,0,0); bitmap.close();
    const sample = [...pixels.getImageData(0,0,1,1).data];
    const noise = new OffscreenCanvas(1024,1024), noiseContext = noise.getContext('2d'), image = noiseContext.createImageData(1024,1024);
    let seed = 123456789;
    for(let i=0;i<image.data.length;i+=4) {
      for(let c=0;c<3;c++){ seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; image.data[i+c]=seed & 255; }
      image.data[i+3]=255;
    }
    noiseContext.putImageData(image,0,0);
    const noiseInput = await encode(noise), reduced = await perchImageTest.readImage(noiseInput,'scratch/noise.png');
    let corruptCode;
    try { await perchImageTest.readImage(new Uint8Array([1,2,3]),'scratch/corrupt.png'); } catch(error) { corruptCode=error.code; }
    return {sample, small:{width:normalized.width,height:normalized.height}, noisy:{originalBytes:noiseInput.length,width:reduced.width,height:reduced.height,resultBytes:atob(reduced.content[0].data).length},corruptCode};
  });
  assert.deepEqual(result.small,{width:8,height:8});
  assert.equal(result.sample[0],255); assert.equal(result.sample[1],0); assert.equal(result.sample[2],0); assert.ok(result.sample[3]>=127 && result.sample[3]<=128);
  assert.ok(result.noisy.originalBytes>1024*1024); assert.ok(result.noisy.width<1024); assert.ok(result.noisy.resultBytes<=1024*1024);
  assert.equal(result.corruptCode,'INVALID_INPUT');
  console.log(JSON.stringify({tier:'T2 locally generated pixels; no native/provider evidence',browserVersion:browser.version(),...result},null,2));
} finally { await browser.close(); }
