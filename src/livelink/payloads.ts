/**
 * host 侧「把 DB 行变成链路载荷」的纯函数集合：索引（index.res）与 meta / content / cover
 * 三个单元（unit.res）。零运行时依赖（只 `import type`），所以 Node 单测能直接跑。
 *
 * ## 单元 id 为什么直接复用 `sync/units.ts` 的 `videoUnit()`
 *
 * 同一门课在云同步与实时链路里必须是**同一个 id**。实时链路不自己拼 `video:<id>:<后缀>`
 * 不是为了少写一行字符串，而是因为两套切法必然漂移：某天一边改了前缀或后缀命名，
 * 两边就会静默地拥有两套 id 空间，表现为「同一条数据在两侧是两个键」——
 * 而这类错乱不报错，只是数据对不上。实时链路只与云同步**共用 id 与分片常量**
 * （PART_BYTES 在 protocol.ts 的 chunkUnit 里用），其余不互相寄生：
 * 中继不碰同步的凭据，同步也不依赖链路在线。
 *
 * ## P1 为什么只发 meta / content / cover，frames 不拉
 *
 * frames（讲义插图）是讲义 IR 的 L2 派生资源，体积占整课的大头。拉它会把「看字幕」
 * 变成「搬整课」——链路带宽是家和云之间那条，人是来看课的不是来等同步的。
 * 讲义 IR 内引用处由 guest 显示占位，真要看原图时再议（P2 或按需单帧）。
 *
 * ## 字段取舍的总原则
 *
 * 发「guest 渲染要用的」，**本机事实不发** —— guest 镜像只进内存，不需要 replicas
 * 意义上的权威性（没有冲突解决、没有墓碑、没有双向合并）。`sync/units.ts` 的
 * VIDEO_LOCAL_FIELDS（fileDeleted / coverState / htmlView）在同步里因「A 删了不等于 B 删了」
 * 被排除，这里同理：把 host 的偏好同步过去只是污染对面。
 *
 * **唯一的例外是 `fileDeleted`**：它决定 openFile 能否播放，是「本机事实」里少见的
 * 必须跨设备的字段。guest 侧没有本地文件（它是纯镜像），所以对面的删除状态无从推断；
 * 索引不带它，用户就只能等播放器报错才知道这门课看不了。
 *
 * `coverState` 连例外都不算，与 sync 侧同哲学：guest 是纯内存镜像、**永不生成封面**，
 * host 端的 `skipped`（典型成因就是「本机文件已删，没法生成」）照抄过来只会在 guest 上
 * 显示成「待生成」且永远等不到——把一台设备的状态 facts 投射成另一台的等待，纯噪音。
 * guest 判断「有没有封面」的唯一依据是 cover 单元拉不拉得到（`video:<id>:cover`
 * 失败 → 无封面占位），不靠任何状态字段。
 *
 * 设计文档：docs/plans/2026-10-09-live-link-design.md
 */

import type { CoverRow, SegmentRow, SubtitleTrackRow, VideoRow } from '../store/db';

/** 索引里的一门课：guest 列表渲染 + 「这门课现在能不能看」要用的全集。 */
export interface IndexEntry {
  id: string;
  name: string;
  /** 'video' | 'material'；老数据没有这个字段，默认 'video' */
  kind: 'video' | 'material';
  /** 秒（材料恒为 0，guest 侧靠它区分进度条与页码） */
  duration: number;
  size: number;
  mimeType: string;
  createdAt: number;
  status: string;
  /** 'pdf' | 'docx' | 'md' | 'html'；视频课没有 */
  materialFormat?: string;
  /**
   * host 本机文件已删 → guest openFile 必失败。索引带上它，guest 能在列表上就说明原因，
   * 而不是等用户点开播放器才看到报错。这是本机事实里唯一进索引的字段，理由见文件头。
   */
  fileDeleted: boolean;
}

/**
 * 课程清单 → 索引条目。
 *
 * 顺序原样保留（调用方 `orderBy('createdAt')` 排好后发）：索引再重排一次会让 guest
 * 列表在重新拉取时整体抖动，而用户正在看它。
 */
export function buildIndex(rows: VideoRow[]): IndexEntry[] {
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind ?? 'video',
    duration: r.duration,
    size: r.size,
    mimeType: r.mimeType,
    createdAt: r.createdAt,
    status: r.status,
    materialFormat: r.materialFormat,
    fileDeleted: r.fileDeleted === 1,
  }));
}

/** meta 单元载荷：guest 打开一门课时渲染列表 / 播放器 / 讲义要用的字段。 */
export function buildMetaUnit(row: VideoRow): string {
  return JSON.stringify({
    id: row.id,
    name: row.name,
    size: row.size,
    mimeType: row.mimeType,
    duration: row.duration,
    createdAt: row.createdAt,
    status: row.status,
    kind: row.kind ?? 'video',
    materialFormat: row.materialFormat,
    unitCount: row.unitCount,
    // 默认 0 而不是 undefined：guest 的进度条直接拿它算比例，
    // undefined 会一路传成 NaN（进度条消失且不报错）
    lastPosition: row.lastPosition ?? 0,
    finished: row.finished ?? 0,
    folderId: row.folderId,
    dominantColor: row.dominantColor,
    // 0|1 → 布尔：host 库里老数据这两个字段都没有，guest 两边判等必须一致
    scanned: row.scanned === 1,
    empty: row.empty === 1,
    // coverState **故意不发**，理由见文件头「字段取舍的总原则」末段。
  });
}

/**
 * content 单元载荷：字幕段 + 对照字幕轨。
 *
 * `status` 0 的未转写段**原样发**：哪句转完了是 guest 显示层的事。host 侧替它过滤，
 * 「正在转写中」的课在 guest 上会看着像空课——而它恰恰是最常被实时打开的场景。
 */
export function buildContentUnit(videoId: string, segments: SegmentRow[], tracks: SubtitleTrackRow[]): string {
  return JSON.stringify({
    videoId,
    segments: segments.map((s) => ({ idx: s.idx, start: s.start, end: s.end, text: s.text, cues: s.cues })),
    tracks: tracks.map((t) => ({ lang: t.lang, lanDoc: t.lanDoc, primary: t.primary === 1, cues: t.cues })),
  });
}

/**
 * cover 单元载荷：封面 blob → base64 的 JSON。
 *
 * **只有 async 版**：base64 必须走 `blob.arrayBuffer()`（浏览器的 Blob 是异步源），
 * 与另外三个同步纯函数签名不一致。同步版要么拿不到真实字节、要么把 await 藏进调用方
 * 看不见的地方，所以这里不给 `buildCoverUnit()`，要封面就 await 这一下。
 */
export async function coverUnitFromBlob(cover: CoverRow): Promise<string> {
  const bytes = new Uint8Array(await cover.blob.arrayBuffer());
  return JSON.stringify({
    videoId: cover.videoId,
    w: cover.w,
    h: cover.h,
    ts: cover.ts,
    blobBase64: bytesToBase64(bytes),
  });
}

/**
 * 字节 → base64，按 0x8000 分片后用 `String.fromCharCode(...sub)` + `btoa`。
 *
 * 为什么必须分片：`String.fromCharCode(...bytes)` 一次 spread 整个数组，参数个数超过
 * 引擎上限就抛 RangeError（「Maximum call stack size exceeded」）。480px 视频封面
 * 通常 <40KB 没事，材料封面（宽幅 PDF 首页）可能宽得多。这条路径跑在 unit.req 的
 * await 链上，抛出来会顺着链路把这一次会话打死。
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
