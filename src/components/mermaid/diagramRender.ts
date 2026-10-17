/**
 * ```diagram 围栏的确定性渲染器：**结构（JSON）→ 几何（SVG）**。
 *
 * 这是「AI 定义结构 + 确定性工具渲染」里「确定性工具」的那一半。模型只描述
 * 节点、连线、函数与范围；坐标、布局、连线路由、刻度、文字位置全部在这里算：
 *
 * - graph：Dagre 分层、环处理、连线路由与标签占位。流式期间布局随完整结构更新，
 *   图元 key 保持稳定；同一份完整数据的布局确定。
 * - chart：柱/折/饼数据映射为图元，不接受模型提供的像素坐标或脚本。
 * - plot：nice ticks 刻度、表达式采样（渐近线自动断条）、几何图元、图例。
 *   函数图像不再由模型手算坐标 —— 这是「模型直出 SVG」最常漂移的地方。
 *
 * ## 确定性是硬契约
 *
 * 同一份 JSON 必须渲染出**逐字节相同**的 SVG：图要能进 Git diff、要能反复渲染
 * 结果稳定、流式预览的最后一拍必须与闭合后的终态一致。所以：
 * - 不读时钟、不读随机数、不用 Map/Set 的迭代顺序承载语义（数组下标才是顺序）；
 * - 数字格式化走同一个 `fmt`（两位小数、去尾零、-0 归一）。
 *
 * ## 输出形态
 *
 * `shapes` 是一组带稳定 key 的 SVG 片段（一个逻辑图元一段），供流式画布按 key 做
 * 「只追加、不重播」的增量上屏；`svg` 是拼好的完整字符串，供闭合后的终态、
 * 大图弹层与下载使用。两者的内容同源。
 *
 * 所有文本都经过 `esc` 转义 —— 模型写的 label 是第三方文本，不能原样进 DOM。
 */
import { graphlib, layout } from '@dagrejs/dagre';
import { compileExpression } from './expr.ts';
import type {
  CircleGeom,
  ChartDoc,
  Curve,
  DiagramDoc,
  DiagramShape,
  GraphDoc,
  GraphNode,
  PlotDoc,
  Point2,
  Polygon,
  Segment,
  TextLabel,
} from './diagramSchema.ts';

export interface RenderedDiagram {
  /** 画布尺寸（viewBox 的后两个数） */
  width: number;
  height: number;
  viewBox: string;
  /** 逻辑图元序列（顺序即绘制顺序 = 笔顺） */
  shapes: DiagramShape[];
  /** 完整 SVG 字符串（闭合后的终态 / 大图 / 下载用） */
  svg: string;
}

export interface RenderOptions {
  /**
   * 宽容模式（流式预览用）：编译不过的曲线项**跳过**而不是抛错。
   * 半截 fn（`sin(` 写到一半）不该把整张图的预览堵死；闭合后终态渲染不走这条，
   * 坏 fn 由终态路径整体抛错，用户与模型都能得到明确反馈。
   */
  tolerant?: boolean;
}

// ───────────────────────────────────────────────────────────────────────────────
// 视觉常量（与 mermaid 主题变量对齐：primary #1677ff / 浅底 #e6f4ff / 描边 #91caff）
// ───────────────────────────────────────────────────────────────────────────────

const C = {
  nodeFill: '#e6f4ff',
  nodeStroke: '#91caff',
  text: '#1f2329',
  edge: '#8c8c8c',
  grid: '#f0f0f0',
  axis: '#8c8c8c',
  tick: '#8c8c8c',
  point: '#f5222d',
  geom: '#1677ff',
  geomFill: 'rgba(22,119,255,0.08)',
  halo: '#ffffff',
} as const;

/** 曲线默认色（按出现顺序取，模型不给 color 时用） */
const CURVE_COLORS = ['#1677ff', '#f5222d', '#52c41a', '#722ed1'] as const;

/** 箭头 marker 的 id。所有图共用同一个定义是安全的：内容完全相同，跨图引用无害 */
const ARROW_ID = 'xmd-ar';

const FONT = 13;
const SMALL = 10;

// ───────────────────────────────────────────────────────────────────────────────
// 基础工具
// ───────────────────────────────────────────────────────────────────────────────

/** XML 文本转义：模型写的 label / fn 旁注都是第三方文本，进 DOM 前必须转义 */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 数字格式化：两位小数、去尾零、-0 归一。确定性契约的一部分 */
function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const r = Math.round(n * 100) / 100;
  if (Object.is(r, -0) || r === 0) return '0';
  return String(r);
}

/** 估算文本像素宽：CJK/全角按一个字 13px，ASCII 按 7.4px（13px 字号下的均值） */
function textWidth(s: string, fontSize = FONT): number {
  let w = 0;
  for (const ch of s) {
    w += /[\u1100-\u11ff\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/.test(ch) ? fontSize : fontSize * 0.57;
  }
  return Math.round(w * 10) / 10;
}

/** 文字光圈：压在网格线 / 连线上也能读（paint-order 让描边画在填充下面） */
function haloAttrs(): string {
  return ` paint-order="stroke" stroke="${C.halo}" stroke-width="3" stroke-linejoin="round"`;
}

/** 一段带光圈的标签 */
function labelText(x: number, y: number, s: string, anchor: string, size = SMALL, fill: string = C.text): string {
  return `<text x="${fmt(x)}" y="${fmt(y)}" font-size="${size}" text-anchor="${anchor}" fill="${fill}"${haloAttrs()}>${esc(s)}</text>`;
}

/** 包围盒：只向右 / 下增长（流式期间已落位的节点不因新节点向左上扩张而挪位） */
class Bounds {
  minX = Infinity;
  minY = Infinity;
  maxX = -Infinity;
  maxY = -Infinity;
  add(x: number, y: number): void {
    if (x < this.minX) this.minX = x;
    if (y < this.minY) this.minY = y;
    if (x > this.maxX) this.maxX = x;
    if (y > this.maxY) this.maxY = y;
  }
  /** 画布尺寸：内容外沿 + 四边距 */
  size(pad: number): { width: number; height: number } {
    if (!Number.isFinite(this.maxX)) return { width: 0, height: 0 };
    return { width: this.maxX - Math.min(this.minX, 0) + pad * 2, height: this.maxY - Math.min(this.minY, 0) + pad * 2 };
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// graph：分层布局
// ───────────────────────────────────────────────────────────────────────────────

interface NodeBox {
  id: string;
  label: string;
  shape: GraphNode['shape'];
  w: number;
  h: number;
  cx: number;
  cy: number;
}

const GAP_X = 56;
const GAP_Y = 34;
const PAD = 16;

function nodeSize(label: string, shape: GraphNode['shape']): { w: number; h: number } {
  const lines = label.split('\n');
  const lw = Math.max(...lines.map((l) => textWidth(l)));
  switch (shape) {
    case 'ellipse':
      return { w: Math.max(60, lw * 1.4 + 28), h: Math.max(38, lines.length * FONT * 1.8 + 16) };
    case 'diamond':
      return { w: Math.max(74, lw * 2 + 26), h: Math.max(46, lines.length * FONT * 2.5 + 16) };
    case 'round':
      return { w: Math.max(58, lw + 28), h: Math.max(34, lines.length * FONT * 1.25 + 16) };
    default:
      return { w: Math.max(56, lw + 22), h: Math.max(34, lines.length * FONT * 1.25 + 16) };
  }
}

function renderGraph(doc: GraphDoc): RenderedDiagram {
  const nodes = doc.nodes ?? [];
  const edges = (doc.edges ?? []).filter((e) => e.from !== e.to);

  if (nodes.length === 0) {
    return { width: 0, height: 0, viewBox: '0 0 0 0', shapes: [], svg: '' };
  }

  // Dagre owns ranking, cycle handling, parallel edge routing and label space.
  // Array order is the deterministic tie-breaker; no model-supplied pixels.
  const graph = new graphlib.Graph({ multigraph: true });
  graph.setGraph({ rankdir: doc.direction ?? 'TB', nodesep: GAP_Y, ranksep: GAP_X, marginx: PAD, marginy: PAD });
  const boxes: NodeBox[] = nodes.map((n) => {
    const { w, h } = nodeSize(n.label, n.shape);
    graph.setNode(n.id, { width: w, height: h });
    return { id: n.id, label: n.label, shape: n.shape, w, h, cx: 0, cy: 0 };
  });
  edges.forEach((edge, i) => {
    graph.setEdge(edge.from, edge.to, { width: edge.label ? textWidth(edge.label, SMALL) + 8 : 0, height: edge.label ? 20 : 0, labelpos: 'c' }, String(i));
  });
  layout(graph);
  for (const b of boxes) {
    const position = graph.node(b.id);
    b.cx = position.x;
    b.cy = position.y;
  }

  const bounds = new Bounds();
  const shapes: DiagramShape[] = [];
  const parts: string[] = [];

  // defs：箭头 marker（有边才需要）
  if (edges.length > 0) {
    const defs = `<defs><marker id="${ARROW_ID}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="${C.edge}"/></marker></defs>`;
    shapes.push({ key: 'defs', svg: defs });
    parts.push(defs);
  }

  // 节点（顺序即 nodes 数组顺序）
  for (const b of boxes) {
    const x = b.cx - b.w / 2;
    const y = b.cy - b.h / 2;
    bounds.add(x, y);
    bounds.add(x + b.w, y + b.h);
    let body: string;
    switch (b.shape) {
      case 'ellipse':
        body = `<ellipse cx="${fmt(b.cx)}" cy="${fmt(b.cy)}" rx="${fmt(b.w / 2)}" ry="${fmt(b.h / 2)}" fill="${C.nodeFill}" stroke="${C.nodeStroke}" stroke-width="1.5"/>`;
        break;
      case 'diamond': {
        const hw = b.w / 2;
        const hh = b.h / 2;
        body = `<path d="M${fmt(b.cx)} ${fmt(b.cy - hh)} L${fmt(b.cx + hw)} ${fmt(b.cy)} L${fmt(b.cx)} ${fmt(b.cy + hh)} L${fmt(b.cx - hw)} ${fmt(b.cy)} Z" fill="${C.nodeFill}" stroke="${C.nodeStroke}" stroke-width="1.5"/>`;
        break;
      }
      case 'round':
        body = `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(b.w)}" height="${fmt(b.h)}" rx="${fmt(b.h / 2)}" fill="${C.nodeFill}" stroke="${C.nodeStroke}" stroke-width="1.5"/>`;
        break;
      default:
        body = `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(b.w)}" height="${fmt(b.h)}" rx="6" fill="${C.nodeFill}" stroke="${C.nodeStroke}" stroke-width="1.5"/>`;
    }
    // 多行标签：\n 分行，行距 1.25em，整体垂直居中
    const lines = b.label.split('\n');
    const lineH = FONT * 1.25;
    const firstY = b.cy - ((lines.length - 1) * lineH) / 2 + FONT * 0.36;
    const text = lines
      .map((l, i) => `<tspan x="${fmt(b.cx)}" y="${fmt(firstY + i * lineH)}">${esc(l)}</tspan>`)
      .join('');
    const svg = `<g>${body}<text font-size="${FONT}" text-anchor="middle" fill="${C.text}">${text}</text></g>`;
    shapes.push({ key: `node:${b.id}`, svg });
    parts.push(svg);
  }

  // 连线（端点存在才画；顺序即 edges 数组顺序）
  edges.forEach((e, i) => {
    const route = graph.edge(e.from, e.to, String(i));
    const d = route.points.map((p: { x: number; y: number }, j: number) => {
      bounds.add(p.x, p.y);
      return `${j ? 'L' : 'M'}${fmt(p.x)} ${fmt(p.y)}`;
    }).join(' ');
    const mid: Point2 = [route.x ?? 0, route.y ?? 0];
    let svg = `<g><path d="${d}" fill="none" stroke="${C.edge}" stroke-width="1.5" marker-end="url(#${ARROW_ID})"/>`;
    if (e.label) {
      const lw = textWidth(e.label, 9.5);
      bounds.add(mid[0] - lw / 2 - 2, mid[1] - 16);
      bounds.add(mid[0] + lw / 2 + 2, mid[1] - 4);
      svg += labelText(mid[0], mid[1] - 5, e.label, 'middle', 9.5);
    }
    svg += '</g>';
    shapes.push({ key: `edge:${i}`, svg });
    parts.push(svg);
  });

  const { width, height } = bounds.size(PAD);
  return {
    width,
    height,
    viewBox: `0 0 ${fmt(width)} ${fmt(height)}`,
    shapes,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmt(width)} ${fmt(height)}">${parts.join('')}</svg>`,
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// plot：坐标系 + 曲线采样 + 几何图元
// ───────────────────────────────────────────────────────────────────────────────

const PLOT_W = 440;
const PLOT_H = 270;
const M = { left: 38, right: 16, top: 16, bottom: 28 };
const SAMPLES = 240;

/** nice step：1/2/5×10^k 里挑一个让刻度数最接近 target 的 */
function niceStep(span: number, target = 6): number {
  const raw = span / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) {
    if (raw <= m * mag) return m * mag;
  }
  return 10 * mag;
}

/** 刻度序列：从 ≥min 的第一个整数倍刻度开始 */
function ticks(min: number, max: number, step: number): number[] {
  const out: number[] = [];
  const first = Math.ceil(min / step) * step;
  for (let v = first; v <= max + step * 1e-6; v += step) {
    out.push(Math.abs(v) < step * 1e-6 ? 0 : v);
  }
  return out;
}

/** 百分位（线性插值）：抗渐近线把 y 范围撑爆 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/**
 * 采样一条曲线，产出 path 的 `d`。
 *
 * 渐近线处理：相邻两点纵向跳变超过**这条曲线自己的** y 跨度（p2~p98）就断开，
 * 下一段从 M 重新开始 —— 否则 1/x 会在 x=0 处画一根连接 ±∞ 的竖线。
 * 用「自己的跨度」而不是全局 y 范围：全局范围在采样时还没算出来（先采样才能
 * 定范围），而每条曲线对「多陡算断」的耐受度本就该由它自己的尺度决定。
 */
function sampleCurve(fn: (x: number) => number, x0: number, x1: number): Sampled {
  const xs: number[] = [];
  const ys: number[] = [];
  const step = (x1 - x0) / SAMPLES;
  for (let i = 0; i <= SAMPLES; i++) {
    const x = x0 + i * step;
    const y = fn(x);
    if (!Number.isFinite(y) || Math.abs(y) > 1e7) continue; // 定义域空洞：跳过，不断线
    xs.push(x);
    ys.push(y);
  }
  const sorted = [...ys].sort((a, b) => a - b);
  const span = sorted.length > 0 ? percentile(sorted, 0.98) - percentile(sorted, 0.02) : 0;
  let d = '';
  let pen = false;
  let prevY = NaN;
  for (let i = 0; i < xs.length; i++) {
    const jump = i > 0 && span > 0 && Math.abs(ys[i] - prevY) > span;
    if (!pen || jump) {
      d += `M${fmt(xs[i])} ${fmt(ys[i])}`;
      pen = true;
    } else {
      d += ` L${fmt(xs[i])} ${fmt(ys[i])}`;
    }
    prevY = ys[i];
  }
  return { path: d, ys };
}

interface Sampled {
  path: string;
  ys: number[];
}

function renderPlot(doc: PlotDoc, opts: RenderOptions): RenderedDiagram {
  const curves: Curve[] = doc.curves ?? [];
  const points = doc.points ?? [];
  const segments: Segment[] = doc.segments ?? [];
  const polygons: Polygon[] = doc.polygons ?? [];
  const circles: CircleGeom[] = doc.circles ?? [];
  const labels: TextLabel[] = doc.labels ?? [];

  // ── 1. x 范围：显式 > 几何外延 > 默认 ──
  let x0: number;
  let x1: number;
  if (doc.x) {
    [x0, x1] = doc.x;
  } else {
    const gx = [
      ...points.map((p) => p.at[0]),
      ...segments.flatMap((s) => [s.from[0], s.to[0]]),
      ...polygons.flatMap((p) => p.points.map((q) => q[0])),
      ...circles.map((c) => c.center[0]),
      ...labels.map((l) => l.at[0]),
    ];
    if (gx.length > 0) {
      const lo = Math.min(...gx);
      const hi = Math.max(...gx);
      const span = Math.max(hi - lo, 2);
      x0 = lo - span * 0.12;
      x1 = hi + span * 0.12;
    } else {
      [x0, x1] = [-10, 10];
    }
  }

  // ── 2. 采样（先采样才能算自动 y 范围）──
  const compiled = curves.map((c) => {
    try {
      return compileExpression(c.fn);
    } catch (e) {
      if (opts.tolerant) return null;
      throw e;
    }
  });
  const sampled = curves.map((c, i) => {
    const fn = compiled[i];
    if (!fn) return null;
    const [a, b] = c.domain ?? [x0, x1];
    return sampleCurve(fn, a, b);
  });

  // ── 3. y 范围：显式 > 曲线百分位 ∪ 几何外延 > 默认 ──
  let y0: number;
  let y1: number;
  if (doc.y) {
    [y0, y1] = doc.y;
  } else {
    const curveYs: number[] = [];
    for (const s of sampled) {
      if (s) curveYs.push(...s.ys);
    }
    curveYs.sort((a, b) => a - b);
    const gy = [
      ...points.map((p) => p.at[1]),
      ...segments.flatMap((s) => [s.from[1], s.to[1]]),
      ...polygons.flatMap((p) => p.points.map((q) => q[1])),
      ...circles.flatMap((c) => [c.center[1] - c.r, c.center[1] + c.r]),
      ...labels.map((l) => l.at[1]),
    ];
    let lo = curveYs.length > 0 ? percentile(curveYs, 0.02) : Infinity;
    let hi = curveYs.length > 0 ? percentile(curveYs, 0.98) : -Infinity;
    if (gy.length > 0) {
      lo = Math.min(lo, ...gy);
      hi = Math.max(hi, ...gy);
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      lo = -5;
      hi = 5;
    }
    const span = Math.max(hi - lo, 1);
    y0 = lo - span * 0.08;
    y1 = hi + span * 0.08;
  }

  // ── 4. 坐标变换 ──
  const px = (x: number) => M.left + ((x - x0) / (x1 - x0)) * PLOT_W;
  const py = (y: number) => M.top + ((y1 - y) / (y1 - y0)) * PLOT_H;
  const width = M.left + PLOT_W + M.right;
  const height = M.top + PLOT_H + M.bottom;

  const shapes: DiagramShape[] = [];
  const parts: string[] = [];
  const push = (key: string, svg: string) => {
    shapes.push({ key, svg });
    parts.push(svg);
  };

  // ── 5. 坐标系（网格 / 轴线 / 刻度 / O / 轴名）──
  if (doc.axes !== false) {
    const sx = niceStep(x1 - x0);
    const sy = niceStep(y1 - y0);
    const xt = ticks(x0, x1, sx);
    const yt = ticks(y0, y1, sy);
    // 轴线位置：0 在范围内就过原点，否则贴在边缘（数学惯例）
    const axisX = x0 <= 0 && 0 <= x1 ? px(0) : M.left;
    const axisY = y0 <= 0 && 0 <= y1 ? py(0) : M.top + PLOT_H;
    let g = '<g>';
    for (const t of xt) {
      const X = px(t);
      g += `<line x1="${fmt(X)}" y1="${fmt(M.top)}" x2="${fmt(X)}" y2="${fmt(M.top + PLOT_H)}" stroke="${C.grid}" stroke-width="1"/>`;
    }
    for (const t of yt) {
      const Y = py(t);
      g += `<line x1="${fmt(M.left)}" y1="${fmt(Y)}" x2="${fmt(M.left + PLOT_W)}" y2="${fmt(Y)}" stroke="${C.grid}" stroke-width="1"/>`;
    }
    // 轴
    g += `<line x1="${fmt(M.left)}" y1="${fmt(axisY)}" x2="${fmt(M.left + PLOT_W)}" y2="${fmt(axisY)}" stroke="${C.axis}" stroke-width="1.5"/>`;
    g += `<line x1="${fmt(axisX)}" y1="${fmt(M.top)}" x2="${fmt(axisX)}" y2="${fmt(M.top + PLOT_H)}" stroke="${C.axis}" stroke-width="1.5"/>`;
    // 刻度标签
    for (const t of xt) {
      if (t === 0) continue;
      g += labelText(px(t), Math.min(axisY + 13, M.top + PLOT_H + 13), fmt(t), 'middle', 9, C.tick);
    }
    for (const t of yt) {
      if (t === 0) continue;
      g += labelText(Math.max(axisX - 5, M.left - 5), py(t) + 3, fmt(t), 'end', 9, C.tick);
    }
    // 原点 O 与轴名
    if (x0 <= 0 && 0 <= x1 && y0 <= 0 && 0 <= y1) {
      g += labelText(axisX - 5, axisY + 11, 'O', 'end', 10, C.tick);
    }
    g += labelText(M.left + PLOT_W + 2, axisY - 5, 'x', 'end', 10, C.tick);
    g += labelText(axisX + 7, M.top + 9, 'y', 'start', 10, C.tick);
    g += '</g>';
    push('axes', g);
  }

  // ── 6. 曲线 ──
  curves.forEach((c, i) => {
    const s = sampled[i];
    if (!s || !s.path) return;
    const color = c.color ?? CURVE_COLORS[i % CURVE_COLORS.length];
    push('curve:' + i, `<g><path d="${s.path}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></g>`);
  });

  // ── 7. 图例（有曲线标签才画；放绘图区左上角）──
  const legendItems = curves.map((c, i) => ({ c, i })).filter(({ c }) => c.label);
  if (legendItems.length > 0) {
    const rowH = 15;
    const boxH = legendItems.length * rowH + 8;
    const boxW = Math.max(...legendItems.map(({ c }) => textWidth(c.label ?? '', SMALL))) + 34;
    let g = `<g><rect x="${fmt(M.left + 6)}" y="${fmt(M.top + 6)}" width="${fmt(boxW)}" height="${fmt(boxH)}" rx="4" fill="#ffffff" fill-opacity="0.78"/>`;
    legendItems.forEach(({ c, i }, row) => {
      const y = M.top + 6 + 14 + row * rowH;
      const color = c.color ?? CURVE_COLORS[i % CURVE_COLORS.length];
      g += `<line x1="${fmt(M.left + 13)}" y1="${fmt(y - 3)}" x2="${fmt(M.left + 27)}" y2="${fmt(y - 3)}" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/>`;
      g += labelText(M.left + 32, y, c.label ?? '', 'start', SMALL);
    });
    g += '</g>';
    push('legend', g);
  }

  // ── 8. 几何图元与标注 ──
  points.forEach((p, j) => {
    const X = px(p.at[0]);
    const Y = py(p.at[1]);
    let svg = `<g><circle cx="${fmt(X)}" cy="${fmt(Y)}" r="3.2" fill="${C.point}" stroke="#ffffff" stroke-width="1"/>`;
    if (p.label) svg += labelText(X + 6, Y - 6, p.label, 'start');
    svg += '</g>';
    push('point:' + j, svg);
  });

  segments.forEach((s, k) => {
    const a = px(s.from[0]);
    const b = py(s.from[1]);
    const c2 = px(s.to[0]);
    const d2 = py(s.to[1]);
    const dash = s.dashed ? ' stroke-dasharray="5 4"' : '';
    let svg = `<g><line x1="${fmt(a)}" y1="${fmt(b)}" x2="${fmt(c2)}" y2="${fmt(d2)}" stroke="${C.geom}" stroke-width="1.5"${dash}/>`;
    if (s.label) svg += labelText((a + c2) / 2, (b + d2) / 2 - 6, s.label, 'middle');
    svg += '</g>';
    push('segment:' + k, svg);
  });

  polygons.forEach((p, m) => {
    const d = p.points.map((q, i) => `${i === 0 ? 'M' : 'L'}${fmt(px(q[0]))} ${fmt(py(q[1]))}`).join(' ') + ' Z';
    const cx = p.points.reduce((s, q) => s + px(q[0]), 0) / p.points.length;
    const cy = p.points.reduce((s, q) => s + py(q[1]), 0) / p.points.length;
    let svg = `<g><path d="${d}" fill="${C.geomFill}" stroke="${C.geom}" stroke-width="1.5"/>`;
    if (p.label) svg += labelText(cx, cy - 8, p.label, 'middle');
    svg += '</g>';
    push('poly:' + m, svg);
  });

  circles.forEach((c2, n) => {
    const X = px(c2.center[0]);
    const Y = py(c2.center[1]);
    // 半径要按两个轴的缩放比例分别换算（x/y 单位长度在像素上不同）
    const rx = (c2.r / (x1 - x0)) * PLOT_W;
    const ry = (c2.r / (y1 - y0)) * PLOT_H;
    let svg = `<g><ellipse cx="${fmt(X)}" cy="${fmt(Y)}" rx="${fmt(rx)}" ry="${fmt(ry)}" fill="none" stroke="${C.geom}" stroke-width="1.5"/>`;
    if (c2.label) svg += labelText(X, Y - ry - 5, c2.label, 'middle');
    svg += '</g>';
    push('circle:' + n, svg);
  });

  labels.forEach((l, p2) => {
    push('label:' + p2, `<g>${labelText(px(l.at[0]), py(l.at[1]), l.text, l.anchor ?? 'start')}</g>`);
  });

  return {
    width,
    height,
    viewBox: `0 0 ${fmt(width)} ${fmt(height)}`,
    shapes,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmt(width)} ${fmt(height)}">${parts.join('')}</svg>`,
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// 入口
// ───────────────────────────────────────────────────────────────────────────────

/**
 * 渲染一段（已校验或半截的）diagram JSON。
 *
 * 传入半截数据是流式预览的用法（`tolerant: true`）：数组缺省当空、字段缺省用默认值、
 * 编译不过的曲线项跳过。传入完整数据（闭合后 / show_widget 预检）时输出即终态，
 * 坏 fn 直接抛错 —— 那时用户与模型都该得到明确反馈，而不是一张 quietly 少画了曲线的图。
 */
export function renderDiagram(doc: DiagramDoc, opts: RenderOptions = {}): RenderedDiagram {
  return doc.type === 'graph' ? renderGraph(doc) : doc.type === 'chart' ? renderChart(doc) : renderPlot(doc, opts);
}

/** Data stays semantic. Fixed canvas, zero baseline and bounded labels are renderer policy. */
function renderChart(doc: ChartDoc): RenderedDiagram {
  const width = doc.kind === 'pie' ? 560 : Math.max(560, doc.data.length * 80 + 80);
  const height = 340;
  const shapes: DiagramShape[] = [];
  const add = (key: string, svg: string) => shapes.push({ key, svg: `<g>${svg}</g>` });
  if (doc.kind === 'pie') {
    // Normalize before summing to avoid overflow for large finite values.
    const max = Math.max(...doc.data.map(d => d.value), 1);
    const total = doc.data.reduce((s, d) => s + d.value / max, 0);
    let angle = -Math.PI / 2;
    doc.data.forEach((d, i) => {
      const ratio = total ? (d.value / max) / total : 0;
      const end = angle + ratio * Math.PI * 2;
      const color = CURVE_COLORS[i % CURVE_COLORS.length];
      const wedge = ratio === 1
        ? `<circle cx="150" cy="170" r="115" fill="${color}"/>`
        : ratio > 0 ? `<path d="M150 170 L${fmt(150 + 115 * Math.cos(angle))} ${fmt(170 + 115 * Math.sin(angle))} A115 115 0 ${ratio > 0.5 ? 1 : 0} 1 ${fmt(150 + 115 * Math.cos(end))} ${fmt(170 + 115 * Math.sin(end))} Z" fill="${color}" stroke="white"/>` : '';
      add(`datum:${i}`, `${wedge}<rect x="290" y="${24 + i * 25}" width="10" height="10" fill="${color}"/>${labelText(308, 34 + i * 25, `${d.label} · ${fmt(ratio * 100)}%`, 'start', 16)}`);
      angle = end;
    });
  } else {
    // Normalize arithmetic as well as geometry: finite input must never yield NaN paths.
    const scale = Math.max(1, ...doc.data.map(d => Math.abs(d.value)), ...(doc.y ?? []).map(Math.abs));
    const lo = doc.y ? doc.y[0] / scale : Math.min(0, ...doc.data.map(d => d.value / scale));
    const hi = doc.y ? doc.y[1] / scale : Math.max(0, ...doc.data.map(d => d.value / scale));
    const span = hi - lo || 1;
    const y = (v: number) => 270 - ((v / scale - lo) / span) * 230;
    const baseline = y(Math.max(lo * scale, Math.min(hi * scale, 0)));
    const step = (width - 80) / Math.max(doc.data.length, 1);
    add('axes', `<path d="M55 35 V270 H${width - 20} M55 ${fmt(baseline)} H${width - 20}" fill="none" stroke="${C.axis}"/>${labelText(50, 44, String(hi * scale), 'end', 16)}${labelText(50, 270, String(lo * scale), 'end', 16)}`);
    doc.data.forEach((d, i) => {
      const x = 55 + step * (i + 0.5);
      const cy = y(d.value);
      const previous = doc.data[i - 1];
      const mark = doc.kind === 'bar'
        ? `<rect x="${fmt(x - step * 0.3)}" y="${fmt(Math.min(cy, baseline))}" width="${fmt(step * 0.6)}" height="${fmt(Math.abs(baseline - cy))}" rx="2" fill="${C.geom}"/>`
        : `${previous ? `<path d="M${fmt(x - step)} ${fmt(y(previous.value))} L${fmt(x)} ${fmt(cy)}" fill="none" stroke="${C.geom}" stroke-width="2"/>` : ''}<circle cx="${fmt(x)}" cy="${fmt(cy)}" r="4" fill="${C.geom}"/>`;
      const chars = [...d.label];
      let label = '';
      for (let j = 0; j < chars.length; j += 4) label += labelText(x, 292 + j / 4 * 18, chars.slice(j, j + 4).join(''), 'middle', 16);
      add(`datum:${i}`, `${mark}${label}${labelText(x, cy - 8, String(d.value), 'middle', 16)}`);
    });
  }
  const viewBox = `0 0 ${width} ${height}`;
  return { width, height, viewBox, shapes, svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${shapes.map(s => s.svg).join('')}</svg>` };
}
