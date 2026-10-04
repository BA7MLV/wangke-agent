/**
 * md 编辑态的装饰计算。**纯函数**：只吃语法树 + 文档字符串 + 光标区间，不碰 DOM。
 *
 * 为什么要拆出来：CodeMirror 的 ViewPlugin 依赖 @codemirror/view（在 node 里跑不起来），
 * 而「某个语法符号该不该藏」是本功能最容易写错、也最影响可用性的一条规则
 * —— 藏过头编辑器就难用，藏少了就不是所见即所得。把决策抽到这里，
 * 就能用 @lezer/markdown（纯 JS 解析器）在一层单测里直接断言，见 scripts/test-md-live-preview.mjs。
 *
 * 输出是一串**按 from 升序、互不重叠**的 spec，直接喂给 CodeMirror 的 RangeSetBuilder
 * （它要求严格有序，重叠会抛）。这个契约有单测守着。
 *
 * ── v1 的取舍（哪些不藏，是刻意的）────────────────────────────────────
 * - **有序列表的序号不藏**：藏了用户就不知道自己在改第几项，那是信息不是语法。
 * - **链接的 `[` `]` `(` `)` 不藏**：藏掉链接地址等于让用户没法核对跳到哪里，
 *   而链接本身渲染出来也就是那串文字，藏了收益很小、风险很大。
 * - **表格 / 图片不特殊处理**：lezer-markdown 的表格来自 GFM mixin，节点边界最容易出 bug，
 *   v1 按源码原样显示，等 v1 稳了再单独做。
 * 这几条是「v1 明确不覆盖」，不是遗漏。
 */
import type { Tree } from '@lezer/common';

export interface DocRange { from: number; to: number }

export type DecorSpec =
  | { kind: 'hide'; from: number; to: number }
  | { kind: 'collapse'; from: number; to: number }
  | { kind: 'mark'; from: number; to: number; cls: string };

/**
 * 纯语法标记：藏了不影响读，只影响「这行源码长什么样」。
 *
 * 不含 ListMark —— 它要不要藏取决于外层是有序还是无序列表（有序序号是信息），
 * 放进这个集合就得再开一个后门，不如在分支里判。
 */
const MARK_NODES = new Set(['HeaderMark', 'QuoteMark', 'EmphasisMark', 'CodeMark']);

/** 行内容器：标记的露出范围以整个行内片段为准 */
const INLINE_OWNERS = new Set(['Emphasis', 'StrongEmphasis', 'InlineCode']);
/**
 * 块级标记：露出范围是标记**自己那一行**。
 *
 * 试过用「最近的外层节点」当范围（ATXHeading / Blockquote / ListItem），
 * 行内标记看起来更统一，但 ListItem 在嵌套列表里覆盖整个子树（`- 外层` 的 ListItem
 * 直接罩到孙子上），光标落在内层就会把外层的 `-` 也露出来，等于整篇列表符号全现。
 * 按行取范围正好：光标在哪一项就只露哪一项的符号。
 */
const LINE_OWNERS = new Set(['HeaderMark', 'QuoteMark', 'ListMark']);

function headingLevel(name: string): number | null {
  const atx = /^ATXHeading([1-6])$/.exec(name);
  if (atx) return Number(atx[1]);
  if (name === 'SetextHeading1') return 1;
  if (name === 'SetextHeading2') return 2;
  return null;
}

/**
 * 语法符号是否要露出：它碰到任一「活跃区间」就不藏。
 * 两侧都是闭区间 —— 光标是 `from === to` 的零宽区间，用半开区间判定会漏掉
 * 「光标正好停在 `**` 前面」这一种，而那恰恰是最常见的位置。
 */
function revealed(scope: DocRange, active: readonly DocRange[]): boolean {
  return active.some((a) => scope.from <= a.to && a.from <= scope.to);
}

function clamp(doc: string, pos: number): number {
  return Math.max(0, Math.min(pos, doc.length));
}

/** pos 所在的那一行，**不含行尾的 \n**（末行无 \n 时到文末） */
function lineAt(doc: string, pos: number): DocRange {
  const p = clamp(doc, pos);
  const from = doc.lastIndexOf('\n', p - 1) + 1;
  const nl = doc.indexOf('\n', p);
  return { from, to: nl < 0 ? doc.length : nl };
}

/**
 * 把块级标记的隐藏区间往后扩，吞掉紧随其后的连续水平空白。
 *
 * 为什么必须吃：只藏符号本身的话，`# 标题` 剩下「 标题」、`- 甲` 剩下「 甲」，
 * 而这些空白仍在文档里照常占位 —— 编辑态下每个标题、每个列表项都向右偏一格，
 * 看着像整体没对齐。空白是分隔符的一部分，不是内容。
 *
 * **只往后扩，绝不往前**：`- 乙` 缩进两格时，`-` 在第 2 列，它**前面**的缩进是列表层级，
 * 是信息不是语法；往前扩到行首就会把层级也吃掉，嵌套列表整个塌成一级。
 * 宁可留一格看不见的缩进，也不能让层级消失。
 *
 * **只吃 [ \\t]**：跨行的空白不是「标记后的分隔符」（那是下一段的开头），
 * 吃过去等于把下一行也拖进隐藏区间；制表符则和空格一样纯属对齐，要一起吃。
 *
 * **行内标记不能走这条**：`**粗体** 文字` 里收尾的 `**` 后面紧跟正文，
 * 扩一格就是删掉用户的一个字。
 */
function withTrailingBlank(doc: string, mark: DocRange): DocRange {
  let to = mark.to;
  while (to < doc.length && (doc[to] === ' ' || doc[to] === '\t')) to++;
  return { from: mark.from, to };
}

/**
 * 把 [from, to) 盖到的行整行取出（自动补上缩进与行首）。
 *
 * 判定用「行的起点是否越过区间终点」，而不是「行与区间相交」：围栏正文的区间
 * 是算到 `close.from` 为止，而闭合围栏那一行的起点正好等于区间终点，按相交判定
 * 会把 ``` 那一行也算成正文行，于是折叠区间和代码块样式区间重叠，RangeSetBuilder 直接抛。
 */
function linesOf(doc: string, from: number, to: number): DocRange[] {
  const start = clamp(doc, from);
  const end = clamp(doc, to);
  if (end <= start) return [];
  const out: DocRange[] = [];
  let p = start;
  for (;;) {
    const l = lineAt(doc, p);
    if (out.length > 0 && l.from >= end) break;
    out.push(l);
    if (l.to >= end) break;
    p = l.to + 1;
  }
  return out;
}

/** 从 [line.from, line.to] 里挖掉所有 holes（holes 要按 from 升序） */
function subtract(line: DocRange, holes: readonly DocRange[]): DocRange[] {
  const out: DocRange[] = [];
  let cur = line.from;
  for (const h of holes) {
    if (h.to <= cur || h.from >= line.to) continue;
    if (h.from > cur) out.push({ from: cur, to: Math.min(h.from, line.to) });
    cur = Math.max(cur, h.to);
  }
  if (cur < line.to) out.push({ from: cur, to: line.to });
  return out;
}

export function planDecorations(tree: Tree, doc: string, active: readonly DocRange[]): DecorSpec[] {
  /** 藏 / 折叠的区间。它们之间天然不重叠（叶子标记互不相交，围栏子树已跳过） */
  const holes: { kind: 'hide' | 'collapse'; from: number; to: number }[] = [];
  /**
   * 整行样式（容器）：标题 / 代码块，套在行里。
   * 既要挖掉 holes，也要挖掉 inlineStyles 的区间。
   */
  const lineStyles: { range: DocRange; cls: string }[] = [];
  /**
   * 行内样式（叶子）：行内代码。
   * 只挖 holes —— 它自己已经是最里层了。行内代码不会嵌套行内代码
   * （lezer 解析成 InlineCode > CodeMark + CodeText，两者是平级的），所以叶子之间天然不重叠。
   */
  const inlineStyles: { range: DocRange; cls: string }[] = [];
  const listStack: ('bullet' | 'ordered')[] = [];
  const inlineScopes: DocRange[] = [];

  const addLineStyle = (lines: DocRange[], cls: string) => {
    for (const l of lines) {
      // 空行（from === to）不给样式：零宽的 mark 在编辑器里既看不出效果、
      // 又会让「有序无重叠」这条契约多出一条噪声
      if (l.to > l.from) lineStyles.push({ range: l, cls });
    }
  };

  tree.iterate({
    enter(node) {
      const name = node.type.name;
      const range: DocRange = { from: node.from, to: node.to };

      if (name === 'BulletList' || name === 'OrderedList') {
        listStack.push(name === 'BulletList' ? 'bullet' : 'ordered');
        return;
      }

      if (INLINE_OWNERS.has(name)) {
        inlineScopes.push(range);
        if (name === 'InlineCode') inlineStyles.push({ range, cls: 'cm-md-inlinecode' });
        // 不能 return false：行内代码里的反引号要单独判露出，
        // 无条件藏掉的话用户在行内代码里就再也看不到、也删不掉那对反引号了
        return;
      }

      if (name === 'ListMark') {
        if (listStack[listStack.length - 1] === 'bullet' && !revealed(lineAt(doc, range.from), active)) {
          holes.push({ kind: 'hide', ...withTrailingBlank(doc, range) });
        }
        return false;
      }

      if (MARK_NODES.has(name)) {
        const isBlockMark = LINE_OWNERS.has(name);
        const scope = isBlockMark
          ? lineAt(doc, range.from)
          // 找不到行内容器就退回标记自身：宁可不露，也不凭空把一大段判成「在编辑」
          : inlineScopes[inlineScopes.length - 1] ?? range;
        if (!revealed(scope, active)) {
          holes.push({ kind: 'hide', ...(isBlockMark ? withTrailingBlank(doc, range) : range) });
        }
        return false;
      }

      const level = headingLevel(name);
      if (level !== null) {
        addLineStyle(linesOf(doc, range.from, range.to), `cm-md-h${level}`);
        // 标题里的行内标记要继续处理，所以不 return false
        return;
      }

      if (name === 'FencedCode') {
        const open = lineAt(doc, range.from);
        const close = lineAt(doc, range.to - 1);
        // 光标在围栏内（含首尾行）就不折叠：折起来那一行就没了，用户进不去也删不掉
        if (!revealed(range, active)) {
          holes.push({ kind: 'collapse', from: open.from, to: open.to });
          if (close.from !== open.from) {
            holes.push({ kind: 'collapse', from: close.from, to: close.to });
          }
        }
        addLineStyle(linesOf(doc, open.to + 1, close.from), 'cm-md-codeblock');
        // 必须 return false：围栏的 CodeMark 就是首尾那两行 ``` 本身，
        // 再当成普通行内标记藏一遍会与上面的折叠区间重叠，RangeSetBuilder 会抛
        return false;
      }

      if (name === 'CodeBlock' || name === 'HTMLBlock') {
        addLineStyle(linesOf(doc, range.from, range.to), 'cm-md-codeblock');
        return false;
      }
    },
    leave(node) {
      const name = node.type.name;
      if (name === 'BulletList' || name === 'OrderedList') listStack.pop();
      else if (INLINE_OWNERS.has(name)) inlineScopes.pop();
    },
  });

  // subtract 要求 holes 按 from 升序，所以下面几处共用一个排序函数，别各自写一遍
  const byPos = (a: DocRange, b: DocRange) => a.from - b.from || a.to - b.to;
  holes.sort(byPos);

  // 先定叶子：行内样式只让开语法符号
  const inlineSpecs: DecorSpec[] = [];
  for (const s of inlineStyles) {
    for (const seg of subtract(s.range, holes)) {
      inlineSpecs.push({ kind: 'mark', from: seg.from, to: seg.to, cls: s.cls });
    }
  }
  // 再定容器：整行样式要让开语法符号**和**所有行内样式。
  // 漏掉后者的话，标题里的行内代码会被整行样式整个吞掉（两者区间重叠，
  // 末尾那层兜底按「from 小的胜」丢掉的一定是行内样式），渲染出来就是没有底色的普通标题文字。
  const lineHoles = [...holes, ...inlineSpecs.map((s) => ({ from: s.from, to: s.to }))].sort(byPos);

  const specs: DecorSpec[] = [...holes, ...inlineSpecs];
  for (const s of lineStyles) {
    for (const seg of subtract(s.range, lineHoles)) {
      specs.push({ kind: 'mark', from: seg.from, to: seg.to, cls: s.cls });
    }
  }

  specs.sort((a, b) => a.from - b.from || a.to - b.to);
  // 兜底：真出现重叠（同起点时短的排前面，hide/collapse 赢过样式）就丢掉后来的那条。
  // 上面「叶子先定、容器让开」的构造已经保证不重叠，这层只是不让「以后加规则」时的疏忽
  // 变成 RangeSetBuilder 的运行时异常 —— 注意它是**减法**，一旦触发就是丢样式而不是崩，
  // 所以别指望它兜住正确性。
  const out: DecorSpec[] = [];
  for (const s of specs) {
    const prev = out[out.length - 1];
    if (prev && s.from < prev.to) continue;
    out.push(s);
  }
  return out;
}