// Actual backend + Slidev compiler + Chromium; deterministic model fixture.
// All mutations use a separate document. No edits to slides/slides.md.
import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import { createServer } from 'vite';
import { createOpenAI } from '@ai-sdk/openai';
import { serve, renderDeck, type Deck } from '../imslide.ts';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const out=resolve('.data/vue-integration');await mkdir(out,{recursive:true});
const original=await readFile('slides/slides.md','utf8');
const file=resolve(out,'slides.md');
const deck:Deck={revision:0,current:0,pages:Array.from({length:60},(_,i)=>({id:`test-${i}`,title:`Page ${i+1}`,layout:i%2?'two-cols':'center',content:i%2?`# Page ${i+1}\n\nLeft\n\n::right::\n\nRight`:`# Page ${i+1}\n\nNative Vue slide\n\n<style>h1{color:#173f76}:global(.brand){color:red!important}</style>`}))};
await rm(resolve(out,'.imslide'),{recursive:true,force:true});
await writeFile(file,renderDeck(deck));
let nextTool:{name:string;args:Record<string,unknown>}|undefined;
const model=httpServer(async(req,res)=>{for await(const _ of req){} const action=nextTool || {name:'finish',args:{}};nextTool=undefined;
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const chunk=(delta:unknown,finish_reason:string|null)=>`data: ${JSON.stringify({id:'test',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason}]})}\n\n`;
  res.write(chunk({role:'assistant',tool_calls:[{index:0,id:crypto.randomUUID(),type:'function',function:{name:action.name,arguments:JSON.stringify(action.args)}}]},null));res.end(chunk({},'tool_calls')+'data: [DONE]\n\n');
});model.listen(0,'127.0.0.1');await once(model,'listening');
const runtime=await serve({file,model:createOpenAI({apiKey:'fixture-only',baseURL:`http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`}).chat('fixture')},0);
if(!runtime.server.listening)await once(runtime.server,'listening');
process.env.PORT=String((runtime.server.address() as AddressInfo).port);process.env.SLIDES_FILE=file;process.env.WEB_PORT='5273';
const vite=await createServer({server:{port:5273,strictPort:true}});await vite.listen();
const browser=await chromium.launch({headless:true,args:['--autoplay-policy=no-user-gesture-required']});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors:string[]=[];
page.on('pageerror',(error:Error)=>errors.push(error.message));
const main=page.locator('.slide-frame .slide-surface');
const checks:string[]=[];
async function mutate(name:string,args:Record<string,unknown>){nextTool={name,args:{...args,done:true}};runtime.core.steer(`验收 ${crypto.randomUUID()}`);await runtime.core.waitForIdle();}
async function content(text:string){await main.filter({hasText:text}).waitFor({timeout:30000});}
try{
  await page.route('**/api/text/paragraphs',async(route:any)=>{const body=route.request().postDataJSON();await route.fulfill({json:{text:body.text,breakBefore:true}});});
  await page.goto('http://127.0.0.1:5273');await page.getByRole('button',{name:'打开文稿：slides',exact:true}).click();await content('Page 1');
  assert.equal(await page.locator('iframe').count(),0);
  assert.notEqual(await page.locator('.brand').evaluate((el:HTMLElement)=>getComputedStyle(el).color),'rgb(255, 0, 0)');
  await page.waitForFunction(()=>{const app=document.getElementById('root')!.shadowRoot!;return app.querySelector('.selected .slide-surface')?.getAttribute('data-snapshot')===app.querySelector('.slide-frame .slide-surface')?.getAttribute('data-snapshot');});
  checks.push('native Vue rendering; no iframe; same snapshot; workspace CSS isolation');
  await page.getByRole('button',{name:'查看下一页',exact:true}).click();await content('Page 2');await main.locator('.col-right').waitFor();
  await page.keyboard.press('ArrowLeft');await content('Page 1');checks.push('button and keyboard navigation; two-column layout');
  await page.getByRole('button',{name:'切换到文字输入'}).click();
  await page.getByRole('textbox',{name:'输入文字'}).fill('更新验收标题');
  nextTool={name:'update_page',args:{title:'Updated',content:'# Updated\n\nText command passed',layout:'center',done:true}};
  await page.getByRole('button',{name:'发送',exact:true}).click();await content('Updated');
  await page.locator('.tool-entry.tool-success').first().waitFor();checks.push('text submit, backend tools, SSE and HMR update');
  let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
  await page.route('**/__slow.svg',async(route:any)=>{await gate;await route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="yellow"/></svg>'});});
  await mutate('update_page',{title:'Slow',content:'# Slow\n\n<img src="http://127.0.0.1:5273/__slow.svg" />',layout:'center'});
  await page.waitForTimeout(1000);assert.ok((await main.locator('.snapshot-viewport').innerText()).includes('Updated'));release();await content('Slow');
  await page.route('**/__broken.png',(route:any)=>route.fulfill({status:404,body:'missing'}));
  await mutate('update_page',{title:'Broken',content:'# Broken\n\n<img src="http://127.0.0.1:5273/__broken.png" />',layout:'center'});
  await page.getByRole('alert').filter({hasText:'渲染失败'}).waitFor();assert.ok((await main.locator('.snapshot-viewport').innerText()).includes('Slow'));
  await mutate('update_page',{title:'Recovered',content:'# Recovered',layout:'center'});await content('Recovered');
  await page.getByRole('alert').filter({hasText:'渲染失败'}).waitFor({state:'detached'});checks.push('slow resources retain previous image; failed image and recovery');
  await mutate('update_page',{title:'Math',content:'# Math\n\n$$E=mc^2$$',layout:'center'});await content('Math');await main.locator('.katex').first().waitFor();
  await mutate('update_page',{title:'Diagram',content:'# Diagram\n\n```mermaid\ngraph LR\n A[输入]-->B[输出]\n```',layout:'center'});await content('Diagram');await main.locator('.mermaid svg.pele-flowchart').waitFor();
  await page.screenshot({path:resolve(out,'pele-flowchart.png')});
  for (const [type,source] of [['sequence','sequenceDiagram\n Alice->>Bob: Hello'],['pie','pie\n "A": 60\n "B": 40']]) {
    await mutate('update_page',{title:'Diagram',content:`# Diagram\n\n\`\`\`mermaid\n${source}\n\`\`\``,layout:'center'});
    await main.locator(`.mermaid svg.pele-${type}`).waitFor();
  }
  checks.push('Pele SVG snapshots: Chinese flowchart, sequence and pie');
  assert.equal(await page.locator('.live-document').innerText(),'更新验收标题');checks.push('math and diagram additions preserve session');
  for(let i=0;i<5;i++)await mutate('update_page',{title:`Latest ${i}`,content:`# Latest ${i}`,layout:'center'});
  await content('Latest 4');checks.push('rapid revision convergence');
  await mutate('delete_page',{pages:60});await mutate('navigate',{action:'add'});
  await page.waitForFunction(()=>document.getElementById('root')!.shadowRoot!.querySelector('.slide-frame .slide-surface')?.getAttribute('data-snapshot')?.startsWith('blank:'));
  assert.equal((await main.locator('.snapshot-viewport').innerText()).trim(),'');
  await mutate('update_page',{title:'Inserted',content:'# Inserted',layout:'center'});await content('Inserted');
  await mutate('delete_page',{pages:2});await content('Page 2');checks.push('blank creation, populate and delete selected page');
  assert.equal(await page.getByRole('navigation',{name:'工作区模式'}).count(),0);
  await page.getByRole('button',{name:'演示',exact:true}).click();await page.waitForFunction(()=>!!document.fullscreenElement);await page.locator('.left-workspace.presentation').waitFor();
  assert.ok(await main.evaluate((el:HTMLElement)=>el.getBoundingClientRect().width>=window.innerWidth-1));
  assert.equal(await page.locator('.chat-panel').count(),1);
  await page.evaluate(()=>document.exitFullscreen());await page.locator('.left-workspace.preview').waitFor();await page.waitForFunction(()=>!document.fullscreenElement);
  // Tool-driven transitions cannot invent a user gesture. Exercise the denied path.
  await page.evaluate(()=>{(window as any).originalFullscreen=Element.prototype.requestFullscreen;Element.prototype.requestFullscreen=()=>Promise.reject(new DOMException('User gesture required','NotAllowedError'));});
  await mutate('switch_mode',{mode:'presentation'});await page.getByRole('button',{name:'点击进入全屏演示',exact:true}).waitFor();assert.equal(await page.evaluate(()=>!!document.fullscreenElement),false);
  await page.evaluate(()=>{Element.prototype.requestFullscreen=(window as any).originalFullscreen;});
  await page.getByRole('button',{name:'点击进入全屏演示',exact:true}).click();await page.waitForFunction(()=>!!document.fullscreenElement);
  await page.keyboard.press('ArrowLeft');await content('Latest 4');await page.keyboard.press('ArrowRight');await content('Page 2');
  await mutate('switch_mode',{mode:'preview'});await page.waitForFunction(()=>!document.fullscreenElement);
  await page.waitForTimeout(200);checks.push('hidden mode navigation; native fullscreen; external exit sync; tool request denied then click succeeds; fullscreen navigation and tool exit');
  await page.evaluate(()=>{(window as any).longTasks=[];new PerformanceObserver(list=>(window as any).longTasks.push(...list.getEntries().map(e=>e.duration))).observe({type:'longtask'});});
  for(let i=0;i<40;i++){await page.locator('.page-list').evaluate((el:HTMLElement,n:number)=>el.scrollTop=n*210,i);await page.waitForTimeout(20);}
  await page.locator('.thumbnail .slide-surface[data-page-id="test-58"]').waitFor({timeout:30000});
  const surfaces=await page.locator('.thumbnail .slide-surface').count();assert.ok(surfaces>0 && surfaces<=9,`live thumbnails ${surfaces}`);
  const longTasks=await page.evaluate(()=>(window as any).longTasks);
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(300);
  await page.locator('.selected .thumbnail .slide-surface').waitFor({timeout:10000});
  assert.ok(await page.locator('.thumbnail .slide-surface').count() <= 5);
  assert.ok(await main.isVisible());assert.equal(await page.locator('iframe').count(),0);checks.push('bounded thumbnails, desktop scrolling, mobile layout');
  await page.screenshot({path:resolve(out,'mobile.png')});await page.getByRole('button',{name:'切换到语音输入'}).scrollIntoViewIfNeeded();assert.ok(await page.getByRole('button',{name:'切换到语音输入'}).isVisible());await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:resolve(out,'desktop.png')});
  // Multi-document flows use the real UI and compiler, with stable right-panel nodes.
  await page.getByRole('textbox',{name:'输入文字'}).fill('保留的输入草稿');
  await page.evaluate(()=>{const root=document.getElementById('root')!.shadowRoot!;(window as any).chatNode=root.querySelector('.chat-panel');(window as any).recordText=root.querySelector('.live-document')!.textContent;});
  const mode=(name:string)=>({click:async()=>{
    if(name==='演示') {await page.getByRole('button',{name:'演示',exact:true}).click();await page.waitForFunction(()=>!!document.fullscreenElement);}
    else {await runtime.core.workspaceAction({tool:'switch_mode',mode:name==='文稿管理'?'management':'preview'});await page.waitForFunction(()=>!document.fullscreenElement);}
  }});
  await mode('文稿管理').click();await page.getByRole('heading',{name:'我的文稿'}).waitFor();
  assert.equal(await page.getByRole('combobox',{name:'文稿风格'}).locator('option').count(),5);
  await page.getByRole('combobox',{name:'文稿风格'}).selectOption('technology');
  await page.screenshot({path:resolve(out,'style-selector.png')});
  await page.getByRole('textbox',{name:'新文稿名称'}).fill('第二份文稿');await page.getByRole('button',{name:'新建文稿',exact:true}).click();
  await page.locator('.deck-card').filter({hasText:'第二份文稿'}).getByText(/科技未来风/).waitFor();
  const card=page.locator('.deck-card').filter({has:page.getByRole('heading',{name:'第二份文稿',exact:true})});await card.waitFor();
  await card.getByRole('button',{name:'重命名',exact:true}).click();await page.getByRole('textbox',{name:'重命名文稿'}).fill('切换验收');await page.getByRole('button',{name:'保存',exact:true}).click();
  await page.getByRole('button',{name:'打开文稿：切换验收',exact:true}).click();
  await page.waitForFunction(()=>document.getElementById('root')!.shadowRoot!.querySelector('.left-workspace.preview'));
  assert.equal((await main.innerText()).trim(),'');
  await mutate('update_page',{title:'Document B',content:'# Document B',layout:'center'});await content('Document B');
  const b=runtime.core.workspace().activeDeckId!,a=runtime.core.workspace().decks.find(d=>d.title==='slides')!.id;
  await mode('文稿管理').click();
  const bCard=page.locator('.deck-card').filter({has:page.getByRole('heading',{name:'切换验收',exact:true})});
  await bCard.getByRole('button',{name:'复制',exact:true}).click();await page.getByRole('heading',{name:'切换验收 副本',exact:true}).waitFor();
  await bCard.getByRole('button',{name:'删除',exact:true}).click();await page.getByRole('button',{name:'回收站',exact:true}).click();
  await page.getByRole('button',{name:'恢复文稿',exact:true}).click();await page.getByRole('button',{name:'返回文稿',exact:true}).click();
  await page.getByRole('searchbox',{name:'搜索文稿'}).fill('不存在的名称');await page.getByText('没有匹配的文稿').waitFor();await page.getByRole('searchbox',{name:'搜索文稿'}).fill('');
  await page.locator('.deck-card .slide-surface').first().waitFor();
  await page.screenshot({path:resolve(out,'library.png')});
  await page.getByRole('button',{name:'打开文稿：切换验收',exact:true}).click();await content('Document B');
  let releaseCross!:()=>void;const crossGate=new Promise<void>(r=>releaseCross=r);
  await page.route('**/__cross.svg',async(route:any)=>{await crossGate;await route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/>'});});
  await mutate('update_page',{title:'Slow B',content:'# Slow B\n\n<img src="http://127.0.0.1:5273/__cross.svg"/>',layout:'center'});await page.waitForTimeout(300);
  await runtime.core.workspaceAction({tool:'switch_mode',mode:'management'});await runtime.core.workspaceAction({tool:'open_deck',deckId:a});releaseCross();await content('Page 2');
  assert.ok(!(await main.innerText()).includes('Slow B'));
  for(let i=0;i<4;i++){await runtime.core.workspaceAction({tool:'switch_mode',mode:'management'});await runtime.core.workspaceAction({tool:'open_deck',deckId:i%2?b:a});}
  await content('Slow B');
  assert.equal(await page.getByRole('textbox',{name:'输入文字'}).inputValue(),'保留的输入草稿');
  assert.ok(await page.evaluate(()=>{const root=document.getElementById('root')!.shadowRoot!;return root.querySelector('.chat-panel')===(window as any).chatNode && root.querySelector('.live-document')!.textContent===(window as any).recordText;}));
  await mode('演示').click();await page.locator('.left-workspace.presentation').waitFor();await page.screenshot({path:resolve(out,'presentation.png')});await page.keyboard.press('Escape');
  checks.push('library CRUD/search/recycle; independent document snapshots; rapid switching; stale slow render rejected; chat DOM and draft preserved');
  if(process.env.TEST_LIVE_ASR==='1') {
    let sockets=0;page.on('websocket',(socket:any)=>{if(socket.url().includes('/api/asr/stream'))sockets++;});
    await page.getByRole('button',{name:'切换到语音输入'}).click();
    await page.evaluate(()=>{const audio=new AudioContext({sampleRate:16000});const silence=audio.createMediaStreamDestination();(window as any).testAudio=audio;navigator.mediaDevices.getUserMedia=async()=>{await audio.resume();return silence.stream;};});
    await page.getByRole('button',{name:'开始语音输入',exact:true}).click();await page.getByRole('button',{name:'停止语音输入',exact:true}).waitFor({timeout:20000});
    for(const [name,css] of [['文稿管理','management'],['预览','preview'],['演示','presentation'],['文稿管理','management']]){await mode(name).click();await page.locator(`.left-workspace.${css}`).waitFor();await page.getByRole('button',{name:'停止语音输入',exact:true}).waitFor();}
    assert.equal(sockets,1);await page.getByRole('button',{name:'停止语音输入',exact:true}).click();await page.getByRole('button',{name:'开始语音输入',exact:true}).waitFor({timeout:20000});
    checks.push('real SeedASR silent stream stays connected through all three modes (one websocket)');
  }
  assert.deepEqual(errors,[]);assert.equal(await readFile('slides/slides.md','utf8'),original);
  const result={passed:true,checks,thumbnailSurfaces:surfaces,longTasks,allInteractionLongTasks:await page.evaluate(()=>(window as any).longTasks),errors};await writeFile(resolve(out,'result.json'),JSON.stringify(result,null,2));console.log(result);
}catch(error){await page.screenshot({path:resolve(out,'failure.png')});console.error('Browser errors',errors);throw error;}
finally{await browser.close();await vite.close();await runtime.core.close();runtime.server.closeAllConnections();runtime.server.close();model.closeAllConnections();model.close();}
