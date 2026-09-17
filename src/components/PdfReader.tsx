import { useCallback, useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import {
  openPdf,
  readPdfOutline,
  renderPageToCanvas,
  renderTextLayer,
  type OutlineEntry,
} from '../materials/pdf';
import {
  cropCanvasRegion,
  isUsableRegion,
  normalizeRect,
  textInRect,
  type RectCss,
  type RegionImage,
} from '../materials/region';
import { useSelectionAsk } from '../store/selectionAsk';
import type { MaterialReaderHandle } from '../materials/types';
import '../materials/material-reader.css';

/**
 * PDF 阅读器。
 *
 * ## 窗口化渲染
 *
 * 每一页都先挂一个**按真实比例占位的空壳**，只有进入视口附近（±600px）的页才真正
 * 建 canvas 画内容、建文本层。理由：一本 300 页的教材若全量渲染，就是 300 张 canvas
 * （每张按 dpr 放大后 ~4000×5600 设备像素），iPad 上必崩。
 * 占位壳常驻还有个好处：`scrollToUnit` 永远能找到元素，不需要「先渲染再滚动」的两段式。
 *
 * ## 文本层与框选共存的方案
 *
 * 两者都要吃拖动，会打架。这里不靠手势区分（长按已被原生选择占用），而是**显式工具态**：
 * 默认「选字」（文本层吃事件），点工具栏的框选按钮进入「框选」态（文本层 `pointer-events:none`，
 * 覆盖层接管），框完一次自动退出 —— 免得用户忘了自己在框选态、以为「选不了字了」。
 */

/** 视口外多渲染这么高，滚动时不至于看到白页 */
const RENDER_AHEAD_PX = 600;

interface Props {
  fileUrl: string;
  initialUnit?: number;
  handleRef: React.RefObject<MaterialReaderHandle | null>;
  /** 阅读位置变化（上层据此写 videos.lastUnit 断点续读） */
  onUnitChange?: (unit: number, total: number) => void;
}

export default function PdfReader({ fileUrl, initialUnit, handleRef, onUnitChange }: Props) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [outline, setOutline] = useState<OutlineEntry[]>([]);
  const [numPages, setNumPages] = useState(0);
  const [error, setError] = useState<string | null>(null);
  /** 内容区可用宽度（不含内边距）：页面宽度 = 它 × zoom */
  const [avail, setAvail] = useState(0);
  /** height/width，按页记录；未测到的页先用 A4 比例占位 */
  const [aspects, setAspects] = useState<number[]>([]);
  const [visible, setVisible] = useState<ReadonlySet<number>>(() => new Set());
  const [current, setCurrent] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [areaMode, setAreaMode] = useState(false);
  const [jumpDraft, setJumpDraft] = useState('');

  const scrollRef = useRef<HTMLDivElement>(null);
  const pageEls = useRef(new Map<number, HTMLDivElement>());
  const showBar = useSelectionAsk((s) => s.showBar);

  // ── 打开文档 ──────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    let opened: PDFDocumentProxy | null = null;
    setError(null);
    setDoc(null);
    setNumPages(0);
    (async () => {
      try {
        const d = await openPdf(fileUrl);
        if (cancelled) {
          void d.destroy();
          return;
        }
        opened = d;
        setDoc(d);
        setNumPages(d.numPages);
        setAspects(new Array(d.numPages).fill(0));
        void readPdfOutline(d).then((o) => !cancelled && setOutline(o));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
      void opened?.destroy();
    };
  }, [fileUrl]);

  // ── 容器宽度 ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      const cs = getComputedStyle(el);
      const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      setAvail(Math.max(120, el.clientWidth - pad));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pageWidth = Math.max(120, Math.round(avail * zoom));
  const pageHeightOf = useCallback(
    (n: number) => Math.round(pageWidth * (aspects[n - 1] > 0 ? aspects[n - 1] : 1.414)),
    [pageWidth, aspects],
  );

  const onMeasured = useCallback((n: number, aspect: number) => {
    setAspects((prev) => {
      if (Math.abs((prev[n - 1] ?? 0) - aspect) < 0.005) return prev; // 抖动阈值：避免无限重渲染
      const next = prev.slice();
      next[n - 1] = aspect;
      return next;
    });
  }, []);

  // ── 两个 IntersectionObserver：一个决定「渲染哪几页」，一个决定「当前是第几页」 ──
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || numPages === 0) return;
    const els = [...pageEls.current.entries()];
    if (els.length === 0) return;

    const ioRender = new IntersectionObserver(
      (entries) => {
        setVisible((prev) => {
          const next = new Set(prev);
          for (const e of entries) {
            const n = Number((e.target as HTMLElement).dataset.page);
            if (e.isIntersecting) next.add(n);
            else next.delete(n);
          }
          return next;
        });
      },
      { root, rootMargin: `${RENDER_AHEAD_PX}px 0px` },
    );
    // 顶部一条窄带：落在带子里的页就是「当前页」（比按 scrollTop 遍历所有页便宜得多）
    const ioCurrent = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) setCurrent(Number((e.target as HTMLElement).dataset.page));
        }
      },
      { root, rootMargin: '-8px 0px -88% 0px' },
    );

    for (const [, el] of els) {
      ioRender.observe(el);
      ioCurrent.observe(el);
    }
    return () => {
      ioRender.disconnect();
      ioCurrent.disconnect();
    };
  }, [numPages, pageWidth]);

  // 位置变化上报（断点续读）
  useEffect(() => {
    if (numPages > 0) onUnitChange?.(current, numPages);
  }, [current, numPages, onUnitChange]);

  // ── 跳转 ──────────────────────────────────────────────────────────────────
  const flash = useCallback((el: HTMLElement) => {
    el.classList.remove('mr-flash');
    // 强制回流，保证连续两次跳同一页也能重放动画
    void el.offsetWidth;
    el.classList.add('mr-flash');
    window.setTimeout(() => el.classList.remove('mr-flash'), 900);
  }, []);

  const goto = useCallback(
    (unit: number) => {
      const n = Math.min(Math.max(1, Math.floor(unit)), Math.max(1, numPages));
      const el = pageEls.current.get(n);
      if (!el) return;
      el.scrollIntoView({ block: 'start', behavior: 'smooth' });
      flash(el);
      setCurrent(n);
    },
    [numPages, flash],
  );

  useEffect(() => {
    handleRef.current = { scrollToUnit: goto };
    return () => {
      handleRef.current = null;
    };
  }, [handleRef, goto]);

  // 首屏落到断点续读的位置（等页码与占位壳都就绪）
  const jumpedRef = useRef(false);
  useEffect(() => {
    if (jumpedRef.current || !initialUnit || initialUnit <= 1 || numPages === 0) return;
    if (pageEls.current.size < numPages) return;
    jumpedRef.current = true;
    // 不要 smooth：首次进入直接落位，滚动动画反而像卡了一下
    const el = pageEls.current.get(Math.min(initialUnit, numPages));
    el?.scrollIntoView({ block: 'start' });
  }, [initialUnit, numPages]);

  const submitJump = () => {
    const n = Number(jumpDraft.replace(/\D/g, ''));
    if (n > 0) goto(n);
    setJumpDraft('');
  };

  /** 框选完成 → 投给浮层（与划词走同一个动作条） */
  const onRegion = useCallback(
    (payload: { unit: number; image: RegionImage | null; text: string }) => {
      showBar(
        {
          // 只有图、没文字时给一个能读的占位，避免引用条上出现空白
          text: payload.text || `（第 ${payload.unit} 页的框选区域，仅图片）`,
          source: 'pdf',
          unit: payload.unit,
          unitLabel: `第 ${payload.unit} 页`,
          image: payload.image ?? undefined,
        },
        { x: Math.round(window.innerWidth / 2), y: Math.round(window.innerHeight * 0.6) },
      );
      setAreaMode(false); // 框完自动退出，避免用户困惑于「为什么选不了字」
    },
    [showBar],
  );

  if (error) {
    return (
      <div className="mr-root">
        <div className="mr-hint" data-testid="reader-error">
          <mdui-sym-error />
          PDF 打开失败：{error}
        </div>
      </div>
    );
  }

  return (
    <div className="mr-root" data-testid="material-reader">
      <div className="mr-bar">
        <mdui-button-icon
          data-testid="reader-prev"
          title="上一页"
          disabled={current <= 1 ? true : undefined}
          onClick={() => goto(current - 1)}
        >
          <mdui-sym-chevron-right className="mr-bar__flip" />
        </mdui-button-icon>
        <span className="mr-bar__pos" data-testid="reader-page-indicator">
          {numPages === 0 ? '载入中…' : `${current} / ${numPages}`}
        </span>
        <mdui-button-icon
          data-testid="reader-next"
          title="下一页"
          disabled={numPages === 0 || current >= numPages ? true : undefined}
          onClick={() => goto(current + 1)}
        >
          <mdui-sym-chevron-right />
        </mdui-button-icon>
        <mdui-text-field
          className="mr-bar__input"
          variant="outlined"
          type="number"
          inputmode="numeric"
          placeholder="页码"
          value={jumpDraft}
          data-testid="reader-jump"
          onInput={(e) => setJumpDraft(e.currentTarget.value)}
          // 回车必须自己接：mdui-text-field 的 change 事件在「失焦」时才发，
          // 只靠 onChange 的话「输入页码回车」什么都不会发生（用户会以为跳页坏了）
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            submitJump();
          }}
          onChange={submitJump}
        />
        <div className="mr-bar__spacer" />
        <mdui-button-icon
          data-testid="reader-zoom-out"
          title="缩小"
          onClick={() => setZoom((z) => Math.max(0.5, Math.round((z - 0.1) * 10) / 10))}
        >
          <mdui-sym-zoom-out />
        </mdui-button-icon>
        <span className="mr-bar__pos">{Math.round(zoom * 100)}%</span>
        <mdui-button-icon
          data-testid="reader-zoom-in"
          title="放大"
          onClick={() => setZoom((z) => Math.min(3, Math.round((z + 0.1) * 10) / 10))}
        >
          <mdui-sym-zoom-in />
        </mdui-button-icon>
        {outline.length > 0 && (
          <mdui-dropdown>
            <mdui-button-icon slot="trigger" data-testid="reader-outline" title="目录">
              <mdui-sym-toc />
            </mdui-button-icon>
            <mdui-menu>
              {outline.slice(0, 200).map((e, i) => (
                <mdui-menu-item key={`${e.page}-${i}`} onClick={() => goto(e.page)}>
                  {e.title}
                  <span slot="end" className="mr-bar__pos">{e.page}</span>
                </mdui-menu-item>
              ))}
            </mdui-menu>
          </mdui-dropdown>
        )}
        {/* 框选开关：显式工具态，避免和「拖选文字」抢同一个手势 */}
        <mdui-button
          variant={areaMode ? 'filled' : 'outlined'}
          data-testid="reader-tool-areaselect"
          title="框选一块区域当图片提问"
          onClick={() => setAreaMode((v) => !v)}
        >
          <mdui-sym-crop-free slot="icon" />
          {areaMode ? '框选中…' : '框选'}
        </mdui-button>
      </div>

      {areaMode && (
        <div className="mr-hint" data-testid="reader-area-hint">
          <mdui-sym-crop-free />
          在页面上拖出要提问的区域（框完自动退出框选）
        </div>
      )}

      <div className="mr-scroll" ref={scrollRef}>
        {Array.from({ length: numPages }, (_, i) => i + 1).map((n) => (
          <div
            key={n}
            className={areaMode ? 'mr-page mr-page--area' : 'mr-page'}
            data-page={n}
            // 划词提问的契约：浮层靠这几个属性反查「选的是哪一页」
            data-askable="pdf"
            data-ask-unit={n}
            data-ask-label={`第 ${n} 页`}
            style={{ width: pageWidth, height: pageHeightOf(n) }}
            ref={(el) => {
              if (el) pageEls.current.set(n, el);
              else pageEls.current.delete(n);
            }}
          >
            {!visible.has(n) && <div className="mr-page__skel">{n}</div>}
            {visible.has(n) && (
              <PdfPageLayer
                doc={doc!}
                num={n}
                width={pageWidth}
                areaMode={areaMode}
                onMeasured={onMeasured}
                onRegion={onRegion}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

interface LayerProps {
  doc: PDFDocumentProxy;
  num: number;
  width: number;
  areaMode: boolean;
  onMeasured: (n: number, aspect: number) => void;
  onRegion: (p: { unit: number; image: RegionImage | null; text: string }) => void;
}

/**
 * 单页的 canvas + 文本层 + 框选覆盖层。只在页面进入渲染窗口时挂载，
 * 卸载时必须同时 cancel 掉渲染任务与文本层流 —— 否则滚动快了会积一堆半成品，
 * 还会撞上 pdf.js 的「同一 canvas 重复 render」限制。
 */
function PdfPageLayer({ doc, num, width, areaMode, onMeasured, onRegion }: LayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useState(1);
  const [rendered, setRendered] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let cancelRender: (() => void) | null = null;
    let textLayer: { cancel: () => void } | null = null;

    (async () => {
      const page: PDFPageProxy = await doc.getPage(num);
      if (cancelled) return;
      const base = page.getViewport({ scale: 1 });
      onMeasured(num, base.height / base.width);

      const handle = renderPageToCanvas(page, canvasRef.current!, width, window.devicePixelRatio || 1);
      cancelRender = handle.cancel;
      setRatio(canvasRef.current!.width / handle.viewport.width);
      try {
        await handle.done;
      } catch {
        return; // 被取消：正常路径，不是错误
      }
      if (cancelled) return;

      const layer = await renderTextLayer(page, textRef.current!, handle.viewport);
      if (cancelled) {
        layer.cancel();
        return;
      }
      textLayer = layer;
      setRendered(true);
    })().catch(() => {
      /* 页面被销毁/取消时的异常不必打扰用户 */
    });

    return () => {
      cancelled = true;
      cancelRender?.();
      textLayer?.cancel();
    };
  }, [doc, num, width, onMeasured]);

  // ── 框选 ────────────────────────────────────────────────────────────────
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<RectCss | null>(null);

  const localPoint = (e: React.PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - box.left, y: e.clientY - box.top };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!areaMode || !rendered) return;
    // 先记起点再尝试指针捕获：捕获只是「手指移出元素后仍能收到 move」的优化，
    // 失败（个别浏览器/合成事件 pointerId 不合法）不该让整个框选失效 —— 顺序反了就会这样
    startRef.current = localPoint(e);
    setDrag({ ...startRef.current, w: 0, h: 0 });
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* 捕获失败也能用，只是拖出页面边缘会丢 move */
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!startRef.current) return;
    setDrag(normalizeRect(startRef.current, localPoint(e)));
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = startRef.current;
    startRef.current = null;
    setDrag(null);
    if (!start || !areaMode || !rendered) return;
    const rect = normalizeRect(start, localPoint(e));
    if (!isUsableRegion(rect)) return;

    const canvas = canvasRef.current;
    const image = canvas ? cropCanvasRegion(canvas, rect, ratio) : null;
    // 顺手把框内文字也取出来：图 + 字双通道，公式/表格这类纯视觉识别易错的内容更稳
    const text = textRef.current ? textInRect(textRef.current, rect) : '';
    onRegion({ unit: num, image, text });
  };

  return (
    <>
      <canvas ref={canvasRef} />
      <div className="textLayer" ref={textRef} />
      <div
        className="mr-area"
        data-testid="reader-area-layer"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          startRef.current = null;
          setDrag(null);
        }}
      >
        {drag && (
          <div
            className="mr-area__rect"
            style={{ left: drag.x, top: drag.y, width: drag.w, height: drag.h }}
          />
        )}
      </div>
    </>
  );
}
