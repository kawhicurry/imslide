<script setup lang="ts">
/* @slidev-injection */ // Workspace components provide their own context.
import { computed } from 'vue';
import { ArrowUp, ChevronLeft, ChevronRight, Layers, Maximize2, Mic, Radio, Keyboard, Square } from 'lucide-vue-next';
import setupRoot from '@slidev/client/setup/root.ts';
import { disableBuiltinSync } from '@slidev/client';
import { usePresentation } from './usePresentation';
import { useWorkspace } from './useWorkspace';
import DeckLibrary from './DeckLibrary.vue';
import ToolActivity from './ToolActivity.vue';
import SlideRenderer from './SlideRenderer.vue';
import SlideSurface from './SlideSurface.vue';
import SlideThumbnail from './SlideThumbnail.vue';
import { thumbnailQueue } from './thumbnail-queue';
import type { CachedSlide } from './slide-types';
setupRoot();
disableBuiltinSync();
const { workspace,covers,workspaceAction,deck,index,page,navigating,rendered,connected,running,renderError,cachedSlides,error,input,inputMode,messages,listening,transcript,activity,toolActivity,voice,chatEnd,canvas,submit,toggleVoice,view,setCachedSlides,setRenderError,setRendered } = useWorkspace();
const {requesting,needsGesture,enter:fullscreen}=usePresentation(canvas,workspace,workspaceAction);
const byId = computed(() => new Map(cachedSlides.value.map(slide => [slide.pageId, slide])));
const selected = computed(() => page.value ? byId.value.get(page.value.id) : undefined);
function published(slide: CachedSlide) {
  if(slide.deckId!==workspace.value.activeDeckId || slide.revision!==deck.value?.revision)return;
  if (!deck.value?.pages.some(page => page.id === slide.pageId)) return;
  if(slide.page===1 && slide.deckId)covers.value={...covers.value,[slide.deckId]:slide};
  setCachedSlides(current => {
    const old = current.find(item => item.pageId === slide.pageId);
    if (old && old.revision > slide.revision) return current;
    return [...current.filter(item => item.pageId !== slide.pageId), slide];
  });
}
function ready(slide: CachedSlide) {
  setRendered(slide);
  if (renderError.value && slide.revision >= renderError.value.revision) setRenderError(undefined);
}
function send() { if (input.value.trim() && connected.value) { void submit(input.value); input.value = ''; } }
function typing(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); send(); }
}
function textMode() { void voice.value?.stop(); inputMode.value = 'text'; }
</script>
<template>
  <div class="app">
    <SlideRenderer v-if="deck && workspace.activeDeckId" :key="workspace.activeDeckId" :deck="deck" @snapshot="published" @error="setRenderError"/>
    <header class="topbar">
      <a href="/" @click.prevent="workspaceAction({tool:'switch_mode',mode:'management'})" class="brand" aria-label="imslide 查看器"><span class="brand-icon"><Layers :size="20"/></span>imslide <span class="readonly">AGENT 创作</span></a>
      <span class="document-name">{{workspace.decks.find(d=>d.id===workspace.activeDeckId)?.title || '文稿库'}}</span>
      <div class="header-actions"><span :class="['connection',{online:connected}]"><i/>{{ connected ? running ? 'Agent 正在更新' : '已连接' : '重新连接中' }}</span><button class="button" :disabled="!workspace.activeDeckId" @click="fullscreen"><Maximize2 :size="14"/> 演示</button></div>
    </header>
    <div class="workspace">
      <section :class="['left-workspace',workspace.mode]" aria-label="幻灯片工作区">
        <DeckLibrary v-if="workspace.mode==='management' && !requesting" :workspace="workspace" :covers="covers" @action="workspaceAction"/>
        <div v-show="workspace.mode!=='management' || requesting" class="preview-workspace">
      <aside class="sidebar"><div class="section-label">幻灯片 <span>{{ deck?.pages.length.toString().padStart(2,'0') || '—' }}</span></div>
        <div class="page-list" @scroll="thumbnailQueue.pause()" @wheel="thumbnailQueue.pause()" @pointerdown="thumbnailQueue.pause()">
          <button v-for="(p,i) in deck?.pages" :key="p.id" :disabled="navigating" :class="['page-item',{selected:i===index}]" @click="view(i)" :aria-label="`查看第 ${i+1} 页：${p.title}`">
            <span class="page-index">{{ String(i+1).padStart(2,'0') }}</span><SlideThumbnail :slide="byId.get(p.id)"/><span class="page-title">{{ p.title }}</span><span v-if="i===index" class="agent-page">AGENT</span>
          </button>
        </div>
        <div class="sidebar-footer"><Layers :size="10"/> SLIDEV ENGINE</div>
      </aside>
      <main class="main-area">
        <div class="canvas-toolbar"><div><Radio :size="13"/> 实时预览 <span class="divider"/><span class="muted">{{ page?.title || '连接文稿中' }}</span></div></div>
        <div class="canvas-region"><div ref="canvas" class="slide-frame" role="img" :aria-label="page?.title || '幻灯片'" :style="{aspectRatio:selected ? `${selected.width}/${selected.height}` : undefined}">
          <SlideSurface :key="workspace.activeDeckId || 'empty'" :slide="selected" @ready="ready"/>
          <div v-if="needsGesture" class="fullscreen-prompt"><button class="button" @click="fullscreen">点击进入全屏演示</button></div>
          <div v-if="!rendered" class="placeholder">{{ renderError ? '页面未能渲染' : '' }}</div>
        </div><div class="slide-under"><span>SLIDE {{ String(index+1).padStart(2,'0') }}</span><span>Slidev Markdown</span></div></div>
        <div v-if="renderError" class="error" role="alert">渲染失败，保留当前画面：{{ renderError.message }}</div>
        <footer class="canvas-bottom"><span><kbd>←</kbd><kbd>→</kbd> 浏览页面</span><div class="pager"><button aria-label="查看上一页" :disabled="!deck || navigating || index===0" @click="view(index-1)"><ChevronLeft :size="17"/></button><span>{{ deck ? index+1 : '—' }} <i>/ {{ deck?.pages.length || '—' }}</i></span><button aria-label="查看下一页" :disabled="!deck || navigating || index >= deck.pages.length-1" @click="view(index+1)"><ChevronRight :size="17"/></button></div></footer>
      </main>
        </div>
      </section>
      <aside class="chat-panel">
        <div class="chat-scroll">
          <div v-if="!messages.length" class="chat-intro"><span>THINK IT. SAY IT. SLIDE IT.</span><h1>从一句话，<br/>开始你的演示。</h1></div>
          <div class="live-document" role="log" aria-label="实时文字记录"><span v-for="(message,i) in messages" :key="message.id" :class="message.status==='sending'?'record-pending':'record-fixed'">{{ (i>0 && message.breakBefore!==false ? '\n\n' : '') + (message.formatted ?? message.text) }}</span><span v-if="transcript.pending" class="transcript-pending">{{ transcript.pending }}</span></div>
          <div ref="chatEnd"/>
        </div>
        <ToolActivity :items="toolActivity" :running="running" :connected="connected"/>
        <div class="composer-area">
          <div v-if="error" class="error" role="alert">{{ error }}</div>
          <div v-if="running && connected" class="activity" role="status"><i/>{{ activity || '正在处理指令…' }}</div>
          <div v-if="inputMode==='voice'" class="voice-controls">
            <button type="button" :class="['voice-orb',{active:listening}]" @click="toggleVoice" :aria-label="listening?'停止语音输入':'开始语音输入'" :aria-pressed="listening"><Square v-if="listening" :size="23" fill="currentColor"/><Mic v-else :size="30"/></button>
            <button type="button" class="input-mode-switch" @click="textMode" aria-label="切换到文字输入"><Keyboard :size="19"/></button>
          </div>
          <form v-else class="composer" @submit.prevent="send">
            <textarea autofocus aria-label="输入文字" v-model="input" maxlength="8000" @keydown="typing"/>
            <div class="composer-bottom"><button type="button" class="mic-button" @click="inputMode='voice'" aria-label="切换到语音输入"><Mic :size="18"/></button><button type="submit" class="send-button" :disabled="!input.trim() || !connected" aria-label="发送"><ArrowUp :size="18"/></button></div>
          </form>
        </div>
      </aside>
    </div>
  </div>
</template>
