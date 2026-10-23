/** Endpoint on 400ms silence; four seconds of new audio is only a fallback. */
export class VoiceChunks {
  private samples = new Float32Array(7 * 16000);
  private length = 0;
  private offset = 0;
  private emitted = 0;
  private silence = 0;
  private voiced = 0;
  private speaking = false;
  private previewed = false;
  constructor(private readonly onPreview?: (chunk: VoiceChunk) => void) {}

  append(input: Float32Array): VoiceChunk[] {
    const chunks: VoiceChunk[] = [];
    // Inspect 20ms frames so endpoint timing is independent of worklet batches.
    for (let i = 0; i < input.length; i += 320) {
      const frame = input.subarray(i, i + 320);
      this.samples.set(frame, this.length); this.length += frame.length;
      let energy = 0;
      for (const sample of frame) energy += sample * sample;
      if (Math.sqrt(energy / frame.length) >= (this.speaking ? 0.0006 : 0.001)) {
        this.previewed = false;
        this.voiced += frame.length; this.silence = 0;
        if (this.voiced >= 960) this.speaking = true;
      } else {
        this.silence += frame.length;
        if (!this.speaking) this.voiced = 0;
      }
      const end = this.offset + this.length;
      // Compute speculatively after 160ms, but confirm the sentence only at 400ms.
      // The confirmed chunk contains these exact samples, so its ASR can be reused.
      if (this.speaking && this.silence >= 2560 && !this.previewed) {
        this.previewed = true;
        this.onPreview?.(this.snapshot(end, true));
      }
      if (this.speaking && this.silence >= 6400) {
        chunks.push(this.take(end, true));
      } else if (this.speaking && end - this.emitted >= 64000 && this.silence === 0) {
        chunks.push(this.take(end, false));
      } else if (!this.speaking && this.length > 3200) {
        // Keep 200ms of pre-roll without accumulating idle audio.
        const trim = this.length - 3200;
        this.samples.copyWithin(0, trim, this.length); this.length -= trim; this.offset += trim;
        this.emitted = this.offset;
      }
    }
    return chunks;
  }
  private snapshot(end: number, endpoint: boolean): VoiceChunk {
    // Keep 160ms of trailing silence for consonants, omit the rest from inference.
    const audioEnd = endpoint ? end - Math.max(0, this.silence - 2560) : end;
    return { start: this.offset / 16000, end: audioEnd / 16000, samples: this.samples.slice(0, audioEnd - this.offset), endpoint };
  }
  private take(end: number, endpoint: boolean): VoiceChunk {
    const chunk = this.snapshot(end, endpoint);
    const keep = endpoint ? end : Math.max(this.offset, end - 32000);
    const consumed = keep - this.offset;
    this.samples.copyWithin(0, consumed, this.length); this.length -= consumed;
    this.offset = keep; this.emitted = end;
    this.previewed = false;
    if (endpoint) { this.speaking = false; this.silence = 0; this.voiced = 0; }
    return chunk;
  }
  flush(): VoiceChunk | undefined {
    const end = this.offset + this.length;
    return this.speaking && this.length > 0 ? this.take(end, true) : undefined;
  }
}
export type VoiceChunk = { start: number; end: number; samples: Float32Array; endpoint: boolean };
