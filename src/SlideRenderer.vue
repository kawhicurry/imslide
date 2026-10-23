<script setup lang="ts">
/* @slidev-injection */ // Workspace components provide their own context.
import { markRaw, nextTick, onErrorCaptured, onMounted, onUnmounted, shallowRef, watch } from 'vue';
import type { NativeSlideRoute as SlideRoute } from './slidev-api';
import { configs, useNav } from '@slidev/client';
import SlideWrapper from '@slidev/client/internals/SlideWrapper.vue';
import { createFixedClicks } from '@slidev/client/composables/useClicks.ts';
import { slideHeight, slideWidth, themeVars } from '@slidev/client/env.ts';
import type { Deck } from '../imslide';
import type { CachedSlide } from './slide-types';
import { renderFailure, type RenderFailure } from './render-error';
import { slideSheets, slideReset } from './slide-styles';
import { blankSlide } from './blank-slide';
const props=defineProps<{deck:Deck}>();
const emit=defineEmits<{snapshot:[slide:CachedSlide];error:[error:RenderFailure]}>();
const nav=useNav(),host=shallowRef<HTMLElement>(),target=shallowRef<HTMLElement>();
const route=shallowRef<SlideRoute>(),clicks=createFixedClicks(undefined,999999);
const published=new Map<string,string>();
let shadow:ShadowRoot,observer:MutationObserver,generation=0,disposed=false,busy=false;
let timer:ReturnType<typeof setTimeout>|undefined;
let componentError:unknown;
const paint=()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
function schedule(){generation++;clearTimeout(timer);timer=setTimeout(()=>void publish(),80);}
onErrorCaptured(error=>{componentError=error;return false;});
async function bounded<T>(promise:Promise<T>) {
  let timeout:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new Error('页面资源加载超时')),20000);})]);}
  finally{clearTimeout(timeout);}
}
async function publish(){
  if(disposed || !shadow || busy)return;
  busy=true;
  const version=generation,deck=props.deck,revision=Number((configs as {imslide?:{revision:number}}).imslide?.revision || 0);
  const valid=()=>!disposed && version===generation;
  let failedPage:string|undefined;
  try{
    if(revision!==deck.revision || (configs as any).imslide?.deckId!==deck.deckId)return;
    const {imslide:_state,...visualConfig}=configs as typeof configs & {imslide?:unknown};
    const configKey=JSON.stringify(visualConfig);
    const ordered=[...nav.slides.value].sort((a,b)=>Number(b.meta.slide.frontmatter.imslideId===deck.pages[deck.current]?.id)-Number(a.meta.slide.frontmatter.imslideId===deck.pages[deck.current]?.id));
    for(const source of ordered){
      const id=String(source.meta.slide.frontmatter.imslideId),pageIndex=deck.pages.findIndex(page=>page.id===id);
      if(pageIndex<0)continue;
      const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(deck.pages[pageIndex])));
      const expected=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
      if(!valid())return;
      if(source.meta.slide.frontmatter.imslideContentKey!==expected)continue;
      const key=JSON.stringify([source.no,source.meta.slide.frontmatter.imslideContentKey,configKey]);
      if(published.get(id)===key)continue;
      failedPage=id;
      const blank=blankSlide(deck.pages[pageIndex],pageIndex,deck.pages.length,deck.revision);
      if(blank){emit('snapshot',{...blank,deckId:deck.deckId});published.set(id,key);continue;}
      const module=await bounded(source.load());
      if(!valid())return;
      if(!module || typeof module!=='object' || !('default' in module))throw new Error(`第 ${source.no} 页模块加载失败`);
      componentError=undefined;
      // Only this one Vue source tree is live; completed DOM is shared by surfaces.
      route.value=markRaw({...source,component:markRaw(module.default),meta:{...source.meta,slide:{...source.meta.slide,frontmatter:{...source.meta.slide.frontmatter}}}}) as SlideRoute;
      await nextTick();await paint();
      if(!valid())return;
      if(componentError)throw componentError;
      shadow.adoptedStyleSheets=[...await slideSheets(),slideReset()];
      await paint();
      await bounded(Promise.all(Array.from(shadow.querySelectorAll('img'),image=>image.decode())));
      await bounded(document.fonts.ready);
      await paint();
      if(!valid())return;
      if(componentError)throw componentError;
      await bounded((async()=>{
        while(Array.from(shadow.querySelectorAll('.mermaid')).some(node=>!node.shadowRoot?.querySelector('svg'))) {
          if(!valid())return;await new Promise(resolve=>setTimeout(resolve,50));
        }
      })());
      if(!valid())return;
      const content=target.value?.firstElementChild;
      if(!content || content.querySelector('.slidev-slide-loading'))throw new Error('页面尚未完成渲染');
      const clone=content.cloneNode(true) as HTMLElement;
      // Mermaid owns an inner shadow tree; copy the completed SVG into the static snapshot.
      const originals=content.querySelectorAll('.mermaid'),copies=clone.querySelectorAll('.mermaid');
      originals.forEach((node,i)=>{if(node.shadowRoot)copies[i].innerHTML=node.shadowRoot.innerHTML;});
      clone.querySelectorAll('script,iframe,object,embed').forEach(node=>node.remove());
      const sheets=await slideSheets();
      emit('snapshot',{deckId:deck.deckId,snapshot:crypto.randomUUID(),pageId:id,page:pageIndex+1,total:deck.pages.length,revision:deck.revision,html:clone.outerHTML,width:slideWidth.value,height:slideHeight.value,sheets});
      published.set(id,key);
      // Yield to input between pages; the current page is always first.
      await new Promise<void>(resolve=>setTimeout(resolve,30));
      if(!valid())return;
    }
    for(const id of published.keys())if(!deck.pages.some(page=>page.id===id))published.delete(id);
  }catch(error){if(valid())emit('error',renderFailure(error,{stage:'renderer',revision:deck.revision,pageId:failedPage}));}
  finally{busy=false;route.value=undefined;if(!disposed && version!==generation)schedule();}
}
watch(()=>JSON.stringify([props.deck.deckId,props.deck.revision,props.deck.current,nav.slides.value.map(route=>[route.no,route.meta.slide.frontmatter.imslideContentKey]),configs]),schedule);
watch(()=>[props.deck.current,props.deck.deckId,nav.slides.value.map(s=>s.meta.slide.frontmatter.imslideId)],()=>{
  const selected=nav.slides.value.find(s=>s.no===props.deck.current+1 && s.meta.slide.frontmatter.imslideId===props.deck.pages[props.deck.current]?.id);
  if(selected)void nav.go(selected.no,999999);
},{immediate:true});
onMounted(()=>{
  shadow=host.value!.attachShadow({mode:'open'});
  const mount=document.createElement('div');shadow.append(mount);target.value=mount;
  observer=new MutationObserver(schedule);observer.observe(document.head,{subtree:true,childList:true,characterData:true});
  schedule();
});
const afterUpdate=(payload:{updates?:Array<{path:string;acceptedPath?:string}>})=>{
  for(const update of payload.updates || []){
    const match=(update.acceptedPath || update.path).match(/\/@slidev\/slides\/(\d+)\/md/);
    if(match){const source=nav.slides.value.find(route=>route.no===Number(match[1]));if(source)published.delete(String(source.meta.slide.frontmatter.imslideId));}
  }
  schedule();
};
const compileError=(payload:{err?:{message?:string}})=>{generation++;emit('error',renderFailure(new Error(payload.err?.message || '幻灯片编译失败'),{stage:'renderer',revision:props.deck.revision}));};
import.meta.hot?.on('vite:afterUpdate',afterUpdate);import.meta.hot?.on('vite:error',compileError);
onUnmounted(()=>{disposed=true;generation++;clearTimeout(timer);observer?.disconnect();import.meta.hot?.off('vite:afterUpdate',afterUpdate);import.meta.hot?.off('vite:error',compileError);});
</script>
<template>
  <div ref="host" class="native-renderer" aria-hidden="true" :style="{width:`${slideWidth}px`,height:`${slideHeight}px`}"/>
  <Teleport v-if="target && route" :to="target"><div :key="`${route.no}:${generation}`" :style="{position:'relative',width:`${slideWidth}px`,height:`${slideHeight}px`,'--slidev-slide-container-scale':1,fontFamily:configs.fonts.sans.join(','),...themeVars}"><SlideWrapper :route="route" :clicks-context="clicks" render-context="overview"/></div></Teleport>
</template>
