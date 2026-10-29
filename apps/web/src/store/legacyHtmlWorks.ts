import { db } from './db';
import { splitAssistantContent } from '../utils/streamingHtml';
import { prepareInteractiveHtml } from '../utils/htmlAnswer';
import { uuid } from '../utils/uuid';
import { versionWidget, validateWidgetPayload } from '../harness/widgetProtocol';
import type { WidgetPayload } from '../harness/widgetRuntime';

function prepare(source: string): WidgetPayload {
  return versionWidget({ html: prepareInteractiveHtml(source), source: 'legacy-html' }, uuid());
}

/** Inert, idempotent compatibility adaptation. No script runs during migration. */
export async function openLegacyHtmlWork(source: string, rowId?: number): Promise<WidgetPayload> {
  if (rowId == null) return prepare(source);
  return db.transaction('rw', db.chats, async () => {
    const row = await db.chats.get(rowId);
    if (!row || row.role !== 'assistant') throw new Error('原回答已删除，请回到当前会话');
    const sources = new Set(splitAssistantContent(row.content)
      .filter(block => block.kind === 'html' && block.htmlContentType === 'interactive' && block.closed).map(block => block.source));
    if (!sources.has(source)) throw new Error('此 HTML 已修改，请重新打开当前版本');
    const previous = row.legacyHtmlWorks?.find(work => work.source === source);
    if (previous) { validateWidgetPayload(previous.payload); return previous.payload; }
    const payload = prepare(source);
    await db.chats.update(rowId, { legacyHtmlWorks: [
      ...(row.legacyHtmlWorks ?? []).filter(work => sources.has(work.source)), { source, payload },
    ] });
    return payload;
  });
}
