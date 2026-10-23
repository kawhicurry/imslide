// Native Vue thumbnail mounting/performance. Slow/failing resources are tested
// through the real compiler by scripts/test-vue-workspace.mts.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1200,height:800}}),errors=[];
page.on('pageerror',error=>errors.push(error.message));const out='.data/thumbnail-check';await mkdir(out,{recursive:true});
try{
 await page.route('**/__thumbnail-test',route=>route.fulfill({contentType:'text/html',body:'<div id="root"></div><script type="module" src="/tests/fixtures/thumbnail-preview.ts"></script>'}));
 await page.goto(`${process.env.THUMBNAIL_TEST_URL || 'http://127.0.0.1:5173'}/__thumbnail-test`);
 const visible=id=>page.locator(`.thumbnail .slide-surface[data-snapshot="${id}"]`);
 await visible('0:0').waitFor();
 assert.equal(await visible('0:0').locator('#slide-content').evaluate(el=>el.clientWidth),980);
 assert.equal(await visible('0:0').locator('#slide-content').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(25, 61, 103)');
 await page.evaluate(()=>{for(let r=1;r<=25;r++)window.replaceThumbnail(0,r);});await visible('0:25').waitFor();
 const before=await page.locator('.thumbnail .slide-surface').count();assert.ok(before<=9);
 await page.evaluate(()=>{window.longTasks=[];new PerformanceObserver(list=>window.longTasks.push(...list.getEntries().map(e=>e.duration))).observe({type:'longtask'});});
 for(let i=0;i<40;i++){await page.locator('.page-list').evaluate((el,n)=>el.scrollTop=n*180,i);await page.waitForTimeout(20);}
 await visible('59:0').waitFor();const after=await page.locator('.thumbnail .slide-surface').count();assert.ok(after<=9);assert.equal(await visible('0:25').count(),0);
 await page.locator('.page-list').evaluate(el=>el.scrollTop=0);await visible('0:25').waitFor();
 assert.equal(await page.locator('iframe').count(),0);assert.deepEqual(errors,[]);
 const result={passed:true,surfacesBefore:before,surfacesAfter:after,longTasks:await page.evaluate(()=>window.longTasks),errors};await writeFile(`${out}/result.json`,JSON.stringify(result,null,2));console.log(result);
}finally{await browser.close();}
