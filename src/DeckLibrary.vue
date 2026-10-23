<script setup lang="ts">
/* @slidev-injection */
import { computed, ref } from 'vue';
import type { WorkspaceState, WorkspaceAction } from './workspace-contract';
import type { CachedSlide } from './slide-types';
import SlideThumbnail from './SlideThumbnail.vue';
const props=defineProps<{workspace:WorkspaceState;covers:Record<string,CachedSlide>}>();
const emit=defineEmits<{action:[action:WorkspaceAction]}>();
const query=ref(''),title=ref(''),deleted=ref(false),renaming=ref(''),renameTitle=ref('');
const items=computed(()=>props.workspace.decks.filter(d=>!!d.deletedAt===deleted.value && d.title.toLocaleLowerCase().includes(query.value.toLocaleLowerCase())).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)));
function create(){if(title.value.trim()){emit('action',{tool:'create_deck',title:title.value.trim()});title.value='';}}
function rename(id:string){if(renameTitle.value.trim()){emit('action',{tool:'rename_deck',deckId:id,title:renameTitle.value.trim()});renaming.value='';}}
</script>
<template>
  <section class="deck-library" aria-label="文稿管理">
    <div class="library-heading"><div><span class="eyebrow">YOUR PRESENTATIONS</span><h1>{{deleted?'回收站':'我的文稿'}}</h1></div><button class="button" @click="deleted=!deleted">{{deleted?'返回文稿':'回收站'}}</button></div>
    <div class="library-tools"><input v-model="query" type="search" aria-label="搜索文稿" placeholder="搜索文稿…"/><form v-if="!deleted" @submit.prevent="create"><input v-model="title" maxlength="120" aria-label="新文稿名称" placeholder="新文稿名称"/><button class="button primary" :disabled="!title.trim()">新建文稿</button></form></div>
    <div v-if="!items.length" class="library-empty">{{query?'没有匹配的文稿':deleted?'回收站为空':'新建一份文稿，开始创作。'}}</div>
    <div class="deck-grid">
      <article v-for="item in items" :key="item.id" class="deck-card" :data-deck-id="item.id">
        <button class="deck-cover" :disabled="deleted" :aria-label="`打开文稿：${item.title}`" @click="emit('action',{tool:'open_deck',deckId:item.id})"><SlideThumbnail v-if="covers[item.id]" :slide="covers[item.id]"/><span v-else class="cover-type">{{item.title.slice(0,2)}}</span></button>
        <div class="deck-card-body"><form v-if="renaming===item.id" class="rename-form" @submit.prevent="rename(item.id)"><input v-model="renameTitle" aria-label="重命名文稿" maxlength="120"/><button class="button">保存</button><button type="button" class="button" @click="renaming=''">取消</button></form><h2 v-else>{{item.title}}</h2>
        <p>{{item.pageCount}} 页 · {{new Date(item.updatedAt).toLocaleString('zh-CN',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}}</p>
        <div class="deck-actions"><template v-if="!deleted"><button @click="emit('action',{tool:'open_deck',deckId:item.id})">打开</button><button @click="renaming=item.id;renameTitle=item.title">重命名</button><button @click="emit('action',{tool:'duplicate_deck',deckId:item.id})">复制</button><button @click="emit('action',{tool:'delete_deck',deckId:item.id})">删除</button></template><button v-else @click="emit('action',{tool:'restore_deck',deckId:item.id})">恢复文稿</button></div></div>
      </article>
    </div>
  </section>
</template>
