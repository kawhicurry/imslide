import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ThumbnailQueue } from '../src/thumbnail-queue';
function fixture() {
  const callbacks = new Set<() => void>();
  const queue = new ThumbnailQueue(run => { callbacks.add(run); return () => { callbacks.delete(run); }; });
  const tick = () => { const run = callbacks.values().next().value; if (run) { callbacks.delete(run); run(); } };
  return { queue, tick, callbacks };
}
test('thumbnail loads are serialized and yield between documents', () => {
  const { queue, tick } = fixture(); const calls: number[] = []; let finish = () => {};
  queue.enqueue(done => { calls.push(1); finish = done; });
  queue.enqueue(() => calls.push(2));
  assert.deepEqual(calls, []); tick(); tick(); assert.deepEqual(calls, [1]);
  finish(); assert.deepEqual(calls, [1]); tick(); assert.deepEqual(calls, [1, 2]);
});
test('offscreen and superseded jobs cancel; stale completion cannot release a newer load', () => {
  const { queue, tick } = fixture(); const calls: number[] = []; let stale = () => {};
  const cancel = queue.enqueue(done => { calls.push(1); stale = done; }); tick(); cancel();
  const cancelWaiting = queue.enqueue(() => calls.push(2)); cancelWaiting();
  queue.enqueue(() => calls.push(3)); tick(); stale();
  queue.enqueue(() => calls.push(4)); tick(); assert.deepEqual(calls, [1, 3]);
});
test('interaction postpones scheduled work without duplicating jobs', () => {
  const { queue, tick, callbacks } = fixture(); let count = 0;
  queue.enqueue(() => count++); const first = [...callbacks][0]; queue.pause();
  assert.equal(callbacks.has(first), false); assert.equal(callbacks.size, 1);
  tick(); assert.equal(count, 1);
});
