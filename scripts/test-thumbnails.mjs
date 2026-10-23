// Run against npm run dev:web. No backend writes; fixtures only.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const browser = await chromium.launch({headless:true});
const page = await browser.newPage({viewport:{width:1200,height:800}});
const errors=[];page.on('pageerror', e=>errors.push(e.message));
const out='.data/thumbnail-check';await mkdir(out,{recursive:true});
try {
  await page.route('**/__thumbnail-test', route=>route.fulfill({contentType:'text/html',body:'<div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;window.__vite_plugin_react_preamble_installed__=true;await import("/tests/fixtures/thumbnail-preview.tsx");</script>'}));
  await page.goto(`${process.env.THUMBNAIL_TEST_URL || 'http://127.0.0.1:5173'}/__thumbnail-test`);
  const visible = snapshot => page.locator(`.thumbnail iframe[data-snapshot="${snapshot}"][aria-hidden="false"]`);
  await visible('0:0').waitFor();
  assert.equal(await visible('0:0').evaluate(f=>f.contentWindow.innerWidth),980);
  assert.equal(await visible('0:0').evaluate(f=>f.contentWindow.getComputedStyle(f.contentDocument.querySelector('#slide-content')).backgroundColor),'rgb(25, 61, 103)');
  let release; const gate = new Promise(resolve=>release=resolve);
  await page.route('**/__slow.svg',async route=>{await gate;await route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="yellow"/></svg>'});});
  await page.evaluate(()=>window.replaceThumbnail(0,1,'/__slow.svg'));
  await page.locator('.thumbnail iframe[data-snapshot="0:1"]').waitFor({state:'attached'});
  assert.equal(await visible('0:0').count(),1);assert.equal(await visible('0:1').count(),0);
  release();await visible('0:1').waitFor();assert.equal(await visible('0:0').count(),0);
  await page.route('**/__broken.png',route=>route.fulfill({status:404,body:'missing'}));
  await page.evaluate(()=>window.replaceThumbnail(0,2,'/__broken.png'));
  await page.waitForTimeout(1200);assert.equal(await visible('0:1').count(),1);
  await page.evaluate(()=>{for(let r=3;r<=25;r++)window.replaceThumbnail(0,r);});
  await visible('0:25').waitFor();
  await page.screenshot({path:`${out}/fixture.png`});
  const before=await page.locator('.thumbnail iframe').count(); assert.ok(before<=9,`bounded frames: ${before}`);
  await page.evaluate(()=>{window.longTasks=[];new PerformanceObserver(list=>window.longTasks.push(...list.getEntries().map(e=>e.duration))).observe({type:'longtask',buffered:false});});
  for (let i=0;i<40;i++) { await page.locator('.page-list').evaluate((el,i)=>el.scrollTop=i*180,i); await page.waitForTimeout(20); }
  await visible('59:0').waitFor();
  const after=await page.locator('.thumbnail iframe').count();assert.ok(after<=9);assert.equal(await visible('0:25').count(),0);
  await page.locator('.page-list').evaluate(el=>el.scrollTop=0);await visible('0:25').waitFor();
  const longTasks=await page.evaluate(()=>window.longTasks);
  assert.deepEqual(errors,[]);
  const result={passed:true,framesBefore:before,framesAfter:after,longTasks,checks:['980px viewport','styles preserved','old image while loading','failure retains old','latest update wins','60-page bounded mounting','scroll away and return']};
  await writeFile(`${out}/result.json`,JSON.stringify(result,null,2));console.log(result);
} finally {await browser.close();}
