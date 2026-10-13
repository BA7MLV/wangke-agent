/**
 * 仓库统一的 id 生成（UUID v4）。
 *
 * ## 为什么要收敛到这一个文件
 *
 * 降级实现在本仓库出现过三份（Library.tsx 的 `uuid()`、livelink/outbox.ts 的
 * `newClientOpId()`、以及一段内联的十六进制拼接），三份的算法一模一样。按仓库自己的
 * 规矩「两套并存必然漂移，而漂移的表现是数据静默错乱」：三份里改坏一份，症状不是报错，
 * 而是某处 id 变成空串 / 短一截 / 不再唯一，然后远端库里多出一条不该有的记录，或者 host
 * 的去重表把两条不同的 op 当成同一条。所以只有一份实现，调用方只管调。
 *
 * ## 为什么需要降级（这一段注释别删）
 *
 * `crypto.randomUUID` **只在安全上下文（HTTPS / localhost）可用**。本应用的来宾场景是
 * 「iPad 用局域网 `http://192.168.x.x` 打开主机给的链接」—— 那不是安全上下文，
 * `crypto.randomUUID` 是 `undefined`，直接调用**同步抛异常**（TypeError）。
 * 症状特别难查：没有报错上屏，只是「选完文件毫无反应」「写面 op 一条都发不出去」，
 * 看起来像 UI 卡住或链路坏了。
 * `crypto.getRandomValues` 在所有上下文都可用（它不是 secure-context-only API），
 * 所以降级到它，版本位/variant 位照 RFC 4122 手工打上（不打算互操作，只是别让
 * 任何按 v4 解析的下游挑出毛病）。
 *
 * **不要改成 `if (!crypto.randomUUID) throw`**：那样本地开发（localhost，有它）永远
 * 测不到，只有在别人家里的 iPad 上才炸。
 */

/**
 * 一个 UUID v4 字符串。算法与命名不变，只是换了个住的地方 ——
 * 调用方拿到的形状和以前逐字相同（Library.tsx 的课程/材料 id 就是这么生成的）。
 */
export function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}