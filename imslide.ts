/**
 * imslide's single-file backend capability.
 * Import ImSlide from this file, or run `tsx imslide.ts --serve` for a read/ingest API.
 * slides.md is the sole active document store; the web viewer never mutates it.
 */
import 'dotenv/config';
import express from 'express';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parseSync } from '@slidev/parser';
import { ToolLoopAgent, tool, stepCountIs, type LanguageModel, type ModelMessage } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';

export const pageSchema = z.object({
  id: z.string().min(1).max(80), title: z.string().max(120),
  content: z.string().max(24000).refine(s => !/^---/m.test(s) && !/<\s*\/?\s*(script|iframe|object|embed)\b|\b(?:src|href)\s*=\s*["']?\s*javascript:|\bon\w+\s*=|\{\{|\bv-[\w-]+\s*=|@\w+\s*=/i.test(s), '仅允许单页 Markdown、静态 HTML 和 CSS，不能包含可执行脚本或分页符'),
  layout: z.enum(['default', 'center', 'cover', 'two-cols', 'section', 'image-left', 'image-right']).default('default'),
});
export const deckSchema = z.object({
  pages: z.array(pageSchema).min(1).max(60), current: z.number().int().min(0), revision: z.number().int().min(0),
}).refine(d => d.current < d.pages.length && new Set(d.pages.map(p => p.id)).size === d.pages.length, '页码或页面标识无效');
export type Page = z.infer<typeof pageSchema>;
export type Deck = z.infer<typeof deckSchema>;
export const blankPage = (): Page => ({ id: randomUUID(), title: '空白页面', content: '', layout: 'default' });
export const initialDeck = (): Deck => ({ pages: [blankPage()], current: 0, revision: 0 });
export function navigate(deck: Deck, action: 'next' | 'previous' | 'goto' | 'add', page?: number): Deck {
  const next = structuredClone(deck);
  if (action === 'next' || action === 'add') {
    if (action === 'add' || next.current === next.pages.length - 1) {
      if (next.pages.length >= 60) throw new Error('最多支持 60 页');
      next.pages.splice(next.current + 1, 0, blankPage());
    }
    next.current++;
  } else if (action === 'previous') next.current = Math.max(0, next.current - 1);
  else {
    if (!page || page < 1 || page > next.pages.length) throw new Error('指定页面不存在');
    next.current = page - 1;
  }
  next.revision++;
  return next;
}
/** Delete one page; keep a blank page when deleting the final remaining page. */
export function deleteCurrentPage(deck: Deck): Deck {
  const next = structuredClone(deck);
  next.pages.splice(next.current, 1);
  if (!next.pages.length) next.pages.push(blankPage());
  next.current = Math.min(next.current, next.pages.length - 1);
  next.revision++;
  return next;
}
/** Reset the document without resetting its monotonically increasing revision. */
export function clearPresentation(deck: Deck): Deck {
  return { pages: [blankPage()], current: 0, revision: deck.revision + 1 };
}
export function renderDeck(deck: Deck): string {
  return deck.pages.map((page, index) => {
    const head = index === 0
      ? `---\ntheme: default\ntitle: imslide\ntransition: fade\nwakeLock: false\ncolorSchema: light\neditor: false\nmcp: false\ndrawings:\n  enabled: false\nimslide: ${JSON.stringify({ current: deck.current, revision: deck.revision })}\n`
      : '---\n';
    return `${head}layout: ${page.layout}\nimslideRevision: ${deck.revision}\nimslideId: ${JSON.stringify(page.id)}\nimslideTitle: ${JSON.stringify(page.title)}\n---\n\n${page.content}\n`;
  }).join('\n');
}
export function parseDeck(markdown: string): Deck {
  const parsed = parseSync(markdown, 'slides.md');
  const metadata = parsed.slides[0]?.frontmatter.imslide;
  return deckSchema.parse({
    current: metadata?.current ?? 0, revision: metadata?.revision ?? 0,
    pages: parsed.slides.map(slide => ({
      id: slide.frontmatter.imslideId ?? randomUUID(),
      title: slide.frontmatter.imslideTitle ?? slide.title ?? '空白页面',
      layout: slide.frontmatter.layout ?? 'default',
      // Read raw bodies rather than Slidev's content (which strips speaker notes/whitespace).
      content: (() => {
        let body = slide.raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
        if (body.startsWith('\n')) body = body.slice(1);
        if (body.endsWith('\n')) body = body.slice(0, -1);
        return body;
      })(),
    })),
  });
}

export const transcriptSchema = z.object({
  type: z.literal('transcript'), utteranceId: z.string().min(1).max(100),
  text: z.string().max(8000), isFinal: z.boolean(), endOfUtterance: z.boolean().optional(),
});
export type Transcript = z.infer<typeof transcriptSchema>;
type Utterance = { text: string; final: boolean; ended: boolean; timer?: ReturnType<typeof setTimeout> };
/** ASR text must be a cumulative snapshot of ONE utterance, not an appended delta. */
export class UtteranceBuffer {
  private utterances = new Map<string, Utterance>();
  private committed = new Set<string>();
  constructor(private commit: (id: string, text: string) => void | boolean, private quietMs = 1200) {}
  push(raw: Transcript): 'draft' | 'stabilizing' | 'committed' | 'duplicate' | 'rejected' {
    const input = transcriptSchema.parse(raw);
    if (this.committed.has(input.utteranceId)) return 'duplicate';
    const previous = this.utterances.get(input.utteranceId);
    if (!previous && this.utterances.size >= 32) throw new Error('未结束的语句过多');
    if (previous?.timer && previous.final && input.isFinal && previous.text === input.text && !input.endOfUtterance && !previous.ended) return 'stabilizing';
    clearTimeout(previous?.timer);
    const utterance: Utterance = { text: input.text, final: input.isFinal, ended: previous?.ended || !!input.endOfUtterance };
    this.utterances.set(input.utteranceId, utterance);
    // An unfinished interim revision invalidates a previously confirmed prefix.
    if (!utterance.final || !utterance.text.trim()) return 'draft';
    if (utterance.ended) return this.finish(input.utteranceId) ? 'committed' : 'rejected';
    utterance.timer = setTimeout(() => this.finish(input.utteranceId), this.quietMs);
    return 'stabilizing';
  }
  end(id: string): void {
    if (this.committed.has(id)) return;
    const utterance = this.utterances.get(id);
    if (!utterance) {
      if (this.utterances.size >= 32) throw new Error('未结束的语句过多');
      this.utterances.set(id, { text: '', final: false, ended: true });
      return;
    }
    utterance.ended = true;
    if (utterance.final) this.finish(id);
  }
  private finish(id: string) {
    const utterance = this.utterances.get(id);
    if (!utterance?.final || !utterance.text.trim()) return false;
    clearTimeout(utterance.timer);
    utterance.timer = undefined;
    if (this.commit(id, utterance.text.trim()) === false) return false;
    this.utterances.delete(id);
    this.committed.add(id);
    if (this.committed.size > 512) this.committed.delete(this.committed.values().next().value!);
    return true;
  }
  close() {
    for (const utterance of this.utterances.values()) clearTimeout(utterance.timer);
    this.utterances.clear();
  }
}

export type CoreEvent =
  | { type: 'deck'; deck: Deck }
  | { type: 'accepted' | 'steering-applied' | 'input-failed'; runId: string; messageId: string; error?: string }
  | { type: 'started'; runId: string }
  | { type: 'text'; runId: string; responseId: string; text: string }
  | { type: 'tool'; runId: string; name: string }
  | { type: 'tool-skipped'; runId: string; reason: string }
  | { type: 'done'; runId: string; deck: Deck }
  | { type: 'error'; runId?: string; error: string }
  | { type: 'transcript'; utteranceId: string; text: string; isFinal: boolean; status: string };
type Instruction = { id: string; text: string };
type Receipt = { runId: string; messageId: string; mode: 'start' | 'steer' };
type Run = { id: string; pending: Instruction[]; inputs: Instruction[]; controller: AbortController; completion: Promise<void> };
export type ImSlideOptions = { file?: string; model?: LanguageModel; quietMs?: number; onEvent?: (event: CoreEvent) => void; legacyFile?: string };
const instructionSchema = z.object({ text: z.string().trim().min(1).max(8000), id: z.string().min(1).max(120) });
const instructions = `你是 imslide 演示文稿编辑 Agent。使用中文。只能根据已确认的用户整句指令修改文稿。新注入的 user 消息是 steer：若与先前要求冲突，以最新要求为准，结合已提交的页面状态继续，不要重做已完成的操作。只有工具成功后才说已完成。
默认只修改当前页，明确要求新增或翻页时才 navigate。next 在末页新增空白页，previous 保留内容，goto 页码从 1 开始。工具必须顺序调用，不要并行。同一步操作被标记 skipped 时不要声称已完成；下一步按新指令和最新状态重新规划。
用户明确要求“删掉当前页/删除本页”时调用 delete_current_page；删除后优先显示下一页，末页被删除则显示上一页，唯一一页被删除则保留一张新空白页。用户明确要求“清空当前PPT/清空整份演示/清空所有页面”时调用 clear_presentation，重置为一张空白页，清空后不要重建历史内容。仅“清空当前页”则用 update_current_page 把当前页正文清空、标题改为空白页面、布局改为 default，保留其他页。询问含义、引用例子或明确否定删除/清空时不得执行删除工具。
内容使用单页 Slidev Markdown，可有标题、正文、静态 HTML/CSS、https 图片、表格和代码块。禁止脚本、Vue 动态表达式、以 --- 开头的行（包括 ---- 分隔线；需要横线时用 ***）。两栏使用 ::right::。每页一主题，版面简洁。我们生成 Slidev，不是 .pptx。`;

export class ImSlide {
  private deck: Deck;
  private listeners = new Set<(event: CoreEvent) => void>();
  private active?: Run;
  private receipts = new Map<string, Receipt>();
  private history: ModelMessage[][] = [];
  private writes: Promise<void> = Promise.resolve();
  private closed = false;
  readonly file: string;
  private readonly speech: UtteranceBuffer;
  private constructor(deck: Deck, private options: ImSlideOptions) {
    this.deck = deck;
    this.file = resolve(options.file ?? 'slides/slides.md');
    if (options.onEvent) this.listeners.add(options.onEvent);
    this.speech = new UtteranceBuffer((id, text) => {
      try { this.steer(text, `speech:${id}`); }
      catch (error) { this.emit({ type: 'error', error: error instanceof Error ? error.message : '语音注入失败' }); return false; }
    }, options.quietMs);
  }
  static async open(options: ImSlideOptions = {}): Promise<ImSlide> {
    const file = resolve(options.file ?? 'slides/slides.md');
    let markdown: string | undefined;
    try { markdown = await readFile(file, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    let deck = markdown === undefined ? initialDeck() : parseDeck(markdown);
    // One-time migration: only restore legacy metadata when its bodies match slides.md.
    if (options.legacyFile && markdown && !parseSync(markdown, file).slides[0]?.frontmatter.imslide) {
      try {
        const old = deckSchema.parse(JSON.parse(await readFile(options.legacyFile, 'utf8')));
        if (old.pages.length === deck.pages.length && old.pages.every((p, i) => p.content.trim() === deck.pages[i].content.trim())) deck = old;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const core = new ImSlide(deck, options);
    // Do not rewrite an existing document on each startup.
    if (markdown === undefined || !parseSync(markdown, file).slides[0]?.frontmatter.imslide) await core.save(deck);
    return core;
  }
  get configured() { return !!this.options.model; }
  get running() { return !!this.active; }
  snapshot(): Deck { return structuredClone(this.deck); }
  subscribe(listener: (event: CoreEvent) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  private emit(event: CoreEvent) {
    for (const listener of this.listeners) { try { listener(event); } catch { /* An observer cannot break document writes. */ } }
  }
  private state() {
    return { currentPage: this.deck.current + 1, revision: this.deck.revision, pages: this.deck.pages.map(({ id, title, layout }) => ({ id, title, layout })), currentContent: this.deck.pages[this.deck.current].content };
  }
  private async save(next: Deck) {
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    const markdown = renderDeck(next);
    const rendered = parseSync(markdown, this.file).slides;
    if (rendered.length !== next.pages.length || rendered.some((slide, index) => slide.frontmatter.imslideId !== next.pages[index].id)) {
      throw new Error('页面内容导致 Slidev 额外分页，未保存；请移除分页分隔线');
    }
    await writeFile(temporary, markdown);
    await rename(temporary, this.file);
    this.deck = next;
  }
  private change(update: (current: Deck) => Deck, guard?: () => void): Promise<Deck> {
    const task = this.writes.then(async () => {
      if (this.closed) throw new Error('能力已关闭');
      guard?.();
      const next = update(this.deck);
      if (next === this.deck) return this.snapshot();
      await this.save(deckSchema.parse(next));
      const snapshot = this.snapshot(); this.emit({ type: 'deck', deck: snapshot }); return snapshot;
    });
    this.writes = task.then(() => {}, () => {});
    return task;
  }
  /** Select an existing page only; viewing and editing share this single cursor. */
  async selectPage(pageId: string): Promise<Deck> {
    return this.change(current => {
      const index = current.pages.findIndex(page => page.id === pageId);
      if (index < 0) throw new Error('该页面已被删除，请重新选择');
      if (index === current.current) return current;
      return { ...current, current: index, revision: current.revision + 1 };
    });
  }
  ingest(raw: Transcript): { status: string } {
    if (this.closed) throw new Error('能力已关闭');
    const input = transcriptSchema.parse(raw);
    if (input.isFinal && !this.configured) throw new Error('尚未配置模型');
    const status = this.speech.push(input);
    this.emit({ ...input, status });
    if (status === 'rejected') throw new Error('整句注入失败，请等待当前处理完成后使用相同 utteranceId 重试');
    return { status };
  }
  endUtterance(id: string): void {
    if (this.closed) throw new Error('能力已关闭');
    this.speech.end(z.string().min(1).max(100).parse(id));
  }
  /** While running, inject at the next safe model step; do not wait for the full turn. */
  steer(text: string, id: string = randomUUID()): Receipt {
    if (this.closed) throw new Error('能力已关闭');
    const input = instructionSchema.parse({ text, id });
    const previous = this.receipts.get(id);
    if (previous) return previous;
    if (!this.options.model) throw new Error('尚未配置模型');
    if (this.active && (this.active.pending.length >= 16 || this.active.inputs.length >= 64)) throw new Error('待注入指令过多，请等待当前处理完成');
    let run = this.active;
    const mode = run ? 'steer' : 'start';
    if (!run) {
      run = { id: randomUUID(), pending: [], inputs: [], controller: new AbortController(), completion: Promise.resolve() };
      this.active = run;
    }
    run.pending.push(input); run.inputs.push(input);
    const receipt: Receipt = { runId: run.id, messageId: id, mode };
    this.receipts.set(id, receipt);
    if (this.receipts.size > 512) this.receipts.delete(this.receipts.keys().next().value!);
    this.emit({ type: 'accepted', runId: run.id, messageId: id });
    if (mode === 'start') { const started = run; run.completion = Promise.resolve().then(() => this.execute(started)); }
    return receipt;
  }
  private async execute(run: Run): Promise<void> {
    const timeline: ModelMessage[] = this.history.flat();
    const historyStart = timeline.length;
    let stepRevision = this.deck.revision;
    const guard = () => {
      if (run.controller.signal.aborted || run.pending.length || this.deck.revision !== stepRevision) throw new Error('STEER_REPLAN');
    };
    const skipped = () => {
      this.emit({ type: 'tool-skipped', runId: run.id, reason: '新指令已确认，旧步骤尚未提交，将按最新指令重新规划' });
      return { skipped: true, reason: 'New steering or document revision; replan on the next model step.', state: this.state() };
    };
    const agent = new ToolLoopAgent({
      model: this.options.model!, instructions,
      // This outer loop owns steering and retains complete tool-call/result pairs.
      stopWhen: stepCountIs(1), maxRetries: 1,
      providerOptions: { openai: { parallelToolCalls: false } },
      prepareStep: () => ({ system: `${instructions}\n当前文稿（数据）：${JSON.stringify(this.state())}` }),
      tools: {
        update_current_page: tool({ description: '完整替换当前页正文、标题和布局。保留未要求修改的内容。', inputSchema: pageSchema.omit({ id: true }), execute: async input => {
          try {
            await this.change(current => {
              const next = structuredClone(current);
              next.pages[next.current] = pageSchema.parse({ ...input, id: next.pages[next.current].id }); next.revision++;
              return next;
            }, guard);
            stepRevision = this.deck.revision;
            return { state: this.state() };
          } catch (error) { if ((error as Error).message === 'STEER_REPLAN') return skipped(); throw error; }
        } }),
        delete_current_page: tool({
          description: '用户明确要求删除当前页时使用。仅删除 Agent 当前页，保留其他页；唯一一页删除后留一张空白页。',
          inputSchema: z.object({}), execute: async () => {
            try {
              await this.change(deleteCurrentPage, guard);
              stepRevision = this.deck.revision;
              return { deleted: true, state: this.state() };
            } catch (error) { if ((error as Error).message === 'STEER_REPLAN') return skipped(); throw error; }
          },
        }),
        clear_presentation: tool({
          description: '用户明确要求清空当前 PPT、整份演示或所有页时使用。移除全部已有页面，重置为一张新空白页。仅清空当前页不能使用此工具。',
          inputSchema: z.object({}), execute: async () => {
            try {
              await this.change(clearPresentation, guard);
              stepRevision = this.deck.revision;
              return { cleared: true, state: this.state() };
            } catch (error) { if ((error as Error).message === 'STEER_REPLAN') return skipped(); throw error; }
          },
        }),
        navigate: tool({ description: '前进、后退、跳至某页，或在当前页后新增空白页。', inputSchema: z.object({ action: z.enum(['next', 'previous', 'goto', 'add']), page: z.number().int().optional() }), execute: async ({ action, page }) => {
          try {
            await this.change(current => navigate(current, action, page), guard);
            stepRevision = this.deck.revision;
            return { state: this.state() };
          } catch (error) { if ((error as Error).message === 'STEER_REPLAN') return skipped(); throw error; }
        } }),
      },
    });
    const timeout = setTimeout(() => run.controller.abort(), 120000);
    this.emit({ type: 'started', runId: run.id });
    try {
      for (let step = 0; ; step++) {
        if (step >= 32) throw new Error('本次处理达到 32 步上限，请继续发送指令');
        if (run.controller.signal.aborted) throw new Error('处理已取消或超时');
        const steering = run.pending.splice(0);
        for (const input of steering) {
          timeline.push({ role: 'user', content: input.text });
          this.emit({ type: 'steering-applied', runId: run.id, messageId: input.id });
        }
        stepRevision = this.deck.revision;
        const responseId = `${run.id}:${step}`;
        const result = await agent.stream({ messages: timeline, abortSignal: run.controller.signal });
        for await (const part of result.fullStream) {
          if (part.type === 'text-delta' && !run.pending.length) this.emit({ type: 'text', runId: run.id, responseId, text: part.text });
          if (part.type === 'tool-call') this.emit({ type: 'tool', runId: run.id, name: part.toolName });
          if (part.type === 'error') throw part.error;
        }
        timeline.push(...(await result.response).messages);
        const calls = await result.toolCalls;
        // A new sentence arriving during a text-only final answer still continues this run.
        if (!run.pending.length && !calls.length) break;
      }
      this.history.push(timeline.slice(historyStart));
      while (this.history.length > 1 && (this.history.length > 6 || JSON.stringify(this.history).length > 100000)) this.history.shift();
      // No await between the final pending check and releasing ownership: no lost late steer.
      if (this.active === run) this.active = undefined;
      this.emit({ type: 'done', runId: run.id, deck: this.snapshot() });
    } catch (error) {
      this.history.push(timeline.slice(historyStart));
      if (this.history.length > 6) this.history.shift();
      if (this.active === run) this.active = undefined;
      const message = run.controller.signal.aborted ? '处理已取消或超时，已保存的页面会保留' : error instanceof Error && error.message.includes('32 步') ? error.message : '模型处理失败，请检查密钥、模型及网络；已保存的页面会保留';
      for (const input of run.inputs) this.emit({ type: 'input-failed', runId: run.id, messageId: input.id, error: message });
      this.emit({ type: 'error', runId: run.id, error: message });
    } finally { clearTimeout(timeout); }
  }
  async waitForIdle(): Promise<void> { while (this.active) await this.active.completion; }
  async close(): Promise<void> {
    this.closed = true; this.speech.close(); this.active?.controller.abort();
    await this.waitForIdle(); await this.writes;
  }
}

/** Resolve server-only credentials without copying keys out of their private source. */
export async function loadModelConfiguration(env: NodeJS.ProcessEnv = process.env) {
  let privateModel: { api_key?: string; base_url?: string; model?: string } = {};
  if (env.PRIVATE_LLM_CONFIG) {
    const path = env.PRIVATE_LLM_CONFIG.replace(/^~(?=\/)/, homedir());
    try {
      const schema = z.object({ agent: z.object({ llm: z.object({ api_key: z.string().optional(), base_url: z.string().optional(), model: z.string().optional() }) }) });
      privateModel = schema.parse(parseYaml(await readFile(path, 'utf8'))).agent.llm;
    } catch { throw new Error('无法读取私有模型配置，请检查 PRIVATE_LLM_CONFIG 指向的配置文件'); }
  }
  if (env.OPENAI_ENABLE_THINKING && !['true', 'false'].includes(env.OPENAI_ENABLE_THINKING)) throw new Error('OPENAI_ENABLE_THINKING 必须为 true 或 false');
  return {
    apiKey: env.OPENAI_API_KEY?.trim() || privateModel.api_key,
    baseURL: env.OPENAI_BASE_URL?.trim() || privateModel.base_url,
    model: env.OPENAI_MODEL?.trim() || privateModel.model || 'gpt-4.1-mini',
    enableThinking: env.OPENAI_ENABLE_THINKING ? env.OPENAI_ENABLE_THINKING === 'true' : undefined,
  };
}

/** Local adapter: read-only document endpoints plus external, finalized ASR/steer ingestion. */
export async function serve(options: ImSlideOptions = {}, port = Number(process.env.PORT || 3001)) {
  const configuration = options.model ? undefined : await loadModelConfiguration();
  const model = options.model ?? (configuration?.apiKey ? createOpenAI({
    apiKey: configuration.apiKey, baseURL: configuration.baseURL,
    // DashScope's non-thinking switch is an extension to the OpenAI request body.
    fetch: async (input, init) => {
      if (configuration.enableThinking !== undefined && typeof init?.body === 'string') {
        return fetch(input, { ...init, body: JSON.stringify({ ...JSON.parse(init.body), enable_thinking: configuration.enableThinking }) });
      }
      return fetch(input, init);
    },
  }).chat(configuration.model) : undefined);
  const core = await ImSlide.open({ ...options, model });
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.get('/api/deck', (_req, res) => res.json(core.snapshot()));
  app.get('/api/status', (_req, res) => res.json({ configured: core.configured, model: configuration?.model ?? 'custom', running: core.running, mode: 'steer', manualEditing: false }));
  app.get('/api/preview-health', async (_req, res) => {
    try { res.json({ ready: (await fetch('http://127.0.0.1:3030/', { signal: AbortSignal.timeout(1500) })).ok }); }
    catch { res.json({ ready: false }); }
  });
  app.post('/api/view', async (req, res) => {
    try {
      const { pageId } = z.object({ pageId: z.string().min(1).max(80) }).strict().parse(req.body);
      res.json(await core.selectPage(pageId));
    } catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : '页面切换失败' }); }
  });
  app.get('/api/events', (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.flushHeaders();
    const send = (event: CoreEvent) => {
      if (res.destroyed) return;
      if (res.writableLength > 262144) { res.end(); return; }
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    send({ type: 'deck', deck: core.snapshot() });
    const unsubscribe = core.subscribe(send);
    const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n'); }, 15000);
    res.on('close', () => { unsubscribe(); clearInterval(heartbeat); });
  });
  const inputSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('instruction'), text: z.string().trim().min(1).max(8000), id: z.string().min(1).max(120), mode: z.literal('steer').default('steer') }),
    transcriptSchema,
    z.object({ type: z.literal('utterance-end'), utteranceId: z.string().min(1).max(100) }),
  ]);
  app.post('/api/chat', (req, res) => {
    try {
      const input = z.object({ message: z.string().trim().min(1).max(8000), id: z.string().min(1).max(120).optional(), mode: z.literal('steer').default('steer') }).parse(req.body);
      res.status(202).json(core.steer(input.message, input.id));
    } catch (error) { res.status(core.configured ? 400 : 503).json({ error: error instanceof Error ? error.message : '交互失败' }); }
  });
  app.post('/api/input', (req, res) => {
    try {
      const input = inputSchema.parse(req.body);
      if (input.type === 'instruction') res.status(202).json(core.steer(input.text, input.id));
      else if (input.type === 'transcript') res.status(202).json(core.ingest(input));
      else { core.endUtterance(input.utteranceId); res.status(202).json({ status: 'end-received' }); }
    } catch (error) { res.status(core.configured ? 400 : 503).json({ error: error instanceof Error ? error.message : '输入失败' }); }
  });
  app.use((_req, res) => res.status(404).json({ error: '不支持手动修改文稿，请通过 /api/chat 或 /api/input 与 Agent 交互' }));
  app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(400).json({ error: '请求格式无效或过大' }));
  const server = app.listen(port, '127.0.0.1');
  return { core, server };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes('--serve')) {
  const runtime = await serve({ file: process.env.SLIDES_FILE || 'slides/slides.md', legacyFile: '.data/deck.json' });
  runtime.server.on('listening', () => console.log('imslide capability ready (read-only canvas + Agent steer input)'));
  async function stop() { runtime.server.closeAllConnections(); runtime.server.close(); await runtime.core.close(); }
  process.once('SIGTERM', () => void stop()); process.once('SIGINT', () => void stop());
}
