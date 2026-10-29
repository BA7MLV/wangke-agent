/** Independent, explicitly opted-in tools may overlap. Everything else is a barrier. */
export const TOOL_CONCURRENCY = 4;
export const TOOL_BATCH_GUIDANCE = 'Batch independent read/search tool calls in one response when their arguments are already known. The runtime runs safe reads concurrently (up to 4). Wait for results before issuing dependent calls; never guess IDs or values from an unfinished call. Writes, user interactions and unknown tools execute in order.';

export async function executeToolBatch<T>(calls: readonly T[], options: {
  canParallel(call: T): boolean;
  execute(call: T, index: number): Promise<void>;
  shouldStop?(): boolean;
  signal?: AbortSignal;
}): Promise<void> {
  for (let index = 0; index < calls.length;) {
    options.signal?.throwIfAborted();
    if (options.shouldStop?.()) return;
    const start = index++;
    // Re-evaluate at each boundary: earlier writes can change permissions/state.
    if (options.canParallel(calls[start])) {
      while (index < calls.length && index - start < TOOL_CONCURRENCY && options.canParallel(calls[index])) index++;
    }
    const results = await Promise.allSettled(calls.slice(start, index).map(async (call, offset) => {
      options.signal?.throwIfAborted();
      if (!options.shouldStop?.()) await options.execute(call, start + offset);
    }));
    // Drain admitted work before returning/throwing. No orphaned promises or
    // late commits after the caller has finalized a run or saved a checkpoint.
    options.signal?.throwIfAborted();
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
}

/** Save partial results immediately, but keep transcript order independent of timing. */
export function recordToolResult<T extends { role: string; tool_call_id?: string }>(
  messages: T[], start: number, calls: readonly { id: string }[], result: T,
): void {
  const order = calls.findIndex(call => call.id === result.tool_call_id);
  const later = new Set(calls.slice(order + 1).map(call => call.id));
  const next = messages.findIndex((message, index) => index >= start && message.role === 'tool' && later.has(message.tool_call_id ?? ''));
  messages.splice(next < 0 ? messages.length : next, 0, result);
}
