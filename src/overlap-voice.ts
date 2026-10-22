import { type ASRWord, type TranscriptView } from './transcript';
import { VoiceChunks, type VoiceChunk } from './voice-chunks';
export type OverlapCallbacks = {
  onTranscript(view: TranscriptView): void;
  onSentence(id: string, text: string): void;
  onListening(value: boolean): void;
  onError(message: string): void;
};

/** Capture never waits for ASR; completed chunks are calibrated in recording order. */
export class OverlapVoiceInput {
  private audio = new VoiceChunks();
  private fixed = '';
  private pending = new Map<number, string>();
  private session = '';
  private sequence = 0;
  private jobs = new Set<Promise<void>>();
  private mergeQueue: Promise<void> = Promise.resolve();
  private controllers = new Set<AbortController>();
  private context?: AudioContext;
  private stream?: MediaStream;
  private capture?: AudioWorkletNode;
  private source?: MediaStreamAudioSourceNode;
  private timer?: ReturnType<typeof setInterval>;
  private wanted = false;
  private starting = false;
  private disposed = false;
  private stopping = false;
  private epoch = 0;
  private flushed?: () => void;
  constructor(private callbacks: OverlapCallbacks) {}
  private render() { this.callbacks.onTranscript({ fixed: this.fixed, pending: [...this.pending.values()].join(''), processing: this.jobs.size > 0 }); }
  private async request(url: string, options: RequestInit) {
    const controller = new AbortController(); this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 90000);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || '语音处理失败');
      return value;
    } finally { clearTimeout(timer); this.controllers.delete(controller); }
  }
  private enqueue(chunk: VoiceChunk) {
    const seq = this.sequence++, epoch = this.epoch;
    const alive = () => !this.disposed && epoch === this.epoch;
    // Recognition starts immediately; merging remains in capture order.
    const recognized = this.request('/api/asr', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: chunk.samples.buffer as ArrayBuffer })
      .then(value => {
        if (!Array.isArray(value.words)) throw new Error('语音结果无效');
        const raw = (value.words as ASRWord[]).map(w => w.text).join('');
        if (alive()) { this.pending.set(seq, raw); this.render(); }
        return { raw, error: undefined as string | undefined };
      }).catch(error => ({ raw: '', error: (error as Error).message }));
    const job = this.mergeQueue.then(async () => {
      const result = await recognized;
      if (!alive()) return;
      const body = JSON.stringify({ session: this.session, seq, start: chunk.start, end: chunk.end, ...result });
      let value: { append: string } | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        try { value = await this.request('/api/asr/merge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }); break; }
        catch (error) { if (!alive()) return; if (attempt === 1) this.callbacks.onError('第' + (seq + 1) + '段校准失败，保留虚字未提交：' + (error as Error).message); }
      }
      if (!alive()) return;
      if (result.error) this.callbacks.onError('第' + (seq + 1) + '段识别失败：' + result.error + '；后续录音继续处理');
      if (value) {
        this.pending.delete(seq); this.fixed += value.append;
        if (value.append.trim()) this.callbacks.onSentence(this.session + ':' + seq, value.append);
      }
    }).finally(() => { this.jobs.delete(job); if (alive()) this.render(); });
    this.jobs.add(job); this.mergeQueue = job.catch(() => {}); this.render();
  }
  async start() {
    if (this.disposed || this.wanted || this.starting || this.stopping) return;
    this.starting = true;
    const epoch = ++this.epoch;
    let stream: MediaStream | undefined, context: AudioContext | undefined;
    try {
      const status = await fetch('/api/asr/status').then(r => r.json());
      if (!status.ready) throw new Error(status.error || '本机语音服务不可用');
      if (epoch !== this.epoch || this.disposed) return;
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      if (epoch !== this.epoch || this.disposed) { stream.getTracks().forEach(t => t.stop()); return; }
      context = new AudioContext({ sampleRate: 16000 });
      await context.audioWorklet.addModule('/pcm-capture.js'); await context.resume();
      if (epoch !== this.epoch || this.disposed) { stream.getTracks().forEach(t => t.stop()); await context.close(); return; }
      this.audio = new VoiceChunks(); this.fixed = ''; this.pending.clear(); this.session = crypto.randomUUID(); this.sequence = 0; this.mergeQueue = Promise.resolve();
      this.context = context; this.stream = stream;
      this.source = context.createMediaStreamSource(stream);
      this.capture = new AudioWorkletNode(context, 'pcm-capture');
      this.source.connect(this.capture); this.capture.connect(context.destination);
      this.capture.port.onmessage = event => {
        if (event.data?.flushed) { this.flushed?.(); return; }
        if (!this.wanted || epoch !== this.epoch) return;
        const samples = event.data as Float32Array;
        for (const chunk of this.audio.append(samples)) this.enqueue(chunk);
      };
      this.wanted = true; this.callbacks.onListening(true); this.render();

    } catch (error) {
      stream?.getTracks().forEach(t => t.stop()); if (context && context.state !== 'closed') await context.close();
      if (!this.disposed) this.callbacks.onError((error as Error).name === 'NotAllowedError' ? '请允许麦克风权限后重试' : (error as Error).message);
    } finally { this.starting = false; }
  }
  private releaseMicrophone() {
    clearInterval(this.timer); this.capture?.disconnect(); this.source?.disconnect();
    if (this.capture) this.capture.port.onmessage = null;
    this.stream?.getTracks().forEach(t => t.stop());
    if (this.context && this.context.state !== 'closed') void this.context.close();
    this.stream = undefined; this.context = undefined; this.capture = undefined; this.source = undefined;
  }
  async stop() {
    if (this.stopping || this.disposed) return;
    if (this.starting) { this.epoch++; this.callbacks.onListening(false); return; }
    if (!this.wanted) return;
    this.stopping = true; clearInterval(this.timer);
    if (this.capture) await new Promise<void>(resolve => {
      const timer = setTimeout(() => { this.flushed = undefined; resolve(); }, 300);
      this.flushed = () => { clearTimeout(timer); this.flushed = undefined; resolve(); };
      this.capture!.port.postMessage('flush');
    });
    this.wanted = false; this.releaseMicrophone();
    this.callbacks.onListening(false);
    const tail = this.audio.flush(); if (tail) this.enqueue(tail);
    try { await this.mergeQueue; }
    finally { this.stopping = false; if (!this.disposed) this.render(); }
  }

  dispose() { this.disposed = true; this.wanted = false; this.epoch++; for (const controller of this.controllers) controller.abort(); this.releaseMicrophone(); }
}
