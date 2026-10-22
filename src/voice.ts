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
export class VoiceInput {
  private wanted = false;
  private disposed = false;
  private failed = false;
  private speaking = false;
  private consumed = 0;
  private results: { text: string; final: boolean }[] = [];
  private carry = '';
  private utteranceId = '';
  private timer?: ReturnType<typeof setTimeout>;
  private restart?: ReturnType<typeof setTimeout>;
  constructor(private recognition: Recognition, private callbacks: VoiceCallbacks, private quietMs = 1200) {
    recognition.lang = 'zh-CN'; recognition.continuous = true; recognition.interimResults = true;
    recognition.onspeechstart = () => { if (!this.disposed) { this.speaking = true; clearTimeout(this.timer); } };
    recognition.onspeechend = () => { if (!this.disposed) { this.speaking = false; this.schedule(); } };
    recognition.onresult = event => {
      if (this.disposed || this.failed) return;
      const previous = this.carry + JSON.stringify(this.pending());
      this.results = Array.from({ length: event.results.length }, (_, index) => ({ text: event.results[index][0].transcript, final: event.results[index].isFinal }));
      if (!this.utteranceId && this.text().trim()) this.utteranceId = crypto.randomUUID();
      this.callbacks.onDraft(this.text());
      if (previous !== this.carry + JSON.stringify(this.pending())) this.schedule();
    };
    recognition.onerror = ({ error }) => {
      if (this.disposed || error === 'no-speech' || error === 'aborted') return;
      this.wanted = false; this.failed = true; this.discard(); this.callbacks.onListening(false);
      this.callbacks.onError(error === 'not-allowed' ? '麦克风权限被拒绝，请在浏览器中允许麦克风访问' : error === 'network' ? '语音识别连接失败，可改用文字输入' : `语音识别停止：${error}`);
    };
    recognition.onend = () => {
      if (this.disposed) return;
      this.speaking = false;
      if (this.failed) { this.discard(); return; }
      if (this.pending().some(result => !result.final)) {
        // Never turn an unresolved interim into an instruction when the engine stops.
        this.discard(); this.callbacks.onError('上一句尚未定稿，未发送给 Agent，请重新说一遍');
      } else {
        this.carry = this.text(); this.results = []; this.consumed = 0; this.schedule();
      }
      if (this.wanted) this.restart = setTimeout(() => {
        if (!this.wanted || this.disposed) return;
        try { recognition.start(); } catch { this.wanted = false; this.callbacks.onListening(false); this.callbacks.onError('无法继续语音识别，请重新开启麦克风'); }
      }, 250);
      else this.callbacks.onListening(false);
    };
  }
  private pending() { return this.results.slice(this.consumed); }
  private text() { return this.carry + this.pending().map(result => result.text).join(''); }
  private schedule() {
    clearTimeout(this.timer);
    if (this.disposed || this.speaking || !this.text().trim() || this.pending().some(result => !result.final)) return;
    this.timer = setTimeout(() => {
      if (this.disposed || this.speaking || this.pending().some(result => !result.final)) return;
      const text = this.text().trim();
      if (!text) return;
      const id = this.utteranceId || crypto.randomUUID();
      this.consumed = this.results.length; this.carry = ''; this.utteranceId = '';
      this.callbacks.onDraft(''); this.callbacks.onSentence(id, text);
    }, this.quietMs);
  }
  private discard() {
    clearTimeout(this.timer); this.results = []; this.consumed = 0; this.carry = ''; this.utteranceId = ''; this.callbacks.onDraft('');
  }
  start() {
    if (this.disposed || this.wanted) return;
    try { this.failed = false; this.recognition.start(); this.wanted = true; this.callbacks.onListening(true); }
    catch { this.callbacks.onError('无法启动语音识别，请检查麦克风权限'); }
  }
  stop() {
    this.wanted = false; clearTimeout(this.restart);
    this.recognition.stop(); this.callbacks.onListening(false);
    // Late final events may still arrive before onend. Do not flush a partial here.
  }
  dispose() {
    this.disposed = true; this.wanted = false; this.discard(); clearTimeout(this.restart); this.recognition.abort();
  }
}
