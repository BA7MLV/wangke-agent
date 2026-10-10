/**
 * 「下一轮该拉哪些字节段」的纯计算：已缓冲区间 + 在途请求数 + seek 目标 → Fetch[]。
 * host / guest 两侧不共用，但语义必须与 Task 6 的调用方（GuestMsePlayer.fill）对齐。
 *
 * 没有播放位置入参是有意的：MediaSource.buffered 与在途数就是「播放器真实状态」的
 * 完整投影，再塞一个估算的播放位置只会和 buffered 打起来（两套真相必然漂移）。
 *
 * ## 为什么窗口封顶，而不是把整文件拉完
 *
 * windowBytes 是「愿意提前缓冲的总量」的封顶：文件头 windowBytes 字节以内边播边拉，
 * 超出就不拉。要是没有这个顶，range 拉流的渐进窗口每轮往前推一点，几十个 chunk 之后
 * 整部视频就全搬过中继了——带宽翻倍，且 seek 之前的时间全浪费在用户还没看的数据上。
 *
 * ## 窗口从哪里起算
 *
 * 从**连续覆盖的起点（字节 0）**起算，而不是「当前连续覆盖末端 + windowBytes」。
 * 后者看着更直觉（播放推进 → 末端推进 → 窗口滑动），但每轮都会把窗口往前推一轮的增量，
 * 封顶形同虚设：第一轮拉 [0, win)，下一轮末端变成 win 又拉 [win, 2win)……窗口永远追着
 * 末端跑，最后一样把整文件拉完。从 0 起算时，窗口是**钉在文件头的一个固定预算**：
 * 播到哪算哪，没播到的部分一个字节都不提前过中继。
 *
 * ## 为什么每轮规划必须写进覆盖表（防重叠）
 *
 * MSE 对同一段字节重复 append 会直接损坏已解码帧——花屏、无声、没有任何报错。
 * 所以「已缓冲」和「本轮已规划」必须放进同一张表，**规划即写入**：后一个请求和
 * 先定的请求天然不重叠。seek 优先也不是免死金牌：落点压在已缓冲区间里（或搭在
 * 区间边缘）时照样要 trim 掉已覆盖的部分，只取没拉过的那截。
 */

export interface Range { start: number; end: number } // 字节，end 开区间
export interface Fetch { start: number; len: number }

export interface PlanOpts {
  size: number;        // 文件总字节数
  buffered: Range[];   // 播放器已缓冲的区间（MSE video.buffered）
  chunk: number;       // 单次请求的基准字节数
  windowBytes: number; // 窗口：自文件头起算、愿意提前缓冲的总量（封顶，见文件头）
  inflight: number;    // 已在途的请求数
  maxInflight: number; // 在途上限
  seek?: number | null;// seek 目标的字节偏移（可选）
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

  // 归一化 buffered：丢掉空区间与 NaN 端点，钳进 [0, size]，按起点排序。
  // 先钳后滤：一个整体越过 size 的区间钳完就空了，留着会污染「下一个未覆盖
  // 区间起点」的判断。
  const cover: Range[] = (Array.isArray(o.buffered) ? o.buffered : [])
    .filter((r): r is Range => !!r && Number.isFinite(r.start) && Number.isFinite(r.end))
    .map((r) => ({ start: Math.max(0, Math.min(size, r.start)), end: Math.max(0, Math.min(size, r.end)) }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);

  const out: Fetch[] = [];

  // 在途配额即背压：占满就不规划新请求——包括 seek。用户此刻就要看，但链路
  // 已经满了，硬塞只会把 socket 缓冲区顶爆，反而谁都到不了。
  // 负数按 0 处理（计错数的 inflight 不该换来一份超发配额），分数向下取整。
  let capacity = Math.max(0, Math.max(0, Math.floor(o.maxInflight)) - Math.max(0, Math.floor(o.inflight)));

  /**
   * 写入一段拉取计划：查配额 → 钳到 [0, size] → 与覆盖表求差（trim 掉已覆盖的
   * 部分）→ 落进 out 与 cover。覆盖表有序不变式：每次写入后重排。
   *
   * trim 只保留**未覆盖**的子段：左侧被覆盖就右移起点，否则截到覆盖区起点。
   * 一个区间骑在两段覆盖中间时只取左半边，右半边留给下一轮（此刻把它拆成两个
   * 请求没有意义——额度只有一份，先到先得）。
   */
  const add = (start: number, len: number): void => {
    if (capacity <= 0) return;
    if (!(len > 0)) return; // NaN / 0 / 负长度都走这里
    let s = Math.max(0, Math.min(size, start));
    let e = Math.min(size, s + len);
    if (!(e > s)) return; // clamp 后为空（如 seek 越界）
    for (;;) {
      const hit = cover.find((r) => r.start < e && s < r.end);
      if (!hit) break;
      if (hit.start <= s) s = hit.end; // 左侧被吃 → 起点右移到覆盖区外
      else e = hit.start; // 否则截到覆盖区前
      if (!(e > s)) return; // 整段都被覆盖了，不拉
    }
    out.push({ start: s, len: e - s });
    cover.push({ start: s, end: e });
    cover.sort((a, b) => a.start - b.start);
    capacity--;
  };

  // seek 优先于一切补洞：用户此刻就要看这个位置。seek 无效（null / 非有限）跳过。
  // 越界由 add 的钳制兜底：钳完为空，一个字节都不多拉。
  if (o.seek != null && Number.isFinite(o.seek)) add(o.seek, chunk);

  /**
   * 连续覆盖末端：从 0 起跳，沿首尾相接的区间一路向右推。
   * cover 有序，所以线性扫一遍即可；start <= cursor 时取 max 是为了兼容
   * 来源里可能重叠的区间（MSE 理论上允许）。
   */
  const contigEnd = (): number => {
    let cursor = 0;
    for (const r of cover) {
      if (r.start <= cursor) cursor = Math.max(cursor, r.end);
      else break;
    }
    return cursor;
  };

  // 窗口封顶：钉在文件头的固定预算，见文件头「窗口从哪里起算」。
  const stop = Math.min(size, win);

  while (capacity > 0) {
    const end = contigEnd();
    if (!(end < stop)) break;
    // 下一段覆盖区的起点就是这段的右界：中间保证没有已覆盖字节，天然防重叠。
    const next = cover.find((r) => r.start >= end);
    const limit = Math.min(stop, next ? next.start : size);
    const before = out.length;
    add(end, Math.min(chunk, limit - end));
    // add 没产出就停：区间被覆盖表吃掉或额度见底。没有这个保险，任何
    // 意料之外的几何关系都会变成死循环——而它跑在 timeupdate 回调里。
    if (out.length === before) break;
  }

  return out;
}
