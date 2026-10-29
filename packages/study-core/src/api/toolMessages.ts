/** Anthropic expects all parallel tool results in the next single user turn. */
export function groupToolResults<T extends { role: string; content: unknown }>(turns: T[]): T[] {
  const grouped: T[] = [];
  const isResult = (turn: T | undefined) => turn?.role === 'user' && Array.isArray(turn.content) &&
    turn.content.length > 0 && turn.content.every(block => block && typeof block === 'object' && block.type === 'tool_result');
  for (const turn of turns) {
    const previous = grouped.at(-1);
    if (isResult(turn) && isResult(previous)) {
      grouped[grouped.length - 1] = { ...previous!, content: [...previous!.content as unknown[], ...turn.content as unknown[]] };
    } else grouped.push(turn);
  }
  return grouped;
}
