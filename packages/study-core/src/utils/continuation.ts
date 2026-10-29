export const CONTINUE_INSTRUCTION =
  '（系统提示：上面那条回答在写到一半时被中断了。请接着它继续写下去：从断点处直接续上，' +
  '不要重复已经写过的内容，也不要重新开头、不要重新总结。如果它其实已经写完了，就只回一句「已写完」。）';

/** Strip only a proven, exact replay at the start of an explicit continuation.
 * Hold ambiguous chunks until they diverge, so an echoed prefix never flashes
 * in the UI. Short coincidences (punctuation, code indentation) are not deduped.
 */
export function createContinuationFilter(prefix: string) {
  const minOverlap = 12;
  const tailStart = Math.max(1, prefix.length - 4096);
  let pending = '';
  let candidates: number[] | undefined;
  let checked = 0;
  let overlap = 0;
  let settled = prefix.length < minOverlap;

  const flush = () => {
    settled = true;
    const text = pending.slice(overlap);
    pending = '';
    return text;
  };

  return {
    push(delta: string): string {
      if (settled) return delta;
      pending += delta;
      if (pending.length < minOverlap) return '';
      if (!candidates) {
        const anchor = pending.slice(0, minOverlap);
        candidates = prefix.startsWith(anchor) ? [0] : [];
        // Match a bounded trailing overlap as well as a full restart. Each
        // candidate is checked incrementally, not rescanned on every token.
        for (let at = prefix.indexOf(anchor, tailStart); at >= 0; at = prefix.indexOf(anchor, at + 1)) candidates.push(at);
        checked = minOverlap;
      }
      candidates = candidates.filter((start) => {
        const length = prefix.length - start;
        const end = Math.min(pending.length, length);
        for (let i = checked; i < end; i++) if (pending[i] !== prefix[start + i]) return false;
        if (pending.length >= length) {
          overlap = Math.max(overlap, length);
          return false;
        }
        return true;
      });
      checked = pending.length;
      return candidates.length ? '' : flush();
    },
    // EOF, failure and user stop must all release unmatched held text verbatim.
    flush,
  };
}
