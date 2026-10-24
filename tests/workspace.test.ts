import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createOpenAI } from '@ai-sdk/openai';
import { ImSlide, initialDeck, renderDeck, serve, type CoreEvent } from '../imslide.ts';
import { checkMode, workspaceActions, WorkspaceError, type WorkspaceAction } from '../src/workspace-contract.ts';
import { renderEntry } from '../src/deck-library.ts';
const context=(core:ImSlide)=>({deckId:core.workspace().activeDeckId,workspaceRevision:core.workspace().workspaceRevision});
function reply(res:ServerResponse,name:string,input:unknown) {
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const chunk=(delta:unknown,finish_reason:string|null)=>`data: ${JSON.stringify({id:'test',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason}]})}\n\n`;
  res.write(chunk({role:'assistant',tool_calls:[{index:0,id:randomUUID(),type:'function',function:{name,arguments:JSON.stringify(input)}}]},null));
  res.end(chunk({},'tool_calls')+'data: [DONE]\n\n');
}
async function fixture() {
  const dir=await mkdtemp(join(tmpdir(),'imslide-library-')),file=join(dir,'slides.md');
  const original=renderDeck(initialDeck());await writeFile(file,original);
  const queue:Array<{name:string;input:any}>=[],requests:any[]=[],events:CoreEvent[]=[];
  let intercept:((res:ServerResponse)=>Promise<void>)|undefined;
  const model=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;requests.push(JSON.parse(body));if(intercept){const f=intercept;intercept=undefined;await f(res);return;}const call=queue.shift() || {name:'finish',input:{}};reply(res,call.name,call.input);});
  model.listen(0,'127.0.0.1');await once(model,'listening');
  const runtime=await serve({file,model:createOpenAI({apiKey:'fixture',baseURL:`http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`}).chat('fixture'),onEvent:event=>events.push(event)},0);
  if(!runtime.server.listening)await once(runtime.server,'listening');
  return {...runtime,file,dir,original,requests,events,queue,intercept:(f:(res:ServerResponse)=>Promise<void>)=>intercept=f,base:`http://127.0.0.1:${(runtime.server.address() as AddressInfo).port}`,
    async run(name:string,input:any,voice=false){queue.push({name,input});if(voice)runtime.core.ingestVoice({session:randomUUID(),seq:0,start:0,end:2,raw:'执行当前完整要求',endpoint:true});else runtime.core.steer('执行当前完整要求',randomUUID());await runtime.core.waitForIdle();},
    async close(){await runtime.core.close();runtime.server.closeAllConnections();await new Promise<void>(r=>runtime.server.close(()=>r()));model.closeAllConnections();await new Promise<void>(r=>model.close(()=>r()));await rm(dir,{recursive:true,force:true});}};
}
test('permission matrix covers all tools and navigation actions',()=>{
  const expected:Record<string,string[]>={get_workspace:['management','preview','presentation'],switch_mode:['management','preview','presentation'],finish:['management','preview','presentation'],apply_voice:['management','preview','presentation'],read_page:['preview','presentation'],update_page:['preview'],edit_page:['preview'],delete_page:['preview']};
  for(const schema of workspaceActions)expected[schema.shape.tool.value] ||= ['management'];
  for(const mode of ['management','preview','presentation'] as const) {
    for(const [tool,allowed] of Object.entries(expected)) {
      if(allowed.includes(mode))assert.doesNotThrow(()=>checkMode(mode,tool));
      else assert.throws(()=>checkMode(mode,tool),(e:any)=>e.code==='TOOL_UNAVAILABLE_IN_MODE' && e.details.currentMode===mode);
    }
    for(const action of ['next','previous','goto','add']) {
      const allowed=mode==='preview' || mode==='presentation' && action!=='add';
      if(allowed)assert.doesNotThrow(()=>checkMode(mode,'navigate',{action}));else assert.throws(()=>checkMode(mode,'navigate',{action}),WorkspaceError);
    }
  }
});
test('library preserves source, duplicates IDs, soft deletes, restores and persists selection',async()=>{
  const f=await fixture();try {
    assert.equal(f.core.workspace().mode,'management');assert.equal(await readFile(f.file,'utf8'),f.original);
    const first=f.core.workspace().activeDeckId!;
    const created=await f.core.workspaceAction({tool:'create_deck',title:'文稿'});const id=created.deckId!;
    await f.core.workspaceAction({tool:'rename_deck',deckId:first,title:'文稿'});
    const list=await f.core.workspaceAction({tool:'list_decks',query:'文稿',deleted:false});assert.equal(list.decks!.length,2);
    await f.core.workspaceAction({tool:'open_deck',deckId:id});
    await f.run('navigate',{action:'add',done:true});
    assert.equal(f.core.snapshot().pages.length,2);
    await f.core.workspaceAction({tool:'switch_mode',mode:'management'});
    const duplicate=await f.core.workspaceAction({tool:'duplicate_deck',deckId:id});
    const oldIds=f.core.snapshot().pages.map(p=>p.id);
    await f.core.workspaceAction({tool:'open_deck',deckId:duplicate.deckId!});
    assert.equal(f.core.snapshot().pages.length,2);assert.ok(f.core.snapshot().pages.every(p=>!oldIds.includes(p.id)));
    await f.core.selectPage(f.core.snapshot().pages[1].id,context(f.core));
    const restored=await ImSlide.open({file:f.file,library:true});assert.equal(restored.workspace().mode,'preview');assert.equal(restored.snapshot().current,1);await restored.close();
    await f.core.workspaceAction({tool:'switch_mode',mode:'management'});
    for(const item of f.core.workspace().decks)await f.core.workspaceAction({tool:'delete_deck',deckId:item.id});
    assert.equal(f.core.workspace().activeDeckId,null);
    await assert.rejects(f.core.workspaceAction({tool:'switch_mode',mode:'preview'}),(e:any)=>e.code==='NO_ACTIVE_DECK');
    await f.core.workspaceAction({tool:'restore_deck',deckId:id});await f.core.workspaceAction({tool:'open_deck',deckId:id});assert.equal(f.core.snapshot().pages.length,2);
    assert.equal(await readFile(f.file,'utf8'),f.original);
    assert.match(await readFile(renderEntry(f.file),'utf8'),new RegExp(id));
  }finally{await f.close();}
});
test('same full schemas for text and voice in all modes; incompatible tools never mutate',async()=>{
  const f=await fixture();try {
    const schemas:string[]=[];
    for(const mode of ['management','preview','presentation'] as const){
      await f.core.workspaceAction({tool:'switch_mode',mode});
      for(const voice of [false,true]) {
        const before=f.requests.length;await f.run('finish',{},voice);
        schemas.push(JSON.stringify(f.requests[before].tools));
      }
    }
    assert.ok(schemas.every(s=>s===schemas[0]));
    const names=JSON.parse(schemas[0]).map((t:any)=>t.function.name);
    for(const name of ['apply_voice','read_page','update_page','edit_page','delete_page','navigate','finish',...workspaceActions.map(s=>s.shape.tool.value)])assert.ok(names.includes(name));
    const before=JSON.stringify(f.core.snapshot()),raw=await readFile(f.file,'utf8');
    await f.run('update_page',{title:'forbidden',content:'# forbidden',layout:'default',done:true});
    assert.equal(JSON.stringify(f.core.snapshot()),before);assert.equal(await readFile(f.file,'utf8'),raw);
    assert.ok(f.events.some(e=>e.type==='tool-result' && (e.output as any)?.code==='TOOL_UNAVAILABLE_IN_MODE'));
    await f.run('navigate',{action:'next',done:true});assert.equal(f.core.snapshot().pages.length,1);
    const result=await fetch(f.base+'/api/workspace/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:{tool:'create_deck',title:'bypass'},context:context(f.core)})});assert.equal(result.status,409);assert.equal((await result.json()).code,'TOOL_UNAVAILABLE_IN_MODE');
    await f.core.workspaceAction({tool:'switch_mode',mode:'management'});
    const view=await fetch(f.base+'/api/view',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pageId:f.core.snapshot().pages[0].id,...context(f.core)})});assert.equal(view.status,409);assert.equal((await view.json()).code,'TOOL_UNAVAILABLE_IN_MODE');
  }finally{await f.close();}
});
test('voice batches traverse modes in order, stop on unavailable action, and retain completed steps',async()=>{
  const f=await fixture();try {
    await f.run('apply_voice',{completed:[{actions:[{tool:'create_deck',title:'语音文稿'}]}]},true);
    const created=f.core.workspace().decks.find(d=>d.title==='语音文稿')!;
    const actions=[{tool:'open_deck',deckId:created.id},{tool:'update_page',title:'语音内容',content:'# 语音内容',layout:'center'},{tool:'navigate',action:'add'},{tool:'switch_mode',mode:'presentation'},{tool:'navigate',action:'previous'},{tool:'switch_mode',mode:'management'}];
    const count=f.requests.length;await f.run('apply_voice',{completed:[{actions}]},true);
    assert.equal(f.requests.length-count,1);assert.equal(f.core.workspace().mode,'management');assert.equal(f.core.snapshot().pages[0].title,'语音内容');assert.equal(f.core.snapshot().current,0);
    await f.run('apply_voice',{completed:[{actions:[{tool:'create_deck',title:'保留成功'},{tool:'update_page',title:'禁止',content:'# 禁止',layout:'default'},{tool:'create_deck',title:'不能执行'}]}]},true);
    assert.equal(f.core.workspace().decks.filter(d=>d.title==='保留成功').length,1);assert.ok(!f.core.workspace().decks.some(d=>d.title==='不能执行'));
    const failure=f.events.find(e=>e.type==='tool-result' && e.name==='apply_voice' && (e.output as any)?.ok===false) as any;
    assert.equal(failure.output.results.length,2);assert.equal(failure.output.results[1].output.code,'TOOL_UNAVAILABLE_IN_MODE');
  }finally{await f.close();}
});
test('delayed model writes cannot cross document or mode changes; HTTP rejects stale contexts',async()=>{
  const f=await fixture();let release!:()=>void;try {
    const a=f.core.workspace().activeDeckId!;const b=(await f.core.workspaceAction({tool:'create_deck',title:'B'})).deckId!;
    await f.core.workspaceAction({tool:'open_deck',deckId:a});const old=context(f.core);
    let started!:()=>void;const start=new Promise<void>(r=>started=r),gate=new Promise<void>(r=>release=r);
    f.intercept(async res=>{started();await gate;reply(res,'update_page',{title:'旧命令',content:'# 旧命令',layout:'center',done:true});});
    f.core.steer('延迟修改',randomUUID());await start;
    await f.core.workspaceAction({tool:'switch_mode',mode:'management'});await f.core.workspaceAction({tool:'open_deck',deckId:b});release();await f.core.waitForIdle();
    assert.equal(f.core.snapshot().pages[0].content,'');assert.equal(await readFile(f.file,'utf8'),f.original);assert.ok(f.events.some(e=>e.type==='error' && e.error.includes('工作区已切换')));
    const res=await fetch(f.base+'/api/view',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pageId:f.core.snapshot().pages[0].id,...old})});assert.equal(res.status,409);assert.equal((await res.json()).code,'STALE_WORKSPACE');
  }finally{release?.();await f.close();}
});

test('legacy Markdown without IDs is preserved and its normalized copy has stable identity',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'imslide-legacy-')),file=join(dir,'old.md');
  const original='# 原文\n\n保留原始排版\n';await writeFile(file,original);
  try {
    const first=await ImSlide.open({file,library:true}),id=first.snapshot().pages[0].id;
    assert.equal(await readFile(file,'utf8'),original);await first.close();
    const second=await ImSlide.open({file,library:true});assert.equal(second.snapshot().pages[0].id,id);assert.equal(await readFile(file,'utf8'),original);await second.close();
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('all presentation styles survive copy/reopen and reach text and voice model context',async()=>{
  const {presentationStyles}=await import('../src/presentation-styles.ts');
  const f=await fixture();try {
    assert.equal(f.core.workspace().decks[0].style,undefined);
    for(const style of Object.keys(presentationStyles) as Array<keyof typeof presentationStyles>) {
      const created=await f.core.workspaceAction({tool:'create_deck',title:style,style});
      const copied=await f.core.workspaceAction({tool:'duplicate_deck',deckId:created.deckId!});
      assert.equal(f.core.workspace().decks.find(d=>d.id===copied.deckId)?.style,style);
      await f.core.workspaceAction({tool:'open_deck',deckId:created.deckId!});
      const reopened=await ImSlide.open({file:f.file,library:true});
      assert.equal(reopened.workspace().decks.find(d=>d.id===created.deckId)?.style,style);await reopened.close();
      for(const voice of [false,true]) {
        const before=f.requests.length;
        await f.run('finish',{},voice);
        assert.equal(f.requests.length-before,1);
        const messages=f.requests.at(-1).messages.map((message:{content:string})=>message.content).join('\n');
        assert.ok(messages.includes(JSON.stringify(presentationStyles[style].prompt).slice(1,-1)));
        assert.ok(messages.includes('designGuidance'));
        const {layoutRhythm}=await import('../src/presentation-layouts.ts');
        assert.ok(messages.includes(layoutRhythm),'text and voice both receive layout rhythm rules');
        assert.ok(messages.includes('代码＋解释'));
        assert.ok(messages.includes('公式／方法＋结果'));
      }
      await f.core.workspaceAction({tool:'switch_mode',mode:'management'});
    }
    const before=JSON.stringify(f.core.workspace());
    await assert.rejects(f.core.workspaceAction({tool:'create_deck',title:'bad',style:'unknown'} as any));
    assert.equal(JSON.stringify(f.core.workspace()),before);
  }finally{await f.close();}
});
