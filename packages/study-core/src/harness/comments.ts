/**
 * 评论区（AI 生成的同学讨论）：数据结构 + LLM 输出清洗 + 排序 + 分组。
 *
 * 纯模块无运行时依赖，Node 下可直接单测 —— 与 `ankiCard.ts` / `quiz.ts` 同一条先例。
 * 拆出来的理由：这里的判断全是分支（角色归一、时间戳钳制、条数上限、两层摊平），
 * 留在流水线里就只能靠真调 API 才验得到。
 */
// 注：本文件被 node 测试脚本直接 import（type stripping），相对导入必须带 .ts 扩展名
import { parseTs } from '../utils/linkify.ts';
import { extractJsonArray } from './ankiCard.ts';

/** 发言类型。只做两层（主贴 → 回复），回复的回复摊平在同一层，与 YouTube 一致 */
export type CommentRole = 'ask' | 'answer' | 'note';

/** UI 上的标签文案。集中在这里，避免组件与测试各写一份 */
export const COMMENT_ROLE_LABEL: Record<CommentRole, string> = {
  ask: '提问',
  answer: '回答',
  note: '补充',
};

/**
 * 角色名单。提示词要求模型**从这里原样复制**（同 `routeSkills` 的手法）——
 * 不限定的话每个字幕块都会发明一批新名字，整门课看起来像换了好几班人。
 */
export const COMMENT_AUTHOR_POOL = ['小林', '阿哲', 'Lily', '老王', '助教'] as const;

/** 模型没给名字或给的名字不在名单里时的兜底 */
export const COMMENT_FALLBACK_AUTHOR = '同学';

export const COMMENT_LIMITS = {
  /** 正文最短字数（低于此视为无效发言） */
  textMin: 4,
  /** 主贴正文上限 */
  textMax: 140,
  /** 回复正文上限 */
  replyMax: 120,
  /**
   * 每个字幕块（600s）至多产出几条讨论串。
   *
   * 取 2 是为了对齐「约每 5 分钟 1 条」的密度：一门 2 小时的课约 24 串、50 条左右的发言，
   * 与一个真实视频的评论区量级相当。**这是上限不是指标** —— 提示词同时要求
   * 「没有值得讨论的内容就返回空数组」，防止为凑数产出废话。
   */
  maxThreadsPerChunk: 2,
  /** 一条讨论串至多几条回复 */
  maxReplies: 3,
  /** 跨块去重时取正文前几个字做键 */
  dedupePrefix: 12,
} as const;

/** 时间戳钳制容差（秒）。比弹幕的 30s 宽一倍：讨论会引用同一段里别的时间点 */
const TIME_TOLERANCE = 60;

/** 一条待落库的主贴（落库时补 videoId / createdAt / parentId） */
export interface CommentThreadDraft {
  time: number;
  author: string;
  role: CommentRole;
  text: string;
  replies: CommentReplyDraft[];
}

export interface CommentReplyDraft {
  author: string;
  role: CommentRole;
  text: string;
}

/**
 * `groupThreads` 的输入形状。
 *
 * 刻意不 import `store/db.ts` 的 `CommentRow`：那会把 Dexie 拉进单测进程。
 * 结构化类型下 `CommentRow` 天然满足这个接口，调用点直接传即可。
 */
export interface CommentRowLike {
  id: number;
  time: number;
  author: string;
  role: CommentRole;
  text: string;
  createdAt: number;
  parentId?: number;
}

/** 一条讨论串：主贴 + 它的回复 */
export interface CommentThread extends CommentRowLike {
  replies: CommentRowLike[];
}

/** 排序档位。刻意没有 YouTube 的「最新」—— 内容是 AI 一次性生成的，createdAt 只差几秒 */
export type CommentSort = 'hot' | 'progress';

export const COMMENT_SORT_LABEL: Record<CommentSort, string> = {
  hot: '热门',
  progress: '按进度',
};

/**
 * 清洗正文：去首尾空白、折掉换行、剥掉包裹的引号、`[mm:ss]` 去掉方括号。
 *
 * 去方括号那一步是刻意的：正文**不做 Markdown 渲染也不 linkify**，
 * 留着方括号会让人以为能点（点了没反应）。变成裸时间戳是「不可点」的诚实表达。
 */
export function cleanText(raw: unknown, max: number): string {
  const s = typeof raw === 'string' ? raw : '';
  const flat = s
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[「『“"']+/, '')
    .replace(/[」』”"']+$/, '')
    .replace(/\[(\d{1,3}:\d{2}(?::\d{2})?)\]/g, '$1')
    .trim();
  return flat.slice(0, max);
}

/** 角色归一：接受英文键与中文标签，未知按位置兜底（主贴当提问、回复当回答） */
export function normalizeRole(raw: unknown, isRoot: boolean): CommentRole {
  const r = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (r === 'ask' || r === 'question' || r === '提问' || r === '问') return 'ask';
  if (r === 'answer' || r === '回答' || r === '答') return 'answer';
  if (r === 'note' || r === '补充' || r === '提醒') return 'note';
  return isRoot ? 'ask' : 'answer';
}

/** 作者归一：只认名单里的名字，其余一律兜底（保证 UI 上不会冒出随机人名） */
export function normalizeAuthor(raw: unknown): string {
  const name = String(raw ?? '').trim();
  return (COMMENT_AUTHOR_POOL as readonly string[]).includes(name) ? name : COMMENT_FALLBACK_AUTHOR;
}

/**
 * 解析一个字幕块的 LLM 输出。
 *
 * range 提供时，`time` 必须落在 `[start-60, end+60]` 内 —— 模型很容易编出这段里
 * 根本没有的时间点，点了跳过去是黑屏或结尾（弹幕同款钳制，只是容差更宽）。
 */
export function parseCommentThreads(
  text: string,
  range: { start: number; end: number },
): CommentThreadDraft[] {
  const raw = extractJsonArray(text);
  const out: CommentThreadDraft[] = [];
  for (const item of raw) {
    if (out.length >= COMMENT_LIMITS.maxThreadsPerChunk) break;
    const o = item as Record<string, unknown> | null;

    const time = parseTs(String(o?.time ?? ''));
    if (!Number.isFinite(time) || time < 0) continue;
    if (time < range.start - TIME_TOLERANCE || time > range.end + TIME_TOLERANCE) continue;

    const body = cleanText(o?.text, COMMENT_LIMITS.textMax);
    if (body.length < COMMENT_LIMITS.textMin) continue;

    const replies: CommentReplyDraft[] = [];
    const rawReplies = Array.isArray(o?.replies) ? o.replies : [];
    for (const r of rawReplies) {
      if (replies.length >= COMMENT_LIMITS.maxReplies) break;
      const ro = r as Record<string, unknown> | null;
      const rtext = cleanText(ro?.text, COMMENT_LIMITS.replyMax);
      if (rtext.length < COMMENT_LIMITS.textMin) continue;
      replies.push({
        author: normalizeAuthor(ro?.author),
        role: normalizeRole(ro?.role, false),
        text: rtext,
      });
    }

    out.push({
      time,
      author: normalizeAuthor(o?.author),
      role: normalizeRole(o?.role, true),
      text: body,
      replies,
    });
  }
  return out;
}

/** 规范化正文（去空白/标点/符号、小写），用于判重 */
function normText(s: string): string {
  return s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

/**
 * 按时间排序 + 主贴去重。
 *
 * 与弹幕的「最小时间间隔」判重不同：讨论串在时间上可以紧邻（同一分钟里两个人各问一句
 * 很正常），重复体现在**内容**上 —— 所以按正文前 12 字判键，保留先出现的。
 */
export function dedupeThreads<T extends { time: number; text: string }>(threads: readonly T[]): T[] {
  const sorted = [...threads].sort((a, b) => a.time - b.time);
  const seen = new Set<string>();
  const out: T[] = [];
  for (const t of sorted) {
    const key = normText(t.text).slice(0, COMMENT_LIMITS.dedupePrefix);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/**
 * 排序。
 *
 * 「热门」用**回复数**而不是点赞数：点赞是编出来的数字（本项目单机无社交回路），
 * 回复数则是这套数据里唯一真实的热度信号。
 */
export function orderThreads<T extends { time: number; replies: readonly unknown[] }>(
  threads: readonly T[],
  sort: CommentSort,
): T[] {
  const arr = [...threads];
  if (sort === 'progress') return arr.sort((a, b) => a.time - b.time);
  return arr.sort((a, b) => b.replies.length - a.replies.length || a.time - b.time);
}

/**
 * 把扁平的行还原成「主贴 + 回复」两层结构。
 *
 * 两趟扫描是必要的：回复可能排在同视频里父评论之前（落库顺序不保证），
 * 一趟就地归位会把它当孤儿。孤儿（父评论缺失）**提升为主贴**而不是丢弃 ——
 * 内容本身还是可读的，静默丢内容比结构不纯更糟。
 */
export function groupThreads(rows: readonly CommentRowLike[]): CommentThread[] {
  const roots: CommentThread[] = [];
  const byId = new Map<number, CommentThread>();
  for (const r of rows) {
    if (r.parentId != null) continue;
    const t: CommentThread = { ...r, replies: [] };
    roots.push(t);
    byId.set(r.id, t);
  }
  const orphans: CommentRowLike[] = [];
  for (const r of rows) {
    if (r.parentId == null) continue;
    const parent = byId.get(r.parentId);
    if (parent) parent.replies.push(r);
    else orphans.push(r);
  }
  for (const r of orphans) roots.push({ ...r, parentId: undefined, replies: [] });

  roots.sort((a, b) => a.time - b.time);
  for (const t of roots) t.replies.sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
  return roots;
}

/** 讨论串总数与发言总数（折叠条与工具条上显示，避免各处自己 reduce） */
export function countComments(rows: readonly CommentRowLike[]): { threads: number; posts: number } {
  let threads = 0;
  for (const r of rows) if (r.parentId == null) threads++;
  return { threads, posts: rows.length };
}
