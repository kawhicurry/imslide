import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceInput, type Recognition, type RecognitionEvent } from '../src/voice.ts';
class FakeRecognition implements Recognition {
  lang = ''; continuous = false; interimResults = false;
  onresult: Recognition['onresult'] = null;
  onspeechstart: Recognition['onspeechstart'] = null;
  onspeechend: Recognition['onspeechend'] = null;
  onerror: Recognition['onerror'] = null;
  onend: Recognition['onend'] = null;
  starts = 0;
  start() { this.starts++; }
  stop() {}
  abort() {}
  result(...segments: [string, boolean][]) {
    const results = segments.map(([transcript, isFinal]) => ({ isFinal, 0: { transcript } }));
    this.onresult?.({ results } as RecognitionEvent);
  }
}
function voiceFixture() {
  const engine = new FakeRecognition();
  const committed: { id: string; text: string }[] = [], drafts: string[] = [], errors: string[] = [];
  const voice = new VoiceInput(engine, { onDraft: text => drafts.push(text), onSentence: (id, text) => committed.push({ id, text }), onListening: () => {}, onError: text => errors.push(text) }, 1200);
  voice.start(); return { engine, voice, committed, drafts, errors };
}
test('browser ASR retains interim locally and submits only one stabilized cumulative sentence', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = voiceFixture();
  f.engine.result(['标题', true]); t.mock.timers.tick(600);
  f.engine.onspeechstart?.(); // Speaking again cancels a confirmed prefix before interim arrives.
  t.mock.timers.tick(1500); assert.equal(f.committed.length, 0);
  f.engine.result(['标题', true], ['改成红色', false]); f.engine.onspeechend?.();
  t.mock.timers.tick(2000); assert.equal(f.committed.length, 0);
  f.engine.result(['标题', true], ['改成蓝色', true]);
  t.mock.timers.tick(1199); assert.equal(f.committed.length, 0);
  t.mock.timers.tick(1); assert.equal(f.committed[0].text, '标题改成蓝色');
  f.engine.result(['标题', true], ['改成蓝色', true]); t.mock.timers.tick(2000);
  assert.equal(f.committed.length, 1, 'cumulative callbacks must not repeat an already sent sentence');
  f.engine.result(['标题', true], ['改成蓝色', true], ['下一页', true]); t.mock.timers.tick(1200);
  assert.equal(f.committed[1].text, '下一页'); assert.notEqual(f.committed[0].id, f.committed[1].id);
  f.voice.dispose();
});
test('stop never submits an unresolved interim, but accepts a late final before engine end', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = voiceFixture();
  f.engine.result(['改成', false]); f.voice.stop(); f.engine.onend?.(); t.mock.timers.tick(2000);
  assert.equal(f.committed.length, 0);
  f.voice.start(); f.engine.result(['下一页', false]); f.voice.stop();
  f.engine.result(['下一页', true]); f.engine.onend?.(); t.mock.timers.tick(1200);
  assert.equal(f.committed[0].text, '下一页'); f.voice.dispose();
});
test('browser session restart preserves a final pending sentence without resending old indexes', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = voiceFixture();
  f.engine.result(['标题改成绿色', true]); f.engine.onend?.();
  t.mock.timers.tick(1200); assert.equal(f.committed[0].text, '标题改成绿色');
  f.engine.result(['下一页', true]); t.mock.timers.tick(1200);
  assert.equal(f.committed[1].text, '下一页'); assert.equal(f.committed.length, 2); f.voice.dispose();
});
test('fatal ASR failure and disposal never leak an old final into the Agent', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = voiceFixture();
  f.engine.result(['旧句子', true]); f.engine.onerror?.({ error: 'network' });
  f.engine.result(['旧句子', true]); f.engine.onend?.(); t.mock.timers.tick(3000);
  assert.equal(f.committed.length, 0); assert.ok(f.errors.length);
  f.voice.start(); f.engine.result(['关闭时不要发送', true]); f.voice.dispose(); t.mock.timers.tick(2000);
  assert.equal(f.committed.length, 0);
});
