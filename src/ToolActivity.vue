<script setup lang="ts">
/* @slidev-injection */ // Workspace components provide their own context.
import { Check, ChevronRight, CircleHelp, LoaderCircle, SkipForward, Wrench, X } from 'lucide-vue-next';
import { toolLabels, toolStatusLabels, toolSummary, type ToolActivity } from './tool-activity';
defineProps<{ items: ToolActivity[]; running: boolean; connected: boolean }>();
const icons = { running: LoaderCircle, success: Check, failed: X, skipped: SkipForward, unknown: CircleHelp };
function duration(item: ToolActivity) {
  if (item.startedAt === undefined || item.endedAt === undefined) return '';
  const ms = Math.max(0, item.endedAt - item.startedAt);
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}
</script>
<template>
  <section class="tool-panel" aria-label="Agent 操作记录">
    <div class="tool-heading"><Wrench :size="14"/><strong>Agent 操作</strong><span>{{ items.length ? `${items.length} 次调用` : '等待指令' }}</span></div>
    <div class="tool-session-status" role="status">{{ !connected ? '连接中断 · 正在重连' : running ? 'Agent 正在处理…' : items.length ? '当前空闲' : '工具调用后会在这里显示' }}</div>
    <div v-if="items.length" class="tool-list">
      <details v-for="item in [...items].reverse()" :key="item.id" :class="`tool-entry tool-${item.status}`">
        <summary><component :is="icons[item.status]" :size="14" :class="item.status === 'running' ? 'tool-spinner' : ''"/><span class="tool-description"><strong>{{ toolLabels[item.name] || item.name }}</strong><span>{{ toolSummary(item) }}</span></span><span class="tool-status">{{ toolStatusLabels[item.status] }}</span><ChevronRight :size="13" class="tool-chevron"/></summary>
        <div class="tool-detail"><div class="tool-meta"><code>{{ item.name }}</code><span>{{ duration(item) }}</span></div>
          <p v-if="item.error" class="tool-error-text">{{ item.error }}</p>
          <h4>调用参数</h4><pre>{{ item.input === undefined ? '未收到参数（可能在连接中断期间调用）' : JSON.stringify(item.input, null, 2) }}</pre>
          <h4>执行结果</h4><pre>{{ item.output !== undefined ? JSON.stringify(item.output, null, 2) : item.status === 'running' ? '等待工具返回…' : item.error || '未收到结果' }}</pre>
        </div>
      </details>
    </div>
    <p v-if="items.length" class="tool-history-note">本次打开期间最近 100 次调用 · 最新在上</p>
  </section>
</template>
