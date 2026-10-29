import { liveQuery } from 'dexie';
import { db, type ChatRow } from './db.ts';
import type { WidgetPayload } from '../harness/widgetRuntime.ts';
import { normalizeWidgetState, type WidgetState } from '../harness/widgetState.ts';
import { uuid } from '../utils/uuid.ts';
import { messageWidgets } from '../harness/widgetLayout.ts';
import { versionWidget } from '../harness/widgetProtocol';

export interface WidgetSession {
  rowId: number;
  sessionId: number;
  videoId: string;
  widgetId: string;
  html: string;
  libs: string;
}

function findSource(row: ChatRow | undefined, payload: WidgetPayload): WidgetPayload | undefined {
  if (!row || row.role !== 'assistant') return;
  return messageWidgets(row).find((widget) => widget.html === payload.html
    && JSON.stringify(widget.libs ?? []) === JSON.stringify(payload.libs ?? [])
    && (!payload.id || widget.id === payload.id));
}

function assertSession(row: ChatRow | undefined, session: WidgetSession): asserts row is ChatRow {
  if (!row || row.role !== 'assistant' || row.sessionId !== session.sessionId || row.videoId !== session.videoId
    || !messageWidgets(row).some((widget) => widget.id === session.widgetId && widget.html === session.html
      && JSON.stringify(widget.libs ?? []) === session.libs))
    throw new Error('此交互讲解已修改或删除，请回到当前回答重新打开');
}

/** Legacy widgets receive a host-owned ID on first open; model input cannot pick a row or ID. */
export async function openWidgetSession(rowId: number, payload: WidgetPayload): Promise<WidgetSession> {
  return db.transaction('rw', db.chats, async () => {
    const row = await db.chats.get(rowId);
    const source = findSource(row, payload);
    if (!row || !source) throw new Error('此交互讲解已修改或删除，请重新打开');
    const widgetId = source.id || uuid();
    const updated = versionWidget(source, widgetId);
    if (JSON.stringify(updated) !== JSON.stringify(source)) {
      await db.chats.update(rowId, row.widgets?.length
        ? { widgets: row.widgets.map((widget) => widget === source ? updated : widget),
          ...(row.widgets.at(-1) === source ? { widget: updated } : {}) }
        : { widget: updated });
    }
    return { rowId, sessionId: row.sessionId, videoId: row.videoId, widgetId, html: source.html,
      libs: JSON.stringify(source.libs ?? []) };
  });
}

export async function readWidgetState(session: WidgetSession): Promise<WidgetState | null> {
  const row = await db.chats.get(session.rowId);
  assertSession(row, session);
  const state = row.widgetStates?.[session.widgetId]
    ?? (row.widgetState?.widgetId === session.widgetId ? row.widgetState.value : null);
  return state == null ? null : normalizeWidgetState(state);
}

/** The ACK is sent only after this transaction commits. Stale frames cannot recreate deleted rows. */
export async function saveWidgetState(session: WidgetSession, raw: unknown): Promise<WidgetState> {
  const state = normalizeWidgetState(raw);
  await db.transaction('rw', db.chats, async () => {
    const row = await db.chats.get(session.rowId);
    assertSession(row, session);
    await db.chats.update(session.rowId, row.widgets?.length
      ? { widgetStates: { ...row.widgetStates, [session.widgetId]: state } }
      : { widgetState: { widgetId: session.widgetId, value: state } });
  });
  return state;
}

export function observeWidgetState(session: WidgetSession) {
  return liveQuery(() => readWidgetState(session));
}
