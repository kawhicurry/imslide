import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UtteranceBuffer } from '../imslide.ts';

test('interim revisions never inject; final + end injects exactly once', () => {
  const committed: string[] = [];
  const speech = new UtteranceBuffer((_id, text) => { committed.push(text); });
  speech.push({ type: 'transcript', utteranceId: '1', text: '改成红', isFinal: false });
  speech.push({ type: 'transcript', utteranceId: '1', text: '改成蓝色', isFinal: false });
  speech.end('1'); assert.deepEqual(committed, []);
  speech.push({ type: 'transcript', utteranceId: '1', text: '改成蓝色标题。', isFinal: true });
  assert.deepEqual(committed, ['改成蓝色标题。']);
  assert.equal(speech.push({ type: 'transcript', utteranceId: '1', text: '改成蓝色标题。', isFinal: true, endOfUtterance: true }), 'duplicate');
  assert.equal(committed.length, 1); speech.close();
});
test('new interim cancels prefix timer; only the latest stable whole sentence is committed', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const committed: string[] = [];
  const speech = new UtteranceBuffer((_id, text) => { committed.push(text); }, 1200);
  speech.push({ type: 'transcript', utteranceId: '1', text: '标题', isFinal: true });
  t.mock.timers.tick(600);
  speech.push({ type: 'transcript', utteranceId: '1', text: '标题改成', isFinal: false });
  t.mock.timers.tick(5000); assert.deepEqual(committed, []);
  speech.push({ type: 'transcript', utteranceId: '1', text: '标题改成蓝色', isFinal: true });
  t.mock.timers.tick(1199); assert.deepEqual(committed, []);
  t.mock.timers.tick(1); assert.deepEqual(committed, ['标题改成蓝色']); speech.close();
});
test('final revisions replace earlier text, consecutive utterances keep separate identities', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const committed: [string, string][] = [];
  const speech = new UtteranceBuffer((id, text) => { committed.push([id, text]); }, 100);
  speech.push({ type: 'transcript', utteranceId: '1', text: '下一夜', isFinal: true });
  t.mock.timers.tick(90);
  speech.push({ type: 'transcript', utteranceId: '1', text: '下一页', isFinal: true });
  t.mock.timers.tick(100);
  speech.push({ type: 'transcript', utteranceId: '2', text: '下一页', isFinal: true, endOfUtterance: true });
  assert.deepEqual(committed, [['1', '下一页'], ['2', '下一页']]); speech.close();
});
test('shutdown discards unfinished transcripts rather than injecting a prefix', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const committed: string[] = [];
  const speech = new UtteranceBuffer((_id, text) => { committed.push(text); }, 100);
  speech.push({ type: 'transcript', utteranceId: '1', text: '一个尚未结束的', isFinal: false });
  speech.close(); t.mock.timers.tick(1000); assert.deepEqual(committed, []);
});
test('repeated identical finals do not postpone stabilization forever; early end is remembered', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const committed: string[] = [];
  const speech = new UtteranceBuffer((_id, text) => { committed.push(text); }, 100);
  speech.push({ type: 'transcript', utteranceId: '1', text: '稳定的整句', isFinal: true });
  t.mock.timers.tick(90);
  speech.push({ type: 'transcript', utteranceId: '1', text: '稳定的整句', isFinal: true });
  t.mock.timers.tick(10); assert.deepEqual(committed, ['稳定的整句']);
  speech.end('2');
  speech.push({ type: 'transcript', utteranceId: '2', text: '稍后到达的最终识别', isFinal: true });
  assert.deepEqual(committed, ['稳定的整句', '稍后到达的最终识别']); speech.close();
});
test('failed injection retains the finalized sentence for an idempotent retry', () => {
  let ready = false; const committed: string[] = [];
  const speech = new UtteranceBuffer((_id, text) => { if (!ready) return false; committed.push(text); });
  const input = { type: 'transcript' as const, utteranceId: 'retry-1', text: '保留这句完整的话', isFinal: true, endOfUtterance: true };
  assert.equal(speech.push(input), 'rejected'); assert.deepEqual(committed, []);
  ready = true; assert.equal(speech.push(input), 'committed');
  assert.deepEqual(committed, ['保留这句完整的话']); speech.close();
});
test('a rejected stabilization callback can be retried with the same final snapshot', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let ready = false; const committed: string[] = [];
  const speech = new UtteranceBuffer((_id, text) => { if (!ready) return false; committed.push(text); }, 100);
  const input = { type: 'transcript' as const, utteranceId: 'retry-timer', text: '定稿后重试', isFinal: true };
  speech.push(input); t.mock.timers.tick(100); assert.deepEqual(committed, []);
  ready = true; speech.push(input); t.mock.timers.tick(100);
  assert.deepEqual(committed, ['定稿后重试']); speech.close();
});
