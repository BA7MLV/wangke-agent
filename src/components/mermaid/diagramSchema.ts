/**
 * ```diagram 围栏的 JSON schema：**AI 定义结构，渲染器负责几何**。
 *
 * 这条链路替代的是「模型直出 SVG」：模型不再手算坐标、手写路径，只描述
 * 「有什么节点、怎么连、函数是什么、范围是多少」，布局 / 连线路由 / 坐标采样
 * 全部由 diagramRender.ts 确定性算出来。于是：
 * - 同样一份 JSON 反复渲染结果完全一致（可 diff、可版本管理）；
 * - 模型只写 20~60 行 JSON，token 成本与出错面都远小于手写 SVG；
 * - 函数图像由解析器采样，不存在「模型猜坐标猜漂了」。
 *
 * ## 锁 schema，不纵容漂移
 *
 * 未知字段一律**拒绝并列出可用字段**，而不是静默忽略。两个原因：
 * 1. 模型把 `colour` / `nodes` 写成 `vertexs` 时，静默忽略会让它以为写对了，
 *    下次还这么写；明确拒绝 + 给出正确字段名，一次就教会。
 * 2. show_widget 预检会把这里的报错带回给模型，它改完再试 —— 拒绝得越具体，
 *    重试成本越低。
 *
 * ## 两层校验，同一份单项校验器
 *
 * - `validateDiagram`：**完整校验**（闭合后的终态与 show_widget 预检走这条），
 *   逐项报错带 `nodes[2].label` 这样的精确位置。
 * - `pickValid*`：**流式预览用的轻量单项校验**（内部就是 catch 住同一个
 *   `check*`），半截数据里坏一项跳过一项，不让一个错节点把整张图的预览堵死。
 *   两条路共用同一份判据，才不会出现「预览放过、终态拒绝」的割裂。
 */

// ───────────────────────────────────────────────────────────────────────────────
// 类型定义
// ───────────────────────────────────────────────────────────────────────────────

export type Point2 = [number, number];

export interface GraphNode {
  id: string;
  label: string;
  shape?: NodeShape;
}
export type NodeShape = 'box' | 'round' | 'ellipse' | 'diamond';
export interface GraphEdge {
  from: string;
  to: string;
  label?: string;
}

export interface GraphDoc {
  type: 'graph';
  direction?: 'TB' | 'LR';
  nodes: GraphNode[];
  edges?: GraphEdge[];
}

export interface Curve {
  fn: string;
  label?: string;
  color?: string;
  domain?: Point2;
}
export interface PlotPoint {
  at: Point2;
  label?: string;
}
export interface Segment {
  from: Point2;
  to: Point2;
  label?: string;
  dashed?: boolean;
}
export interface Polygon {
  points: Point2[];
  label?: string;
}
export interface CircleGeom {
  center: Point2;
  r: number;
  label?: string;
}
export interface TextLabel {
  at: Point2;
  text: string;
  anchor?: 'start' | 'middle' | 'end';
}

export interface PlotDoc {
  type: 'plot';
  x?: Point2;
  y?: Point2;
  axes?: boolean;
  curves?: Curve[];
  points?: PlotPoint[];
  segments?: Segment[];
  polygons?: Polygon[];
  circles?: CircleGeom[];
  labels?: TextLabel[];
}

export interface ChartDatum { label: string; value: number }
export interface ChartDoc {
  type: 'chart';
  kind: 'bar' | 'line' | 'pie';
  data: ChartDatum[];
  y?: Point2;
}
export type DiagramDoc = GraphDoc | PlotDoc | ChartDoc;

/** 渲染层的形状单位：一个逻辑图元 = 一段可独立净化的 SVG 片段 + 稳定 key */
export interface DiagramShape {
  key: string;
  svg: string;
}

// ───────────────────────────────────────────────────────────────────────────────
// 上限（与「讲解配图」技能的正文约束对齐；校验层是那道约束的硬闸门）
// ───────────────────────────────────────────────────────────────────────────────

export const LIMITS = {
  maxData: 12,
  maxNodes: 10,
  maxEdges: 16,
  maxNodeLabel: 20,
  maxEdgeLabel: 12,
  maxText: 40,
  maxCurves: 4,
  maxPoints: 12,
  maxSegments: 12,
  maxPolygons: 6,
  maxCircles: 6,
  maxLabels: 8,
} as const;

// ───────────────────────────────────────────────────────────────────────────────
// 校验工具
// ───────────────────────────────────────────────────────────────────────────────

export class DiagramSchemaError extends Error {}

function bad(msg: string): never {
  throw new DiagramSchemaError(msg);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 拒绝未知字段：列出可用字段，让模型一次改对 */
function rejectUnknown(where: string, obj: Record<string, unknown>, allowed: readonly string[]): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) {
      bad(`${where}有不认识的字段「${k}」。可用字段：${allowed.join(' / ')}（大小写敏感，不要自己发明字段名）`);
    }
  }
}

function reqStr(where: string, v: unknown, max: number): string {
  if (typeof v !== 'string' || !v.trim()) bad(`${where}必须是非空字符串`);
  const s = v.trim();
  if (s.length > max) bad(`${where}超过 ${max} 字（实得 ${s.length} 字）：图里放不下的长文改正文`);
  return s;
}

function optStr(where: string, v: unknown, max: number): string | undefined {
  if (v === undefined || v === null) return undefined;
  return reqStr(where, v, max);
}

function reqNum(where: string, v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) bad(`${where}必须是有限数字（实得 ${JSON.stringify(v)}）`);
  return v;
}

function optBool(where: string, v: unknown): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') bad(`${where}必须是 true / false`);
  return v;
}

/** [number, number] 二元组（坐标 / 范围） */
function reqPair(where: string, v: unknown): Point2 {
  if (!Array.isArray(v) || v.length !== 2) bad(`${where}必须是 [a, b] 两个数的数组（实得 ${JSON.stringify(v)}）`);
  return [reqNum(`${where}[0]`, v[0]), reqNum(`${where}[1]`, v[1])];
}

/** 颜色只接受 #rgb/#rrggbb 与一小套命名色 —— 渲染器不接 url(...) 之类的花活 */
const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const NAMED_COLORS = new Set([
  'black', 'white', 'red', 'green', 'blue', 'gray', 'grey', 'orange', 'purple', 'pink', 'brown', 'cyan', 'magenta', 'yellow',
]);
function optColor(where: string, v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || !(COLOR_RE.test(v) || NAMED_COLORS.has(v.toLowerCase()))) {
    bad(`${where}只能是 #1677ff 这样的十六进制颜色或少数命名色（实得 ${JSON.stringify(v)}）`);
  }
  return v;
}

const NODE_SHAPES: readonly NodeShape[] = ['box', 'round', 'ellipse', 'diamond'];
const ANCHORS: readonly ('start' | 'middle' | 'end')[] = ['start', 'middle', 'end'];

// ───────────────────────────────────────────────────────────────────────────────
// 单项校验器（完整校验与流式预览共用同一份判据）
// ───────────────────────────────────────────────────────────────────────────────

function checkNode(where: string, raw: unknown): GraphNode {
  if (!isPlainObject(raw)) bad(`${where}必须是对象 {"id": …, "label": …}`);
  rejectUnknown(where, raw, ['id', 'label', 'shape']);
  const id = reqStr(`${where}.id`, raw.id, 24);
  const label = reqStr(`${where}.label`, raw.label, LIMITS.maxNodeLabel);
  const node: GraphNode = { id, label };
  if (raw.shape !== undefined && raw.shape !== null) {
    if (!NODE_SHAPES.includes(raw.shape as NodeShape)) {
      bad(`${where}.shape 只能是 ${NODE_SHAPES.join(' / ')}（实得 ${JSON.stringify(raw.shape)}）`);
    }
    node.shape = raw.shape as NodeShape;
  }
  return node;
}

function checkEdge(where: string, raw: unknown): GraphEdge {
  if (!isPlainObject(raw)) bad(`${where}必须是对象 {"from": …, "to": …}`);
  rejectUnknown(where, raw, ['from', 'to', 'label']);
  const edge: GraphEdge = { from: reqStr(`${where}.from`, raw.from, 24), to: reqStr(`${where}.to`, raw.to, 24) };
  const label = optStr(`${where}.label`, raw.label, LIMITS.maxEdgeLabel);
  if (label !== undefined) edge.label = label;
  return edge;
}

function checkCurve(where: string, raw: unknown): Curve {
  if (!isPlainObject(raw)) bad(`${where}必须是对象 {"fn": "sin(x)", …}`);
  rejectUnknown(where, raw, ['fn', 'label', 'color', 'domain']);
  const fn = reqStr(`${where}.fn`, raw.fn, 200);
  let domain: Point2 | undefined;
  if (raw.domain !== undefined && raw.domain !== null) {
    domain = reqPair(`${where}.domain`, raw.domain);
    if (!(domain[0] < domain[1])) bad(`${where}.domain 必须 [起点, 终点] 且起点小于终点`);
  }
  return { fn, label: optStr(`${where}.label`, raw.label, LIMITS.maxText), color: optColor(`${where}.color`, raw.color), domain };
}

function checkPoint(where: string, raw: unknown): PlotPoint {
  if (!isPlainObject(raw)) bad(`${where}必须是对象 {"at": [x, y], "label": "A"}`);
  rejectUnknown(where, raw, ['at', 'label']);
  return { at: reqPair(`${where}.at`, raw.at), label: optStr(`${where}.label`, raw.label, LIMITS.maxText) };
}

function checkSegment(where: string, raw: unknown): Segment {
  if (!isPlainObject(raw)) bad(`${where}必须是对象 {"from": [x,y], "to": [x,y]}`);
  rejectUnknown(where, raw, ['from', 'to', 'label', 'dashed']);
  return {
    from: reqPair(`${where}.from`, raw.from),
    to: reqPair(`${where}.to`, raw.to),
    label: optStr(`${where}.label`, raw.label, LIMITS.maxText),
    dashed: optBool(`${where}.dashed`, raw.dashed),
  };
}

function checkPolygon(where: string, raw: unknown): Polygon {
  if (!isPlainObject(raw)) bad(`${where}必须是对象 {"points": [[x,y], …]}`);
  rejectUnknown(where, raw, ['points', 'label']);
  if (!Array.isArray(raw.points) || raw.points.length < 3) {
    bad(`${where}.points 至少需要 3 个点（实得 ${Array.isArray(raw.points) ? raw.points.length : 0} 个）`);
  }
  if ((raw.points as unknown[]).length > 12) bad(`${where}.points 超过 12 个点`);
  return {
    points: (raw.points as unknown[]).map((p, j) => reqPair(`${where}.points[${j}]`, p)),
    label: optStr(`${where}.label`, raw.label, LIMITS.maxText),
  };
}

function checkCircle(where: string, raw: unknown): CircleGeom {
  if (!isPlainObject(raw)) bad(`${where}必须是对象 {"center": [x,y], "r": 3}`);
  rejectUnknown(where, raw, ['center', 'r', 'label']);
  const r = reqNum(`${where}.r`, raw.r);
  if (r <= 0) bad(`${where}.r 必须是正数（实得 ${r}）`);
  return { center: reqPair(`${where}.center`, raw.center), r, label: optStr(`${where}.label`, raw.label, LIMITS.maxText) };
}

function checkLabel(where: string, raw: unknown): TextLabel {
  if (!isPlainObject(raw)) bad(`${where}必须是对象 {"at": [x,y], "text": "顶点"}`);
  rejectUnknown(where, raw, ['at', 'text', 'anchor']);
  let anchor: 'start' | 'middle' | 'end' | undefined;
  if (raw.anchor !== undefined && raw.anchor !== null) {
    if (!ANCHORS.includes(raw.anchor as 'start')) {
      bad(`${where}.anchor 只能是 ${ANCHORS.join(' / ')}（实得 ${JSON.stringify(raw.anchor)}）`);
    }
    anchor = raw.anchor as 'start' | 'middle' | 'end';
  }
  return { at: reqPair(`${where}.at`, raw.at), text: reqStr(`${where}.text`, raw.text, LIMITS.maxText), anchor };
}

/** 流式预览的单项过滤器：坏项返回 null（跳过），不让一项坏数据堵死整张预览 */
function pick<T>(check: (where: string, raw: unknown) => T) {
  return (raw: unknown): T | null => {
    try {
      return check('流式项', raw);
    } catch {
      return null;
    }
  };
}

export const pickValidNode = pick(checkNode);
export const pickValidEdge = pick(checkEdge);
export const pickValidCurve = pick(checkCurve);
export const pickValidPoint = pick(checkPoint);
export const pickValidSegment = pick(checkSegment);
export const pickValidPolygon = pick(checkPolygon);
export const pickValidCircle = pick(checkCircle);
export const pickValidLabel = pick(checkLabel);

function checkDatum(where: string, raw: unknown): ChartDatum {
  if (!isPlainObject(raw)) bad(`${where}必须是对象 {"label": …, "value": …}`);
  rejectUnknown(where, raw, ['label', 'value']);
  return { label: reqStr(`${where}.label`, raw.label, 12), value: reqNum(`${where}.value`, raw.value) };
}
export const pickValidDatum = pick(checkDatum);

function validateChart(input: Record<string, unknown>): ChartDoc {
  rejectUnknown('chart', input, ['type', 'kind', 'data', 'y']);
  if (input.kind !== 'bar' && input.kind !== 'line' && input.kind !== 'pie') bad('chart.kind 必须是 bar / line / pie');
  if (!Array.isArray(input.data) || !input.data.length || input.data.length > LIMITS.maxData) bad(`chart.data 必须有 1～${LIMITS.maxData} 项`);
  const data = input.data.map((item, i) => checkDatum(`data[${i}]`, item));
  const y = input.y == null ? undefined : reqPair('y', input.y);
  if (y && (!(y[0] < y[1]) || !Number.isFinite(y[1] - y[0]))) bad('y 范围必须递增且跨度有限');
  if (y && data.some(d => d.value < y[0] || d.value > y[1])) bad('data.value 超出了 y 范围');
  if (input.kind === 'pie') {
    if (y) bad('pie 不支持 y 范围');
    if (data.some(d => d.value < 0) || !data.some(d => d.value > 0)) bad('pie 的 value 必须非负，且至少一项大于 0');
  }
  return { type: 'chart', kind: input.kind, data, y };
}

// ───────────────────────────────────────────────────────────────────────────────
// 完整校验（终态 + show_widget 预检）
// ───────────────────────────────────────────────────────────────────────────────

/**
 * 校验并规范化一段 ```diagram 的 JSON。
 *
 * @throws DiagramSchemaError —— 每条错误都写成「哪里错了 + 怎么改」的可执行文案
 */
export function validateDiagram(input: unknown): DiagramDoc {
  if (!isPlainObject(input)) bad('diagram 围栏里必须是一个 JSON 对象：{"type": "graph"|"plot", …}');

  // type 先判：它是其余字段的**解释上下文**。type 都写错了的时候报「不认识的字段」，
  // 会把模型引到错误的方向上 —— 它真正该做的是换 type，或者换 ```mermaid 围栏。
  const type = input.type;
  if (type === 'chart') return validateChart(input);
  if (type !== 'graph' && type !== 'plot') {
    bad(
      `type 必须是 "graph"（结构图）、"plot"（函数/几何）或 "chart"（柱/折/饼），实得 ${JSON.stringify(type)}。` +
        '时序等未覆盖图种用 ```mermaid 围栏',
    );
  }
  rejectUnknown('diagram', input, type === 'graph'
    ? ['type', 'direction', 'nodes', 'edges']
    : ['type', 'x', 'y', 'axes', 'curves', 'points', 'segments', 'polygons', 'circles', 'labels']);

  if (type === 'graph') return validateGraph(input);
  return validatePlot(input);
}

function validateGraph(input: Record<string, unknown>): GraphDoc {
  let direction: 'TB' | 'LR' | undefined;
  if (input.direction !== undefined && input.direction !== null) {
    if (input.direction !== 'TB' && input.direction !== 'LR') {
      bad(`direction 只能是 "TB"（纵向）或 "LR"（横向），实得 ${JSON.stringify(input.direction)}`);
    }
    direction = input.direction;
  }

  if (!Array.isArray(input.nodes)) bad('graph 必须有 nodes 数组：[{"id":"a","label":"客户端"}, …]');
  if (input.nodes.length === 0) bad('nodes 不能为空：至少写一个节点');
  if (input.nodes.length > LIMITS.maxNodes) {
    bad(`nodes 超过 ${LIMITS.maxNodes} 个（实得 ${input.nodes.length} 个）：拆成两张图，或改用列表`);
  }

  const nodes: GraphNode[] = [];
  const seen = new Set<string>();
  input.nodes.forEach((raw, i) => {
    const node = checkNode(`nodes[${i}]`, raw);
    if (seen.has(node.id)) {
      bad(`节点 id 重复：「${node.id}」。id 只在图内做连线引用，重复了连线会指错`);
    }
    seen.add(node.id);
    nodes.push(node);
  });

  let edges: GraphEdge[] | undefined;
  if (input.edges !== undefined && input.edges !== null) {
    if (!Array.isArray(input.edges)) bad('edges 必须是数组：[{"from":"a","to":"b"}, …]');
    if (input.edges.length > LIMITS.maxEdges) {
      bad(`edges 超过 ${LIMITS.maxEdges} 条（实得 ${input.edges.length} 条）：连线太多说明图该拆`);
    }
    edges = [];
    input.edges.forEach((raw, i) => {
      const where = `edges[${i}]`;
      const edge = checkEdge(where, raw);
      if (edge.from === edge.to) {
        bad(`${where} 是自环（from 与 to 都是「${edge.from}」）：本渲染器不支持自环，去掉它或把说明写进节点文案`);
      }
      for (const [role, id] of [['from', edge.from], ['to', edge.to]] as const) {
        if (!seen.has(id)) {
          bad(`${where}.${role} 引用了不存在的节点「${id}」。可用 id：${[...seen].join(' / ')}`);
        }
      }
      edges!.push(edge);
    });
  }

  return { type: 'graph', direction, nodes, edges };
}

function validatePlot(input: Record<string, unknown>): PlotDoc {
  const x = input.x === undefined || input.x === null ? undefined : reqPair('x', input.x);
  if (x && !(x[0] < x[1])) bad(`x 范围必须 [最小值, 最大值] 且最小值小于最大值（实得 [${x[0]}, ${x[1]}]）`);
  const y = input.y === undefined || input.y === null ? undefined : reqPair('y', input.y);
  if (y && !(y[0] < y[1])) bad(`y 范围必须 [最小值, 最大值] 且最小值小于最大值（实得 [${y[0]}, ${y[1]}]）`);

  const doc: PlotDoc = { type: 'plot', x, y, axes: optBool('axes', input.axes) };

  const arr = (key: string, limit: number, check: (where: string, raw: unknown) => unknown): unknown[] | undefined => {
    const v = input[key];
    if (v === undefined || v === null) return undefined;
    if (!Array.isArray(v)) bad(`${key} 必须是数组`);
    if (v.length > limit) bad(`${key} 超过 ${limit} 项（实得 ${v.length} 项）：一张图讲一件事，拆开画`);
    return v.map((item, i) => check(`${key}[${i}]`, item));
  };

  doc.curves = arr('curves', LIMITS.maxCurves, checkCurve) as Curve[] | undefined;
  doc.points = arr('points', LIMITS.maxPoints, checkPoint) as PlotPoint[] | undefined;
  doc.segments = arr('segments', LIMITS.maxSegments, checkSegment) as Segment[] | undefined;
  doc.polygons = arr('polygons', LIMITS.maxPolygons, checkPolygon) as Polygon[] | undefined;
  doc.circles = arr('circles', LIMITS.maxCircles, checkCircle) as CircleGeom[] | undefined;
  doc.labels = arr('labels', LIMITS.maxLabels, checkLabel) as TextLabel[] | undefined;

  // 曲线的定义域不能超出坐标轴范围（画在轴外的曲线对不上刻度）
  if (doc.curves && x) {
    doc.curves.forEach((c, i) => {
      if (c.domain && (c.domain[0] < x[0] || c.domain[1] > x[1])) {
        bad(`curves[${i}].domain [${c.domain[0]}, ${c.domain[1]}] 超出了 x 范围 [${x[0]}, ${x[1]}]：曲线只能画在坐标轴范围内`);
      }
    });
  }

  return doc;
}
