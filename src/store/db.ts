import Dexie, { type Table } from 'dexie';
import type { QuizData } from '../harness/quiz';

export interface VideoRow {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  duration: number; // 秒
  createdAt: number;
  status: 'new' | 'transcribing' | 'transcribed' | 'error';
  /** 上次播放位置（秒），用于断点续播；播完归零。非索引字段 */
  lastPosition?: number;
  /** 视频文件本体已删（释放空间），字幕/讲义/问答等内容保留 */
  fileDeleted?: 1;
  /** 讲义技能手动覆盖：pin=必用，drop=排除（skill id 列表）；不设则由路由器自动选 */
  skillOverride?: { pin: number[]; drop: number[] };
  /** 所属文件夹 id（folders 表）；不设则在「未分类」组。非索引字段 */
  folderId?: number;
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
}

/** 聊天消息附带的截图（仅存缩略图，大图随发随弃） */
export interface ChatImage {
  ts: number;
  thumb: string; // 320px dataURL
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
  }
}

export const db = new WangkeDB();
