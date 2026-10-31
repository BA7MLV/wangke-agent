import { MAX_BOT_MESSAGE_ATTACHMENTS } from '@wangke/contracts';
import type { GatewayEnvelope } from './plugin.js';

/**
 * A human-sized pause after the last image. iLink has no album-complete
 * marker, so this is the fallback turn boundary rather than a user setting.
 */
export const PHOTO_QUIET_MS = 10000;
/** Keep a very slow, active upload from being held forever. New messages reset
 * the normal quiet window; this is only an internal safety cap. */
export const PHOTO_MAX_WAIT_MS = 5 * 60 * 1000;
export type PhotoInboxItem = { id: number; received_at: number; message: GatewayEnvelope & { approvalReply?: unknown } };
const control = (m: PhotoInboxItem['message']) => Boolean(m.approvalReply) || /^(?:\/|(?:同意|不同意|批准|允许|不允许|确认|拒绝|approve|reject)(?:\s|[。！!]*$))/i.test(m.text.trim());
const images = (m: GatewayEnvelope) => Boolean(m.attachments?.length) && m.attachments!.every(a => a.mime.startsWith('image/'));
const ordinary = (m: GatewayEnvelope) => !m.attachments?.length || images(m);
// A caption is not necessarily the end of an album: users commonly send a
// caption first and then continue uploading. Only unambiguous instructions
// commit immediately. This keeps the boundary adaptive instead of making the
// two-second quiet period the only way to finish a batch.
const keepsCollecting = (text: string) => /(?:还有|還有|等一下|等一会儿|等一會兒|稍等|再发|再發|继续发|繼續發|还没发完|還沒發完|wait|more\s+(?:images|photos)|one moment)/i.test(text.trim());
const explicitCommit = (text: string) => {
  const value = text.trim();
  if (!value || keepsCollecting(value)) return false;
  // A task instruction such as “请读完再回答” belongs to the current
  // batch, but is not necessarily an album-complete signal. Only explicit
  // finalization language seals the batch immediately; ordinary instructions
  // are collected with the images and committed after the human pause.
  return /^(?:开始(?:吧|处理|回答|分析)?|開始(?:吧|處理|回答|分析)?|就这些|就這些|可以了|可以開始了|处理吧|處理吧|请开始(?:处理)?|請開始(?:處理)?|go\s+ahead|start(?:\s+now)?|do\s+it)$/i.test(value);
};
const sameConversation = (a: GatewayEnvelope, b: GatewayEnvelope) =>
  a.tenant === b.tenant && a.peer === b.peer && a.chat === b.chat && a.topic === b.topic;

/**
 * A bounded heuristic for iLink, which exposes no album ID in our envelope.
 * Inputs are a durable, contiguous inbox prefix, never an in-memory timer.
 * A following text is included only within the photo burst's quiet window. A
 * normal caption stays in the collecting turn; an unambiguous instruction can
 * commit it immediately.
 */
export function photoBatch(items: PhotoInboxItem[], now = Date.now()): { items: PhotoInboxItem[]; ready: boolean } {
  const first = items[0];
  if (!first || !ordinary(first.message) || control(first.message)) return { items: items.slice(0, 1), ready: true };
  const batch = [first];
  let count = first.message.attachments?.length ?? 0, textLength = first.message.text.length, boundary = false;
  for (const item of items.slice(1)) {
    const previous = batch.at(-1)!;
    if (!sameConversation(first.message, item.message) || control(item.message) ||
        item.received_at - previous.received_at >= PHOTO_QUIET_MS || item.received_at - first.received_at >= PHOTO_MAX_WAIT_MS ||
        count + (item.message.attachments?.length ?? 0) > MAX_BOT_MESSAGE_ATTACHMENTS || textLength + item.message.text.length > 80000) { boundary = true; break; }
    if (!ordinary(item.message)) { boundary = true; break; }
    batch.push(item); count += item.message.attachments?.length ?? 0; textLength += item.message.text.length;
  }
  // Preserve the existing low-latency behavior for one standalone text
  // message. Debouncing is needed when a burst is observable (multiple rows or
  // media), but delaying every ordinary question would make IM feel broken.
  const standaloneText = batch.length === 1 && !first.message.attachments?.length;
  const commitRequested = batch.some(item => explicitCommit(item.message.text));
  const ready = standaloneText || commitRequested || boundary || now - batch.at(-1)!.received_at >= PHOTO_QUIET_MS || now - first.received_at >= PHOTO_MAX_WAIT_MS;
  return { items: batch, ready };
}
