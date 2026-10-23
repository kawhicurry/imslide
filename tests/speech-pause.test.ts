import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpeechPause } from '../src/speech-pause.ts';
const pcm = (seconds: number, amplitude = 0) => new Float32Array(Math.round(seconds * 16000)).fill(amplitude);
test('initial silence and a lagging ASR partial never trigger the fast delivery', () => {
  const p = new SpeechPause(); p.add(pcm(1)); assert.equal(p.ready(1), false);
  p.add(pcm(1, 0.1)); assert.equal(p.ready(2), false);
  assert.equal(p.ready(1.8, true), false);
  assert.equal(p.ready(2, true), true);
  p.add(pcm(0.08)); assert.equal(p.ready(1.8), false);
  assert.equal(p.ready(1.92), true);
  assert.equal(p.ready(0), false);
});
test('resumed speech resets the pause, and quiet padding in a PCM frame is not treated as voiced', () => {
  const p = new SpeechPause();
  const frame = pcm(0.04); frame.set(pcm(0.01, 0.1)); p.add(frame);
  p.add(pcm(0.04)); assert.equal(p.ready(0.08), false);
  p.add(pcm(0.01)); assert.equal(p.ready(0.08), true);
  p.add(pcm(0.02, 0.1)); assert.equal(p.ready(0.12), false);
});
