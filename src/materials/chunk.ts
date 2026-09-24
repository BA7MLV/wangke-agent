/**
 * 材料文本的归一化与分块。
 *
 * 全部是纯函数、**不依赖 DOM** —— 这样能进 `node scripts/test-material-chunk.mjs`
 * 这一档「无需 API key / 无需起服务」的单元测试（与 `handout/ir.ts` 的先例一致）。
 *
 * 约束：被 node 测试脚本直接 import，相对导入必须带 `.ts` 扩展名。
 */

import { fmtUnitLabel, type UnitKind } from './units.ts';

/** 一个定位单元（PDF 一页 / Word 一段）抽出来的原始文本 */
export interface RawUnit {
  /** 1 起的单元号：页码或段落序号 */
  unit: number;
  text: string;
  /** 单元性质；PDF 由字号启发式判定，Word 由段落样式判定 */
  kind?: MaterialBlockKind;
  /** Word 用：所属章节标题（最近一个标题段） */
  section?: string;
}

export type MaterialBlockKind = 'body' | 'title' | 'table' | 'caption';

/** 入库的文本块 */
export interface MaterialBlock {
  idx: number;
  unit: number;
  unitLabel: string;
  text: string;
  kind: MaterialBlockKind;
}

/** 单块上限。超过就切：一块太大时向量会被稀释，检索命中率反而掉 */
export const MAX_BLOCK_CHARS = 800;

/**
 * 扫描件判定阈值：页均字数低于这个数就认为「没有文本层」。
 * 正常一页中文教材约 500~900 字，扫描件的文本层是空的（0 字）或只剩页眉页脚几个字。
 */
export const SCAN_CHARS_PER_UNIT_MIN = 50;

/** CJK 及全角标点（用于「两个汉字之间的空格要去掉」这类中文排版修正） */
const CJK = '\\u3000-\\u303F\\u3040-\\u30FF\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF\\uFF00-\\uFFEF';

/** 去掉「汉字 空格 汉字」里的空格（PDF 文本层常见的多余空格） */
export function collapseCjkSpaces(s: string): string {
  return s.replace(new RegExp(`([${CJK}])[ \\t]+(?=[${CJK}])`, 'g'), '$1');
}

/**
 * 通用文本归一化：去零宽/控制字符、折叠空白、折叠多余换行。
 * PDF 的文本层经常带 `\u0000`（某些生成器用来占位）与零宽字符，不清理会污染检索。
 */
export function normalizeBlockText(raw: string): string {
  const cleaned = raw
    .replace(/\u0000/g, '')
    .replace(/[\u200b-\u200f\ufeff]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u3000]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return collapseCjkSpaces(cleaned);
}

/**
 * 把 PDF 抽出来的「行」拼成段落文本。
 *
 * 核心难点：PDF 没有「段落」概念，只有一堆带坐标的文本片段。行尾的换行可能是
 * ①真的段落结束 ②排版换行（一行放不下）。规则：
 *
 * - **一律先用单个空格相连**，再用 `collapseCjkSpaces` 把「汉字 空格 汉字」的空格吃掉。
 *   这一条同时覆盖了四种组合：汉字接汉字（去空格）、汉字接拉丁（留空格，符合中文排版）、
 *   拉丁接汉字（留空格）、拉丁接拉丁（留空格）。
 * - 行尾是 `-` 且下一行以小写拉丁字母开头 → 视为断词连字符，删掉连字符直接接。
 * - 空行 → 段落分隔（保留一个 `\n\n`，让下游检索能感知段落边界）。
 */
export function joinPdfLines(lines: string[]): string {
  let out = '';
  for (const rawLine of lines) {
    const t = rawLine.replace(/[ \t\u3000]+/g, ' ').trim();
    if (!t) {
      if (out && !out.endsWith('\n\n')) out += '\n\n';
      continue;
    }
    if (!out || out.endsWith('\n\n')) {
      out += t;
      continue;
    }
    if (/-$/.test(out) && /^[a-z]/.test(t)) {
      out = out.slice(0, -1) + t;
      continue;
    }
    out += ' ' + t;
  }
  return normalizeBlockText(out);
}

/**
 * 扫描件判定：**页**均字数过低。
 *
 * 必须显式判定并告知用户 —— 否则用户会以为「问答坏了」，
 * 而真实原因是这份 PDF 根本没有文本层。
 *
 * ⚠️ **只对 PDF 有意义，调用方必须自己保证这一点**（统一走 `judgeMaterialText`）。
 * 这条判定的前提是「PDF 是排版格式，可以完全没有文本层」；Word 是结构化 XML，
 * 正文必然以文本存在。拿段落数当分母，阈值会从「每页 50 字」悄悄变成「每段 50 字」——
 * 大纲、讲稿、条目式笔记的段均字数本来就低于 50，会被整体误判成扫描件并跳过建索引。
 */
export function looksScanned(totalChars: number, unitCount: number): boolean {
  if (unitCount <= 0) return true;
  return totalChars / unitCount < SCAN_CHARS_PER_UNIT_MIN;
}

/** 一份材料能否参与检索，以及不能的原因 */
export interface MaterialTextVerdict {
  /** 有页面但取不到字（PDF 无文本层）→ UI 说「扫描件」：能划词/框选，但不能检索 */
  scanned: boolean;
  /** 压根没解析出内容单元（空文档 / 只有图片的 Word）→ 不是扫描件，是没正文 */
  empty: boolean;
}

/**
 * 判定材料能否参与检索。**格式感知**，这是它与 `looksScanned` 的唯一区别。
 *
 * 为什么必须把「有没有正文」这件事收在一个函数里：`scanned` 与 `empty` 都会跳过建索引，
 * 但给用户看的话不一样。把空 Word 说成「扫描件」、把短段落 Word 说成「没有文本层」
 * 都是错话 —— 而用户看到的正是这句话，他会以为功能坏了。
 *
 * 两者互斥：PDF 的 `contentUnits === 0` 已被 `looksScanned` 的 `unitCount <= 0` 分支吃掉。
 */
export function judgeMaterialText(
  format: 'pdf' | 'docx' | 'md',
  totalChars: number,
  contentUnits: number,
): MaterialTextVerdict {
  const scanned = format === 'pdf' && looksScanned(totalChars, contentUnits);
  return { scanned, empty: !scanned && contentUnits === 0 };
}

/** 句子边界：中文句末符号后，或拉丁句点后跟空白 */
const SENTENCE_SPLIT_RE = /(?<=[。！？；!?;])\s*|(?<=\.)\s+/;

/**
 * 把超长文本切成不超过 `max` 的片段：先按句切，句子本身仍超长才硬切。
 * 切点尽量落在句边界上，避免把一个完整语义切两半。
 */
export function splitLongText(text: string, max: number = MAX_BLOCK_CHARS): string[] {
  if (text.length <= max) return [text];
  const sentences = text.split(SENTENCE_SPLIT_RE).filter((s) => s.length > 0);
  const out: string[] = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push(buf);
    buf = '';
  };
  for (const s of sentences) {
    if (s.length > max) {
      flush();
      for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max));
      continue;
    }
    if (buf.length + s.length > max) flush();
    buf += s;
  }
  flush();
  return out.length > 0 ? out : [text];
}

/**
 * 单元 → 入库文本块。
 *
 * 同一个单元被切成了多块时，`unit` 保持不变（**页码不能因为切块而漂移**，
 * 否则「引用第 3 页」会指错），只在 `unitLabel` 后加 `（1/2）` 让人看得出是切出来的。
 */
export function chunkUnits(units: RawUnit[], kind: UnitKind): MaterialBlock[] {
  const out: MaterialBlock[] = [];
  for (const u of units) {
    const text = normalizeBlockText(u.text);
    if (!text) continue;
    const pieces = splitLongText(text);
    pieces.forEach((p, i) => {
      const suffix = pieces.length > 1 ? `（${i + 1}/${pieces.length}）` : '';
      out.push({
        idx: out.length,
        unit: u.unit,
        unitLabel: fmtUnitLabel(kind, u.unit, u.section) + suffix,
        text: p,
        kind: u.kind ?? 'body',
      });
    });
  }
  return out;
}

/** 块集总字数（扫描件判定与索引进度提示用） */
export function countChars(blocks: { text: string }[]): number {
  let n = 0;
  for (const b of blocks) n += b.text.length;
  return n;
}
