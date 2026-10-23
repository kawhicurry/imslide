/** Align only exact text inside physically overlapping audio windows. Never
 * remove a non-overlapping repetition, or guess away a mismatched prefix. */
export function appendVoiceText(previous: string, next: string, overlap: boolean): { text: string; delta: string; aligned: boolean } {
  if (!previous) return { text: next, delta: next, aligned: true };
  if (!overlap) return { text: previous + '\n' + next, delta: next, aligned: true };
  const normalized = (text: string) => {
    const chars: string[] = [], ends: number[] = []; let offset = 0;
    for (const char of text) {
      offset += char.length;
      if (!/[\p{P}\s]/u.test(char)) { chars.push(char); ends.push(offset); }
    }
    return { chars, ends };
  };
  const left = normalized(previous), right = normalized(next);
  for (let size = Math.min(64, left.chars.length, right.chars.length); size >= 4; size--) {
    if (left.chars.slice(-size).join('') === right.chars.slice(0, size).join('')) {
      const delta = next.slice(right.ends[size - 1]);
      return { text: previous + delta, delta, aligned: true };
    }
  }
  return { text: previous + '\n' + next, delta: next, aligned: false };
}
