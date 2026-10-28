/** Shared by persisted history, model context and cursor pagination. */
export interface OrderedChatRow { id?: number; createdAt?: number; role?: string }

export function compareChatRows(a: OrderedChatRow, b: OrderedChatRow): number {
  // Legacy cloud turns were committed in the same millisecond with random IDs.
  // Resolve that ambiguity by role before using identity as the final tie-breaker.
  const roleOrder = (role?: string) => role === 'user' ? 0 : 1;
  return (a.createdAt ?? 0) - (b.createdAt ?? 0)
    || roleOrder(a.role) - roleOrder(b.role)
    || (a.id ?? 0) - (b.id ?? 0);
}

/** Allocate a strictly ordered pair on the existing persisted timeline, even after clock rollback. */
export function nextChatTurnTimes(history: OrderedChatRow[], startedAt: number, completedAt: number) {
  const last = history.reduce((value, row) => Math.max(value, row.createdAt ?? 0), 0);
  const user = Math.max(startedAt, last + 1);
  return { user, assistant: Math.max(completedAt, user + 1) };
}
