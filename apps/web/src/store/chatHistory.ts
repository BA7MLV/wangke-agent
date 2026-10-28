import { db, type ChatRow } from './db';
import { compareChatRows } from '@wangke/study-core/chat-order';

export async function readChatHistory(sessionId: number) {
  return (await db.chats.where('sessionId').equals(sessionId).toArray()).sort(compareChatRows);
}

export const CHAT_PAGE_SIZE = 40;

/** Read bounded timestamp ranges, including whole tie buckets before applying the shared order. */
export async function readChatPage(sessionId: number, before?: Pick<ChatRow, 'createdAt' | 'id'>) {
  return db.transaction('r', db.chats, async () => {
    const cursor = before?.id == null ? undefined : await db.chats.get(before.id);
    const bucket = (time: number) => db.chats.where('[sessionId+createdAt+id]')
      .between([sessionId, time, -Infinity], [sessionId, time, Infinity], true, true).toArray();
    const tied = before ? (await bucket(before.createdAt))
      .filter(row => compareChatRows(row, cursor ?? before) < 0) : [];
    const previous = await db.chats.where('[sessionId+createdAt+id]')
      .between([sessionId, -Infinity, -Infinity],
        [sessionId, before?.createdAt ?? Infinity, before ? -Infinity : Infinity], true, false)
      .reverse().limit(CHAT_PAGE_SIZE + 1).toArray();
    const oldest = previous.at(-1)?.createdAt;
    const boundary = oldest == null ? [] : await bucket(oldest);
    const rows = [...tied, ...previous.filter(row => row.createdAt !== oldest), ...boundary].sort(compareChatRows);
    return { hasOlder: rows.length > CHAT_PAGE_SIZE, rows: rows.slice(-CHAT_PAGE_SIZE) };
  });
}
