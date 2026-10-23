import { existsSync } from 'node:fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

/** One queued worker: local Whisper or an SSH bridge to the configured MOSS host. */
export class LocalASR {
  readonly provider = process.env.ASR_PROVIDER || 'moss';
  private child?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private active?: { resolve: (value: unknown) => void; reject: (error: Error) => void };
  private sequence = 0;
  private id = 0;
  private closed = false;
  private pending = 0;
  async warmup() {
    if (this.closed) throw new Error('语音服务已关闭');
    if (!['moss', 'whisper'].includes(this.provider)) throw new Error('该语音提供商需要双流连接');
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const bundledPython = fileURLToPath(new URL('../.data/asr-venv/bin/python', import.meta.url));
      const python = process.env.ASR_PYTHON || (existsSync(bundledPython) ? bundledPython : 'python3');
      const script = this.provider === 'moss' ? '../scripts/moss-worker.py' : '../scripts/asr-worker.py';
      const child = spawn(python, [fileURLToPath(new URL(script, import.meta.url))], { stdio: 'pipe' });
      this.child = child;
      const timer = setTimeout(() => { reject(new Error('语音识别服务初始化超时')); child.kill(); }, 30000);
      child.stderr.on('data', () => {}); // Do not expose host paths or transcripts through API errors.
      createInterface({ input: child.stdout }).on('line', line => {
        try {
          const value = JSON.parse(line);
          if (value.ready) { clearTimeout(timer); resolve(); }
          else if (value.error && value.id == null) { clearTimeout(timer); reject(new Error(value.error)); child.kill(); }
          else if (value.id === this.id && this.active) {
            if (value.error) this.active.reject(new Error(value.error));
            else this.active.resolve(value);
          }
        } catch { this.active?.reject(new Error('语音识别结果格式无效')); }
      });
      const failed = () => {
        clearTimeout(timer); this.ready = undefined; this.child = undefined;
        const error = new Error('语音服务不可用，请检查所选ASR服务及连接');
        reject(error); this.active?.reject(error);
      };
      child.once('error', failed); child.once('exit', failed);
    });
    return this.ready;
  }
  private queue: Promise<unknown> = Promise.resolve();
  transcribe(audio: Buffer): Promise<Record<string, unknown> & { timing: { queuedMs: number; processingMs: number; totalMs: number } }> {
    if (this.closed) return Promise.reject(new Error('语音服务已关闭'));
    if (this.pending >= 6) return Promise.reject(new Error('语音识别队列已满，请稍后重试'));
    const accepted = performance.now();
    this.pending++;
    const task = this.queue.then(async () => {
      const started = performance.now();
      const result = await this.recognize(audio);
      const ended = performance.now();
      return { ...result, timing: { queuedMs: Math.round(started - accepted), processingMs: Math.round(ended - started), totalMs: Math.round(ended - accepted) } };
    }).finally(() => { this.pending--; });
    this.queue = task.catch(() => {});
    return task;
  }
  private async recognize(audio: Buffer) {
    await this.warmup();
    if (this.active) throw new Error('语音识别正在处理上一窗口，请稍后重试');
    if (!audio.length || audio.length % 4 || audio.length > 16000 * 24 * 4) throw new Error('音频窗口必须为 24 秒以内的 16kHz Float32 PCM');
    const id = ++this.sequence; this.id = id;
    try {
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => { reject(new Error('语音识别超时，未固定文字不会提交')); this.child?.kill(); }, this.provider === 'moss' ? 70000 : 30000);
        this.active = { resolve: value => { clearTimeout(timer); resolve(value as Record<string, unknown>); }, reject: error => { clearTimeout(timer); reject(error); } };
        this.child!.stdin.write(JSON.stringify({ id, audio: audio.toString('base64') }) + '\n', error => {
          if (error) this.active?.reject(new Error('语音识别进程已断开'));
        });
      });
    } finally { this.active = undefined; }
  }
  close() { this.closed = true; this.active?.reject(new Error('语音服务已关闭')); this.child?.kill(); }
}
