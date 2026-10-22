import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowUp, ChevronLeft, ChevronRight, Layers, Maximize2, Mic, Radio, Sparkles, Square } from 'lucide-react';
import type { Deck, CoreEvent } from '../imslide';
import { VoiceInput, speechConstructor } from './voice';
import './style.css';

type ChatMessage = { id: string; role: 'user' | 'assistant'; text: string; status?: 'sending' | 'accepted' | 'processing' | 'done' | 'failed'; runId?: string };

function App() {
  const [deck, setDeck] = useState<Deck>();
  const [navigating, setNavigating] = useState(false);
  const [rendered, setRendered] = useState<{ pageId: string; revision: number; page: number; total: number }>();
  const [connected, setConnected] = useState(false);
  const [running, setRunning] = useState(false);
  const [previewReady, setPreviewReady] = useState(false);
  const [error, setError] = useState('');
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [configured, setConfigured] = useState<boolean>();
  const [listening, setListening] = useState(false);
  const [draft, setDraft] = useState('');
  const [activity, setActivity] = useState('');
  const voice = useRef<VoiceInput | undefined>(undefined);
  const outgoing = useRef<Promise<void>>(Promise.resolve());
  const chatEnd = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const index = deck?.current ?? 0;
  const page = deck?.pages[index];
  const previewOrigin = `${location.protocol}//${location.hostname}:${import.meta.env.VITE_SLIDEV_PORT || '3030'}`;
  const synced = !!deck && !!page && rendered?.pageId === page.id && rendered.revision === deck.revision && rendered.page === index + 1 && rendered.total === deck.pages.length;
  function receiveDeck(next: Deck) { setDeck(current => !current || next.revision >= current.revision ? next : current); }
  function syncFrame() {
    if (deck && page) frame.current?.contentWindow?.postMessage({ type: 'imslide:navigate', pageId: page.id, revision: deck.revision }, previewOrigin);
  }
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin !== previewOrigin || event.source !== frame.current?.contentWindow || event.data?.type !== 'imslide:rendered') return;
      const value = event.data;
      if (typeof value.pageId === 'string' && Number.isInteger(value.revision) && Number.isInteger(value.page) && Number.isInteger(value.total)) setRendered(value);
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
        if (event.type === 'tool') setActivity(event.name === 'navigate' ? 'Agent 正在切换页面…' : event.name === 'delete_current_page' ? 'Agent 正在删除当前页…' : event.name === 'clear_presentation' ? 'Agent 正在清空演示…' : 'Agent 正在更新当前页…');
        if (event.type === 'tool-skipped') setActivity('收到新要求，正在调整当前步骤…');
        if (event.type === 'input-failed') setMessages(items => items.map(item => item.id === event.messageId ? { ...item, status: 'failed' } : item));
        if (event.type === 'done') { setActivity(''); setMessages(items => items.map(item => item.role === 'user' && item.runId === event.runId ? { ...item, status: 'done' } : item)); }
      };
    }
    connect();
    return () => { stopped = true; clearTimeout(timer); clearTimeout(reconnectTimer); events?.close(); };
  }, []);
  useEffect(() => () => voice.current?.dispose(), []);
  useEffect(() => { chatEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [messages, activity, draft]);
  async function submit(text: string, utteranceId?: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    const id = utteranceId ? `speech:${utteranceId}` : crypto.randomUUID();
    setError('');
    setMessages(items => [...items, { id, role: 'user', text: trimmed, status: 'sending' }]);
    // Serialize transport acknowledgments only. Never wait for an Agent run to finish.
    const task = outgoing.current.then(async () => {
      try {
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
      const Constructor = speechConstructor();
      if (!Constructor) { setError('当前浏览器不支持语音识别，请使用 Chrome / Edge，或通过文字输入'); return; }
      voice.current = new VoiceInput(new Constructor(), { onDraft: setDraft, onListening: setListening, onError: setError, onSentence: (id, text) => { void submit(text, id); } });
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
      <main className="main-area" ref={canvas}>
        <div className="canvas-toolbar"><div><Radio size={13}/> 实时预览 <span className="divider"/> <span className="muted">{page?.title || '连接文稿中'}</span></div><span className="follow-button active">{synced ? '当前页已同步' : '正在同步画布…'}</span></div>
        <div className="canvas-region"><div className="slide-frame">
          {previewReady && deck && <iframe ref={frame} tabIndex={-1} title="Slidev 只读预览" src={`${previewOrigin}/1?embedded=true&imslideParent=${encodeURIComponent(location.origin)}`} onLoad={syncFrame} style={{ opacity: synced ? 1 : 0 }}/>}
          {!synced && <div className="placeholder">{previewReady ? `正在同步第 ${index + 1} 页…` : '正在连接 Slidev 渲染服务…'}</div>}
          {synced && page && !page.content && <div className="placeholder blank"><Layers size={28} strokeWidth={1}/><p>空白页面</p><span>等待底层 Agent 写入内容</span></div>}
        </div><div className="slide-under"><span>SLIDE {String(index + 1).padStart(2, '0')}</span><span>16:9 <span className="divider"/> Slidev Markdown</span></div></div>
        <footer className="canvas-bottom"><span><kbd>←</kbd><kbd>→</kbd> 浏览页面</span><div className="pager"><button aria-label="查看上一页" disabled={!deck || navigating || index === 0} onClick={() => view(index - 1)}><ChevronLeft size={17}/></button><span>{deck ? index + 1 : '—'} <i>/ {deck?.pages.length || '—'}</i></span><button aria-label="查看下一页" disabled={!deck || navigating || index >= deck.pages.length - 1} onClick={() => view(index + 1)}><ChevronRight size={17}/></button></div><span>查看与 Agent 编辑使用同一页</span></footer>
      </main>
      <aside className="chat-panel">
        <div className="chat-heading"><span className="assistant-mark"><Sparkles size={17}/></span><div><strong>创作助手</strong><span>说出想法，让 Agent 实时成页</span></div><span className="steer-badge">STEER</span></div>
        <div className="chat-scroll">
          {messages.length === 0 && <div className="chat-intro"><span>THINK IT. SAY IT. SLIDE IT.</span><h1>从一句话，<br/>开始你的演示。</h1><p>用文字或语音与 Agent 对话。<br/>创建、修改和翻页，都由 Agent 完成。</p><div className="example">可以说：<br/>“做一页关于未来工作的封面”<br/>“把标题改成绿色”<br/>“下一页，介绍产品优势”</div></div>}
          {messages.map(message => <div key={message.id} className={`chat-message ${message.role}`}><span className="message-label">{message.role === 'user' ? '你' : '✦ imslide'}{message.role === 'user' && <span>{message.status === 'sending' ? '发送中' : message.status === 'accepted' ? '等待注入' : message.status === 'processing' ? '已注入' : message.status === 'failed' ? '未完成' : '已处理'}</span>}</span><p>{message.text}</p></div>)}
          {running && <div className="activity"><i/>{activity || 'Agent 正在处理…'}</div>}
          <div ref={chatEnd}/>
        </div>
        <div className="composer-area">
          {error && <div className="error" role="alert">{error}</div>}
          {configured === false && <div className="config-note">请在 .env 中配置模型密钥后与 Agent 交互</div>}
          {listening && <div className="voice-draft"><span className="voice-dot"/>{draft || '正在聆听…'}<small>整句定稿后发送</small></div>}
          <form className={`composer ${listening ? 'listening' : ''}`} onSubmit={event => { event.preventDefault(); if (input.trim()) { void submit(input); setInput(''); } }}>
            <textarea aria-label="与 Agent 对话" placeholder={running ? '继续补充要求，将以 steer 注入…' : '说说你的想法，或想怎么修改…'} value={input} maxLength={8000} onChange={event => setInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }}/>
            <div className="composer-bottom"><button type="button" className={`mic-button ${listening ? 'active' : ''}`} onClick={toggleVoice} aria-label={listening ? '停止语音输入' : '开始语音输入'}>{listening ? <Square size={13} fill="currentColor"/> : <Mic size={16}/>}<span>{listening ? '停止聆听' : '语音输入'}</span></button><button type="submit" className="send-button" disabled={!input.trim() || !connected} aria-label="发送给 Agent"><ArrowUp size={18}/></button></div>
          </form>
          <p className="composer-caption">Enter 发送 · 运行中可继续补充指令</p>
        </div>
      </aside>
    </div>
  </div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
