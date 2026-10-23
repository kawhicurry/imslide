/** Ignore display punctuation, but preserve signs, numbers and meaningful words. */
export const voiceTextKey = (text: string) => text.replace(/[，。！？、；：,.!?;:\s]/gu, '');

/** A later stable-prefix message can trail a pause-delivered full hypothesis. */
export function shouldDeliverVoiceSnapshot(previous: string, next: string, confirmed: boolean) {
  const before = voiceTextKey(previous), after = voiceTextKey(next);
  return !!after && before !== after && (confirmed || !before.startsWith(after));
}

/** Stability is a delivery heuristic, not a promise that ASR cannot revise it.
 * Two consecutive hypotheses must agree before an interim prefix is offered to
 * the semantic Agent. The audio stream itself is never cut or restarted.
 */
export class StableVoiceSnapshot {
  private previous = '';
  private emitted = '';
  update(text: string, confirmed: boolean) {
    const repeated = text === this.previous;
    let stable = text;
    if (!confirmed) {
      let end = 0;
      while (end < text.length && end < this.previous.length && text[end] === this.previous[end]) end++;
      // Avoid splitting a surrogate pair at the agreement boundary.
      if (end && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
      stable = text.slice(0, end);
    }
    this.previous = text;
    if (!confirmed) {
      // A stable word can still be only the beginning of a title or amount.
      // Release earlier clauses once ASR punctuation or the following spoken
      // connective establishes a text boundary; never cut the microphone audio.
      let boundary = 0;
      for (const match of stable.matchAll(/[，,。！？!?；;]|然后|接着|随后|另外|最后|第[二三四五六七八九十]行/gu)) {
        boundary = match.index! + match[0].length;
      }
      // An unchanged full hypothesis is also useful to the semantic Agent even
      // before punctuation arrives. This never declares the instruction complete:
      // the Agent must still leave an unfinished title/amount in pending.
      if (!repeated) stable = stable.slice(0, boundary);
    }
    const key = voiceTextKey(stable);
    if (!key || key === this.emitted || (!confirmed && key.length < 6)) return;
    // A punctuation revision can temporarily shorten the common prefix. That
    // isn't a retraction of already delivered speech; wait for the replacement.
    if (!confirmed && this.emitted.startsWith(key)) return;
    this.emitted = key;
    return stable;
  }
}
