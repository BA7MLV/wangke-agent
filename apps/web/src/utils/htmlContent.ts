/** Fence metadata is saved verbatim with the answer. Raw answer works use interactive semantics. */
export type HtmlContentType = 'example' | 'interactive';
export function htmlFenceContentType(info: string): HtmlContentType {
  return /^\s*html?\s+interactive(?:\s|$)/i.test(info) ? 'interactive' : 'example';
}
