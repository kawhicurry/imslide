import type { OverlapCallbacks } from './overlap-voice';
import { shouldDeliverVoiceSnapshot, voiceTextKey } from './voice-snapshot';
import { SpeechPause } from './speech-pause';

type Snapshot = { text: string; start: number; end: number; endpoint: boolean };

/** Continuous microphone -> server proxy -> SeedASR. Cloud owns all boundaries. */
export class StreamingVoiceInput {
  private ws?: WebSocket;
  private context?: AudioContext;
  private stream?: MediaStream;
  private capture?: AudioWorkletNode;
  private source?: MediaStreamAudioSourceNode;
  private disposed = false;
  private starting = false;
  private listening = false;
  private stopping = false;
  private epoch = 0;
  private session = '';
  private seq = 0;
  private fixed = '';
  private pending = '';
  private intake = Promise.resolve();
  private waiting = 0;
  private flushed?: () => void;
  private finish?: () => void;
  private latest?: Snapshot;
  private snapshotTimer?: ReturnType<typeof setTimeout>;
  private lastSubmitted = '';
  private lastSubmitAt = 0;
  private pause = new SpeechPause();
  private resultAudioEnd = 0;
  private quietSubmitted = '';
  constructor(private callbacks: OverlapCallbacks) {}
  private render() { this.callbacks.onTranscript({ fixed: this.fixed, pending: this.pending, processing: this.waiting > 0 || this.stopping }); }
  private release() {
    this.capture?.disconnect(); this.source?.disconnect();
    if (this.capture) this.capture.port.onmessage = null;
    this.stream?.getTracks().forEach(track => track.stop());
    if (this.context && this.context.state !== 'closed') void this.context.close();
    this.capture = undefined; this.source = undefined; this.stream = undefined; this.context = undefined;
    this.listening = false; this.callbacks.onListening(false);
  }
  private fail(message: string) {
    clearTimeout(this.snapshotTimer); this.latest = undefined;
    this.release(); this.ws?.close(); this.finish?.();
    this.callbacks.onError(message); this.render();
  }
  private offerQuietSnapshot(epoch: number) {
    const text = this.fixed + this.pending;
    // This is a delivery hint, not an instruction boundary. The backend Agent
    // still decides completeness. Require the cloud to have consumed the last
    // voiced samples so a lagging partial cannot win the pause race.
    if (!this.pause.ready(this.resultAudioEnd, this.stopping) || !text.trim()
      || voiceTextKey(text) === this.quietSubmitted) return;
    this.quietSubmitted = voiceTextKey(text);
    this.schedule({ text, start: 0, end: this.resultAudioEnd, endpoint: false }, epoch);
  }
  private schedule(snapshot: Snapshot, epoch: number) {
    this.latest = snapshot;
    clearTimeout(this.snapshotTimer);
    // Coalesce changing hypotheses while one intake is in flight. Never build a
    // backlog of superseded snapshots. Corrections must invalidate an old plan
    // immediately; an ordinary growing transcript can coalesce for 600ms.
    const revised = this.lastSubmitted && !voiceTextKey(snapshot.text).startsWith(voiceTextKey(this.lastSubmitted));
    const delay = snapshot.endpoint || revised ? 0 : Math.max(0, 600 - (performance.now() - this.lastSubmitAt));
    this.snapshotTimer = setTimeout(() => this.flushSnapshot(epoch), delay);
  }
  private flushSnapshot(epoch: number) {
    clearTimeout(this.snapshotTimer);
    if (this.disposed || epoch !== this.epoch || !this.latest) return;
    if (this.waiting) { this.snapshotTimer = setTimeout(() => this.flushSnapshot(epoch), 100); return; }
    const value = this.latest; this.latest = undefined;
    if (!shouldDeliverVoiceSnapshot(this.lastSubmitted, value.text, value.endpoint)) return;
    this.lastSubmitAt = performance.now();
    this.submit(value, epoch);
  }
  private submit(utterance: Snapshot, epoch: number) {
    if (this.waiting >= 16) { this.fail('语音指令积压过多，已停止录音；请等待执行完成'); return; }
    const seq = this.seq++, session = this.session;
    const previous = this.lastSubmitted;
    const body = JSON.stringify({ session, seq, ...utterance, raw: utterance.text, source: 'volc-stream', snapshot: true });
    this.lastSubmitted = utterance.text;
    this.waiting++;
    this.intake = this.intake.then(async () => {
      if (this.disposed || epoch !== this.epoch) return;
      let lastError: unknown;
      // Same session + seq makes a lost HTTP acknowledgement safe to retry.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const response = await fetch('/api/voice', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(10000) });
          const value = await response.json();
          if (!response.ok) throw new Error(value.error || '语音指令接收失败');
          const addition = utterance.text.startsWith(previous) ? utterance.text.slice(previous.length) : utterance.text;
          if (!this.disposed && epoch === this.epoch && addition.trim()) this.callbacks.onSentence(`${session}:${seq}`, addition, false, value.receipt);
          return;
        } catch (error) { lastError = error; }
      }
      if (!this.disposed && epoch === this.epoch) this.fail('语音指令未确认接收，已保留转写：' + (lastError as Error).message);
    }).finally(() => { this.waiting--; if (!this.disposed) this.render(); });
  }
  async start() {
    if (this.disposed || this.starting || this.listening || this.stopping || this.waiting) return;
    this.starting = true;
    const epoch = ++this.epoch;
    try {
      this.fixed = ''; this.pending = ''; this.seq = 0; this.intake = Promise.resolve();
      this.latest = undefined; this.lastSubmitted = ''; this.lastSubmitAt = 0; clearTimeout(this.snapshotTimer);
      this.pause = new SpeechPause(); this.resultAudioEnd = 0; this.quietSubmitted = '';
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/asr/stream`);
      this.ws = ws;
      await new Promise<void>((resolve, reject) => {
        let ready = false, done = false;
        const timer = setTimeout(() => { reject(new Error('火山语音连接超时')); ws.close(); }, 12000);
        ws.onmessage = event => {
          if (epoch !== this.epoch || this.disposed) return;
          try {
            const value = JSON.parse(event.data);
            if (value.type === 'ready') { ready = true; this.session = value.session; clearTimeout(timer); resolve(); }
            else if (value.type === 'result') {
              this.fixed = value.fixed; this.pending = value.pending;
              this.resultAudioEnd = Number(value.audioEnd) || 0;
              if (value.snapshot) this.schedule(value.snapshot, epoch);
              this.offerQuietSnapshot(epoch);
              if (value.final) this.flushSnapshot(epoch);
              this.render();
            } else if (value.type === 'done') { done = true; this.flushSnapshot(epoch); this.finish?.(); this.release(); }
            else if (value.type === 'error') {
              clearTimeout(timer); if (!ready) reject(new Error(value.message)); else this.fail(value.message);
            }
          } catch { clearTimeout(timer); if (!ready) reject(new Error('语音结果格式无效')); else this.fail('语音结果格式无效'); }
        };
        ws.onerror = () => { clearTimeout(timer); if (!ready) reject(new Error('语音连接失败')); else this.fail('语音连接失败，未确认文字不会执行'); };
        ws.onclose = () => {
          clearTimeout(timer);
          if (!ready) reject(new Error('语音连接未就绪即关闭'));
          if (epoch === this.epoch && !this.disposed) {
            if (!done) { clearTimeout(this.snapshotTimer); this.latest = undefined; }
            if (!done && this.listening) this.callbacks.onError('语音连接已断开，未确认文字不会执行');
            this.release(); this.finish?.();
          }
        };
      });
      if (epoch !== this.epoch || this.disposed) { ws.close(); return; }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      if (epoch !== this.epoch || this.disposed) { stream.getTracks().forEach(track => track.stop()); ws.close(); return; }
      this.stream = stream;
      const context = new AudioContext({ sampleRate: 16000 }); this.context = context;
      await context.audioWorklet.addModule('/pcm-capture.js'); await context.resume();
      if (epoch !== this.epoch || this.disposed || ws.readyState !== WebSocket.OPEN) { this.release(); ws.close(); return; }
      this.source = context.createMediaStreamSource(stream);
      this.capture = new AudioWorkletNode(context, 'pcm-capture');
      this.capture.port.onmessage = event => {
        if (event.data?.flushed) { this.flushed?.(); return; }
        if (epoch !== this.epoch || !this.listening) return;
        if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 256000) { this.fail('语音网络积压或断开，已停止录音'); return; }
        const samples = event.data as Float32Array;
        if (this.pause.add(samples)) this.quietSubmitted = '';
        ws.send(samples.buffer);
        this.offerQuietSnapshot(epoch);
      };
      this.source.connect(this.capture); this.capture.connect(context.destination);
      this.listening = true; this.callbacks.onListening(true); this.render();
    } catch (error) {
      this.release(); this.ws?.close();
      if (!this.disposed && epoch === this.epoch) this.callbacks.onError((error as Error).name === 'NotAllowedError' ? '请允许麦克风权限后重试' : (error as Error).message);
    } finally { this.starting = false; }
  }
  async stop() {
    if (this.disposed || this.stopping) return;
    if (this.starting) { this.epoch++; this.ws?.close(); this.release(); return; }
    if (!this.listening) return;
    this.stopping = true;
    if (this.capture) await new Promise<void>(resolve => {
      const timer = setTimeout(() => { this.flushed = undefined; resolve(); }, 300);
      this.flushed = () => { clearTimeout(timer); this.flushed = undefined; resolve(); };
      this.capture!.port.postMessage('flush');
    });
    this.release(); this.render();
    try {
      if (this.ws?.readyState === WebSocket.OPEN) await new Promise<void>(resolve => {
        const timer = setTimeout(() => { this.fail('语音结束确认超时，未确认文字不会执行'); resolve(); }, 12000);
        this.finish = () => { clearTimeout(timer); this.finish = undefined; resolve(); };
        this.ws!.send(JSON.stringify({ type: 'stop' }));
      });
      await this.intake;
      this.flushSnapshot(this.epoch);
      await this.intake;
    } finally { this.stopping = false; this.ws?.close(); if (!this.disposed) this.render(); }
  }
  dispose() { this.disposed = true; this.epoch++; clearTimeout(this.snapshotTimer); this.latest = undefined; this.ws?.close(); this.finish?.(); this.release(); }
}
