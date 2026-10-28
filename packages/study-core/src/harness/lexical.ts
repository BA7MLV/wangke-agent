/**
 * 词法检索（BM25）。**零依赖、不碰 IndexedDB**（与 `skills/scope.ts` 同一条先例），
 * 因此能进 `node scripts/test-lexical.mjs` 这一档「无需 API key / 无需起服务」的单测。
 * 被 node 测试脚本直接 import，相对导入必须带 `.ts` 扩展名。
 *
 * ── 为什么会有这个文件（2026-09-24）────────────────────────────────────────
 * 稠密向量检索被整体移除了（理由见
 * docs/plans/2026-09-23-context-engineering-design.md §1.6）。核心判断是：
 * 「2023 年 RAG 需要 embedding，是因为检索器要给一个只能看 4k token、且只看一眼的模型
 * 做预筛」—— 而本项目的消费方是工具循环里的一个强 LLM，词汇鸿沟（问句用词 ≠ 原文用词）
 * 搬到了 LLM 身上，在那里很便宜就能解决（生成同义词、从划选的原文取词、迭代）。
 *
 * ── 为什么不上倒排索引 ───────────────────────────────────────────────────
 * 语料总量很小：一门 2 小时课约 3 万字。一次查询就是把候选文档扫一遍，
 * 在 JS 里是几毫秒到几十毫秒量级。建索引会引入「索引会脏」这一整类问题
 * （本项目刚为此付过一次代价），而它的收益在这个规模上不存在。
 *
 * ── 为什么分词要 unigram + bigram ────────────────────────────────────────
 * 中文没有词边界，而 BM25 本身不含分词逻辑 —— 质量取决于分词质量。
 * 字符 bigram 是绕过分词器的常用做法，但只发 bigram 会漏掉单字查询：
 * 查「幂」时，文档里的「幂运算」只产出 `幂运` / `运算` 两个 bigram，
 * 单字 `幂` 反而命中不了。所以 CJK 串**同时**发单字与相邻二字组，
 * 靠 IDF 自然压低「这 / 的 / 一」这类高频单字的权重（它们几乎出现在每篇文档里，
 * df ≈ N → idf ≈ 0）。拉丁与数字整段成词，这样 `E1234`、`3.5`、`bge-m3`
 * 这类字面标识符能精确命中 —— 那正是词法相对稠密的强项。
 */

/**
 * CJK 表意文字与日文假名。与 `materials/chunk.ts` 的 CJK 常量口径一致，
 * 只取「无词边界」的那部分：全角标点不在内（它们是天然的分隔符）。
 */
const CJK_RE = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;

/** 拉丁字母与数字：整段成词，不做词干还原 */
const ALNUM_RE = /[a-z0-9]/;

/**
 * 把文本切成检索词项。
 *
 * 大小写不敏感（入库与查询走同一个函数，两边一致性是唯一硬要求）。
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const s = text.toLowerCase();
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (CJK_RE.test(ch)) {
      let j = i;
      while (j < s.length && CJK_RE.test(s[j])) j++;
      const run = s.slice(i, j);
      if (run.length === 1) {
        out.push(run);
      } else {
        for (let k = 0; k < run.length; k++) {
          out.push(run[k]); // 单字：保证单字查询能命中
          if (k + 1 < run.length) out.push(run.slice(k, k + 2)); // 邻接二字组：保证精度
        }
      }
      i = j;
      continue;
    }
    if (ALNUM_RE.test(ch)) {
      let j = i;
      while (j < s.length && ALNUM_RE.test(s[j])) j++;
      out.push(s.slice(i, j));
      i = j;
      continue;
    }
    i++; // 其余字符（空白、标点、符号）当分隔符
  }
  return out;
}

/**
 * BM25 的 idf。用的是「加一」变体 `log(1 + (N - df + 0.5)/(df + 0.5))`，
 * 保证非负 —— 原始形式在 df > N/2 时会给负值，让高频词反过来扣分，
 * 那在短文档集合上会造成「越常见越该排前面」的诡异排序。
 */
export function bm25Idf(docCount: number, docFreq: number): number {
  return Math.log(1 + (docCount - docFreq + 0.5) / (docFreq + 0.5));
}

/** 非重叠出现次数。手写 indexOf 循环而不是 `split` —— 后者会为每次计数分配数组 */
function countOccurrences(text: string, term: string): number {
  if (!term) return 0;
  let count = 0;
  let idx = text.indexOf(term);
  while (idx !== -1) {
    count++;
    idx = text.indexOf(term, idx + term.length);
  }
  return count;
}

export interface LexicalHit<T> {
  doc: T;
  score: number;
}

export interface LexicalOptions {
  /** 词频饱和：越大越奖励重复出现 */
  k1?: number;
  /** 长度归一化强度：0 = 不归一化，1 = 完全归一化 */
  b?: number;
  /**
   * 覆盖率加成系数：所有查询词都出现的文档乘以 `1 + bonus * 命中率`。
   *
   * 为什么需要：BM25 是逐词求和，短查询（「幂运算」）下两项都命中的文档
   * 与只命中一项的文档分数差距本来就不大；而「所有关键词都出现」这个信号
   * 比「某一项出现很多次」更接近用户意图。设 0 可关闭。
   */
  coverageBonus?: number;
}

/**
 * 对一组成员做 BM25 检索，返回按相关度降序的命中。
 *
 * 一遍扫描同时得到：每篇文档对查询词的词频、每个查询词的文档频率、
 * 文档长度与平均长度。第二遍只用查询词算分（不遍历全部词项），
 * 这是 BM25 的标准优化，也让「没有索引」这件事在成本上成立。
 *
 * 只出现零次或分数为 0 的文档不返回 —— 调用方据此说「未检索到」，
 * 而不是拿一堆无关片段去污染上下文。
 *
 * @param docs  候选文档（字幕段 / 材料块）
 * @param textOf 取文档正文。**必须是纯函数且稳定** —— 会被扫两遍
 */
export function lexicalSearch<T>(
  docs: readonly T[],
  textOf: (doc: T) => string,
  query: string,
  topK: number,
  opts: LexicalOptions = {},
): LexicalHit<T>[] {
  const k1 = opts.k1 ?? 1.2;
  const b = opts.b ?? 0.75;
  const coverageBonus = opts.coverageBonus ?? 0.5;

  // 去重：查询里同一个词出现多次不该重复计分
  const terms = [...new Set(tokenize(query))];
  const n = docs.length;
  if (terms.length === 0 || n === 0) return [];

  const tfByTerm = new Map<string, Int32Array>();
  const df = new Map<string, number>();
  const lens = new Int32Array(n);
  /** 每篇文档命中了几个查询词（覆盖率用） */
  const matched = new Int32Array(n);
  let totalLen = 0;

  for (let d = 0; d < n; d++) {
    const text = (textOf(docs[d]) ?? '').toLowerCase();
    lens[d] = text.length;
    totalLen += text.length;
    for (const term of terms) {
      const c = countOccurrences(text, term);
      if (c === 0) continue;
      let arr = tfByTerm.get(term);
      if (!arr) {
        arr = new Int32Array(n);
        tfByTerm.set(term, arr);
      }
      arr[d] = c;
      df.set(term, (df.get(term) ?? 0) + 1);
      matched[d]++;
    }
  }

  const avgdl = totalLen / n || 1;
  const hits: LexicalHit<T>[] = [];
  for (let d = 0; d < n; d++) {
    const lenNorm = 1 - b + (b * lens[d]) / avgdl;
    let score = 0;
    for (const term of terms) {
      const c = tfByTerm.get(term)?.[d] ?? 0;
      if (c === 0) continue;
      score += bm25Idf(n, df.get(term) ?? 0) * ((c * (k1 + 1)) / (c + k1 * lenNorm));
    }
    if (score <= 0) continue;
    if (coverageBonus > 0) score *= 1 + coverageBonus * (matched[d] / terms.length);
    hits.push({ doc: docs[d], score });
  }

  // sort 在现代引擎里是稳定的：同分文档保持入参顺序（= idx 顺序），结果可复现
  hits.sort((x, y) => y.score - x.score);
  return topK >= 0 ? hits.slice(0, topK) : hits;
}
