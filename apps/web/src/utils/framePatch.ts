/** Coalesce token updates; terminal/tool updates synchronously flush pending text. */
export function framePatch<T extends object>(apply: (patch: Partial<T>) => void) {
  let pending: Partial<T> | undefined;
  let frame: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    if (timer !== undefined) clearTimeout(timer);
    frame = undefined;
    timer = undefined;
    if (pending) {
      const value = pending;
      pending = undefined;
      apply(value);
    }
  };
  return {
    flush,
    write(patch: Partial<T>) { flush(); apply(patch); },
    stream(patch: Partial<T>) {
      if (typeof requestAnimationFrame === 'undefined') { apply(patch); return; }
      pending = { ...pending, ...patch };
      if (frame !== undefined) return;
      frame = requestAnimationFrame(flush);
      // Background tabs can suspend animation frames; keep their session state current.
      timer = setTimeout(flush, 100);
    },
  };
}
