/**
 * imslide's single-file backend capability.
 * Import ImSlide from this file, or run `tsx imslide.ts --serve` for a read/ingest API.
 * slides.md is the sole active document store; the web viewer never mutates it.
 */
import 'dotenv/config';
import { prompts, slideEditorSystemPrompt } from './prompt.ts';
import express from 'express';
import { TranscriptMerger, calibrator, mergeSchema } from './src/transcript-merger.ts';
import { paragraphText } from './src/paragraphs.ts';
import { LocalASR } from './src/asr-server.ts';
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
/** Resolve all requested page numbers before deleting anything. */
export function deletePages(deck: Deck, pages: number | number[] | 'all'): Deck {
  if (pages === 'all') return clearPresentation(deck);
  const numbers = Array.isArray(pages) ? pages : [pages];
  if (!numbers.length || numbers.some(page => !Number.isInteger(page) || page < 1 || page > deck.pages.length)) throw new Error('指定页面不存在');
  const selected = new Set(numbers.map(page => page - 1));
  const currentId = deck.pages[deck.current].id;
  const remaining = deck.pages.filter((_, index) => !selected.has(index));
  if (!remaining.length) return clearPresentation(deck);
  const retainedCurrent = remaining.findIndex(page => page.id === currentId);
  // Preserve selection by ID, or select the next surviving page then the previous.
  const nextIndex = deck.pages.findIndex((_, index) => index > deck.current && !selected.has(index));
  const current = retainedCurrent >= 0 ? retainedCurrent : nextIndex >= 0 ? remaining.findIndex(page => page.id === deck.pages[nextIndex].id) : remaining.length - 1;
  return { pages: remaining, current, revision: deck.revision + 1 };
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
  private change(update: (current: Deck) => Deck, guard?: () => void, committed?: () => void): Promise<Deck> {
    const task = this.writes.then(async () => {
      if (this.closed) throw new Error('能力已关闭');
      guard?.();
      const next = update(this.deck);
      if (next === this.deck) return this.snapshot();
      await this.save(deckSchema.parse(next));
      committed?.();
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
    let finished = false;
    let toolFailed = false;
    let stepRevision = this.deck.revision;
    const guard = () => {
      if (run.controller.signal.aborted || run.pending.length || this.deck.revision !== stepRevision) throw new Error('STEER_REPLAN');
    };
    const skipped = () => {
      toolFailed = true;
      this.emit({ type: 'tool-skipped', runId: run.id, reason: '新指令已确认，旧步骤尚未提交，将按最新指令重新规划' });
      return { skipped: true, reason: 'Replan using latest instruction and state.' };
    };
    const agent = new ToolLoopAgent({
      model: this.options.model!, instructions: prompts.slideEditor,
      // This outer loop owns steering and retains complete tool-call/result pairs.
      stopWhen: stepCountIs(1), maxRetries: 1, toolChoice: 'required', maxOutputTokens: 4096,
      prepareStep: () => ({ system: slideEditorSystemPrompt(this.state()) }),
      tools: {
        finish: tool({ description: '全部要求已完成或无需操作时结束，不生成文字回复。', inputSchema: z.object({}), execute: async () => {
          try { guard(); finished = true; return { done: true }; }
          catch (error) { if ((error as Error).message === 'STEER_REPLAN') return skipped(); toolFailed = true; throw error; }
        } }),
        read_page: tool({
          description: '读取指定页的完整标题、正文、布局和ID，不修改文稿也不切换当前页。pages接受从1开始的单页码、页码数组或all。修改非当前页前优先用本工具读取，不要为读取而navigate。',
          inputSchema: z.object({ pages: z.union([z.number().int().positive(), z.array(z.number().int().positive()).min(1).max(60), z.literal('all')]) }),
          execute: async ({ pages }) => {
            try {
              guard();
              const deck = this.snapshot();
              const numbers = pages === 'all' ? deck.pages.map((_, index) => index + 1) : [...new Set(Array.isArray(pages) ? pages : [pages])];
              if (numbers.some(page => !deck.pages[page - 1])) throw new Error('指定页面不存在');
              return { revision: deck.revision, currentPage: deck.current + 1, pages: numbers.map(page => ({ page, ...deck.pages[page - 1] })) };
            } catch (error) {
              if ((error as Error).message === 'STEER_REPLAN') return skipped();
              toolFailed = true;
              return { ok: false, error: (error as Error).message };
            }
          },
        }),
        update_page: tool({ description: '完整替换指定页正文、标题和布局；page从1开始，省略时为当前页。不切换当前浏览页。保留未要求修改的内容。', inputSchema: pageSchema.omit({ id: true }).extend({ page: z.number().int().positive().optional() }), execute: async ({ page, ...input }) => {
          try {
            await this.change(current => {
              const next = structuredClone(current);
              const index = page === undefined ? next.current : page - 1;
              if (!next.pages[index]) throw new Error('指定页面不存在');
              next.pages[index] = pageSchema.parse({ ...input, id: next.pages[index].id }); next.revision++;
              return next;
            }, guard, () => { stepRevision = this.deck.revision; });
            stepRevision = this.deck.revision;
            return { ok: true };
          } catch (error) { if ((error as Error).message === 'STEER_REPLAN') return skipped(); toolFailed = true; throw error; }
        } }),
        edit_page: tool({
          description: '精确替换指定页的部分文本，保留其他内容和浏览位置。page从1开始，省略为当前页；field默认content，也可改title。old_string必须原样匹配，未找到则不写入；多处匹配必须显式replace_all=true，否则请提供更多上下文。new_string为空表示删除匹配文本。',
          inputSchema: z.object({
            page: z.number().int().positive().optional(),
            field: z.enum(['content', 'title']).default('content'),
            old_string: z.string().min(1).max(24000),
            new_string: z.string().max(24000),
            replace_all: z.boolean().default(false),
          }),
          execute: async ({ page, field, old_string, new_string, replace_all }) => {
            try {
              let replacements = 0;
              await this.change(current => {
                const index = page === undefined ? current.current : page - 1;
                const target = current.pages[index];
                if (!target) throw new Error('指定页面不存在');
                const pieces = target[field].split(old_string);
                replacements = pieces.length - 1;
                if (!replacements) throw new Error('old_string未匹配，请根据最新原文重新提供精确文本');
                if (replacements > 1 && !replace_all) throw new Error('old_string匹配多处，请增加上下文或设置replace_all=true');
                if (old_string === new_string) return current;
                const next = structuredClone(current);
                // Joining literal strings avoids replacement-token expansion such as $&.
                next.pages[index] = pageSchema.parse({ ...target, [field]: pieces.join(new_string) });
                next.revision++;
                return next;
              }, guard, () => { stepRevision = this.deck.revision; });
              return { ok: true, replacements };
            } catch (error) {
              if ((error as Error).message === 'STEER_REPLAN') return skipped();
              toolFailed = true;
              return { ok: false, error: (error as Error).message };
            }
          },
        }),
        delete_page: tool({
          description: '删除指定的一页或多页。pages接受从1开始的页码、页码数组，或特殊值all清空整份演示。数组按删除前的页码一次处理，重复页码只删除一次。仅用户明确要求删除或清空时调用；删完后保留一张空白页。',
          inputSchema: z.object({ pages: z.union([z.number().int().positive(), z.array(z.number().int().positive()).min(1).max(60), z.literal('all')]) }),
          execute: async ({ pages }) => {
            try {
              await this.change(current => deletePages(current, pages), guard, () => { stepRevision = this.deck.revision; });
              stepRevision = this.deck.revision;
              return { deleted: true };
            } catch (error) { if ((error as Error).message === 'STEER_REPLAN') return skipped(); toolFailed = true; throw error; }
          },
        }),
        navigate: tool({ description: '前进、后退、跳至某页，或在当前页后新增空白页。', inputSchema: z.object({ action: z.enum(['next', 'previous', 'goto', 'add']), page: z.number().int().optional() }), execute: async ({ action, page }) => {
          try {
            await this.change(current => navigate(current, action, page), guard, () => { stepRevision = this.deck.revision; });
            stepRevision = this.deck.revision;
            return { ok: true };
          } catch (error) { if ((error as Error).message === 'STEER_REPLAN') return skipped(); toolFailed = true; throw error; }
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
        finished = false; toolFailed = false;
        const result = await agent.stream({ messages: timeline, abortSignal: run.controller.signal });
        for await (const part of result.fullStream) {
          if (part.type === 'tool-call') this.emit({ type: 'tool', runId: run.id, name: part.toolName });
          if (part.type === 'tool-error') toolFailed = true;
          if (part.type === 'error') throw part.error;
        }
        timeline.push(...(await result.response).messages);
        const calls = await result.toolCalls;
        if (!run.pending.length && finished && !toolFailed) break;
        if (!run.pending.length && !calls.length) throw new Error('Model did not call a required tool');
      }
      // Current document is authoritative; retain only recent user intent, not old page bodies.
      this.history.push(run.inputs.map(input => ({ role: 'user' as const, content: `历史已完成指令（仅用于理解指代，不重复执行）：${input.text}` })));
      while (this.history.length > 1 && (this.history.length > 3 || JSON.stringify(this.history).length > 12000)) this.history.shift();
      // No await between the final pending check and releasing ownership: no lost late steer.
      if (this.active === run) this.active = undefined;
      this.emit({ type: 'done', runId: run.id, deck: this.snapshot() });
    } catch (error) {
      // Failed tool traces must not inflate future requests.
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
    // DeepSeek requires non-thinking mode for forced tool calls.
    fetch: async (input, init) => {
      if (typeof init?.body === 'string') {
        const body = JSON.parse(init.body);
        if (new URL(configuration.baseURL || 'https://api.openai.com/v1').hostname === 'api.deepseek.com') body.thinking = { type: 'disabled' };
        else if (configuration.enableThinking !== undefined) body.enable_thinking = configuration.enableThinking;
        return fetch(input, { ...init, body: JSON.stringify(body) });
      }
      return fetch(input, init);
    },
  }).chat(configuration.model) : undefined);
  const core = await ImSlide.open({ ...options, model });
  const app = express();
  const asr = new LocalASR();
  app.get('/api/asr/status', async (_req, res) => {
    try { await asr.warmup(); res.json({ ready: true, local: true }); }
    catch (error) { res.status(503).json({ error: (error as Error).message }); }
  });
  app.post('/api/asr', express.raw({ type: 'application/octet-stream', limit: '1536kb' }), async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body)) throw new Error('需要 PCM 音频');
      res.json(await asr.transcribe(req.body));
    } catch (error) { res.status(503).json({ error: (error as Error).message }); }
  });
  app.use(express.json({ limit: '64kb' }));
  const merger = model ? new TranscriptMerger(resolve('.data/transcripts'), calibrator(model)) : undefined;
  app.post('/api/asr/merge', async (req, res) => {
    try {
      if (!merger) throw new Error('请先配置语音校准模型');
      res.json(await merger.merge(mergeSchema.parse(req.body)));
    } catch (error) { res.status(503).json({ error: (error as Error).message }); }
  });
  app.post('/api/text/paragraphs', async (req, res) => {
    try {
      if (!model) throw new Error('请先配置模型');
      const { text, previous } = z.object({ text: z.string().min(1).max(8000), previous: z.string().max(512).default('') }).parse(req.body);
      res.json(await paragraphText(model, text, previous));
    } catch (error) { res.status(503).json({ error: (error as Error).message }); }
  });
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
  server.once('close', () => asr.close());
  return { core, server };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes('--serve')) {
  const runtime = await serve({ file: process.env.SLIDES_FILE || 'slides/slides.md', legacyFile: '.data/deck.json' });
  runtime.server.on('listening', () => console.log('imslide capability ready (read-only canvas + Agent steer input)'));
  async function stop() { runtime.server.closeAllConnections(); runtime.server.close(); await runtime.core.close(); }
  process.once('SIGTERM', () => void stop()); process.once('SIGINT', () => void stop());
}
