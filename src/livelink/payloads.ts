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
 * ## P2 为什么多了 cards 单元，以及它为什么不进 `sync/units.ts`
 *
 * cards（P2）是**来宾审核制卡候选**的读面：来宾要能滑动审核，候选就得从 host 拿。
 * 单元 id 仍走 `video:<id>:<后缀>`（同一门课在两条链路上是同一个 id 空间，见本文件头），
 * 但后缀表**故意不加进** `sync/units.ts` 的 `VIDEO_UNIT_SUFFIXES`：那张表不是「所有
 * 可能的单元」清单，而是**云同步的契约** —— `videoUnits()` 直接喂 `tombstoneVideos()`
 * （删课时按它写墓碑），`parseUnit()` 在云同步侧据此决定认不认远端来的单元 id。往里加
 * 一个云同步造不出、也用不上的 `cards`，结果是另一台设备收到一份 `video:x:cards` 的墓碑
 * 却找不到对应数据（静默删不掉该删的东西），以及云同步开始认一个它没有提供方的单元。
 * 两套 id 空间里，「同一个字符串含义相同」这条比「只有一套」更要紧。
 *
 * ## 只发「待审」：已判定的卡对来宾是历史，主机已经存着
 *
 * 载荷只含 `status === 0` 的行，字段只有 `{id, q, a, time}`。三个理由：
 * 1. **已判定的卡对来宾没有价值**：保留/丢弃是**用户刚做完的显式动作**，主机库就是权威
 *    记录（来宾是纯内存镜像、不落库）。把判定过的卡也流过去，来宾那份就得跟着主机
 *    的每一次审核不断更新，而它更新不了 —— 它只是个内存数组，来宾一关页面就没了。
 * 2. **全量流过去会让来宾那份反复过期**：主机在另一台设备上审完一张，来宾手里的
 *    镜像并没有跟着变（它不知道）；下次来宾重开面板拉到的是新的全量，于是同一张卡
 *    在来宾这侧"重新变回待审"。用户会看到一张刚在 iPad 上丢掉的卡又出现在手机上，
 *    而界面上没有任何一处解释得了这个矛盾。
 * 3. **带宽**：一门课的卡动辄几十张，全量发是白搬（文件头的总原则：发 guest 渲染要用的）。
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

import type { CardRow, CoverRow, SegmentRow, SubtitleTrackRow, VideoRow } from '../store/db';

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
 *
 * **段的 `cues`（句级时间戳）不发**（终审裁定）：guest 的 `segmentsOf` 只读
 * idx/start/end/text，从不看 cues —— 白搬一份可观的带宽（长课的字幕 cues 比正文
 * 还大），而 payloads.ts 早先的注释还写着「句级跳转的依据」，与事实矛盾。真要做
 * 句级跳转，那也是 guest 渲染层自己按 text 切分（SubtitlePanel 在本机的做法），
 * 不该由 host 决定。**轨的 `cues` 照发**：对照轨整行就是一条 cue，guest 直接渲染，
 * 没有替代来源。
 */
export function buildContentUnit(videoId: string, segments: SegmentRow[], tracks: SubtitleTrackRow[]): string {
  return JSON.stringify({
    videoId,
    segments: segments.map((s) => ({ idx: s.idx, start: s.start, end: s.end, text: s.text })),
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

// ───────────────────────── 制卡候选（P2） ─────────────────────────

/**
 * cards 单元 id：`video:<id>:cards`。
 *
 * 手写字符串而**不**复用 `sync/units.ts` 的 `videoUnit()`，因为那个函数的参数类型是
 * `VideoUnitSuffix`（云同步的五后缀联合类型），要加 `cards` 就得动那份契约 —— 理由与
 * 代价见文件头「P2 为什么多了 cards 单元」。前缀与分隔符刻意与它逐字一致：同一门课在
 * 两条链路上必须是同一个 id 空间，这是本文件头那条取舍在单元 id 上的落点。
 */
export function cardsUnit(id: string): string {
  return `video:${id}:cards`;
}

/** cards 单元里的一张待审卡（**只有渲染与判定要用的字段**）。 */
export interface CardsUnitCard {
  /** 主机库里那张卡的行 id。判定 op 原样带回去（card.decide 的 cardId） */
  id: number;
  q: string;
  a: string;
  /** 考点对应的字幕时间（秒）。视频课用来跳播放头 */
  time: number;
}

/**
 * cards 单元载荷：**只发待审**（`status === 0`）的卡，字段 `{id, q, a, time}`。
 *
 * 不发 `videoId`（调用方按单元 id 已经知道是哪门课，载荷里再带一遍是冗余）、不发
 * `status`（恒为待审 —— 它是这个单元的**不变量**，带上就得让来宾判它，而来宾没有判它的
 * 依据）、不发 `createdAt`（SwipeDeck 不读，来宾也不排序它；主机按 `time` 排序，见
 * host 的 handleUnitReq）。
 *
 * **空数组是正常载荷，不是错误**：一门课可能一张待审卡都没有（还没制卡 / 全审完了），
 * host 照样发单元（`{videoId, cards: []}`），来宾据此显示「没有待审核的卡片」。反过来
 * 发 `unit.err` 会让来宾把它当成故障，一路挂到 30s 超时才报错 —— 「没有卡」是常态，
 * 按错误处理等于凭空造出一个假的故障形态。
 */
export function buildCardsUnit(videoId: string, rows: CardRow[]): string {
  const cards: CardsUnitCard[] = [];
  for (const r of rows) {
    if (r.status !== 0) continue;
    // 没有主键的行不可能被判定（card.decide 带的 cardId 要打中它），悄悄跳过而不是发一个 id:0
    if (r.id == null) continue;
    cards.push({ id: r.id, q: r.q, a: r.a, time: r.time });
  }
  return JSON.stringify({ videoId, cards });
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
