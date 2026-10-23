// AudioContext resamples microphone input to 16 kHz. Never stop capture at a window boundary.
class PCMCapture extends AudioWorkletProcessor {
  constructor() {
    super(); this.samples = new Float32Array(640); this.offset = 0;
    this.port.onmessage = event => {
      if (event.data === 'flush') {
        if (this.offset) { const tail = this.samples.slice(0, this.offset); this.port.postMessage(tail, [tail.buffer]); this.offset = 0; }
        this.port.postMessage({ flushed: true });
      }
    };
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) for (const sample of channel) {
      this.samples[this.offset++] = sample;
      if (this.offset === this.samples.length) {
        this.port.postMessage(this.samples, [this.samples.buffer]);
        this.samples = new Float32Array(640); this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PCMCapture);
