import type React from 'react';
import {
  Children,
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import type { ComponentProps } from '@ant-design/x-markdown';
import { Button, Drawer } from '@heroui/react';
import { Sym } from '../ui';
import { copyText } from '../utils/clipboard';
import { useIsMobile } from '../utils/useMobile';
import {
  columnWidthsPx,
  tableToCsv,
  tableToMarkdown,
  type TableAlign,
} from '../utils/markdownTable';
import { useMarkdownStreaming } from './markdown/streaming';

/**
 * 替换 XMarkdown 的 `table`：三线表 + 数值列右对齐 + 流式渐进 + 长表折叠。
 *
 * ## 三线表与对齐
 *
 * 外面套一层横向滚动容器，里面还原成真 `table` 盒（`display:table; width:100%`），
 * 让线撑满整栏；宽表由外层出滚动条。具体样式见 `src/md-table.css`。
 *
 * x-markdown 把作者写的列对齐（`| ---: |`）渲染成 `align="right"` **属性**，那是
 * presentational hint，样式表里任何 `text-align` 都会盖掉它。所以数值列的判定放在
 * 这里：**看数据本身**，把结论变成 `md-table-num` 一个类，具体方向仍在 CSS 里。
 * 判定刻意保守：任何一格有显式 `align` 就整列听作者的；数据格必须全部是纯数值；
 * 空单元格与「—」算中立；行列数对不齐时不插手。
 *
 * ## 流式（见 `markdown/streaming.tsx`）
 *
 * XMarkdown 的 `streamStatus` 对标准 `<table>` 永远是 `done`（它只跟踪自定义标签），
 * 所以「还在生成」从外层 Provider 读。流式期间：
 *   - 只挂**单元格数已经对齐表头**的完整行，末行写一半就裁掉；
 *   - 多列表格最多显示前 `PREVIEW_ROWS` 行（单列更像清单，全部露出），
 *     不出现展开按钮（避免点到半成品）；
 *   - 列宽在表格第一次出现时按表头 + 前几行定死，结束后再交回自动布局。
 *
 * ## 长表
 *
 * 桌面端默认只露前几行，点「展开全部」在气泡里拉高（内部再滚动）；
 * 手机端一律进 HeroUI Drawer 的底部 Sheet，完整表在那里独立滚动、可复制。
 * 复制支持 Markdown（保留链接 / 行内代码 / 加粗）与 CSV（标准引号转义）。
 */

/** 折叠前露出的数据行数。含表头共 7 行，正好在一屏聊天里读得完。 */
const PREVIEW_ROWS = 6;

const NUMERIC =
  /^[+-]?[¥$€]?\d[\d,]*(?:\.\d+)?\s?(?:%|[A-Za-z]{1,3}|[万千百亿元人份个次秒分]|毫秒)?$/;
const NEUTRAL = /^[\s—–\-]*$/;
const CELL_TAGS = new Set(['th', 'td']);
const ROW_GROUP_TAGS = new Set(['thead', 'tbody', 'tfoot']);

interface ParsedRow {
  row: React.ReactElement;
  cells: React.ReactElement[];
}

interface ParsedTable {
  header: ParsedRow | null;
  body: ParsedRow[];
  foot: ParsedRow[];
  columns: number;
  /** 有表头且列数 > 0 才走新渲染；否则原样吐回去，不猜结构。 */
  valid: boolean;
}

function propsOf(el: React.ReactElement): Record<string, unknown> {
  return (el.props ?? {}) as Record<string, unknown>;
}

/** 单元格标签名；不是 th/td（或不是原生元素）就返回 null */
function cellTag(node: React.ReactNode): 'th' | 'td' | null {
  if (!isValidElement(node)) return null;
  const tag = node.type;
  return typeof tag === 'string' && CELL_TAGS.has(tag) ? (tag as 'th' | 'td') : null;
}

/** 单元格的纯文字（递归取，兼容 <code>/<strong>/链接包一层的情况） */
function textOf(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (!isValidElement(node)) return '';
  const props = propsOf(node);
  if (node.type === 'br') return '\n';
  if (node.type === 'img') return typeof props.alt === 'string' ? props.alt : '';
  return textOf(props.children as React.ReactNode);
}

/**
 * 单元格的 Markdown 近似（复制用）。
 *
 * 屏幕上已经是渲染后的 React 树，原始 markdown 拿不到了；这里只还原最常见的行内结构。
 * 不认识的标签一律退成纯文字 —— 复制出去的内容宁可比原来朴素，也不能多出一堆
 * HTML 标签。真正的管道符 / 换行再由 `tableToMarkdown` 统一转义。
 */
function markdownOf(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(markdownOf).join('');
  if (!isValidElement(node)) return '';

  const props = propsOf(node);
  const inner = markdownOf(props.children as React.ReactNode);

  /**
   * XMarkdown 会把 `a` / `img` / `code` 换成自定义组件（SeekLink / SourceImage /
   * MarkdownCode…），这时标签名不再是字符串。能认出来的结构在这里补回去，
   * 认不出来的一律退成纯文字。
   */
  if (typeof node.type !== 'string') {
    const source = props['data-source'];
    if (typeof source === 'string' && source) {
      return props['data-display'] === 'true' ? `$$${source}$$` : `$${source}$`;
    }

    const href = props.href;
    if (typeof href === 'string' && href) return `[${inner}](${href})`;

    const src = props.src;
    if (typeof src === 'string' && src) {
      const alt = typeof props.alt === 'string' ? props.alt : '';
      return `![${alt}](${src})`;
    }

    // MarkdownCode：block 为 false 是行内代码；围栏代码不应出现在单元格里，
    // 真出现了也只留文字，不硬塞反引号。
    if ('block' in props && props.block !== true) {
      return inner ? `\`${inner}\`` : inner;
    }
    return inner;
  }

  switch (node.type) {
    case 'strong':
      return inner ? `**${inner}**` : inner;
    case 'em':
      return inner ? `*${inner}*` : inner;
    case 'del':
      return inner ? `~~${inner}~~` : inner;
    case 'code':
      return inner ? `\`${inner}\`` : inner;
    case 'br':
      return '<br>';
    case 'a': {
      const href = props.href;
      return typeof href === 'string' && href ? `[${inner}](${href})` : inner;
    }
    case 'img': {
      const alt = typeof props.alt === 'string' ? props.alt : '';
      const src = typeof props.src === 'string' ? props.src : '';
      return src ? `![${alt}](${src})` : alt;
    }
    default:
      return inner;
  }
}

function rowOf(node: React.ReactElement): ParsedRow {
  const cells = Children.toArray(propsOf(node).children as React.ReactNode).filter(
    (c): c is React.ReactElement => cellTag(c) !== null,
  );
  return { row: node, cells };
}

/**
 * 把 XMarkdown 给的 `<thead>/<tbody>/<tfoot>` 摊平成「表头 / 数据行 / 表尾」。
 * Markdown 表格结构很简单，但这里仍按标签判断，不按「第几行」猜 —— 猜错会把
 * 表尾当成数据行去折叠。
 */
function parseTable(nodes: React.ReactNode): ParsedTable {
  let header: ParsedRow | null = null;
  const body: ParsedRow[] = [];
  const foot: ParsedRow[] = [];

  const rowsIn = (section: React.ReactElement): ParsedRow[] =>
    Children.toArray(propsOf(section).children as React.ReactNode)
      .filter((n): n is React.ReactElement => isValidElement(n) && n.type === 'tr')
      .map(rowOf);

  Children.forEach(nodes, (node) => {
    if (!isValidElement(node) || typeof node.type !== 'string') return;

    if (node.type === 'tr') {
      body.push(rowOf(node));
      return;
    }
    if (!ROW_GROUP_TAGS.has(node.type)) return;

    const rows = rowsIn(node);
    if (node.type === 'thead') {
      if (!header && rows.length > 0) header = rows[0];
      // 多出来的 thead 行极罕见；宁可当数据行保留，也不悄悄丢掉
      body.push(...rows.slice(1));
    } else if (node.type === 'tbody') {
      body.push(...rows);
    } else {
      foot.push(...rows);
    }
  });

  // 有些渲染器不包 thead，直接把第一行写成 th。能认出来就认，认不出来保持原样。
  if (!header && body.length > 0) {
    const first = body[0];
    if (first.cells.length > 0 && first.cells.every((c) => cellTag(c) === 'th')) {
      header = first;
      body.shift();
    }
  }

  const columns = header?.cells.length ?? 0;
  return { header, body, foot, columns, valid: header !== null && columns > 0 };
}

/** 判定哪些列是数值列。有疑虑就返回空集合（= 不插手）。 */
function numericColumns(header: ParsedRow | null, body: ParsedRow[]): Set<number> {
  const none = new Set<number>();
  if (!header || header.cells.length === 0) return none;

  const width = header.cells.length;
  const rows = [header, ...body];
  const grid = rows.map((row) => row.cells);
  if (grid.some((cells) => cells.length !== width)) return none;

  const isDataRow = grid.map((cells, i) => i > 0 && cells.every((c) => cellTag(c) === 'td'));
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
function markNumericRow(row: React.ReactElement, cols: Set<number>): React.ReactElement {
  if (cols.size === 0) return row;

  let j = -1;
  const cells = Children.map(propsOf(row).children as React.ReactNode, (child) => {
    if (cellTag(child) === null) return child;
    j += 1;
    if (!cols.has(j)) return child;

    const el = child as React.ReactElement;
    const prev = propsOf(el).className;
    const className = typeof prev === 'string' && prev ? `${prev} md-table-num` : 'md-table-num';
    return cloneElement(el, { className } as Record<string, unknown>);
  });

  return cloneElement(row, undefined, cells);
}

function renderRow(
  entry: ParsedRow,
  key: string,
  cols: Set<number>,
  streaming: boolean,
): React.ReactElement {
  const marked = markNumericRow(entry.row, cols);
  const prev = propsOf(marked).className;
  const className = [
    typeof prev === 'string' ? prev : '',
    streaming ? 'md-table-row-enter' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return cloneElement(marked, {
    key,
    className: className || undefined,
    'data-md-row': key.startsWith('h') ? 'head' : key.startsWith('f') ? 'foot' : 'body',
    'data-md-cell-count': entry.cells.length,
  } as Record<string, unknown>);
}

function TableSurface({
  header,
  rows,
  foot,
  cols,
  streaming,
  colWidths,
  containerRef,
  containerClassName,
  tableClassName,
  caption,
}: {
  header: ParsedRow;
  rows: ParsedRow[];
  foot: ParsedRow[];
  cols: Set<number>;
  streaming: boolean;
  colWidths: number[] | null;
  containerRef?: React.RefObject<HTMLDivElement | null>;
  containerClassName: string;
  tableClassName?: string;
  caption: string;
}) {
  const fixed = streaming && colWidths !== null && colWidths.length === header.cells.length;
  const fixedTotal = fixed ? colWidths.reduce((sum, width) => sum + width, 0) : 0;

  return (
    <div ref={containerRef} className={containerClassName}>
      <table
        className={tableClassName}
        style={
          fixed
            ? {
                tableLayout: 'fixed',
                // 各列 px 宽度之和就是表格的宽度下限；容器更窄时横向滚动
                minWidth: `${fixedTotal}px`,
              }
            : undefined
        }
      >
        <caption className="md-table-caption">{caption}</caption>
        {fixed ? (
          <colgroup>
            {colWidths.map((width, i) => (
              <col key={i} style={{ width: `${width}px` }} />
            ))}
          </colgroup>
        ) : null}
        <thead>{renderRow(header, 'h', cols, streaming)}</thead>
        <tbody>
          {rows.map((row, i) => renderRow(row, `b${i}`, cols, streaming))}
        </tbody>
        {foot.length > 0 ? (
          <tfoot>
            {foot.map((row, i) => renderRow(row, `f${i}`, cols, false))}
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}

function CopyButton({
  label,
  ariaLabel,
  text,
}: {
  label: string;
  ariaLabel: string;
  text: string;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const onPress = async () => {
    const ok = await copyText(text);
    setState(ok ? 'copied' : 'failed');
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 1600);
  };

  return (
    <Button
      size="sm"
      variant="tertiary"
      className="md-table-copy"
      aria-label={ariaLabel}
      onPress={onPress}
    >
      <Sym name={state === 'failed' ? 'error' : state === 'copied' ? 'check' : 'content_copy'} />
      {state === 'failed' ? '复制失败' : state === 'copied' ? '已复制' : label}
    </Button>
  );
}

type SheetSnap = 'half' | 'full';

/**
 * 手机端完整表格 Sheet。
 *
 * HeroUI Drawer 负责遮罩 / 焦点陷阱 / Esc / 下拉关闭；这里额外做两件事：
 *   1. 两档 snap（半屏 → 接近全屏），拖拽手柄或点标题栏按钮切换；
 *   2. 完整表放进独立的横向滚动容器，竖向滚动交给 Drawer.Body。
 *
 * `onPointerDown` 必须 `stopPropagation`：HeroUI 的 Dialog 自己也挂了拖拽关闭，
 * 不拦住的话一次上拉会同时被解释成「关掉」。
 */
function TableSheet({
  open,
  onOpenChange,
  header,
  rows,
  foot,
  cols,
  copyMarkdown,
  copyCsv,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  header: ParsedRow;
  rows: ParsedRow[];
  foot: ParsedRow[];
  cols: Set<number>;
  copyMarkdown: string;
  copyCsv: string;
}) {
  const [snap, setSnap] = useState<SheetSnap>('half');
  const drag = useRef<{ y: number; moved: boolean } | null>(null);
  const moved = useRef(false);

  useEffect(() => {
    if (open) {
      setSnap('half');
      return;
    }
    // 等退出动画走完再复位：下次打开从半屏开始，且不会在关闭过程中改高度
    const timer = window.setTimeout(() => setSnap('half'), 300);
    return () => window.clearTimeout(timer);
  }, [open]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    drag.current = { y: e.clientY, moved: false };
    moved.current = false;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // 指针已经抬起（极快的点按）时浏览器会拒绝捕获；不影响后续 click 切档
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state) return;
    e.stopPropagation();

    const dy = e.clientY - state.y;
    // 32px 才是「用户真的在拖」。8px 级的手抖仍然算点击，交给 onClick 切档。
    if (Math.abs(dy) < 32) return;
    state.moved = true;
    moved.current = true;

    if (dy < 0 && snap === 'half') {
      setSnap('full');
      state.y = e.clientY;
    } else if (dy > 0) {
      if (snap === 'full') {
        setSnap('half');
        state.y = e.clientY;
      } else if (dy > 120) {
        onOpenChange(false);
      }
    }
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    drag.current = null;
  };

  const onHandleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (moved.current) {
      moved.current = false;
      return;
    }
    setSnap((value) => (value === 'half' ? 'full' : 'half'));
  };

  return (
    <Drawer.Root isOpen={open} onOpenChange={onOpenChange}>
      <Drawer.Backdrop variant="opaque" className="md-table-sheet__backdrop">
        <Drawer.Content placement="bottom" className="md-table-sheet__content">
          <Drawer.Dialog
            className="md-table-sheet__dialog"
            data-snap={snap}
            data-testid="md-table-sheet"
            aria-label={`表格：${rows.length} 行，${header.cells.length} 列`}
          >
            <Drawer.Handle
              className="md-table-sheet__handle"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onClick={onHandleClick}
            />
            <Drawer.Header className="md-table-sheet__header">
              <div className="md-table-sheet__heading">
                <Drawer.Heading className="md-table-sheet__title">表格</Drawer.Heading>
                <span className="md-table-sheet__meta">
                  {rows.length} 行 × {header.cells.length} 列
                </span>
              </div>
              <Button
                size="sm"
                variant="tertiary"
                className="md-table-sheet__snap"
                aria-label={snap === 'full' ? '收起表格' : '展开表格'}
                onPress={() => setSnap((value) => (value === 'half' ? 'full' : 'half'))}
              >
                <Sym name={snap === 'full' ? 'keyboard_arrow_down' : 'unfold_more'} />
                {snap === 'full' ? '收起' : '展开'}
              </Button>
              <Drawer.CloseTrigger aria-label="关闭表格">
                <Sym name="close" />
              </Drawer.CloseTrigger>
            </Drawer.Header>
            <Drawer.Body className="md-table-sheet__body">
              <div className="x-markdown md-table-sheet__md">
                <TableSurface
                  header={header}
                  rows={rows}
                  foot={foot}
                  cols={cols}
                  streaming={false}
                  colWidths={null}
                  containerClassName="md-table-scroll md-table-scroll--sheet"
                  caption={`表格，共 ${rows.length} 行，${header.cells.length} 列`}
                />
              </div>
            </Drawer.Body>
            <Drawer.Footer className="md-table-sheet__footer">
              <CopyButton
                label="Markdown"
                ariaLabel="复制为 Markdown"
                text={copyMarkdown}
              />
              <CopyButton label="CSV" ariaLabel="复制为 CSV" text={copyCsv} />
            </Drawer.Footer>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </Drawer.Root>
  );
}

export function MarkdownTable({
  children,
  streaming,
}: ComponentProps & { streaming?: boolean }) {
  const inheritedStreaming = useMarkdownStreaming();
  const isStreaming = streaming ?? inheritedStreaming;
  const isMobile = useIsMobile();

  const parsed = parseTable(children as React.ReactNode);
  const completeBody = parsed.valid
    ? parsed.body.filter(
        (row) =>
          row.cells.length === parsed.columns &&
          (!isStreaming || row.cells.some((cell) => textOf(cell).trim() !== '')),
      )
    : [];

  const headerTexts = parsed.header?.cells.map((cell) => textOf(cell)) ?? [];
  const aligns: TableAlign[] = (parsed.header?.cells ?? []).map((cell) => {
    const align = propsOf(cell).align;
    return align === 'left' || align === 'center' || align === 'right' ? align : null;
  });

  const markdownHeaders = parsed.header?.cells.map(markdownOf) ?? [];
  const markdownRows = completeBody.map((row) => row.cells.map(markdownOf));
  const plainRows = completeBody.map((row) => row.cells.map(textOf));
  const copyMarkdown = tableToMarkdown(markdownHeaders, markdownRows, aligns);
  const copyCsv = tableToCsv(headerTexts, plainRows);

  const cols = numericColumns(parsed.header, completeBody);

  /**
   * 流式列宽：只在表格第一次出现时算一次。用 ref 而不是 useMemo，是为了让它
   * **不随 children 变化重算** —— 新行到来时列宽保持不动，直到流结束。
   */
  const frozenWidths = useRef<{ signature: string; widths: number[] } | null>(null);
  const widthSignature = `${parsed.columns}:${headerTexts.join('\u0000')}`;
  if (isStreaming && parsed.header) {
    if (!frozenWidths.current || frozenWidths.current.signature !== widthSignature) {
      frozenWidths.current = {
        signature: widthSignature,
        widths: columnWidthsPx(markdownHeaders, markdownRows.slice(0, 3)),
      };
    }
  } else if (!isStreaming) {
    frozenWidths.current = null;
  }
  const colWidths = isStreaming ? frozenWidths.current?.widths ?? null : null;

  const [expanded, setExpanded] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const previewId = useId();

  // 换了一张表（表头变了）或开始新一轮生成时，先收回折叠态
  useEffect(() => {
    setExpanded(false);
    setSheetOpen(false);
  }, [widthSignature]);

  useEffect(() => {
    if (isStreaming) setExpanded(false);
  }, [isStreaming]);

  // 从桌面拖窄到手机时，桌面那份「已展开」不该带进手机版式：
  // 手机只有预览 + Sheet，没有内联展开态。反过来，离开手机时 Sheet 必须关掉，
  // 否则再拖回来会带着旧的 `sheetOpen` 自动弹出。
  useEffect(() => {
    if (isMobile) setExpanded(false);
    else setSheetOpen(false);
  }, [isMobile]);

  /**
   * 横溢检测。只观察外层滚动容器不够：`table-layout: auto` 下表格变宽时
   * 容器本身尺寸不变，所以连 `<table>` 一起观察。流式期间不做（没有交互入口）。
   */
  useEffect(() => {
    if (!parsed.valid || isStreaming) {
      setOverflowing(false);
      return;
    }
    const el = scrollRef.current;
    if (!el) return;

    let raf = 0;
    const check = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (el.isConnected) setOverflowing(el.scrollWidth - el.clientWidth > 1);
      });
    };

    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    const table = el.querySelector('table');
    if (table) ro.observe(table);
    window.addEventListener('resize', check);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('resize', check);
    };
  }, [parsed.valid, parsed.columns, completeBody.length, isStreaming, expanded]);

  if (!parsed.valid || !parsed.header) {
    return (
      <div className="md-table" data-testid="md-table">
        <div className="md-table-scroll">
          <table>{children as React.ReactNode}</table>
        </div>
      </div>
    );
  }

  const rowCount = completeBody.length;
  /**
   * 需要「纵向折叠」的条件：行数多，且不是单列表。
   * 单列表更像一列清单，折起来只剩 6 行反而更难读 —— 需求里也明确说不给它展开入口。
   * 横溢只影响是否给工具行，不触发遮罩 / 收起。
   */
  const needsCollapse = parsed.columns > 1 && rowCount > PREVIEW_ROWS;
  const isLong = needsCollapse || overflowing;
  /** 单列表不折叠：无论流式还是结束，都把已完整的行全部露出来 */
  const canPreview = parsed.columns > 1;
  const visibleRows =
    (isStreaming || !expanded) && canPreview
      ? completeBody.slice(0, PREVIEW_ROWS)
      : completeBody;
  const showProgress = isStreaming && canPreview && rowCount > PREVIEW_ROWS;
  const showControls = !isStreaming && rowCount > 0 && isLong;
  /**
   * 桌面端只有「行数多」才需要展开按钮；纯横溢的表已经能横滚，展开没有意义。
   * 手机端保留 Sheet 入口（完整表 + 复制），但单列表也不给。
   */
  const showExpand = showControls && parsed.columns > 1 && (needsCollapse || isMobile);
  /** 手机端如果既没有 Sheet 入口、复制也收在 Sheet 里，这一行只剩一个空 meta，干脆不画 */
  const showTools = showControls && (!isMobile || showExpand);
  const faded = !isStreaming && needsCollapse && !expanded;

  const toggleExpanded = () => {
    if (isMobile) setSheetOpen(true);
    else setExpanded((value) => !value);
  };

  const expandLabel = isMobile
    ? '查看完整表格'
    : expanded
      ? '收起'
      : `展开全部 · ${rowCount} 行`;

  const scrollClass = [
    'md-table-scroll',
    expanded && !isStreaming ? 'md-table-scroll--expanded' : '',
    faded ? 'md-table-scroll--faded' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className="md-table"
      data-testid="md-table"
      data-streaming={isStreaming ? 'true' : undefined}
      aria-busy={isStreaming || undefined}
    >
      <div className="md-table-preview" id={previewId}>
        <TableSurface
          header={parsed.header}
          rows={visibleRows}
          foot={parsed.foot}
          cols={cols}
          streaming={isStreaming}
          colWidths={colWidths}
          containerRef={scrollRef}
          containerClassName={scrollClass}
          tableClassName={isStreaming ? 'md-table--streaming' : undefined}
          caption={`表格，共 ${rowCount} 行，${parsed.columns} 列`}
        />
      </div>

      {showProgress ? (
        <div className="md-table-progress" role="status">
          正在生成更多行…
        </div>
      ) : null}

      {showTools ? (
        <div className="md-table-tools">
          <span className="md-table-tools__meta">
            {rowCount} 行 × {parsed.columns} 列
          </span>
          <span className="md-table-tools__spacer" />
          {!isMobile ? (
            <>
              <CopyButton
                label="Markdown"
                ariaLabel="复制为 Markdown"
                text={copyMarkdown}
              />
              <CopyButton label="CSV" ariaLabel="复制为 CSV" text={copyCsv} />
            </>
          ) : null}
          {showExpand ? (
            <Button
              size="sm"
              variant="tertiary"
              className={isMobile ? 'md-table-expand md-table-expand--sheet' : 'md-table-expand'}
              aria-label={expandLabel}
              aria-expanded={isMobile ? undefined : expanded}
              aria-controls={isMobile ? undefined : previewId}
              aria-haspopup={isMobile ? 'dialog' : undefined}
              onPress={toggleExpanded}
            >
              <Sym name={isMobile ? 'open_in_full' : 'keyboard_arrow_down'} />
              {expandLabel}
            </Button>
          ) : null}
        </div>
      ) : null}

      {isMobile && isLong && parsed.columns > 1 ? (
        <TableSheet
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          header={parsed.header}
          rows={completeBody}
          foot={parsed.foot}
          cols={cols}
          copyMarkdown={copyMarkdown}
          copyCsv={copyCsv}
        />
      ) : null}
    </div>
  );
}
