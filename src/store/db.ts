import Dexie, { type Table } from 'dexie';
import type { QuizData } from '../harness/quiz';

/**
 * 课程资源行。表名仍叫 `videos`（历史原因），但语义已经是「一条课程资源」——
 * `kind` 区分视频与阅读材料（PDF / Word）。改名要动 30+ 个文件，不值当，
 * 因此只在类型名与注释上澄清。
 */
export interface VideoRow {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  duration: number; // 秒（材料恒为 0）
  createdAt: number;
  status: 'new' | 'transcribing' | 'transcribed' | 'error';
  /**
   * 上次播放位置（秒），**永远是真实播放位置**（播完也停在结尾，不归零）。
   *
   * 「播完后再打开要从头开始」这件事不在这里表达，而是由 `finished` 标记 + 播放页的
   * `getTime()` 负责翻译 —— 这样主页的进度条直接 `lastPosition / duration` 就能画出满条，
   * 不需要特判。详见 docs/plans/2026-09-18-home-progress-bar-design.md §3.2。
   * 非索引字段。
   */
  lastPosition?: number;
  /**
   * 本轮已播完（看到结尾）。`1` = 已看完，主页显示满条；不设或 `0` = 未看完。
   *
   * 用 `0 | 1` 而不是「有就 true、清就 delete」：清除要靠 `Table.update()` 写回，
   * 而 `update` 收到 `undefined` 时是删字段还是写 undefined 属于 Dexie 的实现细节，
   * 写成 `0` 语义显式、行为可测。判断一律用 `=== 1`（老数据没有这个字段，
   * `undefined === 1` 为 false，天然算「未看完」）。非索引字段。
   */
  finished?: 0 | 1;
  /** 视频文件本体已删（释放空间），字幕/讲义/问答等内容保留 */
  fileDeleted?: 1;
  /** 讲义技能手动覆盖：pin=必用，drop=排除（skill id 列表）；不设则由路由器自动选 */
  skillOverride?: { pin: number[]; drop: number[] };
  /** 所属文件夹 id（folders 表）；不设则在「未分类」组。非索引字段 */
  folderId?: number;
  // ── 阅读材料（kind === 'material'）专属，全部为非索引字段（老数据零迁移、无需升版本）
  /** 资源类型；不设视为 'video' */
  kind?: 'video' | 'material';
  /** 材料格式，决定用哪个阅读器 */
  materialFormat?: 'pdf' | 'docx';
  /** 材料定位单元总数：PDF=页数，Word=段落数 */
  unitCount?: number;
  /** 上次阅读到的单元（断点续读），与视频的 lastPosition 对称 */
  lastUnit?: number;
  /** 解析判定为扫描件（**仅 PDF**：有页面但没有文本层）：不建检索索引，只能划词/框选提问 */
  scanned?: 1;
  /** 解析后没有任何正文单元（空文档 / 只有图片的 Word）：同样不建索引，但与扫描件是两回事 */
  empty?: 1;
  // ── 封面（派生资源），全部为非索引字段
  /**
   * 封面主色 `#RRGGBB`，由生成封面时顺带提取，用作读取侧的 LQIP 占位底。
   *
   * 生效时机要说清楚：它与封面在**同一个事务**里写入，所以能看到的场景是
   * 「封面读取还没 resolve」或「封面读取失败」——把灰格子换成一块属于这门课的色。
   * 它**不是**「生成中」的进度指示（那要把主色提前落库并让列表重读整行，
   * 代价大于收益）。只存 7 个字符，放主表毫无压力；真正的图在 `covers` 表里。
   */
  dominantColor?: string;
  /**
   * 封面生成状态。`done` = 已有封面，或已判定这份资源不需要封面；
   * `pending` = 已入队/生成中；`skipped` = 文件本体已删等根本没法生成。
   * UI 只认这三个值，不再自己猜「没有封面是不是因为还没轮到」。
   */
  coverState?: 'pending' | 'done' | 'skipped';
}

/** 首页视频分组文件夹（单层） */
export interface FolderRow {
  id?: number;
  name: string;
  createdAt: number;
}

export interface FileRow {
  id: string; // 同 videoId
  blob: Blob;
}

export interface SegmentRow {
  id?: number;
  videoId: string;
  idx: number;
  start: number; // 秒
  end: number;
  text: string;
  status: 0 | 1; // 0=待转写 1=已完成
  /** ASR 返回的句级时间戳（绝对时间，秒；非索引字段，无需升级版本）。无则显示层按字数估算切分 */
  cues?: { start: number; end: number; text: string }[];
}

/**
 * B 站多语言字幕：**只喂显示层**（字幕面板的「对照语言」），不进 AI 流水线。
 * 主语言同时写进 `segments`（讲义/卡片/弹幕/检索都用那份），这里存的是全套已选语言。
 */
export interface SubtitleTrackRow {
  id?: number;
  videoId: string;
  /** B 站语言 key，如 ai-zh / ai-en / zh-Hant */
  lang: string;
  /** 展示名，如「英语（自动翻译）」 */
  lanDoc: string;
  /** 1 = 这一路就是 segments 里的主语言 */
  primary?: 1 | 0;
  /** 原始字幕 cue（未按字数细分；显示层再切） */
  cues: { start: number; end: number; text: string }[];
}

export interface FrameRow {
  id?: number;
  videoId: string;
  ts: number; // 秒
  blob: Blob;
  kind: 'slide' | 'other';
  caption?: string;
}

/**
 * 封面（派生资源）。**三类内容共用一张表**：视频、PDF、Word 的主键都是 `videos.id`，
 * 所以这里直接用 `videoId` 当主键 —— `covers.get(id)` 是 O(1)、只读一条记录。
 *
 * 为什么不把封面 blob 挂在 `VideoRow` 上（这是最容易犯的错）：
 * 资料库列表要 `db.videos.toArray()`，blob 若在行上就会被整表读进内存，
 * 视频一多直接顶不住。这正是 `Library.tsx` 里 `useCover` 那条「不要 toArray」注释
 * 躲了半天的坑 —— 把封面拆成独立表，才是从根上消掉它。
 *
 * 为什么不存原尺寸：1080p 单帧 PNG 有 1~3MB，480px WebP 只要 15~30KB，差两个数量级。
 */
export interface CoverRow {
  /** 主键，同 `videos.id` */
  videoId: string;
  /** 480px 宽（16:9 即 480×270）WebP，编码器不支持时回退 JPEG。只存小图，不存原尺寸 */
  blob: Blob;
  w: number;
  h: number;
  /** 视频：取自第几秒；材料：页码（PDF 恒为 1） */
  ts: number;
  /**
   * 来源。读取端不区分来源（有记录就用），这个字段只用于排查与「用户手选不被覆盖」：
   * `user` 手选 > `slide` 讲义抽帧 > `auto` 自动抽样 > `material-*` 文档类。
   */
  source: 'user' | 'slide' | 'auto' | 'material-page' | 'material-title';
  createdAt: number;
}

export interface HandoutRow {
  id?: number;
  videoId: string;
  createdAt: number;
  title: string;
  blob: Blob; // docx
  outlineJson: string;
  /** 每节 IR（HandoutSection[] 的 JSON）：块级编辑/AI 改写的数据源；旧版生成的行没有此字段（只读）。
   *  非索引字段，无需升级版本（参照 SegmentRow.cues 先例）。 */
  sectionsJson?: string;
  /** 本次生成选用的写作技能名（路由结果 + 手动覆盖） */
  usedSkills?: string[];
}

export interface ChatSessionRow {
  id?: number;
  videoId: string;
  title: string;
  createdAt: number;
  /**
   * 会话级技能白名单（非索引字段，无需升级版本）。
   *
   * ⚠️ **`undefined` 与 `[]` 语义不同，不能合并判断**：
   * - `undefined`（不设）= 不限定，全部启用技能可用 —— 默认值，老会话零迁移；
   * - `[]` = 限定，且一个技能都不给；
   * - `[id, ...]` = 限定为该集合（与技能启用状态取交集后才生效）。
   *
   * 判定统一走 `isSkillLimited()`（skills/store.ts），不要在调用点写 `if (ids?.length)` ——
   * 那会把「用户明确禁用了全部技能」静默退化成「全部可用」。
   */
  skillIds?: number[];
}

/** 聊天消息附带的截图（仅存缩略图，大图随发随弃） */
export interface ChatImage {
  /**
   * 锚点：视频截图是秒；材料选区截图是页码。
   * 语义由 `kind` 决定（沿用同一字段以免迁移）。
   */
  ts: number;
  thumb: string; // 320px dataURL
  /** 非索引字段：材料选区的定位标签，如「第 3 页选区」。不设 = 视频截图 */
  label?: string;
  /** 非索引字段：区分截图来源；不设视为视频截图 */
  kind?: 'video' | 'page-selection';
}

/** 答题卡状态（非索引字段）：题目 JSON + 用户作答 */
export interface QuizState {
  data: QuizData;
  /** 每题已选下标；-1 = 未作答 */
  picks: number[];
}

export interface ChatRow {
  id?: number;
  videoId: string;
  sessionId: number;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  /** 用户消息附带的截图（非索引字段，无需升级版本） */
  images?: ChatImage[];
  /** 思考过程（推理模型，历史回放折叠展示） */
  reasoning?: string;
  /** 答题卡（非索引字段，无需升级版本） */
  quiz?: QuizState;
}

export interface EmbeddingRow {
  id?: number;
  videoId: string;
  segmentId: number;
  vector: ArrayBuffer; // Float32Array
}

/**
 * 阅读材料的可检索文本块。
 *
 * 为什么不复用 `segments`：那边的 `start`/`end` 是**秒**，`get_transcript_range` 按秒检索、
 * 字幕面板按时间轴跳转；把页码塞进秒字段会让两套语义互相污染，之后每个读该表的地方
 * 都要先判断 kind。平行表 + 平行检索函数更安全，也让「视频链路零回归」自动成立。
 */
export interface MaterialBlockRow {
  id?: number;
  /** 即 videos.id（材料与视频共用同一 id 空间） */
  materialId: string;
  /** 文档内线性顺序，0 起（排序用） */
  idx: number;
  /** 定位单元：PDF=页码（1 起），Word=段落序号（1 起） */
  unit: number;
  /** 展示用位置描述：「第 3 页」/「§2.1 第 4 段」 */
  unitLabel: string;
  text: string;
  /** 供检索加权与下游裁剪；PDF 用字号启发式判标题 */
  kind: 'body' | 'title' | 'table' | 'caption';
}

/** 材料文本块的向量（与 EmbeddingRow 对称，只是外键换成 blockId） */
export interface MaterialEmbeddingRow {
  id?: number;
  materialId: string;
  blockId: number;
  vector: ArrayBuffer; // Float32Array
}

/** 思考题弹幕：播放到 time 时在画面顶部弹出（AI 按字幕内容生成） */
export interface DanmakuRow {
  id?: number;
  videoId: string;
  time: number; // 秒
  text: string;
}

/** Anki 问答卡（AI 按字幕生成候选，用户滑动审核：右留左弃） */
export interface CardRow {
  id?: number;
  videoId: string;
  /** 问题（正面） */
  q: string;
  /** 答案（背面） */
  a: string;
  /** 考点对应的字幕时间（秒），用于 App 内跳转与卡片来源标注 */
  time: number;
  /** 审核状态：0=待审 1=保留 2=丢弃（非索引字段，无需升级版本） */
  status: 0 | 1 | 2;
  createdAt: number;
}

/**
 * 每日学习时长（在线时长）。**一天一行，主键就是本地日期** `YYYY-MM-DD`。
 *
 * 为什么主键用日期字符串而不是自增 id：热力图是「按区间取一段」，字符串主键上
 * `between(start, end)` 就是天然有序的范围查询；按 id 就得再建一个索引，白搭。
 * 而且一天一行的语义下，「今天那行」的 upsert 天然幂等，多标签页同时写也只是累加。
 *
 * 为什么不存在 settings 里（localStorage）：一天一行、一年 365 行，随着使用会持续增长，
 * 这是**数据**不是**配置**；localStorage 只有几 MB 且是同步写，放久了会拖慢启动。
 */
export interface StudyDayRow {
  /** 主键：本地日期 `YYYY-MM-DD`（本地时区，跨天按本地零点切，见 utils/studyLog.ts） */
  date: string;
  /** 当日累计秒数（只增不减） */
  seconds: number;
  /** 最后一次累计的时刻，排查用 */
  updatedAt: number;
}

export interface SkillRow {
  id?: number;
  name: string;
  description: string;
  body: string; // markdown 正文（不含 frontmatter）
  enabled: 0 | 1;
  builtin: 0 | 1;
  updatedAt: number;
}

/** Skill 的 Level 3 资源：references/ 下的参考文档（纯文本） */
export interface SkillRefRow {
  id?: number;
  skillId: number;
  path: string; // 相对路径，如 references/terms.md
  body: string;
}

class WangkeDB extends Dexie {
  videos!: Table<VideoRow, string>;
  files!: Table<FileRow, string>;
  segments!: Table<SegmentRow, number>;
  frames!: Table<FrameRow, number>;
  handouts!: Table<HandoutRow, number>;
  chats!: Table<ChatRow, number>;
  chatSessions!: Table<ChatSessionRow, number>;
  embeddings!: Table<EmbeddingRow, number>;
  skills!: Table<SkillRow, number>;
  skillRefs!: Table<SkillRefRow, number>;
  danmakus!: Table<DanmakuRow, number>;
  folders!: Table<FolderRow, number>;
  cards!: Table<CardRow, number>;
  subtitleTracks!: Table<SubtitleTrackRow, number>;
  materialBlocks!: Table<MaterialBlockRow, number>;
  materialEmbeddings!: Table<MaterialEmbeddingRow, number>;
  covers!: Table<CoverRow, string>;
  studyDays!: Table<StudyDayRow, string>;

  constructor() {
    super('wangke');
    this.version(1).stores({
      videos: 'id, createdAt',
      files: 'id',
      segments: '++id, videoId, idx',
      frames: '++id, videoId, ts',
      handouts: '++id, videoId, createdAt',
      chats: '++id, videoId, createdAt',
      embeddings: '++id, videoId, segmentId',
    });
    this.version(2).stores({
      skills: '++id, name, enabled, builtin, updatedAt',
    });
    this.version(3)
      .stores({
        chatSessions: '++id, videoId, createdAt',
        chats: '++id, videoId, sessionId, createdAt',
      })
      .upgrade(async (tx) => {
        // 既有聊天记录归入每个视频下的一个「历史会话」
        const chatTable = tx.table('chats');
        const sessionTable = tx.table('chatSessions');
        const byVideo = new Map<string, number>();
        const all: ChatRow[] = await chatTable.toArray();
        for (const c of all) {
          if (c.sessionId != null) continue;
          let sid = byVideo.get(c.videoId);
          if (sid == null) {
            sid = (await sessionTable.add({
              videoId: c.videoId,
              title: '历史会话',
              createdAt: c.createdAt ?? Date.now(),
            })) as number;
            byVideo.set(c.videoId, sid);
          }
          await chatTable.update(c.id, { sessionId: sid });
        }
      });
    this.version(4).stores({
      skillRefs: '++id, skillId, path',
    });
    this.version(5).stores({
      danmakus: '++id, videoId, time',
    });
    this.version(6).stores({
      folders: '++id, createdAt',
    });
    this.version(7).stores({
      cards: '++id, videoId, createdAt',
    });
    // v8：B 站多语言字幕（对照显示用）
    this.version(8).stores({
      subtitleTracks: '++id, videoId, lang',
    });
    // v9：阅读材料（PDF / Word）的文本块与向量。
    // videos 上的 kind / materialFormat / unitCount / lastUnit / scanned 都是**非索引字段**，
    // 沿用 cues / images / sectionsJson 的先例，不需要升版本。
    this.version(9).stores({
      materialBlocks: '++id, materialId, idx',
      materialEmbeddings: '++id, materialId, blockId',
    });
    // v10：封面。独立成表而不是挂在 videos 行上——列表页会整表读 videos，
    // 封面 blob 一旦在行上就会被一并拉进内存（详见 CoverRow 的注释）。
    // videos 上的 dominantColor / coverState 是非索引字段，同样沿用先例、不需要升版本。
    this.version(10).stores({
      covers: 'videoId',
    });
    // v11：每日学习时长（热力图）。主键即日期，见 StudyDayRow 的注释。
    this.version(11).stores({
      studyDays: 'date',
    });
  }
}

export const db = new WangkeDB();
