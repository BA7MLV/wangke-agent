/** A deadline reports unfinished work; it never pretends that work has stopped. */
export async function settleWithin(tasks: Iterable<Promise<unknown>>, milliseconds: number): Promise<boolean> {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new Error('invalid_drain_deadline');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.allSettled([...tasks]).then(() => true),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), milliseconds); }),
    ]);
  } finally { clearTimeout(timer); }
}
