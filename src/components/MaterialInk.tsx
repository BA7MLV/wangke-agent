import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, ToggleButton, ToggleButtonGroup } from '@heroui/react';
import { Eraser, Highlighter, MousePointer2, PenLine, Redo2, Undo2 } from 'lucide-react';
import { db } from '../store/db';
import { hitsInk, inkPath, inkOpacity, type InkNib, type InkPoint, type InkStroke, type InkTool } from '../materials/ink';
import { useSelectionAsk } from '../store/selectionAsk';
import { uuid } from '../utils/uuid';
import { InkInput } from '../materials/inkInput';
import { hitText, indexText, makeTextAnchor, resolveTextAnchor, textRects, type TextIndex } from '../materials/textHighlight';
import './material-ink.css';

interface Change { add: InkStroke[]; remove: InkStroke[] }
interface InkContextValue {
  toolbarActions?: ReactNode;
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

export function MaterialInkProvider({ materialId, children, toolbarActions }: { materialId: string; children: ReactNode; toolbarActions?: ReactNode }) {
  const [tool, setTool] = useState<InkTool>('smart');
  const [penColor, setPenColor] = useState('#dc2626');
  const [highlightColor, setHighlightColor] = useState('#facc15');
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
  const highlighting = tool === 'highlight' || tool === 'text-highlight';
  const fingerInput = useRef(false);
  fingerInput.current = highlighting || (tool !== 'smart' && finger);
  useEffect(() => {
    if (writing && inputRoot.current) return input.attach(inputRoot.current, () => fingerInput.current);
  }, [input, writing]);

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
  return <InkContext value={{ materialId, toolbarActions, tool, setTool, color: highlighting ? highlightColor : penColor,
    setColor: highlighting ? setHighlightColor : setPenColor, width, setWidth, finger, setFinger,
    nib, setNib, opacity: highlighting ? highlightOpacity : penOpacity,
    setOpacity: highlighting ? setHighlightOpacity : setPenOpacity, smoothing, setSmoothing,
    ready, status, error, retry: () => void (ready ? flush() : load()), strokes, commit, undo, redo,
    canUndo: history.past.length > 0, canRedo: history.future.length > 0, input }}>
    <div ref={inputRoot} className="ink-input-root" data-writing={writing || undefined}>{children}</div>
  </InkContext>;
}

export function InkToolbar({ disabled = false, onActivate }: { disabled?: boolean; onActivate?: () => void }) {
  const ink = useMaterialInk();
  const [showHighlights, setShowHighlights] = useState(false);
  const highlights = [...ink.strokes.values()].flat().filter((s) => s.anchor);
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
          <ToggleButton id="smart" aria-label="智能批注：笔写字，手指滚动" data-testid="ink-smart"><PenLine size={18} /><span>智能批注</span></ToggleButton>
          <ToggleButton id="read" aria-label="阅读模式" data-testid="ink-read"><MousePointer2 size={18} /><span>阅读 / 选字</span></ToggleButton>
          <ToggleButton id="pen" aria-label="画笔" data-testid="ink-pen"><PenLine size={18} /><span>画笔</span></ToggleButton>
          <ToggleButton id="text-highlight" aria-label="文字荧光笔：拖过文字，一次后返回智能批注" data-testid="ink-text-highlight"><Highlighter size={18} /><span>文字荧光笔</span></ToggleButton>
          <ToggleButton id="highlight" aria-label="自由荧光笔（画一笔后返回智能批注）" data-testid="ink-highlight"><Highlighter size={18} /><span>自由荧光笔</span></ToggleButton>
          <ToggleButton id="erase" aria-label="橡皮擦（整笔）" data-testid="ink-erase"><Eraser size={18} /></ToggleButton>
        </ToggleButtonGroup>
        <Button isIconOnly variant="tertiary" aria-label="撤销批注" data-testid="ink-undo" isDisabled={!ink.canUndo || disabled} onPress={ink.undo}><Undo2 size={18} /></Button>
        <Button isIconOnly variant="tertiary" aria-label="重做批注" data-testid="ink-redo" isDisabled={!ink.canRedo || disabled} onPress={ink.redo}><Redo2 size={18} /></Button>
        {!['read', 'erase'].includes(ink.tool) && !disabled && <>
          {(ink.tool === 'pen' || ink.tool === 'smart') && <label className="ink-width">笔型 <select aria-label="笔型" value={ink.nib} onChange={(e) => ink.setNib(e.target.value as InkNib)}>
            <option value="pressure">压感笔</option><option value="ballpoint">圆珠笔</option><option value="brush">毛笔</option>
          </select></label>}
          <label className="ink-color" title="笔迹颜色"><span className="sr-only">笔迹颜色</span><input type="color" value={ink.color} onChange={(e) => ink.setColor(e.target.value)} /></label>
          {ink.tool !== 'text-highlight' && <label className="ink-range">粗细 <input aria-label="笔迹粗细" type="range" min="1" max="12" step="0.5" value={ink.width} onChange={(e) => ink.setWidth(Number(e.target.value))} /><span>{ink.width * (ink.tool === 'highlight' ? 6 : 1)}px</span></label>}
          <label className="ink-range">浓度 <input aria-label="笔迹浓度" type="range" min="5" max="100" step="5" value={Math.round(ink.opacity * 100)} onChange={(e) => ink.setOpacity(Number(e.target.value) / 100)} /><span>{Math.round(ink.opacity * 100)}%</span></label>
          {(ink.tool === 'smart' || ink.tool === 'pen') && <label className="ink-width">美化 <select aria-label="实时字迹美化" value={ink.smoothing} onChange={(e) => ink.setSmoothing(Number(e.target.value))}>
            <option value={0}>关闭</option><option value={0.35}>轻度平滑</option><option value={0.65}>增强平滑</option>
          </select></label>}
        </>}
        {(ink.tool === 'pen' || ink.tool === 'erase') && !disabled && <>
          <ToggleButton isSelected={ink.finger} onChange={ink.setFinger} data-testid="ink-finger">启用手指绘制</ToggleButton>
        </>}
        <Button variant="tertiary" data-testid="ink-excerpts" aria-expanded={showHighlights} onPress={() => setShowHighlights(!showHighlights)}>高亮摘录（{highlights.length}）</Button>
        {ink.toolbarActions}
      </div>
      {ink.error ? <div className="ink-toolbar__hint" role="alert"><span className="text-danger">{ink.error}<Button size="sm" variant="tertiary" onPress={ink.retry}>重试</Button></span></div>
        : <span className="sr-only" role="status">{ink.status}</span>}
      {showHighlights && <div className="ink-excerpts" data-testid="ink-excerpt-list">
        {!highlights.length && <p>还没有文字高亮。选择「文字荧光笔」，拖过要标记的文字。</p>}
        {highlights.map((stroke) => {
          const a = stroke.anchor!;
          return <div key={stroke.id} className="ink-excerpt">
            <span>{a.unitLabel}</span><mark>{a.exact}</mark>
            <Button size="sm" variant="secondary" data-testid="ink-excerpt-ask" onPress={() => useSelectionAsk.getState().ask({ text: a.exact, source: a.source, unit: a.unit, unitLabel: a.unitLabel, annotation: 'highlight' }, 'compose')}>引用提问</Button>
            <Button size="sm" variant="tertiary" aria-label={`删除高亮：${a.exact.slice(0, 20)}`} onPress={() => ink.commit({ add: [], remove: [stroke] })}>删除</Button>
          </div>;
        })}
      </div>}
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
  const saved = ink.strokes.get(surface) ?? EMPTY;
  const [resolved, setResolved] = useState<InkStroke[]>(EMPTY);
  const strokes = useMemo(() => [...saved.filter((s) => !s.anchor), ...resolved], [saved, resolved]);
  const active = ink.ready && !disabled && ink.tool !== 'read';
  const preview = useRef<SVGPathElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const previewSvg = useRef<SVGSVGElement>(null);
  const gesture = useRef<{ id: number; stroke: InkStroke; erased: Set<string>; last: InkPoint; rect: DOMRect; tool: InkTool;
    text?: { index: TextIndex; start: number; end: number; at?: { x: number; y: number } } } | null>(null);
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

  // 只观察正文：PDF 延迟装载 / 字体就绪 / 文本重排时重建矩形，绝不改写源 DOM。
  useEffect(() => {
    const host = layer.current?.parentElement;
    if (!host || !saved.some((s) => s.anchor)) { setResolved(EMPTY); return; }
    let frame = 0;
    const update = () => {
      frame = 0;
      const index = indexText(host), bounds = host.getBoundingClientRect();
      if (!bounds.width) return;
      setResolved(saved.flatMap((s) => {
        if (!s.anchor) return [];
        const range = resolveTextAnchor(index.text, s.anchor);
        return range ? [{ ...s, height: bounds.height / bounds.width * 1000, rects: textRects(index, range.start, range.end, host) }] : [];
      }));
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const resize = new ResizeObserver(schedule);
    const mutation = new MutationObserver((changes) => {
      if (changes.some((c) => !(c.target instanceof Element ? c.target : c.target.parentElement)?.closest('.ink-layer'))) schedule();
    });
    resize.observe(host);
    mutation.observe(host, { childList: true, subtree: true, characterData: true });
    document.fonts.addEventListener('loadingdone', schedule);
    schedule();
    return () => { resize.disconnect(); mutation.disconnect(); document.fonts.removeEventListener('loadingdone', schedule); cancelAnimationFrame(frame); };
  }, [saved]);

  const point = (e: Pick<PointerEvent, 'clientX' | 'clientY' | 'pressure' | 'pointerType'>, rect: DOMRect, height = rect.height / rect.width * 1000): InkPoint => ({
    x: Math.max(0, Math.min(1000, (e.clientX - rect.left) / rect.width * 1000)),
    y: Math.max(0, Math.min(height, (e.clientY - rect.top) / rect.height * height)),
    pressure: e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5,
  });
  const updateText = () => {
    const g = gesture.current;
    if (!g?.text?.at) return;
    const hit = hitText(g.text.index, g.text.at.x, g.text.at.y, Infinity);
    g.text.at = undefined;
    if (!hit) return;
    const start = Math.min(g.text.start, hit.start), end = Math.max(g.text.end, hit.end);
    const host = layer.current!.parentElement!;
    g.stroke.anchor = makeTextAnchor(g.text.index, start, end, host, surface);
    g.stroke.rects = textRects(g.text.index, start, end, host);
  };
  const paint = () => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      updateText();
      const g = gesture.current;
      if (g && g.tool !== 'erase') preview.current?.setAttribute('d', inkPath(g.stroke, false));
    });
  };
  const capture = (e: PointerEvent) => {
    try { layer.current?.setPointerCapture(e.pointerId); } catch { /* 合成事件没有活动指针 */ }
  };
  const down = (e: PointerEvent) => {
    if (!active || e.button !== 0) return;
    if (ink.tool === 'smart' && e.pointerType !== 'pen') return;
    if (e.pointerType === 'touch' && ink.input.isBlockedTouch(e.pointerId)) return;
    if (e.pointerType === 'touch' && !ink.finger && ink.tool !== 'text-highlight' && ink.tool !== 'highlight') return;
    if (gesture.current || ink.input.drawing || (e.pointerType === 'touch' && !e.isPrimary)) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = layer.current!.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const host = layer.current!.parentElement!;
    const index = ink.tool === 'text-highlight' ? indexText(host) : undefined;
    const hit = index ? hitText(index, e.clientX, e.clientY) : null;
    if (index && !hit) { ink.setTool('smart'); return; }
    const p = point(e, rect);
    const stroke: InkStroke = {
      id: uuid(), materialId: ink.materialId, surface,
      tool: ink.tool === 'highlight' || index ? 'highlight' : 'pen', color: ink.color,
      width: ink.width * (ink.tool === 'highlight' ? 6 : 1) * 1000 / rect.width,
      height: rect.height / rect.width * 1000, points: [p], createdAt: Date.now(),
      renderer: 'freehand-v1', nib: ink.nib, opacity: ink.opacity, smoothing: ink.smoothing,
      input: e.pointerType === 'touch' ? 'touch' : e.pointerType === 'pen' ? 'pen' : 'mouse',
      ...(index && hit ? { anchor: makeTextAnchor(index, hit.start, hit.end, host, surface), rects: textRects(index, hit.start, hit.end, host) } : {}),
    };
    gesture.current = { id: e.pointerId, stroke, erased: new Set(), last: p, rect, tool: ink.tool,
      ...(index && hit ? { text: { index, ...hit } } : {}) };
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
  const move = (e: PointerEvent) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    e.preventDefault();
    // 工具栏换行、滚动或缩放后仍投回这一笔的坐标系，不能一直使用落笔时的屏幕位置。
    const rect = layer.current!.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    g.rect = rect;
    if (g.text) {
      g.text.at = { x: e.clientX, y: e.clientY };
      paint();
      return;
    }
    // Safari 旧版没有 coalesced events；空数组也必须回退到当前采样。
    const coalesced = e.getCoalescedEvents?.() ?? [];
    for (const event of coalesced.length ? coalesced : [e]) {
      const p = point(event, rect, g.stroke.height);
      if (g.tool === 'erase') erase(p);
      else if (Math.hypot(p.x - g.last.x, p.y - g.last.y) > (e.type === 'pointerup' ? 0 : 0.1 * 1000 / rect.width)) {
        g.stroke.points.push(p); g.last = p;
      }
    }
    paint();
  };
  const up = (e: PointerEvent) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    move(e);
    updateText(); // 抬手必须同步使用最终落点，不能等下一帧再保存。
    const oneShotHighlight = g.tool === 'highlight' || g.tool === 'text-highlight';
    ink.commit(g.tool === 'erase' ? { add: [], remove: saved.filter((s) => g.erased.has(s.id)) } : { add: [g.stroke], remove: [] });
    cancel();
    // 荧光笔是一次性动作：否则用户画完后继续滑页，会不断留下新的荧光笔迹。
    if (oneShotHighlight) ink.setTool('smart');
  };
  // 智能态覆盖层不拦截鼠标选字；在正文父节点接收笔事件并捕获后续笔画。
  useEffect(() => {
    const host = layer.current?.parentElement;
    if (!host || !active) return;
    const abort = (e: PointerEvent) => {
      if (gesture.current?.id !== e.pointerId) return;
      const oneShot = gesture.current.tool === 'highlight' || gesture.current.tool === 'text-highlight';
      cancel();
      if (oneShot) ink.setTool('smart');
    };
    host.addEventListener('pointerdown', down);
    host.addEventListener('pointermove', move);
    host.addEventListener('pointerup', up);
    host.addEventListener('pointercancel', abort);
    host.addEventListener('lostpointercapture', abort);
    return () => {
      host.removeEventListener('pointerdown', down); host.removeEventListener('pointermove', move);
      host.removeEventListener('pointerup', up); host.removeEventListener('pointercancel', abort);
      host.removeEventListener('lostpointercapture', abort);
    };
  });
  return <div ref={layer} className="ink-layer" data-active={active && ink.tool !== 'smart' || undefined} data-testid="ink-layer" data-ink-surface={surface}
    onContextMenu={(e) => { if (active) e.preventDefault(); }}>
    {strokes.map((stroke) => <SavedStroke key={stroke.id} stroke={stroke} />)}
    <svg ref={previewSvg} preserveAspectRatio="none" aria-hidden="true"><path ref={preview} /></svg>
  </div>;
}
