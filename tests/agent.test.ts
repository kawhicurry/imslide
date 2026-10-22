import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createOpenAI } from '@ai-sdk/openai';
import { serve, ImSlide, parseDeck, type CoreEvent } from '../imslide.ts';

type Payload = { messages: { role: string; content: string }[] };
function reply(res: ServerResponse, title?: string, action?: { action: string; page?: number }, namedTool?: string) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const delta = title || action || namedTool ? { tool_calls: [{ index: 0, id: `call_${Math.random()}`, type: 'function', function: { name: namedTool || (action ? 'navigate' : 'update_current_page'), arguments: namedTool ? '{}' : JSON.stringify(action || { title, content: `# ${title}\n\n测试正文`, layout: 'center' }) } }] } : { content: '修改已保存。' };
  const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: 'fixture-response', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  res.write(chunk({ role: 'assistant', ...delta }, null));
  res.write(chunk({}, title || action || namedTool ? 'tool_calls' : 'stop')); res.end('data: [DONE]\n\n');
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function fixture(handler: (payload: Payload, res: ServerResponse) => Promise<void> | void) {
  const temp = await mkdtemp(join(tmpdir(), 'imslide-test-'));
  const events: CoreEvent[] = [];
  const requests: Payload[] = [];
  const model = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body); requests.push(payload);
    try { await handler(payload, res); } catch (e) { res.destroy(e as Error); }
  });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  const port = (model.address() as AddressInfo).port;
  const runtime = await serve({ file: join(temp, 'slides.md'), quietMs: 25, model: createOpenAI({ apiKey: 'fixture-only', baseURL: `http://127.0.0.1:${port}/v1` }).chat('fixture'), onEvent: event => events.push(event) }, 0);
  if (!runtime.server.listening) await once(runtime.server, 'listening');
  const base = `http://127.0.0.1:${(runtime.server.address() as AddressInfo).port}`;
  return { ...runtime, base, events, requests, temp, async cleanup() {
    await runtime.core.close(); runtime.server.closeAllConnections(); model.closeAllConnections();
    await Promise.all([new Promise<void>(r => runtime.server.close(() => r())), new Promise<void>(r => model.close(() => r()))]);
    await rm(temp, { recursive: true, force: true });
  } };
}

test('single-file capability edits, navigates back and restores solely from slides.md', { timeout: 15000 }, async () => {
  const f = await fixture((payload, res) => {
    const last = payload.messages.at(-1)!;
    if (last.role === 'tool') reply(res);
    else if (last.content === '下一页') reply(res, undefined, { action: 'next' });
    else if (last.content === '返回第一页') reply(res, undefined, { action: 'goto', page: 1 });
    else reply(res, last.content);
  });
  try {
    async function instruction(text: string) {
      const response = await fetch(f.base + '/api/input', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'instruction', id: String(Math.random()), text, mode: 'steer' }) });
      assert.equal(response.status, 202); await f.core.waitForIdle(); return f.core.snapshot();
    }
    assert.equal(f.core.snapshot().pages.length, 1); assert.equal(f.core.snapshot().pages[0].content, '');
    await instruction('第一页标题'); await instruction('下一页'); await instruction('第二页标题'); await instruction('返回第一页');
    const deck = await instruction('第一页修改后');
    assert.equal(deck.current, 0); assert.equal(deck.pages[0].title, '第一页修改后'); assert.equal(deck.pages[1].title, '第二页标题');
    const markdown = await readFile(join(f.temp, 'slides.md'), 'utf8');
    assert.deepEqual(parseDeck(markdown), deck);
    const restored = await ImSlide.open({ file: join(f.temp, 'slides.md') });
    assert.deepEqual(restored.snapshot(), deck); await restored.close();
    assert.equal(f.events.some(e => e.type === 'error'), false);
    assert.equal(f.requests.length, 10);
    for (const path of ['/api/action']) {
      const response = await fetch(f.base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'next' }) });
      assert.equal(response.status, 404);
    }
  } finally { await f.cleanup(); }
});

test('steer enters the running stream before its next step; obsolete tool never writes', { timeout: 15000 }, async () => {
  const started = deferred(), release = deferred();
  let first = true;
  const f = await fixture(async (payload, res) => {
    if (first) { first = false; started.resolve(); await release.promise; reply(res, '红色旧版本'); return; }
    const last = payload.messages.at(-1)!;
    if (last.role === 'user') { assert.equal(last.content, '改为蓝色'); reply(res, '蓝色新版本'); }
    else {
      assert.ok(payload.messages.some(m => m.role === 'user' && m.content === '改为蓝色'), 'steering must persist across steps');
      reply(res);
    }
  });
  try {
    const initial = f.core.steer('做红色封面', 'first'); await started.promise;
    const steering = f.core.steer('改为蓝色', 'second');
    assert.equal(steering.runId, initial.runId); assert.equal(steering.mode, 'steer');
    assert.deepEqual(f.core.steer('改为蓝色', 'second'), steering, 'duplicate id does not enqueue again');
    release.resolve(); await f.core.waitForIdle();
    assert.equal(f.core.snapshot().pages[0].title, '蓝色新版本');
    assert.equal(f.core.snapshot().revision, 1, 'old tool must not persist');
    assert.equal(f.events.filter(e => e.type === 'tool-skipped').length, 1);
    assert.equal(f.events.filter(e => e.type === 'done').length, 1);
    assert.equal(f.events.filter(e => e.type === 'accepted').length, 2);
    assert.equal(f.events.some(e => e.type === 'error'), false);
  } finally { release.resolve(); await f.cleanup(); }
});

test('a finalized sentence steers a text-only final response without a lost-tail race', { timeout: 15000 }, async () => {
  const started = deferred(), release = deferred(); let first = true;
  const f = await fixture(async (payload, res) => {
    if (first) { first = false; started.resolve(); await release.promise; reply(res); return; }
    if (payload.messages.at(-1)!.role === 'user') reply(res, '整句修订版本'); else reply(res);
  });
  try {
    const firstRun = f.core.steer('先考虑一下', 'first'); await started.promise;
    f.core.ingest({ type: 'transcript', utteranceId: 'sentence-1', text: '改成', isFinal: false });
    assert.equal(f.events.filter(e => e.type === 'accepted').length, 1);
    f.core.ingest({ type: 'transcript', utteranceId: 'sentence-1', text: '改成整句修订版本', isFinal: true, endOfUtterance: true });
    const receipt = f.events.find(e => e.type === 'accepted' && e.messageId === 'speech:sentence-1');
    assert.ok(receipt && 'runId' in receipt); assert.equal(receipt.runId, firstRun.runId);
    release.resolve(); await f.core.waitForIdle();
    assert.equal(f.core.snapshot().pages[0].title, '整句修订版本');
    assert.equal(f.requests.length, 3); assert.equal(f.events.filter(e => e.type === 'done').length, 1);
  } finally { release.resolve(); await f.cleanup(); }
});

test('viewer SSE receives snapshots; receiving or browsing never writes the document', { timeout: 15000 }, async () => {
  const f = await fixture((payload, res) => payload.messages.at(-1)?.role === 'user' ? reply(res, undefined, { action: 'next' }) : reply(res));
  const abort = new AbortController();
  try {
    const response = await fetch(f.base + '/api/events', { signal: abort.signal });
    assert.match(response.headers.get('content-type')!, /text\/event-stream/);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder(); let buffered = '';
    async function nextEvent() {
      while (!buffered.includes('\n\n')) {
        const chunk = await reader.read(); assert.equal(chunk.done, false); buffered += decoder.decode(chunk.value);
      }
      const index = buffered.indexOf('\n\n'); const item = buffered.slice(0, index); buffered = buffered.slice(index + 2);
      return JSON.parse(item.replace(/^data: /, '')) as CoreEvent;
    }
    const before = await readFile(join(f.temp, 'slides.md'), 'utf8');
    const initial = await nextEvent(); assert.equal(initial.type, 'deck');
    await fetch(f.base + '/api/deck');
    assert.equal(await readFile(join(f.temp, 'slides.md'), 'utf8'), before);
    // Only an Agent tool changes the state and sends a new snapshot.
    f.core.steer('下一页', 'sse-test-next');
    await f.core.waitForIdle();
    let update = await nextEvent();
    while (update.type !== 'deck') update = await nextEvent();
    assert.equal(update.type, 'deck');
    if (update.type === 'deck') { assert.equal(update.deck.pages.length, 2); assert.equal(update.deck.current, 1); }
    abort.abort(); await reader.cancel().catch(() => {});
  } finally { abort.abort(); await f.cleanup(); }
});

test('interaction HTTP input accepts voice drafts and steers the same active run', { timeout: 15000 }, async () => {
  const started = deferred(), release = deferred(); let first = true;
  const f = await fixture(async (payload, res) => {
    if (first) { first = false; started.resolve(); await release.promise; reply(res, '旧要求'); return; }
    if (payload.messages.at(-1)?.role === 'user') reply(res, '语音新要求'); else reply(res);
  });
  async function send(body: unknown) {
    const response = await fetch(f.base + '/api/input', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 202); return response.json();
  }
  try {
    const chatResponse = await fetch(f.base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: '旧要求', id: 'http-text', mode: 'steer' }) });
    assert.equal(chatResponse.status, 202);
    const firstReceipt = await chatResponse.json(); await started.promise;
    await send({ type: 'transcript', utteranceId: 'http-voice', text: '语音新', isFinal: false });
    assert.equal(f.events.filter(event => event.type === 'accepted').length, 1);
    const final = await send({ type: 'transcript', utteranceId: 'http-voice', text: '语音新要求', isFinal: true, endOfUtterance: true });
    assert.equal(final.status, 'committed');
    const accepted = f.events.find(event => event.type === 'accepted' && event.messageId === 'speech:http-voice');
    assert.ok(accepted && 'runId' in accepted); assert.equal(accepted.runId, firstReceipt.runId);
    release.resolve(); await f.core.waitForIdle();
    assert.equal(f.core.snapshot().pages[0].title, '语音新要求'); assert.equal(f.core.snapshot().revision, 1);
  } finally { release.resolve(); await f.cleanup(); }
});

test('chat delete and clear execute Agent tools and persist exactly the remaining pages', { timeout: 15000 }, async () => {
  const f = await fixture((payload, res) => {
    const last = payload.messages.at(-1)!;
    if (last.role === 'tool') reply(res);
    else if (last.content === '下一页') reply(res, undefined, { action: 'next' });
    else if (last.content === '删掉当前页') reply(res, undefined, undefined, 'delete_current_page');
    else if (last.content === '清空当前ppt') reply(res, undefined, undefined, 'clear_presentation');
    else reply(res, last.content);
  });
  try {
    async function chat(message: string, id = String(Math.random())) {
      const response = await fetch(f.base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message, id }) });
      assert.equal(response.status, 202); await f.core.waitForIdle(); return f.core.snapshot();
    }
    await chat('保留的第一页'); await chat('下一页'); await chat('删除的第二页');
    const deleted = await chat('删掉当前页');
    assert.equal(deleted.pages.length, 1); assert.equal(deleted.current, 0);
    assert.equal(deleted.pages[0].title, '保留的第一页');
    await chat('下一页'); await chat('新的第二页');
    const cleared = await chat('清空当前ppt', 'clear-once');
    assert.equal(cleared.pages.length, 1); assert.equal(cleared.pages[0].content, '');
    assert.equal(cleared.current, 0); assert.equal(cleared.pages[0].layout, 'default');
    const retry = await chat('清空当前ppt', 'clear-once');
    assert.deepEqual(retry, cleared, 'a transport retry must not clear the new document twice');
    assert.deepEqual(parseDeck(await readFile(join(f.temp, 'slides.md'), 'utf8')), cleared);
    assert.ok(f.events.some(e => e.type === 'tool' && e.name === 'delete_current_page'));
    assert.ok(f.events.some(e => e.type === 'tool' && e.name === 'clear_presentation'));
    assert.equal(f.events.some(e => e.type === 'error'), false);
  } finally { await f.cleanup(); }
});
test('new steer cancels a pending delete before it mutates the page', { timeout: 15000 }, async () => {
  const started = deferred(), release = deferred(); let first = true;
  const f = await fixture(async (payload, res) => {
    if (first) { first = false; started.resolve(); await release.promise; reply(res, undefined, undefined, 'delete_current_page'); }
    else if (payload.messages.at(-1)?.role === 'user') reply(res, '保留并改标题');
    else reply(res);
  });
  try {
    const id = f.core.snapshot().pages[0].id;
    f.core.steer('删掉当前页', 'pending-delete'); await started.promise;
    f.core.steer('不要删了，保留并改标题', 'cancel-delete'); release.resolve(); await f.core.waitForIdle();
    const deck = f.core.snapshot(); assert.equal(deck.pages[0].id, id);
    assert.equal(deck.pages[0].title, '保留并改标题'); assert.equal(deck.revision, 1);
    assert.ok(f.events.some(e => e.type === 'tool-skipped'));
  } finally { release.resolve(); await f.cleanup(); }
});
