/**
 * 讲义中间表示（IR）：模型输出块级 JSON，渲染器消费 Block[]。
 * 解析层做防御性清洗（编号剥离、Markdown 残留、时间戳换算），
 * 让模型只关心内容、渲染器只做排版，互不猜测。
 */

export type Block =
  | { type: 'lead'; text: string } // 节首主旨段（每节第一个块）
  | { type: 'para'; text: string } // 正文段
  | { type: 'h2'; text: string } // 「（一）」级小节标题，编号由渲染器生成
  | { type: 'list'; ordered: boolean; items: string[] } // 「1.」或「●」
  | { type: 'table'; caption?: string; header: string[]; rows: string[][] } // 三线表
  | { type: 'figure'; ts: number; caption?: string } // 配图（ts 单位：秒）
  | { type: 'note'; text: string }; // 提示/注意（楷体小段）

export interface SectionRange {
  startSec: number;
  endSec: number;
}

/** 模型 JSON 契约中的 figure.time 支持 mm:ss / hh:mm:ss */
function parseTimeToSec(t: unknown): number | null {
  if (typeof t !== 'string') return null;
  const parts = t.trim().split(':').map(Number);
  if (parts.some(isNaN) || parts.length < 2 || parts.length > 3) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return parts[0] * 60 + parts[1];
}

/** 清除文本值中的 Markdown 残留（模型偶发违规输出） */
function cleanInline(text: unknown): string {
  if (typeof text !== 'string') return '';
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

/** 剥离模型顺手写上的前置编号/符号，编号统一由渲染器生成 */
function stripLeadingMarker(text: string): string {
  return text
    .replace(/^[（(][一二三四五六七八九十]+[)）]\s*/, '')
    .replace(/^\d+[.、)]\s*/, '')
    .replace(/^[-*•●]\s*/, '')
    .trim();
}

function requireStringArray(v: unknown, what: string): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== 'string')) {
    throw new Error(`IR 校验失败：${what} 必须是非空字符串数组`);
  }
  return (v as string[]).map(cleanInline).filter(Boolean);
}

/**
 * 把模型原始输出解析为 Block[]。
 * 结构性错误（非 JSON / 未知块 / table 行列不齐 / 无有效块）抛错，供 pipeline 重试；
 * 局部问题（figure 越界、空文本块）宽容丢弃，不值得为单点重试整节。
 */
export function parseSectionBlocks(raw: string, range: SectionRange): Block[] {
  const cleaned = raw.replace(/```(?:json)?/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('模型未返回有效的 JSON');
  const obj = JSON.parse(cleaned.slice(start, end + 1)) as { blocks?: unknown };
  if (!Array.isArray(obj.blocks)) throw new Error('IR 校验失败：缺 blocks 数组');

  const blocks: Block[] = [];
  for (const b of obj.blocks as Record<string, unknown>[]) {
    const text = cleanInline(b?.text);
    switch (b?.type) {
      case 'lead':
      case 'para':
      case 'note':
        if (text) blocks.push({ type: b.type, text });
        break;
      case 'h2':
        if (text) blocks.push({ type: 'h2', text: stripLeadingMarker(text) });
        break;
      case 'list': {
        const items = requireStringArray(b.items, 'list.items').map(stripLeadingMarker).filter(Boolean);
        if (items.length > 0) blocks.push({ type: 'list', ordered: b.ordered === true, items });
        break;
      }
      case 'table': {
        const header = requireStringArray(b.header, 'table.header');
        const rawRows = b.rows;
        if (!Array.isArray(rawRows) || rawRows.length === 0) throw new Error('IR 校验失败：table.rows 为空');
        const rows = rawRows.map((r) => {
          const cells = requireStringArray(r, 'table.rows[]');
          if (cells.length !== header.length) {
            throw new Error(`IR 校验失败：table 行列数不一致（表头 ${header.length} 列，行 ${cells.length} 列）`);
          }
          return cells;
        });
        const caption = cleanInline(b.caption);
        blocks.push({ type: 'table', ...(caption ? { caption } : {}), header, rows });
        break;
      }
      case 'figure': {
        const ts = parseTimeToSec(b.time);
        if (ts === null) break; // 时间戳非法：丢弃
        if (ts < range.startSec || ts > range.endSec) break; // 越界：丢弃
        const caption = cleanInline(b.caption);
        blocks.push({ type: 'figure', ts, ...(caption ? { caption } : {}) });
        break;
      }
      default:
        throw new Error(`IR 校验失败：未知块类型 ${String(b?.type)}`);
    }
  }

  if (blocks.length === 0) throw new Error('IR 校验失败：无有效块');
  return blocks;
}

/**
 * 解析 AI 改写的单块输出：type 必须与原文一致，结构性约束按类型校验
 * （table 行列维度不变、figure 时间戳强制保留原值只改图注、list 条目非空）。
 * 校验失败抛错，供上层重试。
 */
export function parseRewrittenBlock(raw: string, original: Block): Block {
  const cleaned = raw.replace(/```(?:json)?/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('模型未返回有效的 JSON');
  const obj = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;

  switch (original.type) {
    case 'lead':
    case 'para':
    case 'note': {
      const text = cleanInline(obj.text);
      if (!text) throw new Error('改写结果为空');
      return { type: original.type, text };
    }
    case 'h2': {
      const text = stripLeadingMarker(cleanInline(obj.text));
      if (!text) throw new Error('改写结果为空');
      return { type: 'h2', text };
    }
    case 'list': {
      const items = requireStringArray(obj.items, 'list.items').map(stripLeadingMarker).filter(Boolean);
      if (items.length === 0) throw new Error('改写结果为空');
      return { type: 'list', ordered: original.ordered, items };
    }
    case 'table': {
      const header = requireStringArray(obj.header, 'table.header');
      if (header.length !== original.header.length) {
        throw new Error(`表头列数须保持 ${original.header.length} 列`);
      }
      const rawRows = obj.rows;
      if (!Array.isArray(rawRows) || rawRows.length === 0) throw new Error('table.rows 为空');
      const rows = rawRows.map((r) => {
        const cells = requireStringArray(r, 'table.rows[]');
        if (cells.length !== header.length) throw new Error('表格行列数不一致');
        return cells;
      });
      const caption = cleanInline(obj.caption);
      return { type: 'table', ...(caption ? { caption } : {}), header, rows };
    }
    case 'figure': {
      const caption = cleanInline(obj.caption);
      if (!caption) throw new Error('图注改写结果为空');
      return { ...original, caption };
    }
  }
}

const FALLBACK_TEXT = '本节正文格式异常，请重新生成讲义。';

/**
 * 两次解析失败后的兜底：模型若无视契约直接输出了纯文本，按行转 para 块保住内容；
 * 若输出是残缺 JSON 或空内容，退化为单段失败提示。任何情况下讲义生成不阻塞。
 */
export function salvageBlocks(raw: string): Block[] {
  const text = raw.trim();
  if (!text || text.includes('{')) {
    return [{ type: 'para', text: FALLBACK_TEXT }];
  }
  const paras = text
    .split('\n')
    .map((line) => cleanInline(line.replace(/^#{1,6}\s+/, '').replace(/^>\s?/, '')))
    .filter(Boolean);
  if (paras.length === 0) return [{ type: 'para', text: FALLBACK_TEXT }];
  return paras.map((t) => ({ type: 'para' as const, text: t }));
}

/** 收集所有节实际引用的配图时间戳（秒，去重），供高清重抽 */
export function collectFigureTimestamps(sections: { blocks: Block[] }[]): number[] {
  const out: number[] = [];
  for (const s of sections) {
    for (const b of s.blocks) {
      if (b.type === 'figure' && !out.includes(b.ts)) out.push(b.ts);
    }
  }
  return out;
}
