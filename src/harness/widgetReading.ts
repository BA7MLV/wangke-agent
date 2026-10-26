/** Session-only bounded layout memory. Never stores answers or widget snapshots. */
const heights = new Map<string, number>();
export function readWidgetHeight(key: string): number { return heights.get(key) ?? 80; }
export function rememberWidgetHeight(key: string, value: number): number {
  const height = Math.min(2000, Math.max(80, Math.ceil(value)));
  if (!Number.isFinite(height)) return readWidgetHeight(key);
  heights.delete(key); heights.set(key, height);
  if (heights.size > 200) heights.delete(heights.keys().next().value!);
  return height;
}

/** Human-readable source revision in quote context, not an authorization token. */
export function widgetRevision(source: string): string {
  let hash = 2166136261;
  for (let i = 0; i < source.length; i++) hash = Math.imul(hash ^ source.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16);
}

export const WIDGET_SCROLL_INTENT = 'wbw:reading-intent';
