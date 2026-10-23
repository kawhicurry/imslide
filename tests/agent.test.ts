import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createOpenAI } from '@ai-sdk/openai';
import { serve, ImSlide, parseDeck, type CoreEvent } from '../imslide.ts';

type Payload = { tool_choice?: string; max_completion_tokens?: number; messages: { role: string; content: string }[] };
function reply(res: ServerResponse, title?: string, action?: { action: string; page?: number }, namedTool?: string, args: object = {}) {
  if (!title && !action && !namedTool) namedTool = 'finish';
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const delta = title || action || namedTool ? { tool_calls: [{ index: 0, id: `call_${Math.random()}`, type: 'function', function: { name: namedTool || (action ? 'navigate' : 'update_page'), arguments: namedTool ? JSON.stringify(args) : JSON.stringify(action || { title, content: `# ${title}\n\n测试正文`, layout: 'center' }) } }] } : { content: '修改已保存。' };
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
  const runtime = await serve({ library:false, file: join(temp, 'slides.md'), quietMs: 25, model: createOpenAI({ apiKey: 'fixture-only', baseURL: `http://127.0.0.1:${port}/v1` }).chat('fixture'), onEvent: event => events.push(event) }, 0);
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

test('a finalized sentence steers a finish call without a lost-tail race', { timeout: 15000 }, async () => {
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
    const initial = await nextEvent(); assert.equal(initial.type, 'workspace');
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
    else if (last.content === '删掉当前页') reply(res, undefined, undefined, 'delete_page', { pages: 2 });
    else if (last.content === '清空当前ppt') reply(res, undefined, undefined, 'delete_page', { pages: 'all' });
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
    assert.ok(f.events.some(e => e.type === 'tool' && e.name === 'delete_page'));
    assert.ok(f.events.some(e => e.type === 'tool' && e.name === 'delete_page'));
    assert.equal(f.events.some(e => e.type === 'error'), false);
  } finally { await f.cleanup(); }
});
test('new steer cancels a pending delete before it mutates the page', { timeout: 15000 }, async () => {
  const started = deferred(), release = deferred(); let first = true;
  const f = await fixture(async (payload, res) => {
    if (first) { first = false; started.resolve(); await release.promise; reply(res, undefined, undefined, 'delete_page', { pages: 2 }); }
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

test('view selection and Agent editing share one stable page ID, without allowing manual creation', { timeout: 15000 }, async () => {
  const f = await fixture((payload, res) => {
    if (payload.messages.at(-1)?.role === 'tool') reply(res);
    else if (payload.messages.at(-1)?.content === '下一页') reply(res, undefined, { action: 'next' });
    else reply(res, '修改被选中的页');
  });
  try {
    f.core.steer('下一页', 'second-page'); await f.core.waitForIdle();
    const before = f.core.snapshot(); const firstId = before.pages[0].id;
    const response = await fetch(f.base + '/api/view', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pageId: firstId, deckId:'legacy', workspaceRevision:0 }) });
    assert.equal(response.status, 200); assert.equal((await response.json()).current, 0);
    f.core.steer('修改当前页', 'edit-selected'); await f.core.waitForIdle();
    const after = f.core.snapshot();
    assert.equal(after.pages[0].id, firstId); assert.equal(after.pages[0].title, '修改被选中的页');
    assert.deepEqual(after.pages[1], before.pages[1]); assert.equal(after.pages.length, 2);
    assert.deepEqual(parseDeck(await readFile(join(f.temp, 'slides.md'), 'utf8')), after);
    const noOpRevision = after.revision; await f.core.selectPage(firstId); assert.equal(f.core.snapshot().revision, noOpRevision);
    for (const body of [{ pageId: 'missing-page' }, { action: 'add', pageId: firstId }]) {
      const rejected = await fetch(f.base + '/api/view', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(rejected.status, 409);
    }
    assert.equal(f.core.snapshot().pages.length, 2);
  } finally { await f.cleanup(); }
});

 test('tool-only requests suppress prose and keep historical page bodies out of later runs', { timeout: 15000 }, async () => {
  const f = await fixture((payload, res) => {
    assert.equal(payload.tool_choice, 'required');
    if (payload.messages.at(-1)?.role === 'tool') reply(res);
    else reply(res, '内容唯一标记');
  });
  try {
    f.core.steer('创建封面'); await f.core.waitForIdle();
    f.core.steer('标题保持不变'); await f.core.waitForIdle();
    assert.equal(f.events.some(e => e.type === 'error'), false);
    assert.equal(f.events.some(e => e.type === 'text'), false);
    const secondRun = f.requests[2];
    assert.equal(secondRun.messages.filter(m => m.role === 'assistant' || m.role === 'tool').length, 0);
    assert.equal(secondRun.messages.filter(m => m.role === 'system').length, 1);
    assert.equal(f.requests.length, 4);
  } finally { await f.cleanup(); }
});


test('tool lifecycle exposes correlated inputs, success, returned failure and thrown failure', { timeout: 15000 }, async () => {
  let step = 0;
  const f = await fixture((_payload, res) => {
    step++;
    if (step === 1) reply(res, undefined, undefined, 'read_page', { pages: 1 });
    else if (step === 2) reply(res, undefined, undefined, 'edit_page', { old_string: 'not present', new_string: 'replacement' });
    else if (step === 3) reply(res, undefined, { action: 'goto', page: 99 });
    else reply(res);
  });
  try {
    f.core.steer('验证工具事件', 'lifecycle'); await f.core.waitForIdle();
    const calls = f.events.filter(e => e.type === 'tool');
    assert.equal(calls.length, 4);
    for (const call of calls) {
      assert.ok(call.callId); assert.ok(call.input);
      const result = f.events.find(e => (e.type === 'tool-result' || e.type === 'tool-error') && e.runId === call.runId && e.callId === call.callId);
      assert.ok(result, 'each call must have a correlated terminal event');
      assert.ok(f.events.indexOf(result) > f.events.indexOf(call));
    }
    assert.ok(f.events.some(e => e.type === 'tool-result' && e.name === 'edit_page' && (e.output as { ok: boolean }).ok === false));
    assert.ok(f.events.some(e => e.type === 'tool-error' && e.name === 'navigate' && e.error.includes('页面不存在')));
    assert.ok(f.events.some(e => e.type === 'done'));
  } finally { await f.cleanup(); }
});

test('tool lifecycle exposes a skipped call during steering', { timeout: 15000 }, async () => {
  const started = deferred(), release = deferred(); let step = 0;
  const f = await fixture(async (_payload, res) => {
    if (++step === 1) { started.resolve(); await release.promise; reply(res, '旧操作'); }
    else reply(res);
  });
  try {
    f.core.steer('原指令', 'old'); await started.promise;
    f.core.steer('新指令', 'new'); release.resolve(); await f.core.waitForIdle();
    const skipped = f.events.find(e => e.type === 'tool-result' && (e.output as { skipped?: boolean })?.skipped);
    assert.ok(skipped && skipped.type === 'tool-result');
    assert.ok(f.events.some(e => e.type === 'tool' && e.callId === skipped.callId && e.runId === skipped.runId));
    assert.equal(f.core.snapshot().revision, 0);
  } finally { release.resolve(); await f.cleanup(); }
});

function replyVoice(res: ServerResponse, actions: object[], pending = '', needsFollowUp = false) {
  reply(res, undefined, undefined, 'apply_voice', { completed: actions.length ? [{ instruction: '本片完整指令', actions }] : [], pending, needsFollowUp });
}

test('cumulative interim snapshots replace text; final confirmation never repeats an add', async () => {
  let call = 0;
  const f = await fixture((payload, res) => {
    const raw = payload.messages.filter(m => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('连续语音转写快照：')).at(-1)!.content;
    const snapshot = JSON.parse(raw.slice('连续语音转写快照：'.length));
    if (++call === 1) replyVoice(res, [{ tool: 'navigate', action: 'add' }], '标题改为');
    else {
      assert.equal(snapshot.transcript, '请新增一页标题改为预算');
      assert.equal('delta' in snapshot, false, 'do not repeat the same demand in a second text field');
      assert.equal(snapshot.snapshot, true);
      replyVoice(res, [{ tool: 'update_page', title: '预算', content: '# 预算', layout: 'default' }]);
    }
  });
  try {
    const input = { session: randomUUID(), seq: 0, start: 0, end: 3, raw: '请新增一页标题改为', endpoint: false, source: 'volc-stream' as const, snapshot: true };
    f.core.ingestVoice(input); await f.core.waitForIdle();
    f.core.ingestVoice({ ...input, seq: 1, end: 5, raw: '请新增一页标题改为预算' }); await f.core.waitForIdle();
    f.core.ingestVoice({ ...input, seq: 2, end: 6, raw: '请新增一页，标题改为预算。', endpoint: true }); await f.core.waitForIdle();
    assert.equal(call, 2); assert.equal(f.core.snapshot().pages.length, 2);
    assert.equal(f.core.snapshot().pages[1].title, '预算');
  } finally { await f.cleanup(); }
});

test('ASR revision arriving during inference invalidates the obsolete action', async () => {
  const started = deferred(), release = deferred(); let call = 0;
  const f = await fixture(async (_payload, res) => {
    if (++call === 1) { started.resolve(); await release.promise; replyVoice(res, [{ tool: 'update_page', title: '红色', content: '# 红色', layout: 'default' }]); }
    else replyVoice(res, [{ tool: 'update_page', title: '蓝色', content: '# 蓝色', layout: 'default' }]);
  });
  try {
    const input = { session: randomUUID(), seq: 0, start: 0, end: 3, raw: '把标题改成红色', endpoint: false, source: 'volc-stream' as const, snapshot: true };
    f.core.ingestVoice(input); await started.promise;
    f.core.ingestVoice({ ...input, seq: 1, end: 4, raw: '把标题改成蓝色' }); release.resolve();
    await f.core.waitForIdle();
    assert.equal(f.core.snapshot().pages[0].title, '蓝色');
    assert.equal(f.events.some(e => e.type === 'deck' && e.deck.pages.some(p => p.title === '红色')), false);
  } finally { release.resolve(); await f.cleanup(); }
});

test('one backend Agent calibrates speech and executes a complete short command in one model call', async () => {
  const f = await fixture((_payload, res) => replyVoice(res, [{ tool: 'navigate', action: 'add' }]));
  try {
    const session = randomUUID();
    const input = { session, seq: 0, start: 0, end: 2, raw: '请帮我新增一张空白幻灯片', endpoint: true };
    const receipt = f.core.ingestVoice(input);
    await f.core.waitForIdle();
    assert.equal(f.requests.length, 1);
    assert.equal(f.core.snapshot().pages.length, 2);
    assert.deepEqual(f.core.ingestVoice(input), receipt);
    assert.equal(f.requests.length, 1, 'retries must not execute twice');
    assert.throws(() => f.core.ingestVoice({ ...input, raw: '不同内容' }), /冲突/);
  } finally { await f.cleanup(); }
});

test('continuous voice keeps tool history and executes dependent actions sequentially in one inference', async () => {
  let step = 0;
  const f = await fixture((payload, res) => {
    if (++step === 1) replyVoice(res, [{ tool: 'navigate', action: 'add' }], '标题改成');
    else if (step === 2) {
      assert.ok(payload.messages.some(message => message.role === 'tool'), 'previous tools persist');
      replyVoice(res, [{ tool: 'update_page', title: '语音验收', content: '# 语音验收\n\n项目目标是提高效率\n\n项目预算是100万元', layout: 'default' }]);
    } else replyVoice(res, [
      { tool: 'edit_page', old_string: '100万元', new_string: '80万元' },
      { tool: 'delete_page', pages: 'current' },
    ]);
  });
  const session = randomUUID();
  try {
    f.core.ingestVoice({ session, seq: 0, start: 0, end: 4, raw: '新增一页标题改成', endpoint: false });
    await f.core.waitForIdle();
    assert.equal(f.core.snapshot().pages.length, 2, 'complete action executes during speech');
    f.core.ingestVoice({ session, seq: 1, start: 2, end: 8, raw: '标题改成语音验收添加目标提高效率和预算100万元', endpoint: false });
    await f.core.waitForIdle();
    assert.match(f.core.snapshot().pages[1].content, /100万元/);
    f.core.ingestVoice({ session, seq: 2, start: 6, end: 12, raw: '预算改80万元然后删除语音验收这一页', endpoint: true });
    await f.core.waitForIdle();
    const snapshots = f.events.filter((event): event is Extract<CoreEvent, { type: 'deck' }> => event.type === 'deck');
    assert.ok(snapshots.some(event => event.deck.pages.some(page => /80万元/.test(page.content))));
    assert.equal(f.core.snapshot().pages.length, 1);
    assert.equal(f.requests.length, 3, 'no separate calibration or finish inference');
    assert.equal(f.events.some(event => event.type === 'tool-skipped' || event.type === 'error'), false);
  } finally { await f.cleanup(); }
});

test('a new speech continuation does not cancel an earlier complete action', async () => {
  const started = deferred(), release = deferred(); let step = 0;
  const f = await fixture(async (_payload, res) => {
    if (++step === 1) { started.resolve(); await release.promise; replyVoice(res, [{ tool: 'navigate', action: 'add' }]); }
    else replyVoice(res, [{ tool: 'update_page', title: '续句', content: '# 续句', layout: 'default' }]);
  });
  const session = randomUUID();
  try {
    f.core.ingestVoice({ session, seq: 0, start: 0, end: 4, raw: '新增一页', endpoint: false });
    await started.promise;
    f.core.ingestVoice({ session, seq: 1, start: 2, end: 8, raw: '标题改为续句', endpoint: true });
    release.resolve(); await f.core.waitForIdle();
    assert.equal(f.core.snapshot().pages.length, 2);
    assert.equal(f.core.snapshot().pages[1].title, '续句');
    assert.equal(f.events.some(event => event.type === 'tool-skipped'), false);
  } finally { release.resolve(); await f.cleanup(); }
});

test('unfinished speech and invented placeholders cannot become visible content', async () => {
  let step = 0;
  const f = await fixture((_payload, res) => {
    if (++step === 1) replyVoice(res, [
      { tool: 'navigate', action: 'add' },
      { tool: 'update_page', title: '标题', content: '# 标题\n\n待补充', layout: 'default' },
    ], '然后');
    else replyVoice(res, [{ tool: 'update_page', title: '标题', content: '# 标题', layout: 'default' }], '然后');
  });
  try {
    f.core.ingestVoice({ session: randomUUID(), seq: 0, start: 0, end: 4, raw: '新增一页标题为标题然后', endpoint: false });
    await f.core.waitForIdle();
    assert.equal(f.core.snapshot().pages.length, 2, 'successful creation is not replayed on correction');
    assert.equal(f.core.snapshot().pages[1].content, '# 标题');
    assert.ok(f.events.filter(event => event.type === 'deck').every(event => !JSON.stringify(event.deck).includes('待补充')));
    assert.equal(f.requests.length, 2);
  } finally { await f.cleanup(); }
});

test('a failed dependent action stops the rest of a speech batch until corrected', async () => {
  let step = 0;
  const f = await fixture((_payload, res) => {
    if (++step === 1) replyVoice(res, [
      { tool: 'navigate', action: 'add' },
      { tool: 'edit_page', old_string: '不存在的文字', new_string: '预算80万元' },
      { tool: 'delete_page', pages: 'current' },
    ]);
    else replyVoice(res, [
      { tool: 'update_page', title: '预算', content: '# 预算\n\n80万元', layout: 'default' },
      { tool: 'delete_page', pages: 'current' },
    ]);
  });
  try {
    f.core.ingestVoice({ session: randomUUID(), seq: 0, start: 0, end: 4, raw: '新增一页填写预算80万元然后删除该页', endpoint: true });
    await f.core.waitForIdle();
    const saved = f.events.filter((event): event is Extract<CoreEvent, { type: 'deck' }> => event.type === 'deck');
    assert.deepEqual(saved.map(event => event.deck.pages.length), [2, 2, 1]);
    assert.match(saved[1].deck.pages[1].content, /80万元/);
    assert.equal(f.requests.length, 2);
  } finally { await f.cleanup(); }
});

test('compact voice parameters retain ordered actions and reject a duplicated primary title before writing', async () => {
  let call = 0;
  const f = await fixture((_payload, res) => {
    call++;
    if (call === 1) reply(res, undefined, undefined, 'apply_voice', { completed: [{ actions: [{ tool: 'update_page', title: '验收', content: '# 验收\n\n项目目标是提高效率', layout: 'default' }] }] });
    else if (call === 2) replyVoice(res, [{ tool: 'edit_page', old_string: '项目目标是提高效率', new_string: '# 验收\n\n项目目标是提高效率\n项目预算是100万元' }]);
    else replyVoice(res, [{ tool: 'edit_page', old_string: '项目目标是提高效率', new_string: '项目目标是提高效率\n项目预算是100万元' }]);
  });
  try {
    const session = randomUUID();
    f.core.ingestVoice({ session, seq: 0, start: 0, end: 3, raw: '标题验收，项目目标是提高效率', endpoint: true });
    await f.core.waitForIdle();
    f.core.ingestVoice({ session, seq: 1, start: 3, end: 6, raw: '再添加项目预算是100万元', endpoint: true });
    await f.core.waitForIdle();
    assert.equal(call, 3);
    assert.match(f.core.snapshot().pages[0].content, /项目预算是100万元/);
    const snapshots = f.events.filter((event): event is Extract<CoreEvent, { type: 'deck' }> => event.type === 'deck');
    assert.ok(snapshots.every(event => event.deck.pages.every(page => (page.content.match(/^# 验收$/gm) || []).length <= 1)));
    assert.ok(f.events.some(event => event.type === 'tool-result' && JSON.stringify(event.output).includes('重复了已有主标题')));
  } finally { await f.cleanup(); }
});
