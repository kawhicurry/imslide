import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AudioWindows, StableTranscript, type ASRWord } from '../src/transcript.ts';
function words(text: string, start = 0): ASRWord[] {
  return Array.from(text).map((text, i) => ({ text, start: start + i * 0.2, end: start + (i + 1) * 0.2 }));
}
test('overlap agreement fixes only unchanged prefix and allows pending corrections', () => {
  const state = new StableTranscript();
  state.update(words('标题红色'), 0, 2);
  assert.deepEqual(state.view(), { fixed: '', pending: '标题红色', processing: false });
  state.update(words('标题蓝色。'), 0, 4);
  assert.equal(state.view().fixed, '标题'); assert.equal(state.view().pending, '蓝色。');
  assert.deepEqual(state.takeSentences(), []);
  state.update(words('标题蓝色。'), 0, 6);
  assert.equal(state.view().fixed, '标题蓝色。'); assert.equal(state.view().pending, '');
  assert.deepEqual(state.takeSentences(), ['标题蓝色。']); assert.deepEqual(state.takeSentences(), []);
});
test('duplicate window retries cannot stabilize text and new end must advance', () => {
  const state = new StableTranscript(); state.update(words('下一页'), 0, 2);
  state.update(words('下一页'), 0, 2); assert.equal(state.view().fixed, '');
  state.update(words('下一页'), 0, 4); assert.equal(state.view().fixed, '下一页');
});
test('confirmed overlap is not resubmitted; intentional repetition later is preserved', () => {
  const state = new StableTranscript();
  state.update(words('下一页。'), 0, 2); state.update(words('下一页。'), 0, 4);
  assert.deepEqual(state.takeSentences(), ['下一页。']);
  // Window advances; relative timestamps differ but absolute positions are unchanged.
  state.update(words('下一页。', 1), 2, 5); assert.equal(state.view().pending, '下一页。');
  state.update(words('下一页。', 1), 2, 7);
  assert.deepEqual(state.takeSentences(), ['下一页。']); assert.equal(state.view().fixed, '下一页。下一页。');
});
test('window-edge text and mismatching timestamps remain provisional', () => {
  const state = new StableTranscript();
  state.update(words('修改', 1), 0, 1.5); state.update(words('修改', 1), 0, 1.7);
  assert.equal(state.view().fixed, '');
  state.update(words('修改', 3), 0, 5); assert.equal(state.view().fixed, '');
});
test('silence cannot silently discard pending text or force-submit it', () => {
  const state = new StableTranscript(); state.update(words('不确定'), 0, 2); state.update([], 0, 4);
  assert.equal(state.view().pending, '不确定'); assert.deepEqual(state.takeSentences(true), []);
  state.update(words('已修正'), 0, 6); assert.equal(state.view().fixed, '');
  state.update(words('已修正'), 0, 8); assert.deepEqual(state.takeSentences(true), ['已修正']);
});
test('punctuation in quotes does not split titles; stable unpunctuated tail waits for silence', () => {
  const state = new StableTranscript(); const text = '标题“你好。世界”。下一页';
  state.update(words(text), 0, 5); state.update(words(text), 0, 7);
  assert.deepEqual(state.takeSentences(), ['标题“你好。世界”。']);
  assert.deepEqual(state.takeSentences(), []); assert.deepEqual(state.takeSentences(true), ['下一页']);
});
test('audio windows retain actual PCM overlap and never discard unresolved audio on overflow', () => {
  const audio = new AudioWindows(); const pcm = Float32Array.from({ length: 6 * 16000 }, (_, i) => i / 96000);
  audio.append(pcm); const first = audio.snapshot(); audio.retainFrom(3); audio.append(new Float32Array(2 * 16000));
  const next = audio.snapshot(); assert.equal(next.start, 3); assert.equal(next.end, 8);
  assert.deepEqual(next.samples.slice(0, 3 * 16000), first.samples.slice(3 * 16000));
  assert.throws(() => audio.append(new Float32Array(24 * 16000)), /24 秒/); assert.equal(audio.end, 8);
});
test('short tokens after a fixed prefix are not lost at the timestamp boundary', () => {
  const state = new StableTranscript();
  const first = [{text:'前',start:0,end:0.2}];
  state.update(first,0,2); state.update(first,0,4);
  const next = [...first, {text:'后。',start:0.2,end:0.3}];
  state.update(next,0,6); state.update(next,0,8);
  assert.equal(state.view().fixed,'前后。');
});
test('timestamp drift in confirmed overlap does not duplicate its text', () => {
  const state = new StableTranscript();
  state.update(words('标题蓝色。'),0,2); state.update(words('标题蓝色。'),0,4); state.takeSentences();
  const shifted = words('标题蓝色。',0.2).concat(words('下一页。',2));
  state.update(shifted,0,6); state.update(shifted,0,8);
  assert.deepEqual(state.takeSentences(),['下一页。']); assert.equal(state.view().fixed,'标题蓝色。下一页。');
});
test('repeated low-confidence hallucinations never become fixed or submitted', () => {
  const state = new StableTranscript(); const suspect = [{text:'好',start:0.1,end:0.3,confidence:0.02}];
  for (const end of [2,4,6,8]) state.update(suspect,0,end);
  assert.equal(state.view().fixed,''); assert.equal(state.view().pending,'好'); assert.deepEqual(state.takeSentences(true),[]);
});
test('two advancing empty hypotheses can retract a provisional insertion without submitting it', () => {
  const state = new StableTranscript(); state.update(words('错字'),0,2);
  state.update([],0,4); assert.equal(state.view().pending,'错字');
  state.update([],0,6); assert.equal(state.view().pending,''); assert.deepEqual(state.takeSentences(true),[]);
});
