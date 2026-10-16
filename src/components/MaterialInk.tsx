import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Button, ToggleButton, ToggleButtonGroup } from '@heroui/react';
import { Eraser, Highlighter, MousePointer2, PenLine, Redo2, Undo2 } from 'lucide-react';
import { db } from '../store/db';
import { hitsInk, inkPath, type InkPoint, type InkStroke, type InkTool } from '../materials/ink';
import { useSelectionAsk } from '../store/selectionAsk';
import { uuid } from '../utils/uuid';
import './material-ink.css';

interface Change { add: InkStroke[]; remove: InkStroke[] }
interface InkContextValue {
  materialId: string;
  tool: InkTool;
  setTool: (tool: InkTool) => void;
  color: string;
  setColor: (color: string) => void;
  width: number;
  setWidth: (width: number) => void;
  finger: boolean;
  setFinger: (finger: boolean) => void;
  ready: boolean;
  status: string;
  error: string | null;
  retry: () => void;
  strokes: ReadonlyMap<string, InkStroke[]>;
  commit: (change: Change) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  pen: React.RefObject<{ active: boolean; until: number }>;
}
const InkContext = createContext<InkContextValue | null>(null);
export const useMaterialInk = () => useContext(InkContext)!;
const EMPTY: InkStroke[] = [];

export function MaterialInkProvider({ materialId, children }: { materialId: string; children: ReactNode }) {
  const [tool, setTool] = useState<InkTool>('read');
  const [color, setColor] = useState('#dc2626');
  const [width, setWidth] = useState(3);
  const [finger, setFinger] = useState(false);
  const [ready, setReady] = useState(false);
  const [rows, setRows] = useState<InkStroke[]>([]);
  const [status, setStatus] = useState('正在读取批注…');
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<{ past: Change[]; future: Change[] }>({ past: [], future: [] });
  const queue = useRef<Change[]>([]);
  const saving = useRef(false);
  const mounted = useRef(false);
  const pen = useRef({ active: false, until: 0 });

  const load = useCallback(async () => {
    try {
      const saved = await db.materialInk.where('materialId').equals(materialId).sortBy('createdAt');
      if (!mounted.current) return;
      setRows(saved);
      setReady(true);
      setError(null);
      setStatus('批注自动保存在本机');
    } catch {
      if (mounted.current) setError('批注读取失败，请重试后再书写。');
    }
  }, [materialId]);

  useEffect(() => {
    mounted.current = true;
    void load();
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (queue.current.length) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => { mounted.current = false; window.removeEventListener('beforeunload', beforeUnload); };
  }, [load]);

  // 每笔立即开始事务；队列保证快速画/撤销/重做的落盘顺序，离开阅读器也继续完成。
  const flush = useCallback(async () => {
    if (saving.current) return;
    saving.current = true;
    if (mounted.current) { setError(null); setStatus('正在保存批注…'); }
    try {
      while (queue.current.length) {
        const change = queue.current[0];
        await db.transaction('rw', db.materialInk, db.videos, async () => {
          // 已删除材料的后台写入不能复活孤立笔迹。
          if (!await db.videos.get(materialId)) return;
          await db.materialInk.bulkDelete(change.remove.map((s) => s.id));
          await db.materialInk.bulkPut(change.add);
        });
        queue.current.shift();
      }
      if (mounted.current) setStatus('批注已保存到本机');
    } catch {
      if (mounted.current) setError('批注尚未保存，请重试。');
    } finally { saving.current = false; }
  }, [materialId]);

  const apply = useCallback((change: Change) => {
    const deleted = new Set(change.remove.map((s) => s.id));
    setRows((previous) => [...previous.filter((s) => !deleted.has(s.id)), ...change.add]);
    queue.current.push(change);
    void flush();
  }, [flush]);
  const commit = useCallback((change: Change) => {
    if (!change.add.length && !change.remove.length) return;
    apply(change);
    setHistory((h) => ({ past: [...h.past, change], future: [] }));
  }, [apply]);
  const undo = () => {
    const change = history.past.at(-1);
    if (!change) return;
    apply({ add: change.remove, remove: change.add });
    setHistory({ past: history.past.slice(0, -1), future: [...history.future, change] });
  };
  const redo = () => {
    const change = history.future.at(-1);
    if (!change) return;
    apply(change);
    setHistory({ past: [...history.past, change], future: history.future.slice(0, -1) });
  };
  const strokes = useMemo(() => {
    const bySurface = new Map<string, InkStroke[]>();
    for (const stroke of [...rows].sort((a, b) => a.createdAt - b.createdAt)) {
      const list = bySurface.get(stroke.surface) ?? [];
      list.push(stroke);
      bySurface.set(stroke.surface, list);
    }
    return bySurface;
  }, [rows]);
  return <InkContext value={{ materialId, tool, setTool, color, setColor, width, setWidth, finger, setFinger,
    ready, status, error, retry: () => void (ready ? flush() : load()), strokes, commit, undo, redo,
    canUndo: history.past.length > 0, canRedo: history.future.length > 0, pen }}>{children}</InkContext>;
}

export function InkToolbar({ disabled = false, onActivate }: { disabled?: boolean; onActivate?: () => void }) {
  const ink = useMaterialInk();
  const select = (tool: InkTool) => {
    if (tool !== 'read') {
      onActivate?.();
      window.getSelection()?.removeAllRanges();
      useSelectionAsk.getState().hideBar();
    }
    ink.setTool(tool);
  };
  return (
    <div className="ink-toolbar" data-testid="ink-toolbar">
      <div className="ink-toolbar__tools">
        <ToggleButtonGroup aria-label="阅读与批注工具" selectionMode="single" selectedKeys={[ink.tool]}
          isDisabled={disabled || !ink.ready} onSelectionChange={(keys) => {
            const key = [...keys][0] as InkTool | undefined;
            if (key) select(key);
          }}>
          <ToggleButton id="read" aria-label="阅读模式" data-testid="ink-read"><MousePointer2 size={18} /><span>阅读</span></ToggleButton>
          <ToggleButton id="pen" aria-label="画笔" data-testid="ink-pen"><PenLine size={18} /><span>画笔</span></ToggleButton>
          <ToggleButton id="highlight" aria-label="荧光笔" data-testid="ink-highlight"><Highlighter size={18} /><span>荧光笔</span></ToggleButton>
          <ToggleButton id="erase" aria-label="橡皮擦（整笔）" data-testid="ink-erase"><Eraser size={18} /></ToggleButton>
        </ToggleButtonGroup>
        <Button isIconOnly variant="tertiary" aria-label="撤销批注" data-testid="ink-undo" isDisabled={!ink.canUndo || disabled} onPress={ink.undo}><Undo2 size={18} /></Button>
        <Button isIconOnly variant="tertiary" aria-label="重做批注" data-testid="ink-redo" isDisabled={!ink.canRedo || disabled} onPress={ink.redo}><Redo2 size={18} /></Button>
        {ink.tool !== 'read' && !disabled && <>
          <label className="ink-color" title="笔迹颜色"><span className="sr-only">笔迹颜色</span><input type="color" value={ink.color} onChange={(e) => ink.setColor(e.target.value)} /></label>
          <label className="ink-width"><span className="sr-only">笔迹粗细</span><select aria-label="笔迹粗细" value={ink.width} onChange={(e) => ink.setWidth(Number(e.target.value))}>
            <option value={2}>细</option><option value={3}>中</option><option value={5}>粗</option>
          </select></label>
          <ToggleButton isSelected={ink.finger} onChange={ink.setFinger} data-testid="ink-finger">手指绘制</ToggleButton>
        </>}
      </div>
      <div className="ink-toolbar__hint">
        <span>{ink.tool === 'read' ? '用触控笔圈画重点' : ink.finger ? '手指 / 电容笔绘制；切回阅读可滚动' : '触控笔书写 · 手指拖动翻阅'}</span>
        {ink.error ? <span role="alert" className="text-danger">{ink.error}<Button size="sm" variant="tertiary" onPress={ink.retry}>重试</Button></span>
          : <span role="status">{ink.status}</span>}
      </div>
    </div>
  );
}

const SavedStroke = memo(function SavedStroke({ stroke }: { stroke: InkStroke }) {
  return <svg viewBox={`0 0 1000 ${stroke.height}`} preserveAspectRatio="none" aria-hidden="true" data-ink-stroke={stroke.id}>
    <path d={inkPath(stroke)} fill={stroke.color} opacity={stroke.tool === 'highlight' ? 0.25 : 1} />
  </svg>;
});

/** 挂在页面/段落内部，随正文滚动；SVG 向量层不分配整篇文档大小的位图。 */
export function InkLayer({ surface, disabled = false }: { surface: string; disabled?: boolean }) {
  const ink = useMaterialInk();
  const strokes = ink.strokes.get(surface) ?? EMPTY;
  const active = ink.ready && !disabled && ink.tool !== 'read';
  const preview = useRef<SVGPathElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const previewSvg = useRef<SVGSVGElement>(null);
  const gesture = useRef<{ id: number; isPen: boolean; stroke: InkStroke; erased: Set<string>; last: InkPoint; rect: DOMRect; tool: InkTool } | null>(null);
  const pan = useRef<{ id: number; x: number; y: number; scroll: HTMLElement } | null>(null);
  const frame = useRef(0);

  const cancel = useCallback(() => {
    if (frame.current) cancelAnimationFrame(frame.current);
    frame.current = 0;
    // 抬笔后的掌触保护只属于触控笔，不能吞掉电容笔/手指连续书写的下一笔。
    if (gesture.current?.isPen) { ink.pen.current.active = false; ink.pen.current.until = performance.now() + 250; }
    gesture.current = null;
    pan.current = null;
    preview.current?.setAttribute('d', '');
    layer.current?.querySelectorAll<SVGSVGElement>('[data-ink-stroke]').forEach((el) => { el.style.visibility = ''; });
  }, [ink.pen]);
  useEffect(() => cancel, [cancel, active, ink.tool, ink.finger]);

  const point = (e: Pick<PointerEvent, 'clientX' | 'clientY' | 'pressure' | 'pointerType'>, rect: DOMRect): InkPoint => ({
    x: Math.max(0, Math.min(1000, (e.clientX - rect.left) / rect.width * 1000)),
    y: Math.max(0, Math.min(rect.height / rect.width * 1000, (e.clientY - rect.top) / rect.width * 1000)),
    pressure: e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5,
  });
  const paint = () => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const g = gesture.current;
      if (g && g.tool !== 'erase') preview.current?.setAttribute('d', inkPath(g.stroke));
    });
  };
  const capture = (e: ReactPointerEvent) => {
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 合成事件没有活动指针 */ }
  };
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!active || e.button !== 0) return;
    if (e.pointerType === 'touch' && (ink.pen.current.active || performance.now() < ink.pen.current.until || e.width > 40 || e.height > 40)) return;
    if (e.pointerType === 'touch' && !ink.finger) {
      if (!e.isPrimary || pan.current) return;
      const scroll = e.currentTarget.closest<HTMLElement>('.mr-scroll');
      if (scroll) { pan.current = { id: e.pointerId, x: e.clientX, y: e.clientY, scroll }; capture(e); }
      return;
    }
    if (gesture.current || (e.pointerType === 'touch' && !e.isPrimary)) return;
    e.preventDefault();
    e.stopPropagation();
    pan.current = null;
    const rect = e.currentTarget.getBoundingClientRect();
    const p = point(e, rect);
    const stroke: InkStroke = {
      id: uuid(), materialId: ink.materialId, surface,
      tool: ink.tool === 'highlight' ? 'highlight' : 'pen', color: ink.color,
      width: ink.width * (ink.tool === 'highlight' ? 6 : 1) * 1000 / rect.width,
      height: rect.height / rect.width * 1000, points: [p], createdAt: Date.now(),
    };
    gesture.current = { id: e.pointerId, isPen: e.pointerType === 'pen', stroke, erased: new Set(), last: p, rect, tool: ink.tool };
    ink.pen.current.active = e.pointerType === 'pen';
    previewSvg.current?.setAttribute('viewBox', `0 0 1000 ${stroke.height}`);
    preview.current?.setAttribute('fill', stroke.color);
    preview.current?.setAttribute('opacity', stroke.tool === 'highlight' ? '0.25' : '1');
    capture(e);
    if (ink.tool === 'erase') erase(p);
    else paint();
  };
  const erase = (p: InkPoint) => {
    const g = gesture.current!;
    for (const s of strokes) {
      // 各笔高度来自书写时的布局；命中也投回那一笔自己的坐标系。
      const scale = s.height / g.stroke.height;
      if (!g.erased.has(s.id) && hitsInk(s, { ...g.last, y: g.last.y * scale }, { ...p, y: p.y * scale }, 12 * 1000 / g.rect.width)) {
        g.erased.add(s.id);
        layer.current?.querySelector<SVGSVGElement>(`[data-ink-stroke="${CSS.escape(s.id)}"]`)?.style.setProperty('visibility', 'hidden');
      }
    }
    g.last = p;
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = pan.current;
    if (drag?.id === e.pointerId) {
      if (!ink.pen.current.active && performance.now() >= ink.pen.current.until) {
        drag.scroll.scrollTop += drag.y - e.clientY;
        drag.scroll.scrollLeft += drag.x - e.clientX;
      }
      drag.x = e.clientX; drag.y = e.clientY;
      return;
    }
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    e.preventDefault();
    // Safari 旧版没有 coalesced events；空数组也必须回退到当前采样。
    const coalesced = e.nativeEvent.getCoalescedEvents?.() ?? [];
    for (const event of coalesced.length ? coalesced : [e.nativeEvent]) {
      const p = point(event, g.rect);
      if (g.tool === 'erase') erase(p);
      else if (Math.hypot(p.x - g.last.x, p.y - g.last.y) > 0.35) {
        g.stroke.points.push(p); g.last = p;
      }
    }
    paint();
  };
  const up = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (pan.current?.id === e.pointerId) pan.current = null;
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    move(e);
    ink.commit(g.tool === 'erase' ? { add: [], remove: strokes.filter((s) => g.erased.has(s.id)) } : { add: [g.stroke], remove: [] });
    cancel();
  };
  return <div ref={layer} className="ink-layer" data-active={active || undefined} data-testid="ink-layer" data-ink-surface={surface}
    onPointerDown={down} onPointerMove={move} onPointerUp={up}
    onPointerCancel={(e) => { if (gesture.current?.id === e.pointerId || pan.current?.id === e.pointerId) cancel(); }}
    onLostPointerCapture={(e) => { if (gesture.current?.id === e.pointerId || pan.current?.id === e.pointerId) cancel(); }}
    onContextMenu={(e) => { if (active) e.preventDefault(); }}>
    {strokes.map((stroke) => <SavedStroke key={stroke.id} stroke={stroke} />)}
    <svg ref={previewSvg} preserveAspectRatio="none" aria-hidden="true"><path ref={preview} /></svg>
  </div>;
}
