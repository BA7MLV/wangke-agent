import { lexicalSearch, tokenize } from './lexical.ts';

export interface GrepDoc {
  text: string;
  path: string;
  start: number;
  end: number;
  unit: 'seconds' | 'pages' | 'paragraphs' | 'lines';
}

export function grepOptions(args: Record<string, unknown>) {
  const mode = args.mode ?? (args.regex === true ? 'regex' : 'ranked');
  if (!['literal', 'regex', 'ranked'].includes(String(mode))) throw new Error('mode 必须是 literal、regex 或 ranked。');
  if (args.regex === true && mode !== 'regex') throw new Error('regex=true 与 mode 冲突，请使用 mode="regex"。');
  const query = String(args.query ?? '');
  if (!query.trim()) throw new Error('请提供要检索的关键词。');
  const flags = args.flags ?? 'i';
  if (typeof flags !== 'string' || !/^[imsu]*$/.test(flags)) throw new Error('flags 只支持 i、m、s、u。');
  if (mode === 'regex' && query.length > 1000) throw new Error('正则最多 1000 字符。');
  const regex = mode === 'regex' ? new RegExp(query, flags) : undefined;
  return { mode, query, regex, limit: Math.min(15, Math.max(1, Number(args.limit) || 6)) };
}

/** Same matching semantics for every resource; ranked is explicitly approximate. */
export function grepDocs<T extends GrepDoc>(docs: T[], args: Record<string, unknown>) {
  const options = grepOptions(args);
  const { mode, query, regex, limit } = options;
  const all = mode === 'ranked'
    ? lexicalSearch(docs, (doc) => doc.text, query, -1).map((hit) => hit.doc)
    : docs.filter((doc) => regex ? regex.test(doc.text) : doc.text.toLowerCase().includes(query.toLowerCase()));
  const terms = [...new Set(tokenize(query))].sort((a, b) => b.length - a.length);
  const hits = all.slice(0, limit).map((doc) => {
    const lower = doc.text.toLowerCase();
    const exact = regex?.exec(doc.text);
    let at = exact ? exact.index : lower.indexOf(query.toLowerCase());
    let length = exact ? exact[0].length : query.length;
    if (at < 0) {
      const term = terms.find((term) => lower.includes(term));
      at = term ? lower.indexOf(term) : 0;
      length = term?.length ?? 0;
    }
    const from = Math.max(0, at - 160);
    const to = Math.min(doc.text.length, Math.max(from + 500, at + Math.min(length, 500)));
    const excerpt = `${from ? '…' : ''}${doc.text.slice(from, to)}${to < doc.text.length ? '…' : ''}`;
    const clipped = from > 0 || to < doc.text.length;
    const read = doc.unit === 'lines'
      ? { path: doc.path, raw: true, offset: Math.max(0, doc.start - 4), limit: 7 }
      : { path: doc.path, start: Math.max(doc.unit === 'seconds' ? 0 : 1, doc.start - (doc.unit === 'seconds' ? 15 : 1)), end: Math.min(doc.end + (doc.unit === 'seconds' ? 15 : 1), doc.start + (doc.unit === 'seconds' ? 580 : 18)) };
    return { doc, evidence: `path=${doc.path}\n定位：${doc.unit} start=${doc.start} end=${doc.end}\n原文${clipped ? '（摘要已截断）' : ''}：${excerpt}\nread 上下文：${JSON.stringify(read)}` };
  });
  const header = `mode=${mode}${mode === 'ranked' ? '（相关性排序，不保证完整短语匹配）' : ''}\n匹配 ${all.length} 个片段，返回 ${hits.length} 个${all.length > hits.length ? '（结果已截断，可缩小范围或细化查询）' : ''}。`;
  return { header, hits };
}
