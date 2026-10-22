import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowUp, ChevronLeft, ChevronRight, Layers, Maximize2, Mic, Radio, Keyboard, Square } from 'lucide-react';
import type { Deck, CoreEvent } from '../imslide';
import { OverlapVoiceInput } from './overlap-voice';
import type { RenderFailure } from './render-error';
import { SlideCache, type CachedSlide } from './SlideCache';
import type { TranscriptView as TranscriptState } from './transcript';
import './style.css';

type ChatMessage = { id: string; role: 'user' | 'assistant'; text: string; status?: 'sending' | 'accepted' | 'processing' | 'done' | 'failed'; runId?: string; breakBefore?: boolean; formatted?: string };

function App() {
  const [deck, setDeck] = useState<Deck>();
  const [navigating, setNavigating] = useState(false);
  const [rendered, setRendered] = useState<{ pageId: string; revision: number; page: number; total: number }>();
  const [connected, setConnected] = useState(false);
  const [running, setRunning] = useState(false);
  const [previewReady, setPreviewReady] = useState(false);
  const [renderError, setRenderError] = useState<RenderFailure>();
  const previewRevision = useRef(-1);
  const [cachedSlides, setCachedSlides] = useState<CachedSlide[]>([]);
  const [previewPresentation, setPreviewPresentation] = useState<{ blank: boolean }>();
  const [error, setError] = useState('');
  const [input, setInput] = useState('');
  const [inputMode, setInputMode] = useState<'voice' | 'text'>('voice');
  const paragraphContext = useRef('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [configured, setConfigured] = useState<boolean>();
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptState>({ fixed: '', pending: '', processing: false });
  const [activity, setActivity] = useState('');
  const voice = useRef<OverlapVoiceInput | undefined>(undefined);
  const outgoing = useRef<Promise<void>>(Promise.resolve());
  const chatEnd = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const index = deck?.current ?? 0;
  const page = deck?.pages[index];
  const previewOrigin = `${location.protocol}//${location.hostname}:${import.meta.env.VITE_SLIDEV_PORT || '3030'}`;
  const synced = !!deck && !!page && rendered?.pageId === page.id && rendered.revision === deck.revision && rendered.page === index + 1 && rendered.total === deck.pages.length;
  // Keep the last rendered canvas visible while Slidev applies an update.
  // Synchronization status must not turn every revision into a loading screen.
  useEffect(() => {
    if (synced && page) setPreviewPresentation({ blank: !page.content });
  }, [synced, page]);
  const renderedSlide = useCallback((slide: CachedSlide) => {
    setRendered(slide);
    setRenderError(current => current && slide.revision >= current.revision && (!current.pageId || current.pageId === slide.pageId) ? undefined : current);
  }, []);
  function receiveDeck(next: Deck) { setDeck(current => !current || next.revision >= current.revision ? next : current); }
  function syncFrame() {
    if (deck && page) frame.current?.contentWindow?.postMessage({ type: 'imslide:navigate', pageId: page.id, revision: deck.revision }, previewOrigin);
  }
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin !== previewOrigin || event.source !== frame.current?.contentWindow) return;
      if (event.data?.type === 'imslide:render-error') {
        const failure = event.data.error;
        if (failure && typeof failure.message === 'string' && Number.isInteger(failure.revision)) setRenderError(failure);
        return;
      }
      if (event.data?.type !== 'imslide:pages') return;
      if (!Number.isInteger(event.data.revision) || event.data.revision < previewRevision.current) return;
      previewRevision.current = event.data.revision;
      const pages = event.data.pages;
      if (Array.isArray(pages) && pages.every(value => typeof value.snapshot === 'string' && typeof value.pageId === 'string' && typeof value.html === 'string' && Number.isInteger(value.revision) && value.width > 0 && value.height > 0)) setCachedSlides(previous => {
        const available = new Map(previous.map(slide => [slide.pageId, slide]));
        for (const slide of pages) available.set(slide.pageId, slide);
        const order: string[] = Array.isArray(event.data.order) ? event.data.order : pages.map(slide => slide.pageId);
        return order.flatMap((id, index) => {
          const slide = available.get(id);
          return slide ? [{ ...slide, page: index + 1, total: order.length, revision: event.data.revision ?? slide.revision }] : [];
        });
      });
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [previewOrigin]);
  useEffect(() => {
    if (!previewReady || !deck) return;
    syncFrame();
    if (synced) return;
    const timer = setInterval(syncFrame, 250);
    return () => clearInterval(timer);
  }, [previewReady, deck, synced]);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function checkPreview() {
      try {
        const status = await (await fetch('/api/preview-health')).json();
        if (stopped) return;
        if (status.ready) { setPreviewReady(true); return; }
      } catch {}
      if (!stopped) timer = setTimeout(checkPreview, 1500);
    }
    void checkPreview();
    let events: EventSource | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    function connect() {
      if (stopped) return;
      const stream = new EventSource('/api/events');
      events = stream;
      stream.onopen = () => {
        setConnected(true); setError('');
        void fetch('/api/status').then(r => r.json()).then(status => { if (!stopped) { setRunning(status.running); setConfigured(status.configured); } }).catch(() => {});
      };
      // Recreate even after a startup HTTP error, which may permanently close EventSource.
      stream.onerror = () => {
        if (stopped) return;
        setConnected(false); stream.close();
        reconnectTimer = setTimeout(connect, 1500);
      };
      stream.onmessage = message => {
        const event: CoreEvent = JSON.parse(message.data);
        if (event.type === 'deck' || event.type === 'done') receiveDeck(event.deck);
        if (event.type === 'started' || event.type === 'accepted') { setRunning(true); setError(''); }
        if (event.type === 'done' || (event.type === 'error' && event.runId)) setRunning(false);
        if (event.type === 'error') { setError(event.error); setActivity(''); }
        if (event.type === 'accepted' || event.type === 'steering-applied') {
          setMessages(items => items.map(item => item.id === event.messageId ? { ...item, runId: event.runId, status: event.type === 'steering-applied' ? 'processing' : item.status === 'sending' ? 'accepted' : item.status } : item));
          setActivity(event.type === 'steering-applied' ? '正在处理已确认的指令…' : '已收到新指令，将在下一步调整…');
        }
        if (event.type === 'text') setMessages(items => {
          const existing = items.find(item => item.id === event.responseId);
          return existing ? items.map(item => item.id === event.responseId ? { ...item, text: item.text + event.text } : item) : [...items, { id: event.responseId, role: 'assistant', text: event.text, runId: event.runId }];
        });
        if (event.type === 'tool') setActivity(event.name === 'navigate' ? 'Agent 正在切换页面…' : event.name === 'delete_page' ? 'Agent 正在删除页面…' : 'Agent 正在更新页面…');
        if (event.type === 'tool-skipped') setActivity('收到新要求，正在调整当前步骤…');
        if (event.type === 'input-failed') setMessages(items => items.map(item => item.id === event.messageId ? { ...item, status: 'failed' } : item));
        if (event.type === 'done') { setActivity(''); setMessages(items => items.map(item => item.role === 'user' && item.runId === event.runId ? { ...item, status: 'done' } : item)); }
      };
    }
    connect();
    return () => { stopped = true; clearTimeout(timer); clearTimeout(reconnectTimer); events?.close(); };
  }, []);
  useEffect(() => () => voice.current?.dispose(), []);
  useEffect(() => { chatEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [messages, activity, transcript]);
  async function submit(text: string, utteranceId?: string, breakBefore?: boolean) {
    const trimmed = text.trim();
    if (!trimmed) return;
    const id = utteranceId ? `speech:${utteranceId}` : crypto.randomUUID();
    setError('');
    setMessages(items => [...items, { id, role: 'user', text: trimmed, status: 'sending', breakBefore }]);
    // Serialize transport acknowledgments only. Never wait for an Agent run to finish.
    const task = outgoing.current.then(async () => {
      try {
        // Formatting never changes the command sent to the deck agent.
        if (!utteranceId) void (async () => { try {
          const response = await fetch('/api/text/paragraphs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: trimmed, previous: paragraphContext.current }) });
          if (!response.ok) throw new Error('分段失败');
          const formatted = await response.json();
          setMessages(items => items.map(item => item.id === id ? { ...item, formatted: formatted.text, breakBefore: formatted.breakBefore } : item));
        } catch {
          // Keep the original text readable if the formatting service is unavailable.
          setMessages(items => items.map(item => item.id === id ? { ...item, breakBefore: true } : item));
        } })();
        paragraphContext.current = Array.from(paragraphContext.current + trimmed).slice(-128).join('');
        const body = utteranceId ? { type: 'transcript', utteranceId, text: trimmed, isFinal: true, endOfUtterance: true } : { id, message: trimmed, mode: 'steer' };
        const response = await fetch(utteranceId ? '/api/input' : '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const receipt = await response.json();
        if (!response.ok) throw new Error(receipt.error || '指令发送失败');
        setMessages(items => items.map(item => item.id === id ? { ...item, runId: receipt.runId ?? item.runId, status: item.status === 'sending' ? 'accepted' : item.status } : item));
      } catch (error) {
        setError((error as Error).message); setMessages(items => items.map(item => item.id === id ? { ...item, status: 'failed' } : item));
      }
    });
    outgoing.current = task;
    await task;
  }
  function toggleVoice() {
    if (listening) { voice.current?.stop(); return; }
    if (!voice.current) {
      voice.current = new OverlapVoiceInput({ onTranscript: setTranscript, onListening: setListening, onError: setError, onSentence: (id, text, breakBefore) => { void submit(text, id, breakBefore); } });
    }
    setError(''); voice.current.start();
  }
  function view(target: number) {
    if (!deck || navigating || target < 0 || target >= deck.pages.length) return;
    const pageId = deck.pages[target].id;
    setNavigating(true); setError('');
    const task = outgoing.current.then(async () => {
      try {
        const response = await fetch('/api/view', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pageId }) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || '页面切换失败');
        receiveDeck(result);
      } catch (error) { setError((error as Error).message); }
      finally { setNavigating(false); }
    });
    outgoing.current = task;
  }
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).closest('textarea,input,[contenteditable="true"]')) return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); view(index + (event.key === 'ArrowRight' ? 1 : -1)); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [deck, index, navigating]);
  return <div className="app">
    <header className="topbar">
      <a href="/" className="brand" aria-label="imslide 查看器"><span className="brand-icon"><Layers size={20}/></span>imslide <span className="readonly">AGENT 创作</span></a>
      <span className="document-name">slides.md <span>/</span> 实时演示</span>
      <div className="header-actions"><span className={`connection ${connected ? 'online' : ''}`}><i/>{connected ? running ? 'Agent 正在更新' : '已连接' : '重新连接中'}</span><button className="button" onClick={() => canvas.current?.requestFullscreen().catch(() => setError('浏览器未允许全屏'))}><Maximize2 size={14}/> 全屏查看</button></div>
    </header>
    <div className="workspace">
      <aside className="sidebar"><div className="section-label">幻灯片 <span>{deck?.pages.length.toString().padStart(2, '0') || '—'}</span></div>
        <div className="page-list">{deck?.pages.map((p, i) => <button key={p.id} disabled={navigating} className={`page-item ${i === index ? 'selected' : ''}`} onClick={() => view(i)} aria-label={`查看第 ${i + 1} 页：${p.title}`}>
          <span className="page-index">{String(i + 1).padStart(2, '0')}</span><span className="thumbnail">{p.content ? <span className="thumbnail-content"><strong>{p.title}</strong><span>{p.content.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]*>/g, '').replace(/[#*`]/g, '').slice(0, 110)}</span></span> : <span className="thumbnail-blank"/>}</span><span className="page-title">{p.title}</span>{i === deck.current && <span className="agent-page">AGENT</span>}
        </button>)}</div>
        <div className="sidebar-footer"><Layers size={10}/> SLIDEV ENGINE</div>
      </aside>
      <main className="main-area">
        <div className="canvas-toolbar"><div><Radio size={13}/> 实时预览 <span className="divider"/> <span className="muted">{page?.title || '连接文稿中'}</span></div><span className="follow-button active">{synced ? '当前页已同步' : '正在同步画布…'}</span></div>
        <div className="canvas-region"><div className="slide-frame" ref={canvas}>
          {previewReady && deck && <iframe ref={frame} tabIndex={-1} className="slide-renderer" aria-hidden="true" title="后台幻灯片渲染" src={`${previewOrigin}/1?embedded=true&imslideParent=${encodeURIComponent(location.origin)}`} onLoad={syncFrame} style={{ visibility: 'hidden' }}/>}
          <SlideCache slides={cachedSlides} pageId={page?.id} onError={setRenderError} onRendered={renderedSlide}/>
          {!previewPresentation && <div className="placeholder">{renderError ? '页面未能渲染' : previewReady ? `正在同步第 ${index + 1} 页…` : '正在连接 Slidev 渲染服务…'}</div>}
        </div><div className="slide-under"><span>SLIDE {String(index + 1).padStart(2, '0')}</span><span>16:9 <span className="divider"/> Slidev Markdown</span></div></div>
        {renderError && <div className="error" role="alert">渲染失败，保留当前画面：{renderError.message}</div>}
        <footer className="canvas-bottom"><span><kbd>←</kbd><kbd>→</kbd> 浏览页面</span><div className="pager"><button aria-label="查看上一页" disabled={!deck || navigating || index === 0} onClick={() => view(index - 1)}><ChevronLeft size={17}/></button><span>{deck ? index + 1 : '—'} <i>/ {deck?.pages.length || '—'}</i></span><button aria-label="查看下一页" disabled={!deck || navigating || index >= deck.pages.length - 1} onClick={() => view(index + 1)}><ChevronRight size={17}/></button></div><span>查看与 Agent 编辑使用同一页</span></footer>
      </main>
      <aside className="chat-panel">
        <div className="chat-scroll">
          {messages.length === 0 && <div className="chat-intro"><span>THINK IT. SAY IT. SLIDE IT.</span><h1>从一句话，<br/>开始你的演示。</h1></div>}
          <div className="live-document" role="log" aria-label="实时文字记录">
            {messages.map((message, index) => <span key={message.id} className={message.status === 'sending' ? 'record-pending' : 'record-fixed'}>{index > 0 && message.breakBefore !== false ? '\n\n' : ''}{message.formatted ?? message.text}</span>)}
            {transcript.pending && <span className="transcript-pending">{transcript.pending}</span>}
          </div>
          <div ref={chatEnd}/>
        </div>
        <div className="composer-area">
          {inputMode === 'voice' ? <div className="voice-controls">
            <button type="button" className={`voice-orb ${listening ? 'active' : ''}`} onClick={toggleVoice} aria-label={listening ? '停止语音输入' : '开始语音输入'} aria-pressed={listening}>{listening ? <Square size={23} fill="currentColor"/> : <Mic size={30}/>}</button>
            <button type="button" className="input-mode-switch" onClick={() => { void voice.current?.stop(); setInputMode('text'); }} aria-label="切换到文字输入"><Keyboard size={19}/></button>
          </div> : <form className="composer" onSubmit={event => { event.preventDefault(); if (input.trim()) { void submit(input); setInput(''); } }}>
            <textarea autoFocus aria-label="输入文字" value={input} maxLength={8000} onChange={event => setInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }}/>
            <div className="composer-bottom"><button type="button" className="mic-button" onClick={() => setInputMode('voice')} aria-label="切换到语音输入"><Mic size={18}/></button><button type="submit" className="send-button" disabled={!input.trim() || !connected} aria-label="发送"><ArrowUp size={18}/></button></div>
          </form>}

        </div>
      </aside>
    </div>
  </div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
