/** Explicit legacy declarations only. New works are structured show_widget payloads. */
export type HtmlContentType = 'example' | 'interactive';
export function htmlFenceContentType(info: string): HtmlContentType {
  return /^\s*html?\s+interactive(?:\s|$)/i.test(info) ? 'interactive' : 'example';
}
