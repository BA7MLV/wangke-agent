/**
 * 「下一轮该拉哪些字节段」的纯计算：已缓冲区间 + 在途请求数 + 播放头 → Fetch[]。
 * guest 侧播放管道（Task 6 的 GuestMsePlayer.fill）每轮调用一次。
 *
 * ## 为什么必须有播放头入参（pos）
 *
 * buffered 是「已解码了什么」，不是「正在看什么」。浏览器会淘汰已播放的缓冲，
 * buffered 的起点随播放头前移——只看 buffered 根本分不清「观众走到哪了」和
 * 「数据缓冲到哪了」。窗口要跟的是前者，所以播放头必须作为入参显式给出来
 * （调用方按 currentTime/duration×size 估算，误差由下一轮重算兜底）。
 *
 * ## 窗口从哪里起算：播放头。不是缓冲末端，也不是文件头
 *
 * 三个候选锚点都推演过，只有播放头成立：
 *
 *   - **缓冲末端（contigEnd）**：每轮把窗口推到 末端+win，而末端又被这一轮的
 *     fill 推高——窗口永远追着末端跑，封顶形同虚设，几十个 chunk 之后整部
 *     视频照样全过中继。
 *   - **文件头（字节 0）**：首窗 [0, win) 填满后「连续覆盖末端 ≥ stop」恒成立，
 *     之后每轮都返回空——8MB 窗口约 13 秒，播到 13 秒永久饥饿。淘汰已播放
 *     缓冲也救不了它：锚点写死 0，淘汰让 buffered 起点前移，锚点纹丝不动。
 *   - **播放头（pos）**：stop = min(size, pos + win)。播放推进 → 锚点推进 →
 *     窗口滑动，表现就是「边播边拉」；窗口大小恒为 win，绝不追末端。
 *     seek 到新位置就是 pos 跳变，下一轮自然在新位置开窗——不需要单独的
 *     seek 语义，**seek 目标就是新的播放头**。
 *
 * 播放头之后的旧数据不回头补：那是用户已经跳过/看完的，重新搬过中继纯属
 * 带宽浪费（拖进度条时尤其明显）。所以填充范围是 [pos, stop)，不是 [0, stop)。
 *
 * ## 为什么每轮规划必须写进覆盖表（防重叠）
 *
 * MSE 对同一段字节重复 append 会直接损坏已解码帧——花屏、无声、没有任何报错。
 * 所以「已缓冲」和「本轮已规划」必须放进同一张表，**规划即写入**：后一个请求和
 * 先定的请求天然不重叠。播放头不是免死金牌：落点压在已覆盖区间里（或搭在区间
 * 边缘）时照样要 trim/跳过，只取没拉过的那截。
 */

export interface Range { start: number; end: number } // 字节，end 开区间
export interface Fetch { start: number; len: number }

export interface PlanOpts {
  size: number;        // 文件总字节数
  buffered: Range[];   // 播放器已缓冲的区间（MSE video.buffered）
  chunk: number;       // 单次请求的基准字节数
  windowBytes: number; // 窗口：播放头前方愿意提前缓冲的字节总量（封顶）
  inflight: number;    // 已在途的请求数
  maxInflight: number; // 在途上限
  pos?: number | null; // 播放头所在字节偏移；null/缺失/非有限 → 按播放头在 0 处理
}

export function planFetches(o: PlanOpts): Fetch[] {
  // 脏输入一律「安静地少拉」而不是抛异常：本函数跑在 timeupdate 事件回调里，
  // 抛出去的异常会冒泡到 socket 上，把整条链路打死。size 非正/非有限直接空转——
  // 没有文件大小就无从判断该不该拉，瞎拉只会越界。
  if (!Number.isFinite(o.size) || o.size <= 0) return [];
  if (!Number.isFinite(o.chunk) || o.chunk <= 0) return [];
  if (!Number.isFinite(o.inflight) || !Number.isFinite(o.maxInflight)) return [];

  const size = o.size;
  const chunk = o.chunk;

  // 窗口预算：非有限（NaN / ±Infinity）按 0 处理。NaN 漏进字节算术会算出
  // NaN 长度的请求；Infinity 名义上是「不封顶」，实质就是把整文件搬过中继，
  // 见文件头——这个模块的设计前提就是封顶。
  const win = Number.isFinite(o.windowBytes) ? Math.max(0, o.windowBytes) : 0;

  // 锚点 = 播放头，钳进 [0, size]。越界（pos ≥ size，如播放已结束/调用方算错）
  // 落到文件尾，窗口 [size, …) 与 size 的交集为空 → 一片都不拉，见 8.10 测试；
  // 负数钳到 0，等同首窗口。绝不给脏 pos 兜一个「从头再缓冲」的锚点——
  // 那会让调用方的 bug 变成一次全量重拉。
  const anchor = o.pos != null && Number.isFinite(o.pos) ? Math.max(0, Math.min(size, o.pos)) : 0;
  // 窗口封顶：跟着播放头走的固定预算。
  const stop = Math.min(size, anchor + win);

  // 归一化 buffered：丢掉空区间与 NaN 端点，钳进 [0, size]，按起点排序。
  // 先钳后滤：一个整体越过 size 的区间钳完就空了，留着会污染「下一个未覆盖
  // 区间起点」的判断。
  const cover: Range[] = (Array.isArray(o.buffered) ? o.buffered : [])
    .filter((r): r is Range => !!r && Number.isFinite(r.start) && Number.isFinite(r.end))
    .map((r) => ({ start: Math.max(0, Math.min(size, r.start)), end: Math.max(0, Math.min(size, r.end)) }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);

  const out: Fetch[] = [];

  // 在途配额即背压：占满就不规划新请求。用户此刻就要看，但链路已经满了，
  // 硬塞只会把 socket 缓冲区顶爆，反而谁都到不了。
  // 负数按 0 处理（计错数的 inflight 不该换来一份超发配额），分数向下取整。
  let capacity = Math.max(0, Math.max(0, Math.floor(o.maxInflight)) - Math.max(0, Math.floor(o.inflight)));

  /**
   * 写入一段拉取计划：查配额 → 钳到 [0, size] → 与覆盖表求差（trim 掉已覆盖的
   * 部分）→ 落进 out 与 cover。返回写入的结束偏移，没产出返回 null。
   *
   * 覆盖表有序不变式：每次写入后重排。
   *
   * trim 只保留**未覆盖**的子段：左侧被覆盖就右移起点，否则截到覆盖区起点。
   * 当前唯一调用点（下面的循环）的几何保证了传入区间无覆盖，trim 实际不会
   * 触发；保留它是为了把「不与已覆盖重叠」这条硬约束钉在 add 这一处——
   * 将来任何新调用点（例如逐帧预取）自动继承，而不是靠调用方自觉。
   */
  const add = (start: number, len: number): number | null => {
    if (capacity <= 0) return null;
    if (!(len > 0)) return null; // NaN / 0 / 负长度都走这里
    let s = Math.max(0, Math.min(size, start));
    let e = Math.min(size, s + len);
    if (!(e > s)) return null; // clamp 后为空（如 pos 越界）
    for (;;) {
      const hit = cover.find((r) => r.start < e && s < r.end);
      if (!hit) break;
      if (hit.start <= s) s = hit.end; // 左侧被吃 → 起点右移到覆盖区外
      else e = hit.start; // 否则截到覆盖区前
      if (!(e > s)) return null; // 整段都被覆盖了，不拉
    }
    out.push({ start: s, len: e - s });
    cover.push({ start: s, end: e });
    cover.sort((a, b) => a.start - b.start);
    capacity--;
    return e;
  };

  /**
   * 从锚点（播放头）向前枚举 [anchor, stop) 里的未覆盖段，逐段写入：
   * 播放头落在已覆盖区间内是常态（正在看的那段当然已缓冲），先跳到区间末端；
   * 之后每轮写到「下一个覆盖区起点 / 窗口末端 / 文件尾」的较小者，单片钳到 chunk。
   * 播放头之后的洞一律不管——见文件头「不回头补」。
   */
  let cursor = anchor;
  while (capacity > 0 && cursor < stop) {
    const inside = cover.find((r) => r.start <= cursor && cursor < r.end);
    if (inside) {
      cursor = inside.end; // 跳过已覆盖；重叠区间多跳几次，cursor 严格递增，必然收敛
      continue;
    }
    const next = cover.find((r) => r.start > cursor);
    const limit = next && next.start < stop ? next.start : stop;
    if (!(limit > cursor)) break; // 已被覆盖区顶到窗口末端，无洞可补
    const written = add(cursor, Math.min(chunk, limit - cursor));
    // add 没产出就停：额度见底或几何异常。没有这个保险，任何意料之外的
    // 区间关系都会变成死循环——而它跑在 timeupdate 回调里。
    if (written === null) break;
    cursor = written;
  }

  return out;
}
