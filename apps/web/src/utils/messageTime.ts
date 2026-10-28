/** 按本地日历区分今天 / 昨天，避免夏令时与跨年造成误判。 */
export function messageTime(timestamp: number, now = new Date()): string {
  const date = new Date(timestamp);
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const day = sameDay(date, now) ? '今天' : sameDay(date, yesterday) ? '昨天'
    : `${date.getFullYear() === now.getFullYear() ? '' : `${date.getFullYear()}年`}${date.getMonth() + 1}月${date.getDate()}日`;
  return `${day} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
