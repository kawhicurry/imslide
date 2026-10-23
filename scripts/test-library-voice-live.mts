// Real configured model, isolated files, cumulative voice transcripts. No microphone capture.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { serve, type CoreEvent } from '../imslide.ts';
const out=resolve('.data/library-voice-live');await mkdir(out,{recursive:true});
await rm(resolve(out,'.imslide'),{recursive:true,force:true});await rm(resolve(out,'slides.md'),{force:true});
const original=await readFile('slides/slides.md','utf8'),events:CoreEvent[]=[];
const runtime=await serve({file:resolve(out,'slides.md'),onEvent:e=>events.push(e)},0);
if(!runtime.server.listening)await once(runtime.server,'listening');
const session=randomUUID();let text='',seq=0;
async function say(addition:string){text+=addition;runtime.core.ingestVoice({session,seq:seq++,start:0,end:seq*5,raw:text,endpoint:true,snapshot:true,source:'volc-stream'});await runtime.core.waitForIdle();}
try{
  await say('新建一份文稿，名称叫语音库验收。');
  const item=runtime.core.workspace().decks.find(d=>d.title==='语音库验收');assert.ok(item,'created named document');
  await say('打开刚刚创建的语音库验收文稿，把第一页标题和内容都设为测试成功，然后再新增一页，标题和内容都设为第二页。');
  assert.equal(runtime.core.workspace().activeDeckId,item.id);assert.equal(runtime.core.workspace().mode,'preview');
  assert.equal(runtime.core.snapshot().pages.length,2);assert.match(runtime.core.snapshot().pages[0].content,/测试成功/);
  await say('切换到演示模式，回到第一页，再下一页。');
  assert.equal(runtime.core.workspace().mode,'presentation');assert.equal(runtime.core.snapshot().current,1);assert.equal(runtime.core.snapshot().pages.length,2);
  await say('返回文稿管理页，把语音库验收重命名为验收完成。');
  assert.equal(runtime.core.workspace().mode,'management');assert.ok(runtime.core.workspace().decks.some(d=>d.id===item.id && d.title==='验收完成'));
  const steps=events.filter(e=>e.type==='model-step' && e.phase==='start').length;
  const requests=events.filter(e=>e.type==='model-request').length;
  assert.equal(requests,steps,'one physical request per model round');
  assert.ok(!events.some(e=>e.type==='error'));assert.equal(await readFile('slides/slides.md','utf8'),original);
  const result={passed:true,utterances:seq,modelRounds:steps,physicalRequests:requests,tools:events.filter(e=>e.type==='tool').map(e=>e.name),workspace:runtime.core.workspace(),unchangedOriginal:true};
  await writeFile(resolve(out,'result.json'),JSON.stringify(result,null,2));console.log(result);
}finally{await runtime.core.close();runtime.server.closeAllConnections();await new Promise<void>(r=>runtime.server.close(()=>r()));}
