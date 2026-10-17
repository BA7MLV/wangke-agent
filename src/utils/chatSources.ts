/**
 * 从助手回答里解析「这条回答引用了哪些课程、引到了哪一处」。
 *
 * 为什么是解析而不是新字段：系统提示词第 6 条已经要求模型**原样保留**课程 Markdown
 * 链接、并写出工具给出的时间戳/页码（见 harness/libraryAssistant.ts 的 `courseLink()`），
 * 所以来源本来就躺在回答正文里。落库一份结构化的来源列表，等于把同一份事实存两遍，
 * 还得处理「模型没照着格式写」时两边对不上的情况。
 *
 * **归属规则（保守优先）**：以段落为单位扫描，段内的课程链接与时间标记互相归属；
 * 段里只有时间标记、没有课程链接时**不归属任何来源**。宁可少列一条，也不要把
 * A 课的时间戳挂到 B 课名下 —— 来源列表一旦错账，用户会照着它去核对然后对不上，
 * 那比没有来源更糟。
 *
 * 纯函数，不碰 DOM / IndexedDB，可被 node 直接 import 测试（见 scripts/test-chat-sources.mjs）。
 */

/** 一条来源：一门被引用的课程，以及这条回答里引到它的位置 */
export interface ChatSource {
  courseId: string;
  courseName: string;
  /**
   * 该课程在这条回答里被引到的位置（`12:34` / `1:02:03` / `第 3 页`），去重保序。
   * 上限 {@link MAX_SOURCE_REFS} 条 —— 再多就不是「核对入口」而是把回答又抄了一遍。
   */
  refs: string[];
}

/** 每条来源最多展示几个位置 */
export const MAX_SOURCE_REFS = 6;

/**
 * 课程链接。链接文本形如 `《高等数学（上）》`（`courseLink()` 会给它套书名号并转义
 * 方括号），href 是 `#/player/<encodeURIComponent(courseId)>`。
 *
 * 刻意写得宽容：模型偶尔会把书名号漏掉、或把 `#` 写没，只要能认出「指向播放页的
 * 链接」就算数 —— 但**必须**是链接，正文里裸写一个课程名不算引用。
 */
const COURSE_LINK = /\[((?:\\.|[^\]\\])*)\]\(\s*#?\/player\/([^)\s?#]+)(?:\?[^)\s]*)?\s*\)/g;

/** `12:34` / `1:02:03`。前后不能再接数字或冒号，避免从 `1:02:03` 里切出 `02:03`。 */
const TIME_REF = /(?<![\d:])(?:\d{1,2}:)?\d{1,2}:\d{2}(?![\d:])/g;

/** `第 3 页` / `第12页` —— 阅读材料的定位方式 */
const PAGE_REF = /第\s*\d+\s*页/g;

/** 把链接文本还原成课程名：去掉书名号、还原被转义的方括号 */
function cleanName(label: string): string {
  return label
    .replace(/\\([\\[\]])/g, '$1')
    .replace(/^《\s*/, '')
    .replace(/\s*》$/, '')
    .trim();
}

/** courseId 是 encodeURIComponent 过的；模型手抄时可能没编码，两种都要能还原 */
function decodeId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    // 手抄出非法 % 序列（如 `100%`）时 decodeURIComponent 会抛，退回原样
    return raw;
  }
}

/**
 * 解析一条回答的来源列表。
 *
 * 返回顺序 = 课程在回答里**首次出现**的顺序（用户读到的顺序），不是字母序 ——
 * 列表要能跟正文对着看。
 */
export function extractChatSources(markdown: string): ChatSource[] {
  if (!markdown) return [];

  const order: string[] = [];
  const byId = new Map<string, ChatSource>();

  // 以空行为界切段。段内才有「谁引了哪一处」这个上下文，跨段归属就是猜。
  for (const paragraph of markdown.split(/\n\s*\n/)) {
    const links = [...paragraph.matchAll(COURSE_LINK)];
    if (links.length === 0) continue;

    // 段内的位置标记：时间点 + 页码，按出现顺序
    const refs = [...paragraph.matchAll(TIME_REF)].map((m) => m[0]);
    for (const page of paragraph.matchAll(PAGE_REF)) refs.push(page[0].replace(/\s+/g, ' '));

    for (const link of links) {
      const courseId = decodeId(link[2]);
      const courseName = cleanName(link[1]) || courseId;
      let source = byId.get(courseId);
      if (!source) {
        source = { courseId, courseName, refs: [] };
        byId.set(courseId, source);
        order.push(courseId);
      }
      // 同一门课在多个段落被引用时，位置合并（去重、保序、封顶）
      for (const ref of refs) {
        if (source.refs.length >= MAX_SOURCE_REFS) break;
        if (!source.refs.includes(ref)) source.refs.push(ref);
      }
    }
  }

  return order.map((id) => byId.get(id)!);
}
