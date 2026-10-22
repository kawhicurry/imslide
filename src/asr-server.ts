import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

/** One bounded local worker; no credentials or audio are sent to an external service. */
export class LocalASR {
  private child?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private active?: { resolve: (value: unknown) => void; reject: (error: Error) => void };
  private sequence = 0;
  private id = 0;
  private closed = false;
  async warmup() {
    if (this.closed) throw new Error('语音服务已关闭');
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const child = spawn(process.env.ASR_PYTHON || 'python3', [fileURLToPath(new URL('../scripts/asr-worker.py', import.meta.url))], { stdio: 'pipe' });
      this.child = child;
      const timer = setTimeout(() => { reject(new Error('本机语音模型加载超时')); child.kill(); }, 30000);
      child.stderr.on('data', () => {}); // Do not expose host paths or transcripts through API errors.
      createInterface({ input: child.stdout }).on('line', line => {
        try {
          const value = JSON.parse(line);
          if (value.ready) { clearTimeout(timer); resolve(); }
          else if (value.id === this.id && this.active) {
            if (value.error) this.active.reject(new Error(value.error));
            else this.active.resolve(value);
          }
        } catch { this.active?.reject(new Error('语音识别结果格式无效')); }
      });
      const failed = () => {
        clearTimeout(timer); this.ready = undefined; this.child = undefined;
        const error = new Error('本机语音服务不可用，请检查 Python、faster-whisper 和本地模型缓存');
        reject(error); this.active?.reject(error);
      };
      child.once('error', failed); child.once('exit', failed);
    });
    return this.ready;
  }
  private queue: Promise<unknown> = Promise.resolve();
  transcribe(audio: Buffer) {
    const task = this.queue.then(() => this.recognize(audio));
    this.queue = task.catch(() => {});
    return task;
  }
  private async recognize(audio: Buffer) {
    await this.warmup();
    if (this.active) throw new Error('语音识别正在处理上一窗口，请稍后重试');
    if (!audio.length || audio.length % 4 || audio.length > 16000 * 24 * 4) throw new Error('音频窗口必须为 24 秒以内的 16kHz Float32 PCM');
    const id = ++this.sequence; this.id = id;
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { reject(new Error('本机语音识别超时，未固定文字不会提交')); this.child?.kill(); }, 30000);
        this.active = { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } };
        this.child!.stdin.write(JSON.stringify({ id, audio: audio.toString('base64') }) + '\n', error => {
          if (error) this.active?.reject(new Error('语音识别进程已断开'));
        });
      });
    } finally { this.active = undefined; }
  }
  close() { this.closed = true; this.active?.reject(new Error('语音服务已关闭')); this.child?.kill(); }
}
