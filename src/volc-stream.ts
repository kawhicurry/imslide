import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { gzipSync, gunzipSync } from 'node:zlib';
import { WebSocket, WebSocketServer } from 'ws';
import { StableVoiceSnapshot } from './voice-snapshot.ts';

export const VOLC_RESOURCE = 'volc.seedasr.sauc.duration';
export const VOLC_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_async';
export function volcConfiguration(env = process.env) {
  let key = env.VOLC_ASR_API_KEY?.trim();
  if (!key && env.VOLC_ASR_API_KEY_FILE) {
    try { key = readFileSync(env.VOLC_ASR_API_KEY_FILE, 'utf8').trim(); }
    catch { throw new Error('无法读取 VOLC_ASR_API_KEY_FILE'); }
  }
  if (!key) throw new Error('请配置 VOLC_ASR_API_KEY 或 VOLC_ASR_API_KEY_FILE');
  const endpoint = env.VOLC_ASR_ENDPOINT || VOLC_ENDPOINT;
  if (![VOLC_ENDPOINT, 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async'].includes(endpoint)) throw new Error('火山语音接口地址无效');
  return { key, endpoint };
}

export function volcPacket(payload: Buffer, audio = false, final = false) {
  const body = gzipSync(payload);
  const header = Buffer.from([0x11, (audio ? 0x20 : 0x10) | (final ? 2 : 0), audio ? 0x01 : 0x11, 0, 0, 0, 0, 0]);
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}
export function parseVolcPacket(data: Buffer): { final: boolean; value: any } {
  if (data.length < 8 || data[0] >> 4 !== 1) throw new Error('语音协议包无效');
  let offset = (data[0] & 15) * 4;
  const kind = data[1] >> 4, flags = data[1] & 15, compression = data[2] & 15;
  if (offset < 4 || ![9, 15].includes(kind) || flags > 3 || compression > 1) throw new Error('语音协议不受支持');
  const integer = (signed = false) => {
    if (offset + 4 > data.length) throw new Error('语音协议包不完整');
    const result = signed ? data.readInt32BE(offset) : data.readUInt32BE(offset); offset += 4; return result;
  };
  if (kind === 15) throw new Error(`火山语音服务错误（${integer()}）`);
  const sequence = flags & 1 ? integer(true) : 0;
  const size = integer();
  if (size !== data.length - offset || data[2] >> 4 !== 1) throw new Error('语音协议长度或编码无效');
  const body = compression ? gunzipSync(data.subarray(offset), { maxOutputLength: 1024 * 1024 }) : data.subarray(offset);
  const value = JSON.parse(body.toString());
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![undefined, 0, 1000, 20000000].includes(value.code)) throw new Error('火山语音返回识别失败');
  return { final: !!(flags & 2) || sequence < 0, value };
}

type Utterance = { text: string; start: number; end: number };
/** The provider owns utterance boundaries. Never promote interim text on disconnect. */
export class VolcTranscript {
  private confirmed = new Map<string, Utterance>();
  update(value: any, final: boolean) {
    const result = Array.isArray(value.result) ? value.result[0] : value.result;
    if (!result) return { fixed: this.fixed(), pending: '', utterances: [] as Utterance[] };
    const fresh: Utterance[] = [], pending: string[] = [];
    for (const item of result.utterances || []) {
      // The service omits zero-valued start_time (observed on the first utterance).
      const start = item.start_time ?? 0;
      if (typeof item.text !== 'string' || !Number.isFinite(start) || !Number.isFinite(item.end_time) || start < 0 || item.end_time <= start) throw new Error('火山分句结果格式无效');
      const entry = { text: item.text, start: start / 1000, end: item.end_time / 1000 };
      const key = `${start}:${item.end_time}`;
      if (item.definite || final) {
        const prior = this.confirmed.get(key);
        if (prior && prior.text !== entry.text) throw new Error('火山已确认分句发生变化，请重新录音');
        if (!prior) { this.confirmed.set(key, entry); if (entry.text.trim()) fresh.push(entry); }
      } else pending.push(entry.text);
    }
    // show_utterances is required: un-timestamped text is display-only.
    return { fixed: this.fixed(), pending: pending.join('') || (!result.utterances?.length ? result.text || '' : ''), utterances: fresh };
  }
  private fixed() { return [...this.confirmed.values()].map(item => item.text).join(''); }
}

export function attachVolcStream(server: Server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64000 });
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/api/asr/stream' || process.env.ASR_PROVIDER !== 'volc') { socket.destroy(); return; }
    try {
      const origin = request.headers.origin;
      if (origin && !['127.0.0.1', 'localhost'].includes(new URL(origin).hostname)) throw new Error('Invalid origin');
      if (wss.clients.size >= 2) throw new Error('Too many sessions');
      volcConfiguration();
    } catch { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    wss.handleUpgrade(request, socket, head, client => wss.emit('connection', client));
  });
  wss.on('connection', client => {
    const config = volcConfiguration(), id = randomUUID();
    const upstream = new WebSocket(config.endpoint, { headers: { 'X-Api-Key': config.key, 'X-Api-Resource-Id': VOLC_RESOURCE,
      'X-Api-Request-Id': id, 'X-Api-Connect-Id': id, 'X-Api-Sequence': '-1' }, handshakeTimeout: 8000, maxPayload: 1024 * 1024 });
    const transcript = new VolcTranscript();
    const snapshots = new StableVoiceSnapshot();
    let buffer = Buffer.alloc(0), stopping = false, finished = false, closed = false;
    let finalTimer: ReturnType<typeof setTimeout> | undefined;
    const send = (value: unknown) => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(value)); };
    const cleanup = () => { if (closed) return; closed = true; clearTimeout(lifetime); clearTimeout(finalTimer); upstream.terminate(); };
    const fail = (message: string) => { if (closed) return; send({ type: 'error', message }); cleanup(); client.close(); };
    const lifetime = setTimeout(() => fail('语音会话已达30分钟，请重新开始'), 30 * 60 * 1000);
    upstream.on('open', () => {
      upstream.send(volcPacket(Buffer.from(JSON.stringify({ user: { uid: 'imslide' },
        audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
        request: { model_name: 'bigmodel', enable_itn: true, enable_punc: true, enable_ddc: false,
          enable_nonstream: true, show_utterances: true, result_type: 'full' } }))));
      send({ type: 'ready', session: id, provider: 'volc', resource: VOLC_RESOURCE });
    });
    upstream.on('message', data => {
      try {
        const parsed = parseVolcPacket(Buffer.from(data as Buffer));
        const view = transcript.update(parsed.value, parsed.final);
        const result = Array.isArray(parsed.value.result) ? parsed.value.result[0] : parsed.value.result;
        const confirmed = parsed.final || !!(result?.utterances?.length && result.utterances.every((item: any) => item.definite));
        const text = typeof result?.text === 'string' ? result.text : view.fixed + view.pending;
        const stable = text ? snapshots.update(text, confirmed) : undefined;
        const end = Number(parsed.value.audio_info?.duration) / 1000;
        send({ type: 'result', ...view, final: parsed.final, audioEnd: end,
          snapshot: stable && end > 0 ? { text: stable, start: 0, end, endpoint: confirmed } : undefined });
        if (parsed.final) { finished = true; send({ type: 'done' }); cleanup(); client.close(); }
      } catch (error) { fail(error instanceof Error && /^(火山|语音)/.test(error.message) ? error.message : '火山语音协议解析失败'); }
    });
    upstream.on('unexpected-response', (_req, response) => { response.resume(); fail(`火山语音连接被拒绝（HTTP ${response.statusCode}），请检查 Plan 密钥及权限`); });
    upstream.on('error', () => fail('火山语音连接失败，请检查网络和 Plan 凭据'));
    upstream.on('close', () => { if (!finished && !closed) fail('火山语音连接中断，未确认文字不会执行'); });
    client.on('message', (data, binary) => {
      try {
        if (closed || stopping) return;
        if (upstream.readyState !== WebSocket.OPEN) throw new Error('语音连接尚未就绪');
        if (upstream.bufferedAmount > 256000) throw new Error('语音网络积压，已停止录音');
        if (!binary) {
          if (JSON.parse(data.toString()).type !== 'stop') throw new Error('语音控制消息无效');
          stopping = true; upstream.send(volcPacket(buffer, true, true)); buffer = Buffer.alloc(0);
          finalTimer = setTimeout(() => fail('火山语音结束确认超时，未确认文字不会执行'), 10000);
          return;
        }
        const input = Buffer.from(data as Buffer);
        if (!input.length || input.length % 4) throw new Error('PCM 音频格式无效');
        const pcm = Buffer.alloc(input.length / 2);
        for (let i = 0; i < input.length / 4; i++) {
          const sample = input.readFloatLE(i * 4);
          if (!Number.isFinite(sample)) throw new Error('PCM 音频包含无效值');
          pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 32767), i * 2);
        }
        buffer = Buffer.concat([buffer, pcm]);
        // 80ms transport packets reduce the tail held locally. This never cuts
        // an utterance or restarts the provider's continuous decoding context.
        while (buffer.length >= 2560) { upstream.send(volcPacket(buffer.subarray(0, 2560), true)); buffer = buffer.subarray(2560); }
      } catch (error) { fail(error instanceof Error && /^(语音|PCM)/.test(error.message) ? error.message : '语音输入无效'); }
    });
    client.on('close', cleanup); client.on('error', cleanup);
  });
  server.on('close', () => { for (const client of wss.clients) client.terminate(); wss.close(); });
}
