import type { MessageDto } from '@wangke/contracts';

/* ─────────────────────────── 消息分组（iMessage 规则） ───────────────────────────
 * 同一发送方、相隔不到 GROUP_GAP_MS 的连续消息算一组：组内间距收紧，只有最后一条带尾巴。
 * 相隔超过 TIME_GAP_MS 时在两条之间插一行居中时间，和 iMessage 一样，不给每条都标时间。
 */
const GROUP_GAP_MS = 2 * 60_000;
const TIME_GAP_MS = 15 * 60_000;

export interface Row {
  key: string;
  message: MessageDto;
  /** 组内第一条 / 最后一条 */
  first: boolean;
  last: boolean;
  /** 在这一条之前显示的时间分隔（没有则为 null） */
  stamp: string | null;
}

export const timeOf = (message: MessageDto) => {
  const value = Date.parse(message.createdAt);
  return Number.isFinite(value) ? value : 0;
};

function formatStamp(time: number): string {
  const date = new Date(time);
  const now = new Date();
  const hm = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === now.toDateString()) return hm;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${hm}`;
  return `${date.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })} ${hm}`;
}

export function groupMessages(messages: MessageDto[]): Row[] {
  return messages.map((message, index) => {
    const previous = messages[index - 1];
    const next = messages[index + 1];
    const time = timeOf(message);
    const stamp = !previous || time - timeOf(previous) > TIME_GAP_MS ? formatStamp(time) : null;
    const sameAsPrevious = Boolean(previous && !stamp && previous.role === message.role && time - timeOf(previous) <= GROUP_GAP_MS);
    const nextStamped = next ? timeOf(next) - time > TIME_GAP_MS : true;
    const sameAsNext = Boolean(next && !nextStamped && next.role === message.role && timeOf(next) - time <= GROUP_GAP_MS);
    return { key: message.id, message, first: !sameAsPrevious, last: !sameAsNext, stamp };
  });
}

