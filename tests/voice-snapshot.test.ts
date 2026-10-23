import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StableVoiceSnapshot, voiceTextKey, shouldDeliverVoiceSnapshot } from '../src/voice-snapshot.ts';

test('a trailing stable prefix cannot retract the fuller pause delivery; confirmed revisions can', () => {
  assert.equal(shouldDeliverVoiceSnapshot('新增一页标题设置为预算', '新增一页', false), false);
  assert.equal(shouldDeliverVoiceSnapshot('新增一页标题设置为预算', '新增一页', true), true);
  assert.equal(shouldDeliverVoiceSnapshot('预算100万', '预算80万', false), true);
  assert.equal(shouldDeliverVoiceSnapshot('删除这一页', '不要删除这一页', false), true);
  assert.equal(shouldDeliverVoiceSnapshot('新增一页', '新增一页。', true), false);
  assert.equal(shouldDeliverVoiceSnapshot('新增一页', '新增一页再新增一页', false), true);
});

test('growing interim speech yields a stable prefix without silence or definite', () => {
  const s = new StableVoiceSnapshot();
  assert.equal(s.update('请新增一页然后', false), undefined);
  assert.equal(s.update('请新增一页然后标题改为预算', false), '请新增一页然后');
  assert.equal(s.update('请新增一页然后标题改为预算然后', false), undefined);
  assert.equal(s.update('请新增一页然后标题改为预算然后继续', false), '请新增一页然后标题改为预算然后');
});

test('a stable comma delivers the preceding clause while a trailing prohibition is still growing', () => {
  const s = new StableVoiceSnapshot();
  assert.equal(s.update('删除标题为预算的这一页，不要', false), undefined);
  assert.equal(s.update('删除标题为预算的这一页，不要删除其他', false), '删除标题为预算的这一页，');
});
test('final confirmation of the same text does not resubmit an executed prefix', () => {
  const s = new StableVoiceSnapshot();
  s.update('请新增一张空白页。', false);
  assert.equal(s.update('请新增一张空白页。', false), '请新增一张空白页。');
  assert.equal(s.update('请新增一张空白页。', true), undefined);
});

test('unchanged unpunctuated speech reaches the semantic Agent before cloud confirmation', () => {
  const s = new StableVoiceSnapshot();
  assert.equal(s.update('请帮我新增一张空白幻灯片', false), undefined);
  assert.equal(s.update('请帮我新增一张空白幻灯片', false), '请帮我新增一张空白幻灯片');
  assert.equal(s.update('请帮我新增一张空白幻灯片。', true), undefined);
});

test('a stable partial name or amount is held until a following clause establishes its end', () => {
  const s = new StableVoiceSnapshot();
  s.update('请新增一页标题设置为语音', false);
  assert.equal(s.update('请新增一页标题设置为语音验收', false), undefined);
  assert.equal(s.update('请新增一页标题设置为语音验收然后', false), undefined);
  assert.equal(s.update('请新增一页标题设置为语音验收然后添加', false), '请新增一页标题设置为语音验收然后');
});

test('punctuation revisions do not send an older shortened snapshot', () => {
  const s = new StableVoiceSnapshot();
  s.update('新增一页然后写预算100万元然后', false);
  s.update('新增一页然后写预算100万元然后继续', false);
  assert.equal(s.update('新增一页然后写预算，100万元然后继续', false), undefined);
  assert.equal(s.update('新增一页然后写预算，100万元然后继续添加', false), undefined);
});
test('revisions replace old hypotheses and genuinely repeated speech remains distinct', () => {
  const s = new StableVoiceSnapshot();
  s.update('把标题改成红色', false); s.update('把标题改成红色', false);
  assert.equal(s.update('把标题改成蓝色', true), '把标题改成蓝色');
  assert.equal(s.update('把标题改成蓝色然后再新增一页再新增一页', true), '把标题改成蓝色然后再新增一页再新增一页');
  assert.notEqual(voiceTextKey('预算-100'), voiceTextKey('预算100'));
});
