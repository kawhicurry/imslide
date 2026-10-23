import type { TranscriptView as View } from './transcript';
export function TranscriptView({ value, listening }: { value: View; listening: boolean }) {
  if (!value.fixed && !value.pending) return null;
  return <section className="voice-transcript" aria-label="实时语音转写" aria-live="polite">
    <div className="voice-transcript-text">
      <span className="transcript-fixed" aria-label="已固定文字">{value.fixed}</span>
      <span className="transcript-pending" aria-label="待确认文字">{value.pending}</span>
    </div>
    {!listening && value.pending && !value.processing && <span className="sr-only">麦克风已关闭，待确认文字尚未执行</span>}
  </section>;
}
