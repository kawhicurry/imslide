<script setup lang="ts">
/* @slidev-injection */ // Workspace components provide their own context.
import type { TranscriptView } from './transcript';
defineProps<{value:TranscriptView;listening:boolean}>();
</script>
<template>
  <section v-if="value.fixed || value.pending" class="voice-transcript" aria-label="实时语音转写" aria-live="polite">
    <div class="voice-transcript-text"><span class="transcript-fixed" aria-label="已固定文字">{{ value.fixed }}</span><span class="transcript-pending" aria-label="待确认文字">{{ value.pending }}</span></div>
    <span v-if="!listening && value.pending && !value.processing" class="sr-only">麦克风已关闭，待确认文字尚未执行</span>
  </section>
</template>
