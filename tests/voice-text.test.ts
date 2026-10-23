import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendVoiceText } from '../src/voice-text.ts';

test('overlapping ASR becomes a cumulative snapshot without concatenating a partial command twice', () => {
  const old = '然后删除语音验收这一页里面的项目';
  const next = '验收这一页里面的项目目标这一行保留标题和项目预算然后最后';
  const joined = appendVoiceText(old, next, true);
  assert.equal(joined.text, '然后删除语音验收这一页里面的项目目标这一行保留标题和项目预算然后最后');
  assert.equal(joined.aligned, true);
});
test('non-overlapping intentional repetition and mismatched negation are never dropped', () => {
  assert.equal(appendVoiceText('下一页。', '下一页。', false).text, '下一页。\n下一页。');
  const joined = appendVoiceText('删除项目预算', '不，删除项目预算这一行', true);
  assert.equal(joined.aligned, false); assert.match(joined.text, /不，删除/);
});
test('punctuation and emoji offsets do not remove new speech', () => {
  assert.equal(appendVoiceText('标题设置为语音验收，然后', '设置为语音验收然后添加内容', true).delta, '添加内容');
  assert.equal(appendVoiceText('标题😀设置完成', '😀设置完成再翻页', true).delta, '再翻页');
});
