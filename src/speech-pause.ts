/** PCM energy only schedules delivery. Instruction completeness belongs to the LLM. */
export class SpeechPause {
  private samples = 0;
  private voicedEnd = 0;
  add(pcm: Float32Array) {
    const base = this.samples;
    this.samples += pcm.length;
    let voiced = false;
    for (let offset = 0; offset < pcm.length; offset += 160) {
      const end = Math.min(offset + 160, pcm.length);
      let power = 0;
      for (let index = offset; index < end; index++) power += pcm[index] ** 2;
      if (Math.sqrt(power / (end - offset)) > 0.001) {
        this.voicedEnd = base + end;
        voiced = true;
      }
    }
    return voiced;
  }
  ready(consumedSeconds: number, captureEnded = false) {
    // Provider duration advances in transport quanta. Permit at most one 80ms
    // quantum of timestamp lag, never a stale word/phrase several packets behind.
    return this.voicedEnd > 0 && (captureEnded || this.samples - this.voicedEnd >= 1280)
      && consumedSeconds > 0 && consumedSeconds * 16000 + 1280 >= this.voicedEnd;
  }
}
