import { getStroke } from 'perfect-freehand';

export type InkNib = 'pressure' | 'ballpoint' | 'brush';
/** 笔迹用页面自身的坐标系保存（宽 1000），缩放/横竖屏不会改变 PDF 上的落点。 */
export interface InkPoint { x: number; y: number; pressure: number }
export interface InkStroke {
  id: string;
  materialId: string;
  surface: string;
  tool: 'pen' | 'highlight';
  color: string;
  width: number;
  height: number;
  points: InkPoint[];
  createdAt: number;
  /** 缺省表示旧版轮廓，升级后不改变已有笔迹外观。 */
  renderer?: 'freehand-v1';
  nib?: InkNib;
  opacity?: number;
  smoothing?: number;
  /** 手指优先贴合触点；持久化以保证刷新和问答裁图使用同一轮廓。 */
  input?: 'touch' | 'pen' | 'mouse';
}
export type InkTool = 'read' | 'pen' | 'highlight' | 'erase';

const n = (value: number) => Math.round(value * 100) / 100;
const radius = (stroke: InkStroke, point: InkPoint) =>
  stroke.width * (stroke.tool === 'highlight' ? 0.5 : 0.25 + point.pressure * 0.75);

/** 一条填充轮廓而非数百个半透明线段，荧光笔重采样处不会出现深色接缝。 */
export function inkOpacity(stroke: InkStroke): number {
  return stroke.opacity ?? (stroke.tool === 'highlight' ? 0.25 : 1);
}

export function inkPath(stroke: InkStroke, complete = true): string {
  if (stroke.renderer === 'freehand-v1') {
    const smooth = stroke.smoothing ?? 0.35;
    const outline = getStroke(stroke.points, {
      size: stroke.width,
      thinning: stroke.tool === 'highlight' || stroke.nib === 'ballpoint' ? 0 : stroke.nib === 'brush' ? 0.8 : 0.5,
      smoothing: smooth,
      streamline: stroke.input === 'touch' ? 0 : smooth,
      simulatePressure: false,
      last: complete || stroke.input === 'touch',
    });
    return outline.length ? `M${outline.map(([x, y]) => `${n(x)},${n(y)}`).join('L')}Z` : '';
  }
  const { points } = stroke;
  if (!points.length) return '';
  if (points.length === 1) {
    const p = points[0];
    const r = radius(stroke, p);
    return `M${n(p.x - r)},${n(p.y)}a${n(r)},${n(r)} 0 1,0 ${n(r * 2)},0a${n(r)},${n(r)} 0 1,0 ${n(-r * 2)},0`;
  }
  const left: string[] = [];
  const right: string[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(points.length - 1, i + 1)];
    const p = points[i];
    const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const dx = -(b.y - a.y) / length * radius(stroke, p);
    const dy = (b.x - a.x) / length * radius(stroke, p);
    left.push(`${n(p.x + dx)},${n(p.y + dy)}`);
    right.push(`${n(p.x - dx)},${n(p.y - dy)}`);
  }
  return `M${left.join('L')}L${right.reverse().join('L')}Z`;
}

/** 橡皮沿移动线段命中整笔，快速移动时也不会从两次采样之间漏过去。 */
export function hitsInk(stroke: InkStroke, from: InkPoint, to: InkPoint, tolerance: number): boolean {
  const distance = (p: InkPoint, a: InkPoint, b: InkPoint) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
  };
  const limit = tolerance + stroke.width;
  for (let i = 0; i < stroke.points.length; i++) {
    const a = stroke.points[i], b = stroke.points[Math.min(i + 1, stroke.points.length - 1)];
    if (distance(a, from, to) <= limit || distance(from, a, b) <= limit || distance(to, a, b) <= limit) return true;
    // 两条线段相交，但端点彼此距离大于橡皮半径。
    const cross = (p: InkPoint, q: InkPoint, r: InkPoint) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    if (cross(from, to, a) * cross(from, to, b) < 0 && cross(a, b, from) * cross(a, b, to) < 0) return true;
  }
  return false;
}

/** 可重排文本按内容隔离：正文编辑后不把旧笔迹套到新段落上。 */
export function inkTextKey(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(36);
}
