/**
 * imslide's Agent runtime and backend API.
 * Import ImSlide from this file, or run `tsx imslide.ts --serve` for a read/ingest API.
 * Each document has its own Markdown source; the library publishes one renderer entry.
 */
import 'dotenv/config';
import { DeckLibrary } from './src/deck-library.ts';
import { checkMode, workspaceActions, workspaceActionSchema, workspaceDescriptions, WorkspaceError, type WorkspaceAction, type WorkspaceState } from './src/workspace-contract.ts';
import { prompts, slideEditorSystemPrompt } from './prompt.ts';
import { stylePrompt } from './src/presentation-styles.ts';
import express from 'express';
import { TranscriptMerger, calibrator, mergeSchema, type MergeInput } from './src/transcript-merger.ts';
import { paragraphText } from './src/paragraphs.ts';
import { LocalASR } from './src/asr-server.ts';
import { attachVolcStream, volcConfiguration, VOLC_RESOURCE } from './src/volc-stream.ts';
import { appendVoiceText } from './src/voice-text.ts';
import { voiceTextKey } from './src/voice-snapshot.ts';
import { mkdir, readFile, writeFile, rename, appendFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { parseSync } from '@slidev/parser';
import { ToolLoopAgent, tool, stepCountIs, type LanguageModel, type ModelMessage } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { Agent as HttpAgent } from 'undici';
import { z } from 'zod';

export const pageSchema = z.object({
  id: z.string().min(1).max(80), title: z.string().max(120),
  content: z.string().max(24000).refine(s => !/^---/m.test(s) && !/<\s*\/?\s*(script|iframe|object|embed)\b|\b(?:src|href)\s*=\s*["']?\s*javascript:|\bon\w+\s*=|\{\{|\bv-[\w-]+\s*=|@\w+\s*=/i.test(s), '仅允许单页 Markdown、静态 HTML 和 CSS，不能包含可执行脚本或分页符'),
  layout: z.enum(['default', 'center', 'cover', 'two-cols', 'section', 'image-left', 'image-right']).default('default'),
});
const actionSchema = z.discriminatedUnion('tool', [
  ...workspaceActions,
  z.object({ tool: z.literal('navigate'), action: z.enum(['next', 'previous', 'goto', 'add']), page: z.number().int().positive().optional() }),
  pageSchema.omit({ id: true }).extend({ tool: z.literal('update_page'), page: z.number().int().positive().optional() }),
  z.object({ tool: z.literal('edit_page'), page: z.number().int().positive().optional(), field: z.enum(['content', 'title']).default('content'), old_string: z.string().min(1).max(24000), new_string: z.string().max(24000), replace_all: z.boolean().default(false) }),
  z.object({ tool: z.literal('delete_page'), pages: z.union([z.number().int().positive(), z.array(z.number().int().positive()).min(1).max(60), z.literal('all'), z.literal('current')]) }),
  z.object({ tool: z.literal('read_page'), pages: z.union([z.number().int().positive(), z.array(z.number().int().positive()).min(1).max(60), z.literal('all')]) }),
]);
export const voicePlanSchema = z.object({ completed: z.array(z.object({ actions: z.array(actionSchema).max(16) })).max(16), pending: z.string().max(4000).default(''), needsFollowUp: z.boolean().default(false) });

export const deckSchema = z.object({
  pages: z.array(pageSchema).min(1).max(60), current: z.number().int().min(0), revision: z.number().int().min(0),
}).refine(d => d.current < d.pages.length && new Set(d.pages.map(p => p.id)).size === d.pages.length, '页码或页面标识无效');
export type Page = z.infer<typeof pageSchema>;
export type Deck = z.infer<typeof deckSchema> & { deckId?: string | null; workspaceRevision?: number };
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
    return `${head}layout: ${page.layout}\nimslideContentKey: ${createHash('sha256').update(JSON.stringify(page)).digest('hex')}\nimslideId: ${JSON.stringify(page.id)}\nimslideTitle: ${JSON.stringify(page.title)}\n---\n\n${page.content}\n`;
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
  | { type: 'workspace'; workspace: WorkspaceState; deck: Deck }
  | { type: 'deck'; deck: Deck }
  | { type: 'accepted' | 'steering-applied' | 'input-failed'; runId: string; messageId: string; error?: string }
  | { type: 'started'; runId: string }
  | { type: 'model-step'; runId: string; phase: 'start' | 'first-token' | 'finish'; at: number; inputTokens?: number; outputTokens?: number }
  | { type: 'model-request'; runId: string; replica: number; replicas: number; at: number }
  | { type: 'text'; runId: string; responseId: string; text: string }
  | { type: 'tool'; runId: string; name: string; callId: string; input: unknown; at: number }
  | { type: 'tool-result'; runId: string; name: string; callId: string; output: unknown; at: number }
  | { type: 'tool-error'; runId: string; name: string; callId: string; error: string; at: number }
  | { type: 'tool-skipped'; runId: string; reason: string }
  | { type: 'done'; runId: string; deck: Deck }
  | { type: 'error'; runId?: string; error: string }
  | { type: 'transcript'; utteranceId: string; text: string; isFinal: boolean; status: string };
type Instruction = { id: string; text: string; voice?: MergeInput };
type Receipt = { runId: string; messageId: string; mode: 'start' | 'steer' };
type Run = { id: string; pending: Instruction[]; inputs: Instruction[]; controller: AbortController; completion: Promise<void>; voiceSession?: string };
export type ImSlideOptions = { file?: string; model?: LanguageModel; quietMs?: number; onEvent?: (event: CoreEvent) => void; legacyFile?: string; library?: boolean; libraryDirectory?: string };
const instructionSchema = z.object({ text: z.string().trim().min(1).max(8000), id: z.string().min(1).max(120) });


export class ImSlide {
  recordModelRequest(replica: number, replicas: number) {
    if (this.active) this.emit({ type: 'model-request', runId: this.active.id, replica, replicas, at: Date.now() });
  }
  private deck: Deck;
  private listeners = new Set<(event: CoreEvent) => void>();
  private active?: Run;
  private receipts = new Map<string, Receipt>();
  private history: ModelMessage[][] = [];
  private voiceSessions = new Map<string, { messages: ModelMessage[]; pending: string; transcript: string; audioEnd: number; lastSeq: number; receipts: Map<number, { fingerprint: string; receipt: Receipt }> }>();
  private writes: Promise<void> = Promise.resolve();
  private closed = false;
  private library?: DeckLibrary;
  get file() { return this.library?.activeFile || resolve(this.options.file ?? 'slides/slides.md'); }
  private readonly speech: UtteranceBuffer;
  private constructor(deck: Deck, private options: ImSlideOptions) {
    this.deck = deck;
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
    if (markdown === undefined || (!options.library && !parseSync(markdown, file).slides[0]?.frontmatter.imslide)) await core.save(deck);
    if (options.library) {
      const opened = await DeckLibrary.open(file, deck, options.libraryDirectory);
      core.library = opened.library; core.deck = opened.deck;
    }
    return core;
  }
  get configured() { return !!this.options.model; }
  get running() { return !!this.active; }
  snapshot(): Deck { return { ...structuredClone(this.deck), ...(this.library ? {deckId:this.workspace().activeDeckId,workspaceRevision:this.workspace().workspaceRevision} : {}) }; }
  workspace(): WorkspaceState { return this.library?.snapshot() || {mode:'preview',activeDeckId:'legacy',workspaceRevision:0,decks:[]}; }
  private permission(tool: string, input: {action?:string} = {}) { checkMode(this.workspace().mode, tool, input); }
  assertContext(context: {deckId: string | null; workspaceRevision: number}) {
    const state=this.workspace();
    if(context.deckId!==state.activeDeckId || context.workspaceRevision!==state.workspaceRevision)
      throw new WorkspaceError('STALE_WORKSPACE','工作区已改变，请基于最新状态重试');
  }
  async workspaceAction(raw: WorkspaceAction, context?: {deckId:string|null;workspaceRevision:number}, guard?:()=>void) {
    const action=workspaceActionSchema.parse(raw);
    const task=this.writes.then(async()=>{
      if(this.closed)throw new Error('能力已关闭');
      guard?.();if(context)this.assertContext(context);
      this.permission(action.tool);
      if(action.tool==='get_workspace')return {ok:true,workspace:this.workspace(),deck:this.snapshot()};
      if(!this.library)throw new WorkspaceError('LIBRARY_DISABLED','文稿库未启用');
      const before=this.workspace();
      const result=await this.library.action(action);
      const after=this.workspace();
      // A UI/API context switch cancels old intent, never replans it against another document.
      if(!guard && (before.mode!==after.mode || before.activeDeckId!==after.activeDeckId))this.active?.controller.abort('WORKSPACE_CHANGED');
      if(result.deck)this.deck=result.deck;
      const workspace=this.workspace(),deck=this.snapshot();
      this.emit({type:'workspace',workspace,deck});
      return {ok:true,...result,workspace,deck};
    });
    this.writes=task.then(()=>{},()=>{});return task;
  }
  subscribe(listener: (event: CoreEvent) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  private emit(event: CoreEvent) {
    for (const listener of this.listeners) { try { listener(event); } catch { /* An observer cannot break document writes. */ } }
  }
  private selectionVersion = 0;
  private state(known?: Map<string, string>) {
    const current = this.deck.pages[this.deck.current];
    const fingerprint = JSON.stringify(current);
    const unchanged = known?.get(current.id) === fingerprint;
    const workspace = this.workspace();
    const style = workspace.decks.find(item => item.id === workspace.activeDeckId)?.style;
    return { workspace, designGuidance: stylePrompt(style), currentPage: this.deck.current + 1, revision: this.deck.revision,
      pages: this.deck.pages.map(({ title, layout }, index) => ({ page: index + 1, title, layout })),
      ...(unchanged ? { currentContentUnchanged: true } : { currentContent: current.content }) };
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
      const previousPages=this.deck.pages;
      const validated = deckSchema.parse(next);
      const selected = this.deck.pages[this.deck.current].id !== validated.pages[validated.current].id;
      if (JSON.stringify(validated.pages) === JSON.stringify(this.deck.pages)) {
        // Browsing is session state: never rewrite Markdown just to move the cursor.
        this.deck = { ...validated, revision: this.deck.revision };
      } else await this.save(validated);
      if(this.library)await this.library.saved(this.deck, JSON.stringify(validated.pages)!==JSON.stringify(previousPages));
      if (selected) this.selectionVersion++;
      committed?.();
      const snapshot = this.snapshot();
      if(this.library)this.emit({type:'workspace',workspace:this.workspace(),deck:snapshot});
      else this.emit({ type: 'deck', deck: snapshot }); return snapshot;
    });
    this.writes = task.then(() => {}, () => {});
    return task;
  }
  /** Select an existing page only; viewing and editing share this single cursor. */
  async selectPage(pageId: string, context?: {deckId:string|null;workspaceRevision:number}): Promise<Deck> {
    return this.change(current => {
      this.permission('navigate',{action:'goto'});if(context)this.assertContext(context);
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
    return this.enqueueInstruction(text, id);
  }
  ingestVoice(raw: MergeInput): Receipt {
    const input = mergeSchema.parse(raw);
    if (input.error) throw new Error('语音片段识别失败，未执行；请重新说出完整指令');
    let session = this.voiceSessions.get(input.session);
    if (!session) {
      if (this.voiceSessions.size >= 32) {
        const oldest = [...this.voiceSessions.keys()].find(id => id !== this.active?.voiceSession);
        if (oldest) this.voiceSessions.delete(oldest);
      }
      session = { messages: [], pending: '', transcript: '', audioEnd: 0, lastSeq: -1, receipts: new Map() };
      this.voiceSessions.set(input.session, session);
    }
    const fingerprint = JSON.stringify(input);
    const previous = session.receipts.get(input.seq);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('语音片段编号冲突');
      return previous.receipt;
    }
    if (input.seq <= session.lastSeq) throw new Error('语音片段顺序无效');
    if (input.snapshot && voiceTextKey(input.raw) === voiceTextKey(session.transcript) && session.lastSeq >= 0) {
      const receipt = session.receipts.get(session.lastSeq)!.receipt;
      session.lastSeq = input.seq; session.receipts.set(input.seq, { fingerprint, receipt });
      return receipt;
    }
    if (this.active && this.active.voiceSession !== input.session) throw new Error('其他指令仍在处理，请稍后重试语音片段');
    if (session.receipts.size >= 128 || JSON.stringify(session.messages).length > 180000) throw new Error('语音会话过长，请结束后开始新录音');
    let transcript = session.transcript, audioEnd = session.audioEnd;
    let aligned = true;
    if (input.snapshot) {
      // A revised cumulative hypothesis replaces the old one. It is never appended.
      transcript = input.raw;
      audioEnd = input.end;
    } else for (const part of input.segments || [input]) {
      const joined = appendVoiceText(transcript, part.raw, part.start < audioEnd);
      transcript = joined.text; aligned &&= joined.aligned;
      audioEnd = part.end;
    }
    const text = '连续语音转写快照：' + JSON.stringify({ session: input.session, seq: input.seq, endpoint: input.endpoint,
      snapshot: input.snapshot, revised: !!input.snapshot && !voiceTextKey(transcript).startsWith(voiceTextKey(session.transcript)),
      start: input.start, end: input.end, transcript: transcript.slice(-6000), overlapAligned: aligned });
    const receipt = this.enqueueInstruction(text, `speech:${input.session}:${input.seq}`, input);
    session.lastSeq = input.seq;
    session.transcript = transcript.slice(-12000); session.audioEnd = audioEnd;
    session.receipts.set(input.seq, { fingerprint, receipt });
    return receipt;
  }
  private enqueueInstruction(text: string, id: string, voice?: MergeInput): Receipt {
    if (this.closed) throw new Error('能力已关闭');
    const input = (voice ? instructionSchema.extend({ text: z.string().trim().min(1).max(24000) }) : instructionSchema).parse({ text, id });
    const previous = this.receipts.get(id);
    if (previous) return previous;
    if (!this.options.model) throw new Error('尚未配置模型');
    if (this.active && (this.active.pending.length >= 16 || this.active.inputs.length >= 64)) throw new Error('待注入指令过多，请等待当前处理完成');
    const preceding = this.active?.controller.signal.aborted ? this.active.completion : undefined;
    let run = this.active?.controller.signal.aborted ? undefined : this.active;
    const mode = run ? 'steer' : 'start';
    if (!run) {
      run = { id: randomUUID(), pending: [], inputs: [], controller: new AbortController(), completion: Promise.resolve(), voiceSession: voice?.session };
      this.active = run;
    }
    const instruction = { ...input, voice };
    run.pending.push(instruction); run.inputs.push(instruction);
    const receipt: Receipt = { runId: run.id, messageId: id, mode };
    this.receipts.set(id, receipt);
    if (this.receipts.size > 512) this.receipts.delete(this.receipts.keys().next().value!);
    this.emit({ type: 'accepted', runId: run.id, messageId: id });
    if (mode === 'start') { const started = run; run.completion = Promise.resolve(preceding).then(() => this.execute(started)); }
    return receipt;
  }
  private async execute(run: Run): Promise<void> {
    const voice = run.voiceSession ? this.voiceSessions.get(run.voiceSession) : undefined;
    const timeline: ModelMessage[] = voice ? [...voice.messages] : this.history.flat();
    const knownPages = new Map<string, string>();
    let finished = false;
    let toolFailed = false;
    let waiting = false;
    let stepRevision = this.deck.revision;
    let stepSelection = this.selectionVersion;
    let stepWorkspace = this.workspace().workspaceRevision;
    let stepTranscript = voice?.transcript || '';
    const guard = () => {
      if (voice && run.pending.some(input => input.voice?.snapshot) && !voiceTextKey(voice.transcript).startsWith(voiceTextKey(stepTranscript))) throw new Error('STEER_REPLAN');
      if (run.controller.signal.aborted || run.pending.some(input => !input.voice) || this.deck.revision !== stepRevision || this.selectionVersion !== stepSelection || this.workspace().workspaceRevision !== stepWorkspace) throw new Error('STEER_REPLAN');
    };
    const skipped = () => {
      toolFailed = true;
      this.emit({ type: 'tool-skipped', runId: run.id, reason: '新指令已确认，旧步骤尚未提交，将按最新指令重新规划' });
      return { skipped: true, reason: 'Replan using latest instruction and state.' };
    };
    const completion = z.boolean().optional();
    const deckTools = {
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
              return { revision: deck.revision, currentPage: deck.current + 1, pages: numbers.map(page => {
                const value = deck.pages[page - 1], signature = JSON.stringify(value);
                if (knownPages.get(value.id) === signature) return { page, id: value.id, unchanged: true };
                knownPages.set(value.id, signature);
                return { page, ...value };
              }) };
            } catch (error) {
              if ((error as Error).message === 'STEER_REPLAN') return skipped();
              toolFailed = true;
              return { ok: false, error: (error as Error).message };
            }
          },
        }),
        update_page: tool({ description: '完整替换指定页正文、标题和布局；page从1开始，省略时为当前页。不切换当前浏览页。保留未要求修改的内容。', inputSchema: pageSchema.omit({ id: true }).extend({ page: z.number().int().positive().optional(), done: completion }), execute: async ({ page, done, ...input }) => {
          try {
            await this.change(current => {
              const next = structuredClone(current);
              const index = page === undefined ? next.current : page - 1;
              if (!next.pages[index]) throw new Error('指定页面不存在');
              next.pages[index] = pageSchema.parse({ ...input, id: next.pages[index].id }); next.revision++;
              return next;
            }, guard, () => { stepRevision = this.deck.revision; stepSelection = this.selectionVersion; stepWorkspace = this.workspace().workspaceRevision; });
            stepRevision = this.deck.revision;
            if (done) finished = true;
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
            done: completion,
          }),
          execute: async ({ page, field, old_string, new_string, replace_all, done }) => {
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
              }, guard, () => { stepRevision = this.deck.revision; stepSelection = this.selectionVersion; stepWorkspace = this.workspace().workspaceRevision; });
              if (done) finished = true;
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
          inputSchema: z.object({ pages: z.union([z.number().int().positive(), z.array(z.number().int().positive()).min(1).max(60), z.literal('all')]), done: completion }),
          execute: async ({ pages, done }) => {
            try {
              await this.change(current => deletePages(current, pages), guard, () => { stepRevision = this.deck.revision; stepSelection = this.selectionVersion; stepWorkspace = this.workspace().workspaceRevision; });
              stepRevision = this.deck.revision;
              if (done) finished = true;
              return { deleted: true };
            } catch (error) { if ((error as Error).message === 'STEER_REPLAN') return skipped(); toolFailed = true; throw error; }
          },
        }),
        navigate: tool({ description: '用户要求新增一页时用add：在当前页后插入空白页并切换过去。next用于下一页（预览末页才新增，演示末页停止）；previous上一页，goto跳至指定页。', inputSchema: z.object({ action: z.enum(['next', 'previous', 'goto', 'add']), page: z.number().int().optional(), done: completion }), execute: async ({ action, page, done }) => {
          try {
            await this.change(current => this.workspace().mode==='presentation' && action==='next' && current.current===current.pages.length-1 ? current : navigate(current, action, page), guard, () => { stepRevision = this.deck.revision; stepSelection = this.selectionVersion; stepWorkspace = this.workspace().workspaceRevision; });
            stepRevision = this.deck.revision;
            if (done) finished = true;
            return { ok: true };
          } catch (error) { if ((error as Error).message === 'STEER_REPLAN') return skipped(); toolFailed = true; throw error; }
        } }),
    };
    const managementTools = Object.fromEntries(workspaceActions.map(schema => {
      const name=schema.shape.tool.value;
      return [name,tool({description:workspaceDescriptions[name],inputSchema:(schema as z.ZodObject<any>).omit({tool:true}).extend({done:completion}),execute:async(input:any)=>{
        const result=await this.workspaceAction({tool:name,...input},undefined,guard);
        stepRevision=this.deck.revision;stepSelection=this.selectionVersion;stepWorkspace=this.workspace().workspaceRevision;
        if(input.done)finished=true;
        return result;
      }})];
    }));
    // One execution gate for direct tools and actions nested inside apply_voice.
    const allTools: Record<string, any> = {...deckTools,...managementTools};
    for(const [name, definition] of Object.entries(allTools)) {
      const execute=definition.execute;
      definition.execute=async(input:any,context:any)=>{
        try { guard(); this.permission(name,input); return await execute(input,context); }
        catch(error) {
          if((error as Error).message==='STEER_REPLAN')return skipped();
          toolFailed=true;finished=false;
          if(error instanceof WorkspaceError)return error.result();
          throw error;
        }
      };
    }
    const voiceTool = tool({
      description: '校准并依序执行全部新增完整语音指令；未完尾句留pending。需读取后续规划时needsFollowUp=true。参数用紧凑JSON，省略空或false默认字段。',
      inputSchema: voicePlanSchema,
      execute: async ({ completed, pending, needsFollowUp }, context) => {
        const results: Array<{ instruction: string; tool: string; output: unknown }> = [];
        for (const instruction of completed) {
          for (const action of instruction.actions) {
            const { tool: name, ...args } = action;
            const input = { ...args, done: false, ...('pages' in args && args.pages === 'current' ? { pages: this.deck.current + 1 } : {}) };
            const callId = `${context.toolCallId}:${results.length}`;
            this.emit({ type: 'tool', runId: run.id, name, callId, input, at: Date.now() });
            const execute = allTools[name].execute as unknown as (input: unknown) => Promise<unknown>;
            const written = action.tool === 'update_page' ? action.content : action.tool === 'edit_page' ? action.new_string : '';
            const existing = this.deck.pages[('page' in action && action.page ? action.page - 1 : this.deck.current)]?.content || '';
            const allowed = (voice?.transcript || '') + existing;
            const inventedPlaceholder = written.match(/待补充|待完善|待填写|TODO|TBD/gi)?.some(marker => !allowed.includes(marker));
            const clean = (text: string) => text.replace(/<[^>]*>/g, '').replace(/[\p{P}\p{S}\s]/gu, '');
            const lastLine = clean(written.trim().split('\n').at(-1) || '');
            const copiedTail = pending && lastLine.length >= 4 && clean(pending).endsWith(lastLine);
            const proposed = action.tool === 'edit_page' && action.field !== 'title'
              ? (action.replace_all ? existing.split(action.old_string).join(action.new_string) : existing.replace(action.old_string, () => action.new_string))
              : action.tool === 'update_page' ? action.content : existing;
            const headings = (text: string) => [...text.matchAll(/^#\s+(.+)$/gm)].map(match => clean(match[1]));
            const beforeHeadings = headings(existing), afterHeadings = headings(proposed);
            const duplicatedTitle = afterHeadings.some(title => title && afterHeadings.filter(value => value === title).length > Math.max(1, beforeHeadings.filter(value => value === title).length));
            const output = duplicatedTitle
              ? { ok: false, error: '局部替换重复了已有主标题，未写入。new_string只替换old_string范围；整页重写用update_page。保留单个主标题并重试此步，成功前序动作不重放。' }
              : inventedPlaceholder || copiedTail
              ? { ok: false, error: '不能把未要求的占位词或待确认尾句写入页面。只写完整内容，未完原话留在pending；此前成功动作不要重复。' }
              : await execute(input).catch(error=>({ok:false,error:(error as Error).message}));
            results.push({ instruction: `完整指令${completed.indexOf(instruction) + 1}`, tool: name, output });
            this.emit({ type: 'tool-result', runId: run.id, name, callId, output, at: Date.now() });
            if (output && typeof output === 'object' && (('ok' in output && output.ok === false) || ('skipped' in output && output.skipped))) {
              toolFailed = true; finished = false;
              return { ok: false, results, retryRemaining: true };
            }
          }
        }
        if (voice) voice.pending = pending;
        waiting = !!pending;
        finished = !needsFollowUp;
        return { ok: true, results, pending, needsFollowUp };
      },
    });
    const agent = new ToolLoopAgent({
      model: this.options.model!, instructions: prompts.slideEditor,
      temperature: voice ? 0 : undefined,
      stopWhen: stepCountIs(1), maxRetries: 1, toolChoice: 'required', maxOutputTokens: 4096,
      // Keep the voice system prefix invariant across document revisions so the
      // provider can reuse its prefill; mutable document state stays in user data.
      prepareStep: () => ({ system: voice ? prompts.voiceEditor : slideEditorSystemPrompt(this.state(knownPages)) }),
      tools: { ...allTools, apply_voice: voiceTool },
    });
    const timeout = setTimeout(() => run.controller.abort(), 120000);
    this.emit({ type: 'started', runId: run.id });
    try {
      for (let step = 0; ; step++) {
        if (step >= 32) throw new Error('本次处理达到 32 步上限，请继续发送指令');
        if (run.controller.signal.aborted) throw new Error('处理已取消或超时');
        // Retain a changed page body once in messages, rather than replacing the
        // system prompt with the same body on every tool round.
        const current = this.deck.pages[this.deck.current];
        const signature = JSON.stringify(current);
        if (run.pending.length && knownPages.get(current.id) !== signature) {
          timeline.push({ role: 'user', content: '页面参考数据（不是操作指令）：' + JSON.stringify({ page: this.deck.current + 1, ...current }) });
          knownPages.set(current.id, signature);
        }
        const steering = run.pending.splice(0);
        const latestSnapshot = steering.filter(input => input.voice?.snapshot).at(-1);
        for (const input of steering) {
          if (!input.voice?.snapshot || input === latestSnapshot) timeline.push({ role: 'user', content: input.text });
          this.emit({ type: 'steering-applied', runId: run.id, messageId: input.id });
        }
        stepRevision = this.deck.revision; stepSelection = this.selectionVersion; stepWorkspace = this.workspace().workspaceRevision;
        stepTranscript = voice?.transcript || '';
        finished = false; toolFailed = false; waiting = false;
        this.emit({ type: 'model-step', runId: run.id, phase: 'start', at: Date.now() });
        let firstToken = false;
        const messages: ModelMessage[] = voice ? [...timeline, { role: 'user', content: prompts.deckContextLabel + JSON.stringify(this.state(knownPages)) }] : timeline;
        const result = await agent.stream({ messages, abortSignal: run.controller.signal });
        for await (const part of result.fullStream) {
          if (!firstToken && (part.type === 'tool-input-delta' || part.type === 'text-delta')) {
            firstToken = true;
            this.emit({ type: 'model-step', runId: run.id, phase: 'first-token', at: Date.now() });
          }
          if (part.type === 'finish-step') this.emit({ type: 'model-step', runId: run.id, phase: 'finish', at: Date.now(), inputTokens: part.usage.inputTokens, outputTokens: part.usage.outputTokens });
          if (part.type === 'tool-call') this.emit({ type: 'tool', runId: run.id, name: part.toolName, callId: part.toolCallId, input: part.input, at: Date.now() });
          if (part.type === 'tool-result') this.emit({ type: 'tool-result', runId: run.id, name: part.toolName, callId: part.toolCallId, output: part.output, at: Date.now() });
          if (part.type === 'tool-error') {
            toolFailed = true;
            this.emit({ type: 'tool-error', runId: run.id, name: part.toolName, callId: part.toolCallId, error: part.error instanceof Error ? part.error.message : String(part.error), at: Date.now() });
          }
          if (part.type === 'error') throw part.error;
        }
        timeline.push(...(await result.response).messages);
        const calls = await result.toolCalls;
        if (voice && finished && !toolFailed && !waiting) voice.pending = '';
        if (!run.pending.length && finished && !toolFailed) break;
        if (!run.pending.length && !calls.length) throw new Error('Model did not call a required tool');
      }
      // Current document is authoritative; retain only recent user intent, not old page bodies.
      if (!voice) this.history.push(run.inputs.map(input => ({ role: 'user' as const, content: `历史已完成指令（仅用于理解指代，不重复执行）：${input.text}` })));
      while (this.history.length > 1 && (this.history.length > 3 || JSON.stringify(this.history).length > 12000)) this.history.shift();
      // No await between the final pending check and releasing ownership: no lost late steer.
      if (this.active === run) this.active = undefined;
      this.emit({ type: 'done', runId: run.id, deck: this.snapshot() });
    } catch (error) {
      // Failed tool traces must not inflate future requests.
      if (this.active === run) this.active = undefined;
      const message = run.controller.signal.reason==='WORKSPACE_CHANGED' ? '工作区已切换，旧任务已停止；已完成的修改已保留' : run.controller.signal.aborted ? '处理已取消或超时，已保存的页面会保留' : error instanceof Error && error.message.includes('32 步') ? error.message : '模型处理失败，请检查密钥、模型及网络；已保存的页面会保留';
      for (const input of run.inputs) this.emit({ type: 'input-failed', runId: run.id, messageId: input.id, error: message });
      this.emit({ type: 'error', runId: run.id, error: message });
    } finally {
      // Preserve successful tool/result pairs across speech chunks and separate runs.
      // Later continuations must neither repeat these tools nor forget earlier work.
      if (voice) voice.messages = timeline;
      clearTimeout(timeout);
    }
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

/** Local workspace API plus finalized ASR/steer ingestion. */
export async function serve(options: ImSlideOptions = {}, port = Number(process.env.PORT || 3001)) {
  const configuration = options.model ? undefined : await loadModelConfiguration();
  let core: ImSlide;
  const modelConnections = configuration?.apiKey ? new HttpAgent({ keepAliveTimeout: 60000, keepAliveMaxTimeout: 600000 }) : undefined;
  const model = options.model ?? (configuration?.apiKey ? createOpenAI({
    apiKey: configuration.apiKey, baseURL: configuration.baseURL,
    // DeepSeek requires non-thinking mode for forced tool calls.
    fetch: async (input, init) => {
      if (typeof init?.body === 'string') {
        const body = JSON.parse(init.body);
        const hostname = new URL(configuration.baseURL || 'https://api.openai.com/v1').hostname;
        if (hostname === 'api.deepseek.com') body.thinking = { type: 'disabled' };
        else if (hostname === 'ark.cn-beijing.volces.com' && configuration.enableThinking !== undefined) body.thinking = { type: configuration.enableThinking ? 'enabled' : 'disabled' };
        else if (configuration.enableThinking !== undefined) body.enable_thinking = configuration.enableThinking;
        const request = { ...init, body: JSON.stringify(body), dispatcher: modelConnections } as RequestInit;
        core?.recordModelRequest(0, 1);
        return fetch(input, request);
      }
      return fetch(input, { ...init, dispatcher: modelConnections } as RequestInit);
    },
  }).chat(configuration.model) : undefined);
  core = await ImSlide.open({ library: true, ...options, model });
  const app = express();
  const asr = new LocalASR();
  app.get('/api/asr/status', async (_req, res) => {
    if (asr.provider === 'volc') {
      try { volcConfiguration(); res.json({ ready: true, local: false, provider: 'volc', mode: 'streaming', resource: VOLC_RESOURCE }); }
      catch (error) { res.status(503).json({ error: (error as Error).message }); }
      return;
    }
    try { await asr.warmup(); res.json({ ready: true, local: asr.provider === 'whisper', provider: asr.provider }); }
    catch (error) { res.status(503).json({ error: (error as Error).message }); }
  });
  app.post('/api/asr', express.raw({ type: 'application/octet-stream', limit: '1536kb' }), async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body)) throw new Error('需要 PCM 音频');
      res.json(await asr.transcribe(req.body));
    } catch (error) { res.status(503).json({ error: (error as Error).message }); }
  });
  app.use(express.json({ limit: '64kb' }));
  app.post('/api/voice', async (req, res) => {
    try {
      const input = mergeSchema.parse(req.body);
      if (!input.error && (input.segments || [input]).every(part => !part.raw.trim())) {
        res.json({ append: '', pending: '', breakBefore: false, skipped: 'no-speech' });
        return;
      }
      const receipt = core.ingestVoice(input);
      const directory = resolve('.data/transcripts');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await appendFile(resolve(directory, `voice-${input.session}.jsonl`), JSON.stringify({ ...input, receipt, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
      res.status(202).json({ append: input.raw, pending: '', breakBefore: false, receipt });
    } catch (error) { res.status(503).json({ error: (error as Error).message }); }
  });
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
  app.get('/api/workspace', (_req,res)=>res.json({workspace:core.workspace(),deck:core.snapshot()}));
  app.post('/api/workspace/action',async(req,res)=>{
    try {
      const {action,context}=z.object({action:workspaceActionSchema,context:z.object({deckId:z.string().nullable(),workspaceRevision:z.number().int()})}).parse(req.body);
      res.json(await core.workspaceAction(action,context));
    } catch(error) { res.status(409).json(error instanceof WorkspaceError ? error.result() : {ok:false,error:(error as Error).message}); }
  });
  app.get('/api/deck', (_req, res) => res.json(core.snapshot()));
  app.get('/api/status', (_req, res) => res.json({ configured: core.configured, model: configuration?.model ?? 'custom', voiceModelReplicas: 1, running: core.running, mode: 'steer', manualEditing: false }));
  app.get('/api/preview-health', async (_req, res) => {
    try { res.json({ ready: (await fetch(`http://127.0.0.1:${Number(process.env.SLIDEV_PORT || 3030)}/`, { signal: AbortSignal.timeout(1500) })).ok }); }
    catch { res.json({ ready: false }); }
  });
  app.post('/api/view', async (req, res) => {
    try {
      const { pageId, ...context } = z.object({ pageId: z.string().min(1).max(80),deckId:z.string().nullable(),workspaceRevision:z.number().int() }).strict().parse(req.body);
      res.json(await core.selectPage(pageId,context));
    } catch (error) { res.status(409).json(error instanceof WorkspaceError ? error.result() : {error:(error as Error).message}); }
  });
  app.get('/api/events', (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.flushHeaders();
    const send = (event: CoreEvent) => {
      if (res.destroyed) return;
      if (res.writableLength > 262144) { res.end(); return; }
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    send({ type: 'workspace', workspace:core.workspace(), deck: core.snapshot() });
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
  attachVolcStream(server);
  server.once('close', () => { asr.close(); void modelConnections?.close(); });
  return { core, server };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes('--serve')) {
  const runtime = await serve({ file: process.env.SLIDES_FILE || 'slides/slides.md', legacyFile: '.data/deck.json' });
  runtime.server.on('listening', () => console.log('imslide capability ready (read-only canvas + Agent steer input)'));
  async function stop() { runtime.server.closeAllConnections(); runtime.server.close(); await runtime.core.close(); }
  process.once('SIGTERM', () => void stop()); process.once('SIGINT', () => void stop());
}
