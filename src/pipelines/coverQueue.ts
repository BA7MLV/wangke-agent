import { db } from '../store/db';
import { useCoverStore } from '../store/covers';
import { formatCaughtError } from '../utils/errorText';
import { ensureCover } from './cover';

/**
 * 封面生成队列：全局唯一入口。与转写队列同构，但刻意做得更轻。
 *
 * 1. **串行（并发 1）**：抽帧要 seek + 解码，一次就够吃掉可观的内存带宽，
 *    并行只会和「正在播放的视频」抢解码器 —— 转写队列也是同一个理由。
 * 2. **幂等**：同一份资源重复入队（导入 + 启动回填 + 换封面）不会跑第二遍。
 * 3. **不阻塞、不冒泡**：封面是派生资源，生成失败绝不该影响导入本身
 *    （字幕、讲义、问答照常可用），所以这里把异常吃掉，只留一条控制台日志。
 *
 * 为什么不进 job store（转写/解析那套 phase + 进度条）：单张封面只要几百毫秒到两三秒，
 * 为它加一套进度只会让列表行多出一截会闪的 UI。封面落地时把 `store/covers` 的
 * 刷新令牌 +1，卡片自己把图换上就够了。
 *
 * 生成失败的资源**不写 `coverState`** —— 那正是留给下次启动回填重试的语义；
 * `skipped` 只留给「永远生成不了」（文件已删、Word 材料）这类确定性结论。
 */

/** 等待中的 id（FIFO） */
const queue: string[] = [];
/** 队列里 + 正在跑的 id，用于幂等吸附 */
const known = new Set<string>();
/** 需要强制重做（忽略已有封面）的 id */
const forced = new Set<string>();
let pumping = false;

/** 触发一次封面生成。已在队列/在跑的会被吸附掉，不会重复执行 */
export function enqueueCover(id: string, opts: { force?: boolean } = {}): void {
  if (opts.force) forced.add(id);
  if (known.has(id)) return;
  known.add(id);
  queue.push(id);
  void pump();
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      const id = queue.shift();
      if (id === undefined) break;
      const force = forced.delete(id);
      try {
        if (await ensureCover(id, { force })) useCoverStore.getState().bump();
      } catch (e) {
        console.warn(`[cover] ${id} 封面生成失败：${formatCaughtError(e)}`);
      } finally {
        known.delete(id);
      }
    }
  } finally {
    pumping = false;
  }
}

/**
 * 回填：给「本来就没有封面」的资源补上。
 *
 * 覆盖三类历史数据：这个功能上线之前导入的视频、上次生成失败留下的、
 * 以及被删过文件又重新导入的。走同一条队列，因此不会和正在进行的生成抢解码器。
 *
 * **不处理** `skipped`（文件已删）与 `done`（Word 材料这类没有画面的资源）——
 * 那不是「还没轮到」，是「本来就不会有」。
 *
 * @returns 本次入队的数量（0 表示没有要补的）
 */
export async function backfillCovers(): Promise<number> {
  const rows = await db.videos.toArray();
  if (rows.length === 0) return 0;
  // 只取主键：`primaryKeys()` 不会把封面 blob 读出来，几十上百张也是瞬间的事
  const have = new Set(await db.covers.toCollection().primaryKeys());
  let n = 0;
  for (const row of rows) {
    if (have.has(row.id)) continue;
    if (row.coverState === 'skipped' || row.coverState === 'done') continue;
    enqueueCover(row.id);
    n++;
  }
  return n;
}

/** 队列是否还在跑（探测脚本与测试用；界面不依赖它） */
export function isCoverQueueBusy(): boolean {
  return pumping || queue.length > 0;
}
