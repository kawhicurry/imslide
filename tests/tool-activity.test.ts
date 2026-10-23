import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderVue } from './vue-render';
import { reduceToolActivity, type ToolActivity as Activity } from '../src/tool-activity.ts';
import type { CoreEvent } from '../imslide.ts';

const call = (runId = 'run', callId = 'one'): CoreEvent => ({ type: 'tool', runId, callId, name: 'edit_page', input: { old_string: '<script>alert(1)</script>', new_string: '新标题' }, at: 100 });
const result = (output: unknown, runId = 'run', callId = 'one'): CoreEvent => ({ type: 'tool-result', runId, callId, name: 'edit_page', output, at: 150 });
test('tool calls correlate by run and call ID and preserve failures and skipped results', () => {
  let items = reduceToolActivity([], call());
  items = reduceToolActivity(items, call());
  assert.equal(items.length, 1);
  items = reduceToolActivity(items, result({ ok: false, error: '未匹配' }));
  assert.equal(items[0].status, 'failed');
  items = reduceToolActivity(items, call('other'));
  items = reduceToolActivity(items, result({ skipped: true }, 'other'));
  assert.equal(items[1].status, 'skipped');
  assert.equal(items[0].status, 'failed');
  items = reduceToolActivity(items, call('third'));
  items = reduceToolActivity(items, { type: 'tool-error', runId: 'third', callId: 'one', name: 'edit_page', error: '写入失败', at: 150 });
  assert.equal(items[2].status, 'failed');
});
test('connection loss never guesses success; a late result resolves uncertainty', () => {
  let items = reduceToolActivity([], call());
  items = reduceToolActivity(items, { type: 'disconnected' });
  assert.equal(items[0].status, 'unknown');
  items = reduceToolActivity(items, result({ ok: true }));
  assert.equal(items[0].status, 'success');
  assert.equal(items[0].error, undefined);
  items = reduceToolActivity(items, call('other'));
  items = reduceToolActivity(items, { type: 'error', runId: 'other', error: '超时' });
  assert.equal(items[1].status, 'unknown');
  assert.equal(items[0].status, 'success');
});
test('result received after reconnect can stand alone and history is bounded', () => {
  let items: Activity[] = reduceToolActivity([], result({ ok: true }));
  assert.equal(items[0].status, 'success');
  assert.equal(items[0].startedAt, undefined);
  for (let i = 0; i < 110; i++) items = reduceToolActivity(items, call('run', String(i)));
  assert.equal(items.length, 100);
});
test('detail view escapes tool content and labels failed and pending calls accurately', async () => {
  let items = reduceToolActivity([], call());
  items = reduceToolActivity(items, result({ ok: false, error: '未匹配' }));
  const html = await renderVue('/src/ToolActivity.vue', { items, running: false, connected: true });
  assert.match(html, /局部修改/); assert.match(html, /失败/); assert.match(html, /调用参数/); assert.match(html, /执行结果/);
  assert.ok(!html.includes('<script>')); assert.match(html, /&lt;script&gt;/);
});
