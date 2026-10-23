import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { OverlapVoiceInput } from '../src/overlap-voice.ts';
import type { TranscriptView } from '../src/transcript.ts';
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
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
  t.mock.method(globalThis, 'fetch', async (url: string, options: any) => url.endsWith('/status') ? Response.json({ ready: true }) : url.endsWith('/voice') ? Response.json({ append: JSON.parse(options.body).raw, pending: '' }) : handler(options.body));
  const voice = new OverlapVoiceInput({ onTranscript: v => views.push(v), onSentence: (_id, text) => committed.push(text), onListening: () => {}, onError: e => errors.push(e) });
  t.after(() => voice.dispose());
  return { voice, committed, views, errors, stopped: () => stopped, audio: (seconds: number, amplitude = 0.05) => node.port.onmessage({ data: new Float32Array(Math.round(seconds * 16000)).fill(amplitude) }) };
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
test('single-flight ASR preserves capture order and forwards partials for backend semantic decisions', async t => {
  const finish: Array<(r: Response) => void> = [];
  const f = environment(t, () => new Promise(resolve => finish.push(resolve)));
  await f.voice.start(); f.audio(8); await settle();
  assert.equal(finish.length, 1);
  finish[0](Response.json({text:'第一段'})); await settle();
  assert.equal(finish.length, 2); assert.deepEqual(f.committed, ['第一段']);
  finish[1](Response.json({text:'第二段'})); await settle();
  f.audio(0.4, 0); await settle();
  assert.equal(finish.length, 3);
  finish[2](Response.json({text:'完整指令'})); await settle();
  await f.voice.stop();
  assert.deepEqual(f.committed, ['第一段', '第二段', '完整指令']);
});
test('disposing pending recognition never submits a late result', async t => {
  let finish!: (r: Response) => void;
  const f = environment(t, () => new Promise(resolve => { finish = resolve; }));
  await f.voice.start(); f.audio(4); await settle(); f.voice.dispose();
  finish(Response.json({words:[{text:'删除'}]})); await settle();
  assert.equal(f.stopped(), true); assert.deepEqual(f.committed, []);
});
test('recognition failure reports a gap but later audio continues', async t => {
  let n = 0;
  const f = environment(t, async () => ++n === 1 ? Response.json({error:'fixture unavailable'},{status:503}) : Response.json({words:[{text:'继续'}]}));
  await f.voice.start(); f.audio(8); await settle();
  assert.equal(f.stopped(), false); f.audio(0.4, 0); await settle(); await f.voice.stop();
  assert.ok(f.committed.every(text => text === '继续')); assert.ok(f.errors[0].includes('fixture unavailable'));
});

test('pause speculation reuses exact audio but never commits before 400ms', async t => {
  let requests = 0;
  const f = environment(t, async () => { requests++; return Response.json({text:'下一页'}); });
  await f.voice.start(); f.audio(1); f.audio(0.16, 0); await settle();
  assert.equal(requests, 1); assert.deepEqual(f.committed, []);
  f.audio(0.24, 0); await settle();
  assert.equal(requests, 1); assert.deepEqual(f.committed, ['下一页']);
  await f.voice.stop(); assert.equal(requests, 1);
});
test('resumed speech discards an obsolete speculative transcript', async t => {
  let requests = 0;
  const f = environment(t, async () => Response.json({text: ++requests === 1 ? '删除' : '删除这个词，不要删除页面'}));
  await f.voice.start(); f.audio(1); f.audio(0.16, 0); await settle();
  f.audio(1); f.audio(0.4, 0); await settle(); await f.voice.stop();
  assert.equal(requests, 2);
  assert.deepEqual(f.committed, ['删除这个词，不要删除页面']);
});
test('overload pauses explicitly without sending a growing backlog', async t => {
  let requests = 0;
  const f = environment(t, async () => { requests++; return new Promise<Response>(() => {}); });
  await f.voice.start(); f.audio(40); await settle();
  assert.equal(f.stopped(), true); assert.ok(f.errors.some(message => message.includes('积压')));
  assert.deepEqual(f.committed, []); assert.ok(requests <= 1);
});

test('no-speech ASR results never reach the voice instruction endpoint', async t => {
  const f = environment(t, async () => Response.json({ text: '', speechDetected: false }));
  let submissions = 0;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.endsWith('/status')) return Response.json({ ready: true });
    if (url.endsWith('/voice')) { submissions++; return Response.json({ append: '' }); }
    return Response.json({ text: '', speechDetected: false });
  });
  await f.voice.start();
  f.audio(4); await settle();
  await f.voice.stop();
  assert.equal(submissions, 0);
  assert.deepEqual(f.committed, []);
  assert.deepEqual(f.errors, []);
});
