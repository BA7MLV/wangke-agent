import type { ChatToolCall } from '../store/db';

/** A process group starts here, followed by its delivered content. Offsets are UTF-16. */
export interface ResponseSegment {
  contentOffset: number;
  reasoningOffset: number;
  toolOffset: number;
  startedAt?: number;
}

/** Append-only: a new process can never move above content already shown to the user. */
export function beginResponseSegment(segments: ResponseSegment[], content: string, reasoning: string, tools: ChatToolCall[]): ResponseSegment[] {
  const last = segments.at(-1);
  if (last && !content.slice(last.contentOffset).trim()) return segments;
  return [...segments, { contentOffset: content.length, reasoningOffset: reasoning.length, toolOffset: tools.length, startedAt: Date.now() }];
}

/** Keep the exact prefix (including Markdown indentation and stable render offsets). */
export function nextResponseRound(content: string): string {
  if (!content || content.endsWith('\n\n')) return content;
  return content + (content.endsWith('\n') ? '\n' : '\n\n');
}

/** Move later process anchors with a local artifact edit, without changing their identity. */
export function rebaseResponseSegments(segments: ResponseSegment[], before: string, after: string): ResponseSegment[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = before.length, nextEnd = after.length;
  while (end > start && nextEnd > start && before[end - 1] === after[nextEnd - 1]) { end--; nextEnd--; }
  return segments.map((segment) => ({ ...segment, contentOffset: segment.contentOffset <= start ? segment.contentOffset
    : segment.contentOffset >= end ? segment.contentOffset + nextEnd - end : nextEnd }));
}
