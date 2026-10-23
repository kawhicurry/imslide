import { type ASRWord, type TranscriptView } from './transcript';
import { VoiceChunks, type VoiceChunk } from './voice-chunks';
export type OverlapCallbacks = {
  onTranscript(view: TranscriptView): void;
  onSentence(id: string, text: string, breakBefore?: boolean, receipt?: { runId: string; messageId: string }): void;
  onListening(value: boolean): void;
  onError(message: string): void;
};

type Recognition = { raw: string; error?: string };
/** Persistent capture; bounded, single-flight ASR pipelined with ordered calibration. */
export class OverlapVoiceInput {
  private audio = this.createAudio();
  private recognitionQueue: Promise<unknown> = Promise.resolve();
  private recognizing = 0;
  private preview?: { key: string; result: Promise<Recognition> };
  private fixed = '';
  private tail = '';
  private pending = new Map<number, string>();
  private session = '';
  private sequence = 0;
  private queue: Array<{ seq: number; chunk: VoiceChunk; result?: { raw: string; error?: string }; ready: Promise<void> }> = [];
  private draining = false;
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
  private render() { this.callbacks.onTranscript({ fixed: this.fixed, pending: this.tail + [...this.pending.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => text).join(''), processing: this.draining || this.queue.length > 0 }); }
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
  private key(chunk: VoiceChunk) { return `${chunk.start}:${chunk.end}`; }
  private createAudio() {
    return new VoiceChunks(chunk => {
      // Speculation never queues behind real work or changes the transcript.
      if (this.recognizing || this.queue.length || !this.wanted) return;
      this.preview = { key: this.key(chunk), result: this.recognize(chunk) };
    });
  }
  private recognize(chunk: VoiceChunk): Promise<Recognition> {
    const epoch = this.epoch;
    this.recognizing++;
    const task = this.recognitionQueue.then(async () => {
      if (epoch !== this.epoch || this.disposed) return { raw: '', error: '录音会话已结束' };
      try {
        const value = await this.request('/api/asr', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: chunk.samples.buffer as ArrayBuffer });
        if (typeof value.text !== 'string' && !Array.isArray(value.words)) throw new Error('语音结果无效');
        return { raw: typeof value.text === 'string' ? value.text : (value.words as ASRWord[]).map(word => word.text).join('') };
      } catch (error) { return { raw: '', error: (error as Error).message }; }
    }).finally(() => { this.recognizing--; });
    this.recognitionQueue = task;
    return task;
  }
  private enqueue(chunk: VoiceChunk) {
    if (this.queue.length >= 6) {
      // Do not silently drop audio or let old commands build up minutes of latency.
      this.epoch++; this.wanted = false; this.queue = []; this.preview = undefined;
      for (const controller of this.controllers) controller.abort();
      this.releaseMicrophone(); this.callbacks.onListening(false);
      this.callbacks.onError('语音处理积压过多，已暂停录音；未确认内容不会执行，请等待处理结束后重新开始');
      return;
    }
    const seq = this.sequence++, epoch = this.epoch;
    const item: (typeof this.queue)[number] = { seq, chunk, ready: Promise.resolve() };
    const recognition = this.preview?.key === this.key(chunk) ? this.preview.result : this.recognize(chunk);
    this.preview = undefined;
    item.ready = recognition.then(result => {
      item.result = result;
      if (!this.disposed && epoch === this.epoch) { this.pending.set(seq, result.raw); this.render(); }
    });
    this.queue.push(item);
    if (!this.draining) {
      this.draining = true;
      this.mergeQueue = this.drain(epoch).finally(() => { this.draining = false; if (!this.disposed) this.render(); });
    }
    this.render();
  }
  private async drain(epoch: number) {
    const alive = () => !this.disposed && epoch === this.epoch;
    while (this.queue.length && alive()) {
      await this.queue[0].ready;
      if (!alive()) return;
      const batch = [this.queue.shift()!];
      // Never wait to form a batch. Only fold already-ready, consecutive backlog.
      while (!batch[batch.length - 1].chunk.endpoint && !batch[0].result?.error && batch.length < 4 && this.queue[0]?.result && !this.queue[0].result.error && this.queue[0].chunk.end - batch[0].chunk.start <= 24) batch.push(this.queue.shift()!);
      if (batch.every(item => !item.result!.error && !item.result!.raw.trim())) {
        for (const item of batch) this.pending.delete(item.seq);
        this.render();
        continue;
      }
      const first = batch[0], last = batch[batch.length - 1];
      const segments = batch.map(item => ({ seq: item.seq, start: item.chunk.start, end: item.chunk.end, raw: item.result!.raw, endpoint: item.chunk.endpoint }));
      const body = JSON.stringify({ session: this.session, seq: last.seq, start: first.chunk.start, end: last.chunk.end, endpoint: last.chunk.endpoint,
        raw: segments.map(segment => segment.raw).join('\n'), segments, error: first.result!.error });
      let value: { append: string; pending?: string; breakBefore?: boolean; receipt?: { runId: string; messageId: string } } | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        try { value = await this.request('/api/voice', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }); break; }
        catch (error) { if (!alive()) return; if (attempt === 1) this.callbacks.onError('语音指令接收失败，保留转写：' + (error as Error).message); }
      }
      if (!alive()) return;
      if (first.result!.error) this.callbacks.onError('语音识别失败：' + first.result!.error + '；后续录音继续处理');
      if (value) {
        for (const item of batch) this.pending.delete(item.seq);
        this.tail = value.pending || '';
        this.fixed += (value.breakBefore && this.fixed ? '\n\n' : '') + value.append;
        if (value.append.trim()) this.callbacks.onSentence(this.session + ':' + last.seq, value.append, value.breakBefore, value.receipt);
      }
      this.render();
    }
  }
  async start() {
    if (this.disposed || this.wanted || this.starting || this.stopping || this.draining) return;
    this.starting = true;
    const epoch = ++this.epoch;
    let stream: MediaStream | undefined, context: AudioContext | undefined;
    try {
      const status = await fetch('/api/asr/status').then(r => r.json());
      if (!status.ready) throw new Error(status.error || '语音服务不可用');
      if (epoch !== this.epoch || this.disposed) return;
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      if (epoch !== this.epoch || this.disposed) { stream.getTracks().forEach(t => t.stop()); return; }
      context = new AudioContext({ sampleRate: 16000 });
      await context.audioWorklet.addModule('/pcm-capture.js'); await context.resume();
      if (epoch !== this.epoch || this.disposed) { stream.getTracks().forEach(t => t.stop()); await context.close(); return; }
      this.audio = this.createAudio(); this.preview = undefined; this.fixed = ''; this.tail = ''; this.pending.clear(); this.session = crypto.randomUUID(); this.sequence = 0; this.queue = []; this.mergeQueue = Promise.resolve();
      this.context = context; this.stream = stream;
      this.source = context.createMediaStreamSource(stream);
      this.capture = new AudioWorkletNode(context, 'pcm-capture');
      this.source.connect(this.capture); this.capture.connect(context.destination);
      this.capture.port.onmessage = event => {
        if (event.data?.flushed) { this.flushed?.(); return; }
        if (!this.wanted || epoch !== this.epoch) return;
        const samples = event.data as Float32Array;
        for (const chunk of this.audio.append(samples)) { if (!this.wanted) break; this.enqueue(chunk); }
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
