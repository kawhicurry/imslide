// Opt-in real model acceptance; isolated library, no writes to the user's deck.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import type { AddressInfo } from 'node:net';
import { serve, type CoreEvent } from '../imslide.ts';
import { presentationStyles, styleIds } from '../src/presentation-styles.ts';
const out=resolve('.data/presentation-styles-live');await mkdir(out,{recursive:true});
if(!process.env.STYLE_RENDER_ONLY)await rm(resolve(out,'.imslide'),{recursive:true,force:true});if(!process.env.STYLE_RENDER_ONLY)await rm(resolve(out,'slides.md'),{force:true});
const original=await readFile('slides/slides.md','utf8'),events:CoreEvent[]=[];
const runtime=await serve({file:resolve(out,'slides.md'),onEvent:e=>events.push(e)},0);
if(!runtime.server.listening)await once(runtime.server,'listening');
const results=[];
try {
  for(const style of process.env.STYLE_RENDER_ONLY ? [] : styleIds){
    await runtime.core.workspaceAction({tool:'switch_mode',mode:'management'});
    const created=await runtime.core.workspaceAction({tool:'create_deck',title:presentationStyles[style].label,style});
    await runtime.core.workspaceAction({tool:'open_deck',deckId:created.deckId!});
    const start=events.length;
    runtime.core.steer('请按当前文稿风格制作一页演示，整体排版并写出可见标题。主题：让知识更容易被找到。资料：团队文档分散在三个系统；计划用统一检索减少查找步骤；尚无实验数据。只生成当前页，不新增。表达现状、方案、验证计划，不编造数值；用局部静态CSS体现风格。');
    await runtime.core.waitForIdle();
    const recent=events.slice(start);
    assert.ok(!recent.some(e=>e.type==='error'),JSON.stringify(recent.filter(e=>e.type==='error')));
    const deck=runtime.core.snapshot();assert.ok(deck.pages[0].content.length>80);assert.equal(deck.pages.length,1);
    results.push({style,deck,modelRequests:recent.filter(e=>e.type==='model-request').length});
    await writeFile(resolve(out,'samples.json'),JSON.stringify(results,null,2));
    console.log(`${style}: ${deck.pages[0].content.length} chars`);
  }
  process.env.PORT=String((runtime.server.address() as AddressInfo).port);
  process.env.SLIDES_FILE=resolve(out,'slides.md');process.env.WEB_PORT='5373';
  const vite=await createServer({server:{port:5373,strictPort:true}});await vite.listen();
  const {chromium}=await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors:string[]=[];
    page.on('pageerror',(error:Error)=>errors.push(error.message));
    await page.goto('http://127.0.0.1:5373');
    for(const style of styleIds){
      const item=runtime.core.workspace().decks.find(d=>d.style===style)!;assert.ok(item);
      await runtime.core.workspaceAction({tool:'switch_mode',mode:'management'});
      await runtime.core.workspaceAction({tool:'open_deck',deckId:item.id});
      const id=runtime.core.snapshot().pages[0].id;
      const surface=page.locator(`.slide-frame .slide-surface[data-page-id="${id}"]`);
      await surface.locator('.snapshot-viewport').waitFor({timeout:30000});
      if(style==='technology') {
        const canvas=surface.locator('.tech-canvas');await canvas.waitFor();
        const coverage=await canvas.evaluate((el:HTMLElement)=>{
          const a=el.getBoundingClientRect(),b=el.closest('.snapshot-viewport')!.getBoundingClientRect();
          return {background:getComputedStyle(el).backgroundColor,radius:getComputedStyle(el).borderRadius,
            edges:[a.left-b.left,a.top-b.top,a.right-b.right,a.bottom-b.bottom]};
        });
        assert.equal(coverage.background,'rgb(11, 18, 32)');assert.equal(coverage.radius,'0px');
        assert.ok(coverage.edges.every((edge:number)=>Math.abs(edge)<1),'technology background covers the entire canvas');
      }
      await surface.screenshot({path:resolve(out,`${style}.png`)});
      const overflow=await surface.locator('.snapshot-viewport').evaluate((el:HTMLElement)=>{
        const bounds=el.getBoundingClientRect(),walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT),bad:string[]=[];
        for(let n=walker.nextNode();n;n=walker.nextNode()){
          if(!n.textContent?.trim() || n.parentElement?.closest('style,script'))continue;
          const range=document.createRange();range.selectNodeContents(n);
          for(const rect of range.getClientRects())if(rect.width && (rect.bottom>bounds.bottom+2 || rect.right>bounds.right+2 || rect.left<bounds.left-2 || rect.top<bounds.top-2)){bad.push(n.textContent!.trim().slice(0,40));break;}
        }return bad;
      });
      assert.deepEqual(overflow,[],`${style}: text outside slide`);
      assert.ok((await surface.locator('.snapshot-viewport').innerText()).length>20);
    }
    assert.deepEqual(errors,[]);
    await writeFile(resolve(out,'render-result.json'),JSON.stringify({passed:true,styles:styleIds,errors},null,2));
  }finally{await browser.close();await vite.close();}
  assert.equal(await readFile('slides/slides.md','utf8'),original);
}finally{await runtime.core.close();runtime.server.closeAllConnections();await new Promise<void>(r=>runtime.server.close(()=>r()));}
