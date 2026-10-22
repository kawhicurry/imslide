export type ASRWord = { text: string; start: number; end: number; confidence?: number };
type Token = ASRWord & { key: string };
export type TranscriptView = { fixed: string; pending: string; processing: boolean };

function tokens(words: ASRWord[], offset: number): Token[] {
  const result: Token[] = [];
  let space = '';
  for (const word of words) {
    const chars = Array.from(word.text);
    chars.forEach((char, i) => {
      if (/\s/u.test(char)) { space += char; return; }
      if (/\p{P}/u.test(char) && result.length) { result[result.length - 1].text += char; return; }
      const duration = Math.max(0, word.end - word.start);
      result.push({ key: ({ '零':'0', '〇':'0', '一':'1', '二':'2', '三':'3', '四':'4', '五':'5', '六':'6', '七':'7', '八':'8', '九':'9' } as Record<string, string>)[char] || char.toLowerCase(), text: space + char,
        start: offset + word.start + duration * i / chars.length,
        end: offset + word.start + duration * (i + 1) / chars.length, confidence: word.confidence });
      space = '';
    });
  }
  return result;
}

/** Local agreement: only a common prefix of consecutive, advancing audio windows is fixed.
 * Stability is a conservative heuristic, not a guarantee of ASR correctness. */
export class StableTranscript {
  private previous: Token[] = [];
  private committed: Token[] = [];
  private lastWindowEnd = -1;
  private emptyVotes = 0;
  private fixedText = '';
  private pendingText = '';
  private readyText = '';
  confirmedUntil = 0;
  update(words: ASRWord[], windowStart: number, windowEnd: number) {
    if (windowEnd <= this.lastWindowEnd + 0.05) return ''; // Retries are not independent evidence.
    if (words.some(w => !Number.isFinite(w.start) || !Number.isFinite(w.end) || w.start < 0 || w.end < w.start || w.end > windowEnd - windowStart + 0.2)) throw new Error('语音时间戳无效');
    const decoded = tokens(words, windowStart);
    let overlapEnd = -1, longest = 0;
    // Prefer the matching confirmed suffix over a timestamp cutoff: ASR word times drift.
    for (let end = 0; end < decoded.length; end++) {
      if (Math.abs(decoded[end].end - this.confirmedUntil) > 0.5) continue;
      let length = 0;
      while (end - length >= 0 && this.committed.length - length > 0 &&
        decoded[end - length].key === this.committed[this.committed.length - 1 - length].key) length++;
      if ((length >= 2 || (length === 1 && /[0-9]/.test(decoded[end].key) && Math.abs(decoded[end].end - this.confirmedUntil) < 0.4)) && length > longest) { longest = length; overlapEnd = end; }
    }
    const current = overlapEnd >= 0 ? decoded.slice(overlapEnd + 1) : decoded.filter(t => t.end > this.confirmedUntil + 0.001);
    let count = 0;
    while (count < current.length && count < this.previous.length) {
      const a = current[count], b = this.previous[count];
      if ((a.confidence ?? 1) < 0.25 || (b.confidence ?? 1) < 0.25 || a.key !== b.key || Math.abs(a.start - b.start) > 0.8 || a.end > windowEnd - 0.8) break;
      count++;
    }
    const stable = current.slice(0, count);
    const added = stable.map(t => t.text).join('');
    if (stable.length) {
      this.confirmedUntil = stable.at(-1)!.end;
      this.committed = [...this.committed, ...stable].slice(-40);
      this.fixedText += added; this.readyText += added;
    }
    this.previous = current.slice(count);
    // A silent/empty decode must not erase an unresolved hypothesis.
    if (!current.length && this.pendingText) {
      this.previous = [];
      // A provisional hallucination may be deleted, but only after two windows agree.
      if (++this.emptyVotes >= 2) this.pendingText = '';
    } else { this.emptyVotes = 0; this.pendingText = this.previous.map(t => t.text).join(''); }
    this.lastWindowEnd = windowEnd;
    return added;
  }
  /** Submit stable full sentences; flush a punctuation-free tail only after confirmed silence. */
  takeSentences(flush = false): string[] {
    const sentences: string[] = [];
    const closers: Record<string, string> = { '“': '”', '‘': '’', '「': '」', '（': '）', '(': ')' };
    const stack: string[] = [];
    let start = 0;
    for (let i = 0; i < this.readyText.length; i++) {
      const char = this.readyText[i];
      if (stack.at(-1) === char) stack.pop();
      else if (closers[char]) stack.push(closers[char]);
      else if (char === '"' || char === '`') stack.push(char);
      const end = /[。！？!?]/.test(char) || (/[，,；;]/.test(char) && i - start >= 8) || (char === '.' && /\s/.test(this.readyText[i + 1] || ''));
      if (end && !stack.length) {
        sentences.push(this.readyText.slice(start, i + 1).trim()); start = i + 1;
      }
    }
    this.readyText = this.readyText.slice(start);
    if (flush && !this.pendingText.trim() && this.readyText.trim()) { sentences.push(this.readyText.trim()); this.readyText = ''; }
    return sentences.filter(Boolean);
  }
  view(processing = false): TranscriptView { return { fixed: this.fixedText.slice(-3000), pending: this.pendingText, processing }; }
}

/** PCM ring retaining unresolved audio plus confirmed overlap. */
export class AudioWindows {
  samples = new Float32Array(0);
  start = 0;
  get end() { return this.start + this.samples.length / 16000; }
  append(chunk: Float32Array) {
    if (this.samples.length + chunk.length > 24 * 16000) throw new Error('有超过 24 秒的语音尚未稳定，已暂停录音；虚体文字未提交，请缩短语句后重试');
    const next = new Float32Array(this.samples.length + chunk.length); next.set(this.samples); next.set(chunk, this.samples.length); this.samples = next;
  }
  retainFrom(time: number) {
    const count = Math.min(this.samples.length, Math.max(0, Math.floor((time - this.start) * 16000)));
    this.samples = this.samples.slice(count); this.start += count / 16000;
  }
  snapshot() { return { start: this.start, end: this.end, samples: this.samples.slice() }; }
}
