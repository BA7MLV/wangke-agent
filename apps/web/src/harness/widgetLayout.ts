import type { WidgetPayload } from './widgetRuntime.ts';
import { artifactFences } from '../utils/artifactEdit.ts';

export interface WidgetCollection {
  /** Legacy single-widget replies remain readable. */
  widget?: WidgetPayload;
  widgets?: WidgetPayload[];
}

export function messageWidgets(message: WidgetCollection): WidgetPayload[] {
  return message.widgets?.length ? message.widgets : message.widget ? [message.widget] : [];
}

export function widgetReference(ref: string): string {
  return `\`\`\`wbw-widget\n${ref}\n\`\`\``;
}

/** Only actual, closed Markdown fences count. Examples inside other fences do not. */
export function layoutWidgets(content: string, widgets: WidgetPayload[]) {
  const byRef = new Map(widgets.filter((widget) => widget.ref).map((widget) => [widget.ref!, widget]));
  const seen = new Set<string>();
  const duplicates: { start: number; end: number }[] = [];
  for (const fence of artifactFences(content)) {
    if (fence.kind !== 'wbw-widget' || !byRef.has(fence.source.trim())) continue;
    const ref = fence.source.trim();
    if (seen.has(ref)) duplicates.push(fence);
    seen.add(ref);
  }
  // Blank duplicates without shifting persisted process/content offsets or later block keys.
  let markdown = content;
  for (const { start, end } of duplicates.reverse()) markdown = markdown.slice(0, start)
    + markdown.slice(start, end).replace(/[^\r\n]/g, ' ') + markdown.slice(end);
  return { markdown, unplaced: widgets.filter((widget) => !widget.ref || !seen.has(widget.ref)) };
}
