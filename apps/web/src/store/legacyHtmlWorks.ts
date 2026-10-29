import { db } from './db';
import { splitAssistantContent } from '../utils/streamingHtml';
import { artifactFences } from '../utils/artifactEdit';
import { prepareInteractiveHtml } from '../utils/htmlAnswer';
import { uuid } from '../utils/uuid';
import { versionWidget, validateWidgetPayload } from '../harness/widgetProtocol';
import type { WidgetPayload } from '../harness/widgetRuntime';

function prepare(source: string): WidgetPayload {
  return versionWidget({ html: prepareInteractiveHtml(source), source: 'legacy-html' }, uuid());
}

/** Inert, idempotent compatibility/explicit-example adaptation. No script runs
 * here; ordinary examples call this only after the reader opens preview. */
export async function openLegacyHtmlWork(source: string, rowId?: number): Promise<WidgetPayload> {
  if (rowId == null) return prepare(source);
  return db.transaction('rw', db.chats, async () => {
    const row = await db.chats.get(rowId);
    if (!row || row.role !== 'assistant') throw new Error('原回答已删除，请回到当前会话');
    const sources = new Set(splitAssistantContent(row.content)
      .filter(block => block.kind === 'html' && block.closed).map(block => block.source));
    for (const fence of artifactFences(row.content)) {
      if (/^html?$/i.test(fence.kind)) sources.add(row.content.slice(fence.start, fence.end));
    }
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
