import type React from 'react';
import { Children, cloneElement, isValidElement } from 'react';
import type { ComponentProps } from '@ant-design/x-markdown';

/**
 * 替换 XMarkdown 的 `table`，做两件事：
 *   1. 外面套一层横向滚动容器（见下）；
 *   2. 逐列判定「数值列」，打上 `md-table-num`，让表头与数据一起右对齐。
 *
 * ## 为什么必须多这一层容器
 *
 * x-markdown 给表格的是 `display:block; width:max-content; overflow:auto`——
 * 「宽表能横滚」是它用**放弃表格盒**换来的：元素一旦是 block 盒，`width:100%` 拉不宽
 * 里面那个匿名 table 盒，宽度只能永远是「内容多宽就多宽」（窄表缩在左边一小截，
 * 三条线也跟着只有一小截）。想做三线表那种「线撑满整栏、列自动摊开」，
 * 表格必须是真 `table` 盒（`display:table; width:100%`），而真 table 盒没法自己横滚。
 *
 * 于是把两件事拆开：**宽度给内层**（真表格，撑满整栏）、**滚动给外层**（这一层 div）。
 * 宽表靠内层的 `min-width:max-content` 不被压扁，超出容器时由外层出滚动条。
 * 具体样式见 `src/md-table.css`。
 *
 * ## 对齐为什么在这里做
 *
 * x-markdown 把作者写的列对齐（`| ---: |`）渲染成 `align="right"` **属性**，
 * 那是 presentational hint：样式表里凡是写 `text-align` 都会把它整个盖掉
 * （hint 的优先级低于任何作者声明，连 `th { text-align: start }` 都能压住它）。
 * 所以「表头默认居中 → 改成与数据同侧」只能写成 `th:not([align])`，动不了对齐的判定。
 *
 * 而 Markdown 作者几乎不会写 `---:`，纯数值列于是只能左对齐——三线表里数值该右对齐
 * 这条规范就落不了地。所以数值列的判定放在这里：**看数据本身**，把结论变成
 * `md-table-num` 一个类，具体的 `text-align` 仍在 CSS 里（`md-table.css`）。
 *
 * 判定刻意保守，宁可漏判也不错判：
 *   - 该列只要有任何一格写了显式对齐（`align` 属性）→ 整列听作者的，不插手；
 *   - 数据格必须**全部**是「纯数值」（可选正负号 / 货币符号 / 千分位 / 小数 / 单个单位）
 *     —— 「2~6s」「¥0.02/分钟」「<1s」这类带范围、斜杠、比较符的都不是纯数值，保持左对齐；
 *   - 空单元格与「—」算中立，不影响判定；一格数据都没有的空表不动；
 *   - 行列数对不齐（流式写到一半的表格）→ 整表不动，等它长完。
 */

/** 纯数值：可选正负号 + 可选货币符号 + 数字（千分位 / 小数）+ 可选单个单位 */
const NUMERIC =
  /^[+-]?[¥$€]?\d[\d,]*(?:\.\d+)?\s?(?:%|[A-Za-z]{1,3}|[万千百亿元人份个次秒分]|毫秒)?$/;

/** 中立内容：空白、破折号类占位符 —— 不参与「是不是数值列」的判定 */
const NEUTRAL = /^[\s—–\-]*$/;

const CELL_TAGS = new Set(['th', 'td']);
const ROW_GROUP_TAGS = new Set(['thead', 'tbody', 'tfoot']);

function propsOf(el: React.ReactElement): Record<string, unknown> {
  return (el.props ?? {}) as Record<string, unknown>;
}

/** 单元格标签名；不是 th/td（或不是原生元素）就返回 null */
function cellTag(node: React.ReactNode): 'th' | 'td' | null {
  if (!isValidElement(node)) return null;
  const tag = node.type;
  return typeof tag === 'string' && CELL_TAGS.has(tag) ? (tag as 'th' | 'td') : null;
}

/** 单元格的文字内容（递归取，兼容 <code>/<strong> 包一层的情况） */
function textOf(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement(node)) return textOf(propsOf(node).children as React.ReactNode);
  return '';
}

/**
 * 收集所有 `tr`。只认原生 thead/tbody/tfoot/tr —— 结构里有别的东西（自定义组件、
 * 嵌套 table）就停下不下潜，宁可不对齐也不猜。
 */
function collectRows(nodes: React.ReactNode, out: React.ReactElement[] = []): React.ReactElement[] {
  Children.forEach(nodes, (node) => {
    if (!isValidElement(node) || typeof node.type !== 'string') return;
    if (node.type === 'tr') {
      out.push(node);
    } else if (ROW_GROUP_TAGS.has(node.type)) {
      collectRows(propsOf(node).children as React.ReactNode, out);
    }
  });
  return out;
}

/** 一行里的单元格（按列序） */
function cellsOf(row: React.ReactElement): React.ReactElement[] {
  return Children.toArray(propsOf(row).children as React.ReactNode).filter(
    (c): c is React.ReactElement => cellTag(c) !== null,
  );
}

/** 判定哪些列是数值列。有疑虑就返回空集合（= 不插手）。 */
function numericColumns(rows: React.ReactElement[]): Set<number> {
  const none = new Set<number>();
  if (rows.length === 0) return none;

  const grid = rows.map(cellsOf);
  const width = grid[0].length;
  if (width === 0) return none;
  // 行列数对不齐（含流式写到一半）→ 等它长完再说
  if (grid.some((cells) => cells.length !== width)) return none;

  const isDataRow = grid.map((cells) => cells.every((c) => cellTag(c) === 'td'));
  const result = new Set<number>();

  for (let j = 0; j < width; j += 1) {
    // 作者写过对齐（align 属性）的列，一律不插手
    if (grid.some((cells) => propsOf(cells[j]).align != null)) continue;

    const texts = grid
      .filter((_, i) => isDataRow[i])
      .map((cells) => textOf(propsOf(cells[j]).children as React.ReactNode).trim())
      .filter((t) => !NEUTRAL.test(t));

    if (texts.length === 0) continue;
    if (texts.every((t) => NUMERIC.test(t))) result.add(j);
  }
  return result;
}

/** 给数值列的 th/td 补上 `md-table-num`，其余原样返回 */
function markNumeric(nodes: React.ReactNode, cols: Set<number>): React.ReactNode {
  return Children.map(nodes, (node) => {
    if (!isValidElement(node) || typeof node.type !== 'string') return node;
    const props = propsOf(node);
    if (node.type === 'tr') {
      let j = -1;
      const cells = Children.map(props.children as React.ReactNode, (child) => {
        if (cellTag(child) === null) return child;
        j += 1;
        if (!cols.has(j)) return child;
        const el = child as React.ReactElement;
        const prev = propsOf(el).className;
        const className = typeof prev === 'string' && prev ? `${prev} md-table-num` : 'md-table-num';
        return cloneElement(el, { className } as Record<string, unknown>);
      });
      return cloneElement(node, undefined, cells);
    }
    if (ROW_GROUP_TAGS.has(node.type)) {
      return cloneElement(node, undefined, markNumeric(props.children as React.ReactNode, cols));
    }
    return node;
  });
}

/**
 * 用它的地方：问答正文 / 课程问答 / 题卡解析 / Markdown 素材阅读 —— 四处共用
 * XMarkdown，都挂上这个组件，表格口径才一致。
 */
export function MarkdownTable({ children }: ComponentProps) {
  const body = children as React.ReactNode;
  const cols = numericColumns(collectRows(body));
  return (
    <div className="md-table-scroll">
      <table>{cols.size > 0 ? markNumeric(body, cols) : body}</table>
    </div>
  );
}
