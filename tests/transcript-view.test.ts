import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderVue } from './vue-render';
test('transcript view renders fixed and provisional spans separately, including stopped unresolved tails', async () => {
  const html = await renderVue('/src/TranscriptView.vue', { value: { fixed: '标题蓝色。', pending: '下一页', processing: false }, listening: false });
  assert.match(html, /class="transcript-fixed" aria-label="已固定文字">标题蓝色。/);
  assert.match(html, /class="transcript-pending" aria-label="待确认文字">下一页/);
  assert.match(html, /麦克风已关闭/);
});
