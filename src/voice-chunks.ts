/** Four seconds of new audio per request, preceded by two seconds of context. */
export class VoiceChunks {
  private samples = new Float32Array();
  private offset = 0;
  private next = 4 * 16000;
  private emitted = 0;
  append(input: Float32Array) {
    const joined = new Float32Array(this.samples.length + input.length);
    joined.set(this.samples); joined.set(input, this.samples.length); this.samples = joined;
    const chunks = [];
    while (this.offset + this.samples.length >= this.next) {
      chunks.push(this.take(this.next)); this.next += 4 * 16000;
    }
    return chunks;
  }
  private take(end: number) {
    const chunk = { start: this.offset / 16000, end: end / 16000, samples: this.samples.slice(0, end - this.offset) };
    const keep = Math.max(0, end - 2 * 16000);
    this.samples = this.samples.slice(keep - this.offset); this.offset = keep; this.emitted = end;
    return chunk;
  }
  flush() {
    const end = this.offset + this.samples.length;
    return end > this.emitted ? this.take(end) : undefined;
  }
}
export type VoiceChunk = ReturnType<VoiceChunks['append']>[number];
