import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalASR } from '../src/asr-server.ts';

test('backend ASR bounds its queue, reports timing and recovers after overload', async t => {
  const asr = new LocalASR();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  t.mock.method(asr as any, 'recognize', async () => {
    if (++calls === 1) await blocked;
    return { text: '识别完成' };
  });
  const pending = Array.from({ length: 6 }, () => asr.transcribe(Buffer.alloc(4)));
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(calls, 1, 'only one request may enter the model at a time');
    await assert.rejects(asr.transcribe(Buffer.alloc(4)), /队列已满/);
  } finally { release(); }
  const results = await Promise.all(pending);
  assert.equal(calls, 6);
  for (const result of results) {
    assert.equal(result.text, '识别完成');
    assert.ok(result.timing.queuedMs >= 0);
    assert.ok(result.timing.processingMs >= 0);
    assert.ok(result.timing.totalMs >= result.timing.processingMs);
  }
  assert.equal((await asr.transcribe(Buffer.alloc(4))).text, '识别完成');
  asr.close();
  await assert.rejects(asr.transcribe(Buffer.alloc(4)), /已关闭/);
});

test('a failed ASR task releases the lane for subsequent audio', async t => {
  const asr = new LocalASR();
  let calls = 0;
  t.mock.method(asr as any, 'recognize', async () => {
    if (++calls === 1) throw new Error('fixture model failure');
    return { text: '继续' };
  });
  const first = asr.transcribe(Buffer.alloc(4));
  const second = asr.transcribe(Buffer.alloc(4));
  await assert.rejects(first, /fixture model failure/);
  assert.equal((await second).text, '继续');
  asr.close();
});
