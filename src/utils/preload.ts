/**
 * 空闲时依次预取若干动态 import。
 *
 * 用 requestIdleCallback（Safari 没有，就退回 setTimeout），一次只取一个，
 * 免得和首屏还在进行的请求抢带宽。省流量模式（Save-Data）下不预取。
 * 返回的函数用于在组件卸载时取消尚未开始的预取。
 */
export function preloadOnIdle(loaders: Array<() => Promise<unknown>>): () => void {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  if (connection?.saveData) return () => {};
  let cancelled = false;
  let handle = 0;
  const idle = (fn: () => void) => {
    if (typeof window.requestIdleCallback === 'function') handle = window.requestIdleCallback(fn, { timeout: 4000 });
    else handle = globalThis.setTimeout(fn, 1500) as unknown as number;
  };
  const queue = [...loaders];
  const next = () => {
    if (cancelled) return;
    const load = queue.shift();
    if (!load) return;
    void load().catch(() => {}).finally(() => idle(next));
  };
  idle(next);
  return () => {
    cancelled = true;
    if (typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(handle);
    globalThis.clearTimeout(handle);
  };
}
