<script setup lang="ts">
/* @slidev-injection */ // Workspace components provide their own context.
import { onMounted, onUnmounted, shallowRef, watch } from 'vue';
import type { CachedSlide } from './slide-types';
import SlideSurface from './SlideSurface.vue';
import { thumbnailQueue } from './thumbnail-queue';
const props=defineProps<{slide?:CachedSlide}>();
const host=shallowRef<HTMLElement>(),nearby=shallowRef(false),displayed=shallowRef<CachedSlide>();
let observer:IntersectionObserver,cancel:(()=>void)|undefined,finish:(()=>void)|undefined;
onMounted(()=>{observer=new IntersectionObserver(([entry])=>{nearby.value=entry.isIntersecting;},{root:null,rootMargin:'100px'});observer.observe(host.value!);});
watch([nearby,()=>props.slide?.snapshot],()=>{
  cancel?.();finish=undefined;
  if(!nearby.value){displayed.value=undefined;return;}
  const slide=props.slide;if(!slide)return;
  cancel=thumbnailQueue.enqueue(done=>{finish=done;displayed.value=slide;});
});
onUnmounted(()=>{observer?.disconnect();cancel?.();});
</script>
<template><span ref="host" class="thumbnail" aria-hidden="true" :style="{aspectRatio:`${displayed?.width || slide?.width || 980}/${displayed?.height || slide?.height || 552}`}"><SlideSurface v-if="nearby && displayed" :slide="displayed" @ready="finish?.()"/></span></template>
