import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { OverlapVoiceInput } from '../src/overlap-voice.ts';
import type { TranscriptView } from '../src/transcript.ts';
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function environment(t: TestContext, handler: (body: ArrayBuffer) => Promise<Response>) {
  let stopped = false;
  const committed: string[] = [], views: TranscriptView[] = [], errors: string[] = [];
  let node: any;
  class Context {
    state = 'running'; destination = {};
    audioWorklet = { addModule: async () => {} };
    resume = async () => {}; close = async () => { this.state = 'closed'; };
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  }
  class Capture {
    port = { onmessage: null as any, postMessage: () => this.port.onmessage?.({ data: { flushed: true } }) };
    constructor() { node = this; }
    connect() {} disconnect() {}
  }
  for (const [key, value] of Object.entries({ AudioContext: Context, AudioWorkletNode: Capture, navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => { stopped = true; } }] }) } } })) {
    const old = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => { if (old) Object.defineProperty(globalThis, key, old); else Reflect.deleteProperty(globalThis, key); });
  }
  t.mock.method(globalThis, 'fetch', async (url: string, options: any) => url.endsWith('/status') ? Response.json({ ready: true }) : url.endsWith('/merge') ? Response.json({ append: JSON.parse(options.body).raw }) : handler(options.body));
  const voice = new OverlapVoiceInput({ onTranscript: v => views.push(v), onSentence: (_id, text) => committed.push(text), onListening: () => {}, onError: e => errors.push(e) });
  t.after(() => voice.dispose());
  return { voice, committed, views, errors, stopped: () => stopped, audio: (seconds: number) => node.port.onmessage({ data: new Float32Array(seconds * 16000).fill(0.05) }) };
}

test('fixed windows keep recording beyond 24 seconds and flush only new tail', async t => {
  const lengths: number[] = [];
  const f = environment(t, async body => { lengths.push(body.byteLength / 64000); return Response.json({ words: [{text:'蓝色。'}] }); });
  await f.voice.start();
  for (let i = 0; i < 8; i++) { f.audio(4); await settle(); }
  assert.equal(f.stopped(), false);
  f.audio(1); await f.voice.stop();
  assert.deepEqual(lengths, [4,6,6,6,6,6,6,6,3]);
  assert.equal(f.committed.length, 9); assert.deepEqual(f.errors, []);
});
test('out of order recognition merges in capture order', async t => {
  const finish: Array<(r: Response) => void> = [];
  const f = environment(t, () => new Promise(resolve => finish.push(resolve)));
  await f.voice.start(); f.audio(8);
  finish[1](Response.json({words:[{text:'第二段'}]})); await settle();
  assert.deepEqual(f.committed, []);
  finish[0](Response.json({words:[{text:'第一段'}]})); await settle();
  await f.voice.stop();
  assert.deepEqual(f.committed, ['第一段','第二段']);
});
test('disposing pending recognition never submits a late result', async t => {
  let finish!: (r: Response) => void;
  const f = environment(t, () => new Promise(resolve => { finish = resolve; }));
  await f.voice.start(); f.audio(4); f.voice.dispose();
  finish(Response.json({words:[{text:'删除'}]})); await settle();
  assert.equal(f.stopped(), true); assert.deepEqual(f.committed, []);
});
test('recognition failure reports a gap but later audio continues', async t => {
  let n = 0;
  const f = environment(t, async () => ++n === 1 ? Response.json({error:'fixture unavailable'},{status:503}) : Response.json({words:[{text:'继续'}]}));
  await f.voice.start(); f.audio(8); await settle();
  assert.equal(f.stopped(), false); await f.voice.stop();
  assert.deepEqual(f.committed, ['继续']); assert.ok(f.errors[0].includes('fixture unavailable'));
});
