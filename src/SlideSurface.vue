<script setup lang="ts">
/* @slidev-injection */ // Workspace components provide their own context.
import { onMounted, onUnmounted, shallowRef, watch } from 'vue';
import type { CachedSlide } from './slide-types';
import { slideReset } from './slide-styles';
const props = defineProps<{slide?:CachedSlide}>();
const emit = defineEmits<{ready:[slide:CachedSlide]}>();
const host = shallowRef<HTMLElement>();
let root: ShadowRoot, observer: ResizeObserver, displayed: CachedSlide | undefined;
function resize() {
  const viewport = root?.querySelector<HTMLElement>('.snapshot-viewport');
  if (!viewport || !host.value || !displayed) return;
  const scale = Math.min(host.value.clientWidth/displayed.width,host.value.clientHeight/displayed.height);
  viewport.style.transform=`scale(${scale})`;
  viewport.style.left=`${Math.max(0,(host.value.clientWidth-displayed.width*scale)/2)}px`;
  viewport.style.top=`${Math.max(0,(host.value.clientHeight-displayed.height*scale)/2)}px`;
}
function show(slide?:CachedSlide) {
  if (!slide || !root || !host.value) return; // Retain last complete page.
  if (displayed?.snapshot !== slide.snapshot) {
    const viewport=document.createElement('div');viewport.className='snapshot-viewport';
    viewport.style.width=`${slide.width}px`;viewport.style.height=`${slide.height}px`;
    // Snapshots come only from our compiled Vue renderer or the canonical blank.
    const doc=new DOMParser().parseFromString(slide.html,'text/html');
    viewport.innerHTML=doc.body.innerHTML;
    viewport.querySelectorAll('script,iframe,object,embed').forEach(node=>node.remove());
    root.adoptedStyleSheets=[...(slide.sheets || []),slideReset()];
    root.replaceChildren(viewport);
  }
  displayed=slide;
  host.value.dataset.pageId=slide.pageId;host.value.dataset.snapshot=slide.snapshot;host.value.dataset.revision=String(slide.revision);
  resize();emit('ready',slide);
}
onMounted(()=>{root=host.value!.attachShadow({mode:'open'});observer=new ResizeObserver(resize);observer.observe(host.value!);show(props.slide);});
watch(()=>props.slide,show,{flush:'post'});
onUnmounted(()=>observer?.disconnect());
</script>
<template><div ref="host" class="slide-surface" aria-hidden="true"/></template>
