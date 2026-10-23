import {createApp,defineComponent,h,shallowRef} from 'vue';
import SlideThumbnail from '../../src/SlideThumbnail.vue';
import {thumbnailQueue} from '../../src/thumbnail-queue';
import css from '../../src/style.css?inline';
import type {CachedSlide} from '../../src/slide-types';
const styles=new CSSStyleSheet();styles.replaceSync('#slide-content{width:980px;height:552px;background:#193d67;color:white;font:48px sans-serif;display:flex;align-items:center;justify-content:center}');
function snapshot(i:number,r:number):CachedSlide{return {pageId:`p${i}`,page:i+1,total:60,revision:r,snapshot:`${i}:${r}`,width:980,height:552,sheets:[styles],html:`<div id="slide-content">Page ${i} · Revision ${r}</div>`};}
const style=document.createElement('style');style.textContent=css;document.head.append(style);
createApp(defineComponent({setup(){const slides=shallowRef(Array.from({length:60},(_,i)=>snapshot(i,0)));Object.assign(window,{replaceThumbnail:(i:number,r:number)=>{slides.value=slides.value.map((slide,index)=>index===i?snapshot(i,r):slide);}});return ()=>h('div',{class:'page-list',style:{width:'200px',height:'600px',overflow:'auto'},onScroll:()=>thumbnailQueue.pause()},slides.value.map(slide=>h('div',{key:slide.pageId,style:{padding:'10px'}},[h(SlideThumbnail,{slide})])));}})).mount('#root');
