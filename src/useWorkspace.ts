import { computed, shallowRef, onMounted, onUnmounted, watch, type ShallowRef } from 'vue';
import type { WorkspaceState, WorkspaceAction } from './workspace-contract';
import type { Deck, CoreEvent } from '../imslide';
import { OverlapVoiceInput } from './overlap-voice';
import { StreamingVoiceInput } from './streaming-voice';
import { advanceSlideCache } from './blank-slide';
import type { CachedSlide } from './slide-types';
import type { RenderFailure } from './render-error';
import type { TranscriptView as TranscriptState } from './transcript';
import { reduceToolActivity, type ToolActivity as ToolActivityState, toolLabels } from './tool-activity';
type ChatMessage = {id:string;role:'user'|'assistant';text:string;status?:'sending'|'accepted'|'processing'|'done'|'failed';runId?:string;breakBefore?:boolean;formatted?:string};
function cell<T>(value: T): [ShallowRef<T>, (next: T | ((old:T)=>T))=>void];
function cell<T>(): [ShallowRef<T|undefined>, (next:T|undefined|((old:T|undefined)=>T|undefined))=>void];
function cell<T>(value?:T) { const state=shallowRef(value);return [state,(next:T|undefined|((old:T|undefined)=>T|undefined))=>{state.value=typeof next==='function'?(next as (old:T|undefined)=>T|undefined)(state.value):next;}]; }
export function useWorkspace() {

    const workspace=shallowRef<WorkspaceState>({mode:'management',activeDeckId:null,workspaceRevision:-1,decks:[]});
    const covers=shallowRef<Record<string,CachedSlide>>({});
    const [deck, setDeck] = cell<Deck>();
    const receivedDeck = shallowRef<Deck | undefined>(undefined);
    const [navigating, setNavigating] = cell(false);
    const [rendered, setRendered] = cell<{
        pageId: string;
        revision: number;
        page: number;
        total: number;
    }>();
    const [connected, setConnected] = cell(false);
    const [running, setRunning] = cell(false);
    const [renderError, setRenderError] = cell<RenderFailure>();
    const [cachedSlides, setCachedSlides] = cell<CachedSlide[]>([]);
    const [error, setError] = cell('');
    const [input, setInput] = cell('');
    const [inputMode, setInputMode] = cell<'voice' | 'text'>('voice');
    const paragraphContext = shallowRef('');
    const [messages, setMessages] = cell<ChatMessage[]>([]);
    const [configured, setConfigured] = cell<boolean>();
    const [listening, setListening] = cell(false);
    const [transcript, setTranscript] = cell<TranscriptState>({ fixed: '', pending: '', processing: false });
    const [activity, setActivity] = cell('');
    const [toolActivity, setToolActivity] = cell<ToolActivityState[]>([]);
    const voice = shallowRef<OverlapVoiceInput | StreamingVoiceInput | undefined>(undefined);
    const outgoing = shallowRef<Promise<void>>(Promise.resolve());
    const chatEnd = shallowRef<HTMLDivElement | null>(null);
    const canvas = shallowRef<HTMLDivElement | null>(null);

 const index = computed(() => deck.value?.current ?? 0);
 const page = computed(() => deck.value?.pages[index.value]);
 function receiveDeck(next: Deck) {
 const previous = receivedDeck.value;
 if (next.workspaceRevision!==undefined && next.workspaceRevision<workspace.value.workspaceRevision)return;
 if(previous?.deckId!==next.deckId) {
   if(previous?.deckId && cachedSlides.value[0])covers.value={...covers.value,[previous.deckId]:cachedSlides.value.find(s=>s.page===1) || cachedSlides.value[0]};
   setCachedSlides([]);setRendered(undefined);setRenderError(undefined);receivedDeck.value=undefined;
 }
 if (previous?.deckId===next.deckId && previous && next.revision < previous.revision) return;
 receivedDeck.value=next; setDeck(next);
 setCachedSlides(current=>advanceSlideCache(current,previous?.deckId===next.deckId?previous:undefined,next));
 }
 function receiveWorkspace(state:WorkspaceState,next:Deck) {
   if(state.workspaceRevision<workspace.value.workspaceRevision)return;
   workspace.value=state;receiveDeck(next);
 }
 async function workspaceAction(action:WorkspaceAction) {
   const state=workspace.value;
   try {
     const response=await fetch('/api/workspace/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,context:{deckId:state.activeDeckId,workspaceRevision:state.workspaceRevision}})});
     const result=await response.json();if(!response.ok)throw new Error(result.error || '操作失败');
     receiveWorkspace(result.workspace,result.deck);setError('');return result;
   } catch(cause){setError((cause as Error).message);}
 }
    const connectEvents = () => {
        let stopped = false;
        let events: EventSource | undefined;
        let reconnectTimer: ReturnType<typeof setTimeout>;
        function connect() {
            if (stopped)
                return;
            const stream = new EventSource('/api/events');
            events = stream;
            stream.onopen = () => {
                setConnected(true);
                setError('');
                void fetch('/api/status').then(r => r.json()).then(status => { if (!stopped) {
                    setRunning(status.running);
                    setConfigured(status.configured);
                } }).catch(() => { });
            };
            // Recreate even after a startup HTTP error, which may permanently close EventSource.
            stream.onerror = () => {
                if (stopped)
                    return;
                setConnected(false);
                stream.close();
                setToolActivity(items => reduceToolActivity(items, { type: 'disconnected' }));
                reconnectTimer = setTimeout(connect, 1500);
            };
            stream.onmessage = message => {
                const event: CoreEvent = JSON.parse(message.data);
                setToolActivity(items => reduceToolActivity(items, event));
                if(event.type==='workspace')receiveWorkspace(event.workspace,event.deck);
                if (event.type === 'deck' || event.type === 'done')
                    receiveDeck(event.deck);
                if (event.type === 'started' || event.type === 'accepted') {
                    setRunning(true);
                    setError('');
                }
                if (event.type === 'done' || (event.type === 'error' && event.runId))
                    setRunning(false);
                if (event.type === 'error') {
                    setError(event.error);
                    setActivity('');
                }
                if (event.type === 'accepted' || event.type === 'steering-applied') {
                    setMessages(items => items.map(item => item.id === event.messageId ? { ...item, runId: event.runId, status: event.type === 'steering-applied' ? 'processing' : item.status === 'sending' ? 'accepted' : item.status } : item));
                    setActivity(event.type === 'steering-applied' ? '正在处理已确认的指令…' : '已收到新指令，将在下一步调整…');
                }
                if (event.type === 'text')
                    setMessages(items => {
                        const existing = items.find(item => item.id === event.responseId);
                        return existing ? items.map(item => item.id === event.responseId ? { ...item, text: item.text + event.text } : item) : [...items, { id: event.responseId, role: 'assistant', text: event.text, runId: event.runId }];
                    });
                if (event.type === 'tool')
                    setActivity(`正在${toolLabels[event.name] || event.name}…`);
                if (event.type === 'tool-skipped')
                    setActivity('收到新要求，正在调整当前步骤…');
                if (event.type === 'input-failed')
                    setMessages(items => items.map(item => item.id === event.messageId ? { ...item, status: 'failed' } : item));
                if (event.type === 'done') {
                    setActivity('');
                    setMessages(items => items.map(item => item.role === 'user' && item.runId === event.runId ? { ...item, status: 'done' } : item));
                }
            };
        }
        connect();
        return () => { stopped = true; clearTimeout(reconnectTimer); events?.close(); };
    };
    let disconnectEvents: (() => void) | undefined;
    onMounted(() => { disconnectEvents = connectEvents(); });
    onUnmounted(() => disconnectEvents?.());
    onUnmounted(() => voice.value?.dispose());
    watch([messages, activity, transcript], () => { chatEnd.value?.scrollIntoView({behavior:'smooth',block:'nearest'}); }, {flush:'post'});
    async function submit(text: string, utteranceId?: string, breakBefore?: boolean, accepted?: {
        runId: string;
        messageId: string;
    }) {
        const trimmed = text.trim();
        if (!trimmed)
            return;
        const id = utteranceId ? `speech:${utteranceId}` : crypto.randomUUID();
        setError('');
        setMessages(items => [...items, { id, role: 'user', text: trimmed, status: accepted ? 'accepted' : 'sending', runId: accepted?.runId, breakBefore }]);
        if (accepted)
            return; // /api/voice already submitted this chunk to the backend Agent.
        // Serialize transport acknowledgments only. Never wait for an Agent run to finish.
        const task = outgoing.value.then(async () => {
            try {
                // Formatting never changes the command sent to the deck agent.
                if (!utteranceId)
                    void (async () => {
                        try {
                            const response = await fetch('/api/text/paragraphs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: trimmed, previous: paragraphContext.value }) });
                            if (!response.ok)
                                throw new Error('分段失败');
                            const formatted = await response.json();
                            setMessages(items => items.map(item => item.id === id ? { ...item, formatted: formatted.text, breakBefore: formatted.breakBefore } : item));
                        }
                        catch {
                            // Keep the original text readable if the formatting service is unavailable.
                            setMessages(items => items.map(item => item.id === id ? { ...item, breakBefore: true } : item));
                        }
                    })();
                paragraphContext.value = Array.from(paragraphContext.value + trimmed).slice(-128).join('');
                const body = utteranceId ? { type: 'transcript', utteranceId, text: trimmed, isFinal: true, endOfUtterance: true } : { id, message: trimmed, mode: 'steer' };
                const response = await fetch(utteranceId ? '/api/input' : '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
                const receipt = await response.json();
                if (!response.ok)
                    throw new Error(receipt.error || '指令发送失败');
                setMessages(items => items.map(item => item.id === id ? { ...item, runId: receipt.runId ?? item.runId, status: item.status === 'sending' ? 'accepted' : item.status } : item));
            }
            catch (error) {
                setError((error as Error).message);
                setMessages(items => items.map(item => item.id === id ? { ...item, status: 'failed' } : item));
            }
        });
        outgoing.value = task;
        await task;
    }
    async function toggleVoice() {
        if (listening.value) {
            voice.value?.stop();
            return;
        }
        if (!voice.value) {
            try {
                const status = await fetch('/api/asr/status').then(response => response.json());
                if (!status.ready)
                    throw new Error(status.error || '语音服务不可用');
                const Voice = status.provider === 'volc' ? StreamingVoiceInput : OverlapVoiceInput;
                voice.value ??= new Voice({ onTranscript: setTranscript, onListening: setListening, onError: setError, onSentence: (id, text, breakBefore, receipt) => { void submit(text, id, breakBefore, receipt); } });
            }
            catch (error) {
                setError((error as Error).message);
                return;
            }
        }
        setError('');
        voice.value.start();
    }
    function view(target: number) {
        if (workspace.value.mode==='management' || !deck.value || navigating.value || target < 0 || target >= deck.value.pages.length)
            return;
        const pageId = deck.value.pages[target].id;
        const context={deckId:workspace.value.activeDeckId,workspaceRevision:workspace.value.workspaceRevision};
        setNavigating(true);
        setError('');
        const task = outgoing.value.then(async () => {
            try {
                const response = await fetch('/api/view', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pageId,...context }) });
                const result = await response.json();
                if (!response.ok)
                    throw new Error(result.error || '页面切换失败');
                receiveDeck(result);
            }
            catch (error) {
                setError((error as Error).message);
            }
            finally {
                setNavigating(false);
            }
        });
        outgoing.value = task;
    }
    const handler = (event: KeyboardEvent) => {
 const target = event.composedPath()[0];
 if (target instanceof HTMLElement && target.closest('textarea,input,[contenteditable="true"]')) return;
 if(workspace.value.mode==='management')return;
 if(event.key==='Escape' && workspace.value.mode==='presentation'){void workspaceAction({tool:'switch_mode',mode:'preview'});return;}
 if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {event.preventDefault();view(index.value+(event.key==='ArrowRight'?1:-1));}
 };
 onMounted(()=>window.addEventListener('keydown',handler));
 onUnmounted(()=>window.removeEventListener('keydown',handler));

 return {workspace,covers,workspaceAction,deck,index,page,navigating,rendered,connected,running,renderError,cachedSlides,error,input,inputMode,messages,listening,transcript,activity,toolActivity,voice,chatEnd,canvas,submit,toggleVoice,view,setCachedSlides,setRenderError,setRendered};
}
