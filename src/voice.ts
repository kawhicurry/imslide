/** Browser ASR adapter. Drafts stay local; only a stable complete sentence is sent. */
export interface RecognitionResult { isFinal: boolean; 0: { transcript: string }; }
export interface RecognitionEvent { results: { length: number; [index: number]: RecognitionResult }; }
export interface Recognition {
  lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((event: RecognitionEvent) => void) | null;
  onspeechstart: (() => void) | null; onspeechend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null; onend: (() => void) | null;
  start(): void; stop(): void; abort(): void;
}
export function speechConstructor(): (new () => Recognition) | undefined {
  const browser = window as Window & { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return browser.SpeechRecognition || browser.webkitSpeechRecognition;
}
export type VoiceCallbacks = {
  onDraft(text: string): void; onSentence(id: string, text: string): void;
  onListening(listening: boolean): void; onError(message: string): void;
};
/** Split confirmed text at sentence punctuation, preserving quoted titles and decimals. */
export function splitSentences(text: string): string[] {
  const parts: string[] = [], stack: string[] = [];
  const pairs: Record<string, string> = { '“': '”', '‘': '’', '「': '」', '『': '』', '（': '）', '(': ')', '[': ']', '【': '】' };
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (stack.at(-1) === char) stack.pop();
    else if (pairs[char]) stack.push(pairs[char]);
    else if (char === '"' || char === '`') stack.push(char);
    const boundary = /[。！？!?]/.test(char) || (char === '.' && (i === text.length - 1 || /\s/.test(text[i + 1])));
    if (boundary && !stack.length) {
      const part = text.slice(start, i + 1).trim();
      if (part) parts.push(part);
      start = i + 1;
    }
  }
  const tail = text.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}
export class VoiceInput {
  private wanted = false;
  private disposed = false;
  private failed = false;
  private consumed = 0;
  private results: { text: string; final: boolean }[] = [];
  private utteranceId = '';
  private cutting = false;
  private boundaryTimer?: ReturnType<typeof setTimeout>;
  private segmentTimer?: ReturnType<typeof setTimeout>;
  private restart?: ReturnType<typeof setTimeout>;
  constructor(private recognition: Recognition, private callbacks: VoiceCallbacks) {
    // A recognition session ends at the browser's utterance boundary. Restart it
    // automatically, instead of waiting for continuous mode to end a paragraph.
    recognition.lang = 'zh-CN'; recognition.continuous = false; recognition.interimResults = true;
    recognition.onspeechstart = () => {
      if (this.disposed || this.failed || this.cutting) return;
      clearTimeout(this.boundaryTimer);
    };
    recognition.onspeechend = () => {
      if (!this.disposed && !this.failed) this.scheduleBoundary(350);
    };
    recognition.onresult = event => {
      if (this.disposed || this.failed) return;
      const previous = this.text();
      this.results = Array.from({ length: event.results.length }, (_, index) => ({ text: event.results[index][0].transcript, final: event.results[index].isFinal }));
      if (!this.utteranceId && this.text().trim()) this.utteranceId = crypto.randomUUID();
      this.callbacks.onDraft(this.text());
      this.commitFinal();
      if (this.text().trim() && !this.cutting) {
        // Bound an uninterrupted stream even when ASR never emits speechend/final.
        this.segmentTimer ??= setTimeout(() => this.finalizeSegment(), 15000);
        if (previous !== this.text()) {
          const first = splitSentences(this.text())[0];
          this.scheduleBoundary(first && /[。！？!?.]$/.test(first) ? 300 : 1200);
        }
      }
    };
    recognition.onerror = ({ error }) => {
      if (this.disposed || error === 'no-speech' || error === 'aborted') return;
      this.wanted = false; this.failed = true; this.discard(); this.callbacks.onListening(false);
      this.callbacks.onError(error === 'not-allowed' ? '麦克风权限被拒绝，请在浏览器中允许麦克风访问' : error === 'network' ? '语音识别连接失败，可改用文字输入' : `语音识别停止：${error}`);
    };
    recognition.onend = () => {
      if (this.disposed) return;
      this.clearBoundaryTimers(); this.cutting = false;
      if (this.failed) { this.discard(); return; }
      if (this.pending().some(result => !result.final)) {
        // Never turn an unresolved interim into an instruction when the engine stops.
        this.discard(); this.callbacks.onError('上一句尚未定稿，未发送给 Agent，请重新说一遍');
      } else {
        this.commitFinal(); this.discard();
      }
      if (this.wanted) this.restart = setTimeout(() => {
        if (!this.wanted || this.disposed) return;
        try { recognition.start(); } catch { this.wanted = false; this.callbacks.onListening(false); this.callbacks.onError('无法继续语音识别，请重新开启麦克风'); }
      }, 100);
      else this.callbacks.onListening(false);
    };
  }
  private clearBoundaryTimers() {
    clearTimeout(this.boundaryTimer); clearTimeout(this.segmentTimer);
    this.boundaryTimer = undefined; this.segmentTimer = undefined;
  }
  private scheduleBoundary(delay: number) {
    if (!this.wanted || this.cutting || !this.text().trim()) return;
    clearTimeout(this.boundaryTimer);
    this.boundaryTimer = setTimeout(() => this.finalizeSegment(), delay);
  }
  private finalizeSegment() {
    if (!this.wanted || this.disposed || this.failed || this.cutting || !this.text().trim()) return;
    this.cutting = true; this.clearBoundaryTimers();
    // stop() requests a final result; never promote an interim to a command.
    try { this.recognition.stop(); }
    catch { this.cutting = false; this.wanted = false; this.discard(); this.callbacks.onListening(false); this.callbacks.onError('语音分段失败，请重新开启麦克风'); }
  }
  private pending() { return this.results.slice(this.consumed); }
  private text() { return this.pending().map(result => result.text).join(''); }
  private commitFinal() {
    if (this.disposed || this.failed || this.pending().some(result => !result.final)) return;
    const text = this.text().trim();
    if (!text) return;
    const id = this.utteranceId || crypto.randomUUID();
    this.consumed = this.results.length; this.utteranceId = '';
    this.clearBoundaryTimers();
    this.callbacks.onDraft('');
    splitSentences(text).forEach((sentence, index) => this.callbacks.onSentence(index === 0 ? id : crypto.randomUUID(), sentence));
  }
  private discard() {
    this.clearBoundaryTimers();
    this.results = []; this.consumed = 0; this.utteranceId = ''; this.callbacks.onDraft('');
  }
  start() {
    if (this.disposed || this.wanted) return;
    try { this.failed = false; this.recognition.start(); this.wanted = true; this.callbacks.onListening(true); }
    catch { this.callbacks.onError('无法启动语音识别，请检查麦克风权限'); }
  }
  stop() {
    this.wanted = false; clearTimeout(this.restart); this.clearBoundaryTimers();
    this.recognition.stop(); this.callbacks.onListening(false);
    // Late final events may still arrive before onend. Do not flush a partial here.
  }
  dispose() {
    this.disposed = true; this.wanted = false; this.discard(); clearTimeout(this.restart); this.recognition.abort();
  }
}
