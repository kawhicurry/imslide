import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceInput, splitSentences, type Recognition, type RecognitionEvent } from '../src/voice.ts';
class FakeRecognition implements Recognition {
  lang = ''; continuous = false; interimResults = false;
  onresult: Recognition['onresult'] = null;
  onspeechstart: Recognition['onspeechstart'] = null;
  onspeechend: Recognition['onspeechend'] = null;
  onerror: Recognition['onerror'] = null;
  onend: Recognition['onend'] = null;
  starts = 0; stops = 0;
  start() { this.starts++; }
  stop() { this.stops++; }
  abort() {}
  result(...segments: [string, boolean][]) {
    const results = segments.map(([transcript, isFinal]) => ({ isFinal, 0: { transcript } }));
    this.onresult?.({ results } as RecognitionEvent);
  }
}
function voiceFixture() {
  const engine = new FakeRecognition();
  const committed: { id: string; text: string }[] = [], drafts: string[] = [], errors: string[] = [];
  const voice = new VoiceInput(engine, { onDraft: text => drafts.push(text), onSentence: (id, text) => committed.push({ id, text }), onListening: () => {}, onError: text => errors.push(text) });
  voice.start(); return { engine, voice, committed, drafts, errors };
}
test('single utterance ASR displays drafts and submits a final immediately without speechend', () => {
  const f = voiceFixture();
  assert.equal(f.engine.continuous, false);
  assert.equal(f.engine.interimResults, true);
  f.engine.onspeechstart?.();
  f.engine.result(['标题改成', false]);
  assert.equal(f.drafts.at(-1), '标题改成');
  assert.equal(f.committed.length, 0);
  f.engine.result(['标题改成蓝色', true]);
  assert.equal(f.committed[0].text, '标题改成蓝色');
  assert.equal(f.drafts.at(-1), '');
  f.engine.result(['标题改成蓝色', true]);
  assert.equal(f.committed.length, 1);
  f.voice.dispose();
});
test('automatic restart sends consecutive identical sentences once each with distinct ids', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = voiceFixture();
  f.engine.result(['下一页', true]); f.engine.onend?.();
  t.mock.timers.tick(100);
  assert.equal(f.engine.starts, 2);
  f.engine.result(['下一页', false]);
  assert.equal(f.committed.length, 1);
  f.engine.result(['下一页', true]); f.engine.onend?.();
  assert.deepEqual(f.committed.map(x => x.text), ['下一页', '下一页']);
  assert.notEqual(f.committed[0].id, f.committed[1].id);
  f.voice.stop(); t.mock.timers.tick(1000);
  assert.equal(f.engine.starts, 2, 'manual stop cancels automatic restart');
  f.voice.dispose();
});
test('stop never submits an unresolved interim, but accepts a late final before engine end', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = voiceFixture();
  f.engine.result(['改成', false]); f.voice.stop(); f.engine.onend?.(); t.mock.timers.tick(2000);
  assert.equal(f.committed.length, 0);
  f.voice.start(); f.engine.result(['下一页', false]); f.voice.stop();
  f.engine.result(['下一页', true]); f.engine.onend?.();
  assert.equal(f.committed[0].text, '下一页'); f.voice.dispose();
});
test('a final prefix with an interim suffix stays local until the entire utterance is final', () => {
  const f = voiceFixture();
  f.engine.result(['标题', true], ['改成红色', false]);
  assert.equal(f.committed.length, 0);
  f.engine.result(['标题', true], ['改成蓝色', true]);
  assert.equal(f.committed[0].text, '标题改成蓝色'); f.voice.dispose();
});
test('fatal ASR failure and disposal discard drafts and cancel restarts', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = voiceFixture();
  f.engine.result(['旧句子', false]); f.engine.onerror?.({ error: 'network' });
  f.engine.result(['旧句子', true]); f.engine.onend?.(); t.mock.timers.tick(3000);
  assert.equal(f.committed.length, 0); assert.ok(f.errors.length);
  f.voice.start(); f.engine.result(['关闭时不要发送', false]); f.engine.onend?.();
  f.voice.dispose(); t.mock.timers.tick(2000);
  f.engine.result(['关闭时不要发送', true]);
  assert.equal(f.committed.length, 0); assert.equal(f.engine.starts, 2);
});

test('sentence splitting preserves quoted titles, decimals and URLs', () => {
  assert.deepEqual(splitSentences('标题改为“你好。世界。”。下一页！版本 3.14，链接 https://example.com。完成了吗？'), ['标题改为“你好。世界。”。', '下一页！', '版本 3.14，链接 https://example.com。', '完成了吗？']);
});
test('punctuated interim requests finalization and commits revised final sentences exactly once', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = voiceFixture();
  f.engine.result(['标题红色。下一页', false]);
  t.mock.timers.tick(300); assert.equal(f.engine.stops, 1); assert.equal(f.committed.length, 0);
  f.engine.result(['标题蓝色。下一页。', true]);
  assert.deepEqual(f.committed.map(x => x.text), ['标题蓝色。', '下一页。']);
  assert.equal(new Set(f.committed.map(x => x.id)).size, 2);
  f.engine.result(['标题蓝色。下一页。', true]); f.engine.onend?.();
  t.mock.timers.tick(100); assert.equal(f.engine.starts, 2); assert.equal(f.committed.length, 2);
  f.voice.dispose();
});
test('unchanged interim callbacks do not postpone pause finalization', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = voiceFixture(); f.engine.result(['标题改成蓝色', false]);
  t.mock.timers.tick(800); f.engine.result(['标题改成蓝色', false]);
  t.mock.timers.tick(400); assert.equal(f.engine.stops, 1); assert.equal(f.committed.length, 0);
  f.engine.result(['标题改成蓝色', true]); assert.equal(f.committed.length, 1); f.voice.dispose();
});
test('continuous long speech is finalized at the segment limit despite evolving drafts', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = voiceFixture(); f.engine.result(['长句', false]);
  for (let i = 0; i < 15; i++) { t.mock.timers.tick(1000); f.engine.result(['长句' + '继续'.repeat(i + 1), false]); }
  assert.equal(f.engine.stops, 1); assert.equal(f.committed.length, 0);
  f.engine.result(['长句定稿', true]); f.engine.onend?.(); t.mock.timers.tick(100);
  assert.equal(f.committed[0].text, '长句定稿'); assert.equal(f.engine.starts, 2); f.voice.dispose();
});
test('dispose cancels all boundary timers', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = voiceFixture(); f.engine.result(['待定。', false]); f.voice.dispose();
  t.mock.timers.tick(20000); assert.equal(f.engine.stops, 0); assert.equal(f.committed.length, 0);
});
