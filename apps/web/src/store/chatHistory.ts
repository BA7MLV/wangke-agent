import Dexie from 'dexie';
import { db, type ChatRow } from './db';

export const CHAT_PAGE_SIZE = 40;

/** Indexed cursor: timestamp ties are ordered by the persistent row id. */
export async function readChatPage(sessionId: number, before?: Pick<ChatRow, 'createdAt' | 'id'>) {
  const rows = await db.chats.where('[sessionId+createdAt+id]')
    .between([sessionId, Dexie.minKey, Dexie.minKey],
      [sessionId, before?.createdAt ?? Dexie.maxKey, before?.id ?? Dexie.maxKey], true, !before)
    .reverse().limit(CHAT_PAGE_SIZE + 1).toArray();
  return { hasOlder: rows.length > CHAT_PAGE_SIZE, rows: rows.slice(0, CHAT_PAGE_SIZE).reverse() };
}
