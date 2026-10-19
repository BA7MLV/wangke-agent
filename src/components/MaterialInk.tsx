import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Button, ToggleButton, ToggleButtonGroup } from '@heroui/react';
import { Eraser, Highlighter, MousePointer2, PenLine, Redo2, Undo2 } from 'lucide-react';
import { db } from '../store/db';
import { hitsInk, inkPath, inkOpacity, type InkNib, type InkPoint, type InkStroke, type InkTool } from '../materials/ink';
import { useSelectionAsk } from '../store/selectionAsk';
import { uuid } from '../utils/uuid';
import { InkInput } from '../materials/inkInput';
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
  nib: InkNib;
  setNib: (nib: InkNib) => void;
  opacity: number;
  setOpacity: (opacity: number) => void;
  smoothing: number;
  setSmoothing: (smoothing: number) => void;
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
  input: InkInput;
}
const InkContext = createContext<InkContextValue | null>(null);
export const useMaterialInk = () => useContext(InkContext)!;
const EMPTY: InkStroke[] = [];

export function MaterialInkProvider({ materialId, children }: { materialId: string; children: ReactNode }) {
  const [tool, setTool] = useState<InkTool>('read');
  const [color, setColor] = useState('#dc2626');
  const [width, setWidth] = useState(3);
  const [nib, setNib] = useState<InkNib>('pressure');
  const [penOpacity, setPenOpacity] = useState(1);
  const [highlightOpacity, setHighlightOpacity] = useState(0.25);
  const [smoothing, setSmoothing] = useState(0.35);
  const [finger, setFinger] = useState(false);
  const [ready, setReady] = useState(false);
  const [rows, setRows] = useState<InkStroke[]>([]);
  const [status, setStatus] = useState('正在读取批注…');
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<{ past: Change[]; future: Change[] }>({ past: [], future: [] });
  const queue = useRef<Change[]>([]);
  const saving = useRef(false);
  const mounted = useRef(false);
  const [input] = useState(() => new InkInput());
  const inputRoot = useRef<HTMLDivElement>(null);
  const writing = ready && tool !== 'read';
  useEffect(() => {
    if (writing && inputRoot.current) return input.attach(inputRoot.current, finger);
  }, [input, writing, finger]);

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
    nib, setNib, opacity: tool === 'highlight' ? highlightOpacity : penOpacity,
    setOpacity: tool === 'highlight' ? setHighlightOpacity : setPenOpacity, smoothing, setSmoothing,
    ready, status, error, retry: () => void (ready ? flush() : load()), strokes, commit, undo, redo,
    canUndo: history.past.length > 0, canRedo: history.future.length > 0, input }}>
    <div ref={inputRoot} className="ink-input-root" data-writing={writing || undefined}>{children}</div>
  </InkContext>;
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
        {(ink.tool === 'pen' || ink.tool === 'highlight') && !disabled && <>
          {ink.tool === 'pen' && <label className="ink-width">笔型 <select aria-label="笔型" value={ink.nib} onChange={(e) => ink.setNib(e.target.value as InkNib)}>
            <option value="pressure">压感笔</option><option value="ballpoint">圆珠笔</option><option value="brush">毛笔</option>
          </select></label>}
          <label className="ink-color" title="笔迹颜色"><span className="sr-only">笔迹颜色</span><input type="color" value={ink.color} onChange={(e) => ink.setColor(e.target.value)} /></label>
          <label className="ink-range">粗细 <input aria-label="笔迹粗细" type="range" min="1" max="12" step="0.5" value={ink.width} onChange={(e) => ink.setWidth(Number(e.target.value))} /><span>{ink.width * (ink.tool === 'highlight' ? 6 : 1)}px</span></label>
          <label className="ink-range">浓度 <input aria-label="笔迹浓度" type="range" min="5" max="100" step="5" value={Math.round(ink.opacity * 100)} onChange={(e) => ink.setOpacity(Number(e.target.value) / 100)} /><span>{Math.round(ink.opacity * 100)}%</span></label>
          <label className="ink-width">美化 <select aria-label="实时字迹美化" value={ink.smoothing} onChange={(e) => ink.setSmoothing(Number(e.target.value))}>
            <option value={0}>关闭</option><option value={0.35}>轻度平滑</option><option value={0.65}>增强平滑</option>
          </select></label>
        </>}
        {ink.tool !== 'read' && !disabled && <>
          <ToggleButton isSelected={ink.finger} onChange={ink.setFinger} data-testid="ink-finger">启用手指绘制</ToggleButton>
        </>}
      </div>
      <div className="ink-toolbar__hint">
        <span>{ink.tool === 'read' ? '阅读 / 选字；选择画笔进入书写' : ink.finger ? '手指绘制模式；切回阅读可滚动' : '笔写字 · 手指滑动 · 落笔时暂停触摸翻页'}</span>
        {ink.error ? <span role="alert" className="text-danger">{ink.error}<Button size="sm" variant="tertiary" onPress={ink.retry}>重试</Button></span>
          : <span role="status">{ink.status}</span>}
      </div>
    </div>
  );
}

const SavedStroke = memo(function SavedStroke({ stroke }: { stroke: InkStroke }) {
  return <svg viewBox={`0 0 1000 ${stroke.height}`} preserveAspectRatio="none" aria-hidden="true" data-ink-stroke={stroke.id}>
    <path d={inkPath(stroke)} fill={stroke.color} opacity={inkOpacity(stroke)} />
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
  const gesture = useRef<{ id: number; stroke: InkStroke; erased: Set<string>; last: InkPoint; rect: DOMRect; tool: InkTool } | null>(null);
  const frame = useRef(0);

  const cancel = useCallback(() => {
    if (frame.current) cancelAnimationFrame(frame.current);
    frame.current = 0;
    // 抬笔后的掌触保护只属于触控笔，不能吞掉电容笔/手指连续书写的下一笔。
    const id = gesture.current?.id;
    if (id !== undefined) {
      ink.input.endPen(id);
      if (ink.input.drawing?.id === id) ink.input.drawing = null;
    }
    gesture.current = null;
    preview.current?.setAttribute('d', '');
    layer.current?.querySelectorAll<SVGSVGElement>('[data-ink-stroke]').forEach((el) => { el.style.visibility = ''; });
  }, [ink.input]);
  useEffect(() => cancel, [cancel, active, ink.tool, ink.finger]);

  const point = (e: Pick<PointerEvent, 'clientX' | 'clientY' | 'pressure' | 'pointerType'>, rect: DOMRect, height = rect.height / rect.width * 1000): InkPoint => ({
    x: Math.max(0, Math.min(1000, (e.clientX - rect.left) / rect.width * 1000)),
    y: Math.max(0, Math.min(height, (e.clientY - rect.top) / rect.height * height)),
    pressure: e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5,
  });
  const paint = () => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const g = gesture.current;
      if (g && g.tool !== 'erase') preview.current?.setAttribute('d', inkPath(g.stroke, false));
    });
  };
  const capture = (e: ReactPointerEvent) => {
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 合成事件没有活动指针 */ }
  };
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!active || e.button !== 0) return;
    if (e.pointerType === 'touch' && ink.input.isBlockedTouch(e.pointerId)) return;
    if (e.pointerType === 'touch' && !ink.finger) return;
    if (gesture.current || ink.input.drawing || (e.pointerType === 'touch' && !e.isPrimary)) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const p = point(e, rect);
    const stroke: InkStroke = {
      id: uuid(), materialId: ink.materialId, surface,
      tool: ink.tool === 'highlight' ? 'highlight' : 'pen', color: ink.color,
      width: ink.width * (ink.tool === 'highlight' ? 6 : 1) * 1000 / rect.width,
      height: rect.height / rect.width * 1000, points: [p], createdAt: Date.now(),
      renderer: 'freehand-v1', nib: ink.nib, opacity: ink.opacity, smoothing: ink.smoothing,
      input: e.pointerType === 'touch' ? 'touch' : e.pointerType === 'pen' ? 'pen' : 'mouse',
    };
    gesture.current = { id: e.pointerId, stroke, erased: new Set(), last: p, rect, tool: ink.tool };
    ink.input.drawing = { id: e.pointerId, type: e.pointerType, cancel };
    previewSvg.current?.setAttribute('viewBox', `0 0 1000 ${stroke.height}`);
    preview.current?.setAttribute('fill', stroke.color);
    preview.current?.setAttribute('opacity', String(inkOpacity(stroke)));
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
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    e.preventDefault();
    // 工具栏换行、滚动或缩放后仍投回这一笔的坐标系，不能一直使用落笔时的屏幕位置。
    const rect = e.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    g.rect = rect;
    // Safari 旧版没有 coalesced events；空数组也必须回退到当前采样。
    const coalesced = e.nativeEvent.getCoalescedEvents?.() ?? [];
    for (const event of coalesced.length ? coalesced : [e.nativeEvent]) {
      const p = point(event, rect, g.stroke.height);
      if (g.tool === 'erase') erase(p);
      else if (Math.hypot(p.x - g.last.x, p.y - g.last.y) > (e.type === 'pointerup' ? 0 : 0.1 * 1000 / rect.width)) {
        g.stroke.points.push(p); g.last = p;
      }
    }
    paint();
  };
  const up = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    move(e);
    ink.commit(g.tool === 'erase' ? { add: [], remove: strokes.filter((s) => g.erased.has(s.id)) } : { add: [g.stroke], remove: [] });
    cancel();
  };
  return <div ref={layer} className="ink-layer" data-active={active || undefined} data-finger={ink.finger || undefined} data-testid="ink-layer" data-ink-surface={surface}
    onPointerDown={down} onPointerMove={move} onPointerUp={up}
    onPointerCancel={(e) => { if (gesture.current?.id === e.pointerId) cancel(); }}
    onLostPointerCapture={(e) => { if (gesture.current?.id === e.pointerId) cancel(); }}
    onContextMenu={(e) => { if (active) e.preventDefault(); }}>
    {strokes.map((stroke) => <SavedStroke key={stroke.id} stroke={stroke} />)}
    <svg ref={previewSvg} preserveAspectRatio="none" aria-hidden="true"><path ref={preview} /></svg>
  </div>;
}
