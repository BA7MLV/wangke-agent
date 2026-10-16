/**
 * ```diagram 围栏的流式增量解析：**半截 JSON → 已经能落画的 shapes**。
 *
 * 与 svgRender.ts 的 `peekSvgProgress` 是同一思想、不同媒介：那边从半截 SVG 源码里
 * 切「已经写完整的顶层元素」，这边从半截 JSON 里切「已经写完整的字段与数组项」。
 * 两条路共同的服务对象是同一个画布契约（DiagramCanvas）：
 *
 * - **只认完整值**。`"label": "客户端` 这种半截字符串宁可晚几个字符，也不先画出去
 *   —— 画错了收不回来，只能等围栏闭合整体重来，而整体重来正是要避免的那次闪烁。
 * - **key 稳定、集合单调**。每个逻辑图元的 key 由数组下标 / 节点 id 决定，
 *   已上屏的 key 只会更新内容、不会消失（追加字符不会让一个完整值变回不完整）。
 * - **宽容渲染**。单项坏数据跳过（`tolerant` 模式），编译一半的 `sin(` 让整张图
 *   等一拍而不是画错。闭合后的终态不走这条路：那边的完整校验 + 完整渲染才是权威。
 *
 * 词法上是「括号配平 + 字符串感知」的浅扫描，不做完整 JSON.parse ——
 * 半截内容 parse 不了，而我们要的恰恰是「在 parse 不了的时候已经能画多少」。
 */
import { renderDiagram } from './diagramRender.ts';
import {
  pickValidCircle,
  pickValidCurve,
  pickValidEdge,
  pickValidLabel,
  pickValidNode,
  pickValidPoint,
  pickValidPolygon,
  pickValidSegment,
  type Curve,
  type DiagramDoc,
  type DiagramShape,
  type GraphDoc,
  type GraphEdge,
  type GraphNode,
  type PlotDoc,
  type Point2,
} from './diagramSchema.ts';

/** 半截内容的一份落画快照：画布尺寸 + 已完整的逻辑图元 */
export interface DiagramProgress {
  viewBox: string;
  shapes: DiagramShape[];
}

/** 「数组当标量用」的顶层字段：范围是二元组，不是列表（见 scanTop 的注释） */
const SCALAR_ARRAY_KEYS = new Set(['x', 'y']);

// ───────────────────────────────────────────────────────────────────────────────
// 浅扫描：括号配平 + 字符串感知
// ───────────────────────────────────────────────────────────────────────────────

interface ScanResult {
  /** 已完整的 type 字段（"graph" / "plot" / 其他） */
  type: string | null;
  /** 已完整的标量字段（direction / axes / x / y…） */
  scalars: Record<string, unknown>;
  /** 各数组字段里**已完整**的元素（未闭合的数组也收） */
  arrays: Record<string, unknown[]>;
}

function skipWs(src: string, i: number): number {
  while (i < src.length && (src[i] === ' ' || src[i] === '\t' || src[i] === '\n' || src[i] === '\r')) i++;
  return i;
}

/** 扫一个字符串：返回闭引号后的下标；没写完 → -1 */
function scanString(src: string, i: number): number {
  i++; // 跳过开引号
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '"') return i + 1;
    i++;
  }
  return -1;
}

/** 扫一个 {}/[] 容器：返回闭括号后的下标；没闭合 → -1 */
function scanContainer(src: string, i: number): number {
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"') {
      const e = scanString(src, i);
      if (e < 0) return -1;
      i = e;
      continue;
    }
    if (c === '{' || c === '[') {
      depth++;
      i++;
      continue;
    }
    if (c === '}' || c === ']') {
      depth--;
      i++;
      if (depth === 0) return i;
      continue;
    }
    i++;
  }
  return -1;
}

/** 扫一个值：返回结束下标（不含）；半截 → -1 */
function scanValue(src: string, i: number): number {
  i = skipWs(src, i);
  if (i >= src.length) return -1;
  const c = src[i];
  if (c === '"') return scanString(src, i);
  if (c === '{' || c === '[') return scanContainer(src, i);
  // 字面量（数字 / true / false / null）：遇到分隔符才算完。
  // 停在输入末尾的字面量一律算没写完 —— "-1" 下一个字符可能是 "2"。
  let j = i;
  while (j < src.length && !/[\s,}\]]/.test(src[j])) j++;
  return j >= src.length ? -1 : j;
}

/** 收一个（可能未闭合的）数组里已完整的元素 */
function scanArrayItems(src: string, from: number): unknown[] {
  const items: unknown[] = [];
  let j = from + 1; // 跳过 '['
  for (;;) {
    j = skipWs(src, j);
    if (j >= src.length) break;
    if (src[j] === ']') break;
    if (src[j] === ',') {
      j++;
      continue;
    }
    const end = scanValue(src, j);
    if (end < 0) break; // 这个元素还没写完
    try {
      items.push(JSON.parse(src.slice(j, end)));
    } catch {
      // 单个元素 parse 失败（畸形内容）：跳过它，不影响其他元素
    }
    j = end;
  }
  return items;
}

/** 扫顶层对象：收已完整的字段；对象没闭合也返回已收到的那部分 */
function scanTop(src: string): ScanResult | null {
  const start = src.indexOf('{');
  if (start < 0) return null;
  const out: ScanResult = { type: null, scalars: {}, arrays: {} };
  let i = start + 1;
  for (;;) {
    i = skipWs(src, i);
    if (i >= src.length) return out;
    const c = src[i];
    if (c === '}') return out; // 整体闭合
    if (c === ',') {
      i++;
      continue;
    }
    if (c !== '"') return out; // 畸形：停在这，等终态去报错
    const keyEnd = scanString(src, i);
    if (keyEnd < 0) return out; // key 没写完
    let key: string;
    try {
      key = JSON.parse(src.slice(i, keyEnd)) as string;
    } catch {
      return out;
    }
    i = skipWs(src, keyEnd);
    if (i >= src.length || src[i] !== ':') return out; // 冒号没到
    i = skipWs(src, i + 1);
    if (i >= src.length) return out;

    if (src[i] === '[') {
      const arrEnd = scanContainer(src, i);
      if (arrEnd < 0) {
        out.arrays[key] = scanArrayItems(src, i);
        return out; // 数组没闭合：已收元素就是当前全部
      }
      // 完整数组：列表字段（nodes/curves/…）按元素拆开收；
      // 「数组当标量用」的字段（x / y 范围）整体收一份 —— 它们不是列表，
      // 拆成元素就丢了「这是同一个二元组」的信息。
      if (SCALAR_ARRAY_KEYS.has(key)) {
        try {
          out.scalars[key] = JSON.parse(src.slice(i, arrEnd));
        } catch {
          // 解析失败：当没收到，等终态报错
        }
      }
      out.arrays[key] = scanArrayItems(src.slice(0, arrEnd), i);
      i = arrEnd;
      continue;
    }
    const valEnd = scanValue(src, i);
    if (valEnd < 0) return out; // 值没写完
    try {
      const v = JSON.parse(src.slice(i, valEnd));
      if (key === 'type' && typeof v === 'string') out.type = v;
      else out.scalars[key] = v;
    } catch {
      // 单项 parse 失败：跳过
    }
    i = valEnd;
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// 半截数据 → 部分 doc → 宽容渲染
// ───────────────────────────────────────────────────────────────────────────────

function pair(v: unknown): Point2 | undefined {
  if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number' && Number.isFinite(v[0]) && Number.isFinite(v[1])) {
    return [v[0], v[1]];
  }
  return undefined;
}

/**
 * 从**未闭合**的围栏内容里切出「已经可以落画」的部分。
 *
 * @returns 还没有 type / 没有任何可画图元 / 渲染抛错 → `null`（调用方退回等待态）。
 *          **不抛错**：这只是一层预览，权威判定在闭合后的完整校验 + 完整渲染。
 */
export function peekDiagramProgress(raw: string): DiagramProgress | null {
  const scan = scanTop(raw);
  if (!scan || !scan.type) return null;
  if (scan.type !== 'graph' && scan.type !== 'plot') return null; // 等终态报「type 不合法」

  let doc: DiagramDoc;
  if (scan.type === 'graph') {
    const seen = new Set<string>();
    const nodes: GraphNode[] = [];
    for (const item of scan.arrays.nodes ?? []) {
      const n = pickValidNode(item);
      // 同 id 只收第一个：半截数据里出现重复 id 时，画布按 key 合并会互相顶掉
      if (n && !seen.has(n.id)) {
        seen.add(n.id);
        nodes.push(n);
      }
    }
    if (nodes.length === 0) return null;
    const edges: GraphEdge[] = (scan.arrays.edges ?? [])
      .map(pickValidEdge)
      .filter((e): e is GraphEdge => e !== null && seen.has(e.from) && seen.has(e.to));
    doc = {
      type: 'graph',
      direction: scan.scalars.direction === 'LR' ? 'LR' : 'TB',
      nodes,
      edges,
    };
  } else {
    const plot: PlotDoc = { type: 'plot' };
    const x = pair(scan.scalars.x);
    if (x && x[0] < x[1]) plot.x = x;
    const y = pair(scan.scalars.y);
    if (y && y[0] < y[1]) plot.y = y;
    if (typeof scan.scalars.axes === 'boolean') plot.axes = scan.scalars.axes;
    const curves = (scan.arrays.curves ?? []).map(pickValidCurve).filter((c): c is Curve => c !== null);
    if (curves.length > 0) plot.curves = curves;
    const points = (scan.arrays.points ?? []).map(pickValidPoint).filter((p) => p !== null);
    if (points.length > 0) plot.points = points;
    const segments = (scan.arrays.segments ?? []).map(pickValidSegment).filter((s) => s !== null);
    if (segments.length > 0) plot.segments = segments;
    const polygons = (scan.arrays.polygons ?? []).map(pickValidPolygon).filter((p) => p !== null);
    if (polygons.length > 0) plot.polygons = polygons;
    const circles = (scan.arrays.circles ?? []).map(pickValidCircle).filter((c) => c !== null);
    if (circles.length > 0) plot.circles = circles;
    const labels = (scan.arrays.labels ?? []).map(pickValidLabel).filter((l) => l !== null);
    if (labels.length > 0) plot.labels = labels;
    doc = plot;
  }

  try {
    const out = renderDiagram(doc, { tolerant: true });
    // 一个图元都没有（比如只有 {"type":"plot"} 且 axes:false）→ 还没到落画的时候
    if (out.shapes.length === 0) return null;
    return { viewBox: out.viewBox, shapes: out.shapes };
  } catch {
    // 宽容模式下渲染仍可能抛（半截 domain 等）：这一拍不画，下一拍数据齐了自然恢复
    return null;
  }
}
