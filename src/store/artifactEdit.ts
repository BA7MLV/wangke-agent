import { db, type ChatRow } from './db';
import { htmlPreviewSource } from '../utils/streamingHtml';
import { replaceArtifactFence, type ArtifactKind, type ArtifactLocation } from '../utils/artifactEdit';
import { uuid } from '../utils/uuid';
import { messageWidgets } from '../harness/widgetLayout';

export interface ArtifactTarget {
  rowId: number; kind: ArtifactKind; location: ArtifactLocation; source: string; widgetId?: string;
}

/** Check only this target, so editing a different figure never invalidates a pending draft. */
export function assertArtifactTarget(row: ChatRow | undefined, input: ArtifactTarget): asserts row is ChatRow {
  if (!row || row.role !== 'assistant') throw new Error('原回答已被删除，修改未保存');
  if (row.resume || row.interrupted) throw new Error('请先完成或继续这条回答，再修改内容块');
  if (input.location === 'widget') {
    const matches = messageWidgets(row).filter((widget) => widget.html === input.source
      && (!input.widgetId || widget.id === input.widgetId));
    if (matches.length !== 1) throw new Error('此 HTML 已变化或位置不唯一，请重新打开修改');
  } else if (input.location === 'fence' || /^\s*[`~]{3}/.test(row.content)) {
    replaceArtifactFence(row.content, input.kind, input.source, input.source);
  } else if (htmlPreviewSource(row.content) !== input.source) {
    throw new Error('原 HTML 已变化，请重新打开修改');
  }
}

/** Compare-and-swap inside one IndexedDB transaction; unrelated row metadata is preserved. */
export async function persistArtifactEdit(input: ArtifactTarget & { next: string }): Promise<ChatRow> {
  return db.transaction('rw', db.chats, async () => {
    const row = await db.chats.get(input.rowId);
    assertArtifactTarget(row, input);
    let patch: Partial<ChatRow>;
    if (input.location === 'widget') {
      const matches = messageWidgets(row).filter((widget) => widget.html === input.source
        && (!input.widgetId || widget.id === input.widgetId));
      if (matches.length !== 1) throw new Error('此 HTML 已变化或位置不唯一，请重新打开修改');
      const widget = matches[0];
      // Source changes invalidate old frames and snapshots; do not replay incompatible UI state.
      const next = { ...widget, ...(widget.id ? { id: uuid() } : {}), html: input.next };
      const states = { ...row.widgetStates };
      if (widget.id) delete states[widget.id];
      patch = {
        ...(row.widgets?.length ? { widgets: row.widgets.map((item) => item === widget ? next : item), widgetStates: states } : {}),
        ...(!row.widgets?.length || row.widget?.id === widget.id ? { widget: next } : {}),
        ...(row.widgetState?.widgetId === widget.id ? { widgetState: undefined } : {}),
      };
    } else {
      if (input.location === 'fence') {
        patch = { content: replaceArtifactFence(row.content, input.kind, input.source, input.next) };
      } else {
        if (htmlPreviewSource(row.content) !== input.source) throw new Error('原 HTML 已变化，请重新打开修改');
        const fenced = /^\s*[`~]{3}/.test(row.content);
        if (!fenced && htmlPreviewSource(input.next) !== input.next) throw new Error('修改结果不能保持 HTML 预览，请保留原来的 HTML 根元素');
        patch = { content: fenced
          ? replaceArtifactFence(row.content, 'html', input.source, input.next)
          : input.next };
      }
    }
    await db.chats.update(input.rowId, patch);
    return { ...row, ...patch };
  });
}
