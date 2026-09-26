import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { db, type MaterialBlockRow } from '../store/db';
import {
  MR_UNIT_ATTR,
  prepareHtmlDocument,
  readHtmlText,
  sanitizeHtmlFragment,
  type PreparedHtml,
} from '../materials/html';
import { cleanSelectionText, isUsableSelection } from '../materials/region';
import { useSelectionAsk } from '../store/selectionAsk';
import { useSettings } from '../store/settings';
import { useMduiEvent } from '../ui/useMduiEvent';
import type { HtmlView, MaterialReaderHandle } from '../materials/types';
import '../materials/material-reader.css';

interface Block {
  unit: number;
  label: string;
  html: string;
  kind: string;
}

interface Props {
  blob: Blob;
  materialId: string;
  initialUnit?: number;
  /** 上次用的视图（入库值）。**只是初值** —— 见下方 `view` 状态。 */
  initialView: HtmlView;
  onViewChange: (view: HtmlView) => void;
  handleRef: React.RefObject<MaterialReaderHandle | null>;
  onUnitChange?: (unit: number, total: number) => void;
}

/** 视口顶部往下多少像素算「当前段」的判定线（iframe 自己的坐标系） */
const CURRENT_LINE = 72;

/**
 * 入库位置 → 落位目标。
 *
 * 单独抽出来是因为它有三处用法（初值、原样视图落位、分段视图落位），而「`initialUnit`
 * 是什么」这件事只有一个答案。`undefined` 与 `NaN` 都退回第 1 段：库里读到 NaN 时若照直
 * 用下去，指示器会渲染成「第 NaN / 5 段」—— 静默错账，比退回第 1 段难查得多。
 */
const toUnit = (n: number | undefined) => (typeof n === 'number' && Number.isFinite(n) && n > 1 ? Math.floor(n) : 1);

/**
 * HTML 阅读器：**原样视图**（默认）+ **分段视图**。
 *
 * ## 原样视图为什么是沙箱 iframe
 *
 * 在应用主文档里直接插导入文档，它自己的 CSS（`body{position:fixed}`、`*{display:none}`）
 * 一条就能锁死或覆盖整个界面，而 CSS 选择器无法安全地「作用域化」；Shadow DOM 挡得住
 * 样式泄漏，但视口相关规则（`position:fixed`、`html/body`、`@media`、独立滚动）仍按主文档算，
 * 一份为整页设计的文档塞进去必然错位。取舍详见
 * `docs/plans/2026-09-26-html-faithful-import-design.md` §3.1。
 *
 * `sandbox="allow-same-origin"` 是**唯一**授予的权限，且绝不能再加 `allow-scripts`：
 * 同源 + 可执行 = 沙箱形同虚设，导入文档能直接读写 IndexedDB / OPFS / API Key。
 * 保留 `allow-same-origin` 的唯一目的是让父窗口拿得到 `contentDocument` ——
 * 划词、`[第N段]` 跳转、滚动定位全靠它（见下方 `frameDocRef` 的接线）。
 *
 * ## 跨文档交互要自己接
 *
 * iframe 内的选区事件**不会冒泡到宿主 document**，全局浮层（`SelectionAsk`）收不到。
 * 所以这里接管 `contentDocument` 的三个事件，并把命中投进 `useSelectionAsk` 已有的
 * `bar` 通道（PDF 框选用的那条「外部投递」通道）—— 浮层组件因此一行都不用改。
 * 唯一的坑是**坐标**：iframe 内 `getBoundingClientRect()` 是它自己的坐标系，
 * 落到宿主视口必须加 iframe 的偏移，否则浮层会飘，且只在 iframe 不在视口原点时才显形。
 */
export default function HtmlReader({
  blob,
  materialId,
  initialUnit,
  initialView,
  onViewChange,
  handleRef,
  onUnitChange,
}: Props) {
  /**
   * 视图**由本组件持有**，而不是受控于 `videos.htmlView`。
   *
   * 为什么：`Player` 的 `video` 是一次性 `db.videos.get()` 的结果，写库不会回灌到 props ——
   * 若受控于入库值，点一下切换就会被旧值弹回去（表现为「点了没反应」）。
   * 入库只做「下次打开还记得」，所以它只当初值用。
   */
  const [view, setView] = useState<HtmlView>(initialView);
  /**
   * 初值取入库位置，不是 1。
   *
   * 与 `view` 取 `initialView` 对称，但这里不只是「首屏好看」：`ready` 一变 true，
   * 下面那个 `onUnitChange` effect 就会把 `current` 写回库。初值若是 1，打开一份断点在
   * 第 3 段的材料会**先写一次 1**、等文档加载完才写回 3 —— 中间那一下是真写库，
   * 窗口期内退出就把断点丢了（实测：重开后库里 `lastUnit=1`）。
   */
  const [current, setCurrent] = useState(() => toUnit(initialUnit));
  useEffect(() => {
    setView(initialView);
    setCurrent(toUnit(initialUnit));
  }, [initialView, initialUnit, materialId]);

  const changeView = useCallback(
    (next: HtmlView) => {
      setView(next);
      onViewChange(next);
    },
    [onViewChange],
  );

  const remoteSetting = useSettings((s) => s.htmlRemoteAssets);
  /** 「本次离线」：不动全局设置，只让这一份材料这次不联网（联网必须是可见、可撤回的行为） */
  const [offlineOnce, setOfflineOnce] = useState(false);
  const remote = remoteSetting && !offlineOnce;

  const [prepared, setPrepared] = useState<PreparedHtml | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [labels, setLabels] = useState<Map<number, string>>(() => new Map());
  const [mark, setMark] = useState<number | null>(null);
  /** 沙箱/同源假设没成立（读不到 contentDocument）：渲染照常，但划词与跳转会失效，必须说出来 */
  const [frameBlocked, setFrameBlocked] = useState(false);
  const [frameTick, setFrameTick] = useState(0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const unitEls = useRef(new Map<number, HTMLElement>());
  const frameRef = useRef<HTMLIFrameElement>(null);
  const frameDocRef = useRef<Document | null>(null);
  /** iframe 里全部 `data-mr-unit` 元素，文档序 —— 判定「当前段」用（重复段号不影响，取最后一个过线的） */
  const frameUnitsRef = useRef<Element[]>([]);
  const currentRef = useRef(1);
  const rafRef = useRef(0);

  const showBar = useSelectionAsk((s) => s.showBar);
  const hideBar = useSelectionAsk((s) => s.hideBar);

  useEffect(() => {
    currentRef.current = current;
  }, [current]);

  /* ── 读文件 → 净化 → 抽单元（原样视图与分段视图共用这一份结果） ─────────── */

  useEffect(() => {
    let cancelled = false;
    setPrepared(null);
    setError(null);
    unitEls.current.clear();
    (async () => {
      const src = await readHtmlText(blob);
      // 高亮色只能取出来写死：iframe 是独立文档，CSS 自定义属性不跨文档继承
      const markRgb = getComputedStyle(document.documentElement)
        .getPropertyValue('--mdui-color-primary')
        .trim();
      const next = prepareHtmlDocument(src, { remote, markRgb });
      const rows: MaterialBlockRow[] = await db.materialBlocks
        .where('materialId')
        .equals(materialId)
        .sortBy('idx');
      if (cancelled) return;
      // 位置标签仍以入库块为准（那边才带「§2.1」这类章节前缀），库里没有才退回「第 N 段」
      const map = new Map<number, string>();
      for (const row of rows) {
        if (!map.has(row.unit)) map.set(row.unit, row.unitLabel.replace(/（\d+\/\d+）$/, ''));
      }
      setLabels(map);
      setPrepared(next);
    })().catch((e) => {
      if (!cancelled) setError(e instanceof Error ? e.message : String(e));
    });
    return () => {
      cancelled = true;
    };
  }, [blob, materialId, remote]);

  const total = prepared?.units.length ?? 0;

  const blocks = useMemo<Block[] | null>(() => {
    if (!prepared) return null;
    return prepared.units.map((u) => ({
      unit: u.unit,
      label: labels.get(u.unit) ?? `第 ${u.unit} 段`,
      html: sanitizeHtmlFragment(u.html),
      kind: u.kind ?? 'body',
    }));
  }, [prepared, labels]);

  /* ── 定位：两个视图各一套，对外只暴露一个句柄 ───────────────────────────── */

  const gotoBlocks = useCallback((unit: number) => {
    const n = Math.max(1, Math.floor(unit));
    const el = unitEls.current.get(n);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setMark(n);
    setCurrent(n);
  }, []);

  const gotoRaw = useCallback((unit: number) => {
    const doc = frameDocRef.current;
    const n = Math.max(1, Math.floor(unit));
    const el = doc?.querySelector(`[${MR_UNIT_ATTR}="${n}"]`);
    if (!doc || !el) return;
    el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    // 一个单元可能落在多个元素上（标题 + 紧随的正文块），全部点亮才看得出整段
    doc.querySelectorAll('.mr-doc-mark').forEach((m) => m.classList.remove('mr-doc-mark'));
    doc.querySelectorAll(`[${MR_UNIT_ATTR}="${n}"]`).forEach((m) => m.classList.add('mr-doc-mark'));
    window.setTimeout(() => {
      doc.querySelectorAll('.mr-doc-mark').forEach((m) => m.classList.remove('mr-doc-mark'));
    }, 1600);
    setMark(n);
    setCurrent(n);
  }, []);

  useEffect(() => {
    handleRef.current = { scrollToUnit: (unit: number) => (view === 'raw' ? gotoRaw(unit) : gotoBlocks(unit)) };
    return () => {
      handleRef.current = null;
    };
  }, [handleRef, view, gotoRaw, gotoBlocks]);

  /** 切视图时把旧视图的浮层收掉，否则它会停在一个已经不存在的选区上 */
  useEffect(() => {
    hideBar();
  }, [view, hideBar]);

  /* ── 原样视图：接管 iframe ─────────────────────────────────────────────── */

  const onFrameLoad = useCallback(() => setFrameTick((n) => n + 1), []);

  useEffect(() => {
    if (view !== 'raw' || !prepared) return;
    const frame = frameRef.current;
    const doc = frame?.contentDocument;
    if (!frame || !doc) {
      setFrameBlocked(true);
      return;
    }
    /**
     * 文档还没加载完就**别往下走**。
     *
     * `srcdoc` 的 `contentDocument` 在加载完成前先是一个空的 `about:blank`：
     * 它非空（过得了上面的 `!doc` 判断），但里面没有任何东西。此时如果照常跑
     * `syncCurrent()`，`frameUnitsRef` 是空数组 → 循环一次都不进 → 把 `current` 误判成 1，
     * 接着 `onUnitChange` 就把 `lastUnit` 写成 1 —— 切视图带过来的位置当场被冲掉
     * （实测：分段 → 原样后指示器回到「第 1 / 5 段」，`lastUnit` 变回 1）。
     *
     * 这个 effect 本来就会在 `view` 变化时跑一次（那时文档还没加载），
     * 再在 `onLoad` → `frameTick` 时跑一次（那时才就绪）。所以这里直接返回、
     * 把活儿留给第二次即可 —— 不能在这里报 `frameBlocked`，那是「读不到文档」的提示，
     * 沙箱真的被拦时 `doc` 才是 null。
     */
    if (doc.readyState !== 'complete' || !doc.querySelector(`[${MR_UNIT_ATTR}]`)) return;
    setFrameBlocked(false);
    frameDocRef.current = doc;
    frameUnitsRef.current = Array.from(doc.querySelectorAll(`[${MR_UNIT_ATTR}]`));

    const syncCurrent = () => {
      let unit = 1;
      for (const el of frameUnitsRef.current) {
        if (el.getBoundingClientRect().top > CURRENT_LINE) break;
        const n = Number(el.getAttribute(MR_UNIT_ATTR));
        if (n > 0) unit = n;
      }
      setCurrent(unit);
    };

    const pushHit = () => {
      const sel = doc.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      const text = cleanSelectionText(sel.toString());
      if (!isUsableSelection(text)) return;
      const start = range.startContainer;
      const node = start.nodeType === Node.ELEMENT_NODE ? (start as Element) : start.parentElement;
      const host = node?.closest?.(`[${MR_UNIT_ATTR}]`) ?? null;
      const n = host ? Number(host.getAttribute(MR_UNIT_ATTR)) : NaN;
      const unit = Number.isFinite(n) && n > 0 ? n : undefined;
      const r = range.getBoundingClientRect();
      const box = frame.getBoundingClientRect();
      showBar(
        {
          text,
          source: 'html',
          unit,
          // 没有锚点的文字（导航、页脚等未抽为单元的内容）照旧可划词，只是不显示位置标签
          unitLabel: unit ? labels.get(unit) : undefined,
        },
        {
          x: Math.min(Math.max(box.left + r.left + r.width / 2, 104), window.innerWidth - 104),
          y: box.top + r.bottom,
        },
      );
    };

    let selTimer = 0;
    const onSelectionChange = () => {
      window.clearTimeout(selTimer);
      selTimer = window.setTimeout(pushHit, 140);
    };
    const onPointerDown = () => hideBar();
    const onScroll = () => {
      // 浮层锚点是宿主视口坐标，iframe 一滚就失效 —— 先收起，停稳后按新位置重算
      hideBar();
      window.clearTimeout(selTimer);
      selTimer = window.setTimeout(pushHit, 120);
      if (rafRef.current) return;
      rafRef.current = window.requestAnimationFrame(() => {
        rafRef.current = 0;
        syncCurrent();
      });
    };
    /** 外链：沙箱没有 allow-popups，`target=_blank` 点了没反应。交给父窗口打开，
     *  比授予 `allow-popups-to-escape-sandbox` 干净，且不放松沙箱。 */
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.('a[href]');
      const href = a?.getAttribute('href') ?? '';
      if (!/^https?:/i.test(href)) return;
      e.preventDefault();
      window.open(href, '_blank', 'noopener,noreferrer');
    };

    doc.addEventListener('selectionchange', onSelectionChange);
    doc.addEventListener('pointerdown', onPointerDown, true);
    doc.addEventListener('scroll', onScroll, true);
    doc.addEventListener('click', onClick, true);

    // 断点续读 / 切回原样视图：直接落位，不要 smooth（首屏滚动动画看着像卡了一下）。
    // 目标取「当前段」优先于入库的 initialUnit —— 切视图时用户的位置是当前段，不是上次入库值。
    const target = currentRef.current > 1 ? currentRef.current : toUnit(initialUnit);
    const el = target > 1 ? doc.querySelector(`[${MR_UNIT_ATTR}="${target}"]`) : null;
    el?.scrollIntoView({ block: 'start' });
    /**
     * **落位即位置：不在这里用几何重算。**
     *
     * 与分段视图「丢掉 IntersectionObserver 首批回调」是同一条道理 —— 进入视图不是用户动作，
     * 不该改写位置。几何只在用户**真的滚动**时说话（见上面的 `onScroll`）。
     *
     * 反例（实测踩到）：文档高度装得下时（本仓 fixture 约 250px 高、视口 704px），容器压根
     * 没有滚动条，`scrollIntoView` 是空操作，于是按「视口顶部所在单元」重算必然得到第 1 段 ——
     * 切视图带过来的 3 被改写成 1、还写回库，断点续读就废了（违反设计文档不变量 6）。
     * 这类「文档装得下」的输入很常见（存下来的文章片段、单页笔记），不是测试造的边角料。
     *
     * 只有**目标单元不存在**时才退回几何 —— 那时没有别的依据可依。
     */
    if (el) setCurrent(target);
    else syncCurrent();

    return () => {
      window.clearTimeout(selTimer);
      if (rafRef.current) window.cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      doc.removeEventListener('selectionchange', onSelectionChange);
      doc.removeEventListener('pointerdown', onPointerDown, true);
      doc.removeEventListener('scroll', onScroll, true);
      doc.removeEventListener('click', onClick, true);
    };
  }, [view, prepared, labels, initialUnit, showBar, hideBar, frameTick]);

  /* ── 分段视图：定位与断点续读（与原实现一致） ───────────────────────────── */

  const ready = view === 'raw' ? prepared !== null : blocks !== null;

  useEffect(() => {
    const root = scrollRef.current;
    if (view !== 'blocks' || !root || !blocks || unitEls.current.size === 0) return;
    /**
     * **丢掉首批回调。**
     *
     * `IntersectionObserver` 在 `observe()` 之后会立刻回调一次「当前交集状态」——
     * 那不是用户动作，而是**这个视图的初始状态**。对一份高度装得下的文档，
     * 容器压根没有滚动条，带子里必然只命中第 1 段，于是它会把 `current` 报成 1。
     *
     * 别的阅读器（Docx / Md / Pdf）没有这个问题：它们只有一种视图，挂载时报 1 恰好就是真话。
     * HTML 有**两种视图共用一个 `current` / `lastUnit`**，于是「切到分段视图」这一个动作
     * 会把原样视图记下的位置改写成 1（实测：切视图前 `lastUnit=3`，切完变 1，
     * 断点续读就废了 —— 违反设计文档不变量 6）。
     *
     * 丢掉首批之后：位置仍由「切换时带过来的 current」与跳转落位决定；
     * 用户真的滚动时 IO 会再报，那时才交给它。首批只在每次进入本视图时丢一次
     * （flag 声明在 effect 内，重新进入会重置）。
     */
    let firstBatch = true;
    const io = new IntersectionObserver(
      (entries) => {
        if (firstBatch) {
          firstBatch = false;
          return;
        }
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const n = Number((entry.target as HTMLElement).dataset.unit);
          if (n > 0) setCurrent(n);
        }
      },
      { root, rootMargin: '-8px 0px -88% 0px' },
    );
    for (const el of unitEls.current.values()) io.observe(el);
    return () => io.disconnect();
  }, [view, blocks]);

  /**
   * 进入分段视图时按「带过来的段号」落位 —— **每次进入都要做**，不是只做一次。
   *
   * 只做一次会漏掉「切走再切回来」这一路：那次进入不会再落位，于是容器停在顶部、
   * 指示器却报着带过来的段号 —— 位置丢了，而且看不出来（指示器在说谎，比单纯丢位置更难发现）。
   *
   * ⚠️ 一处**实测出来的**细节，免得以后有人按直觉改错：切视图时容器**不一定**被重挂。
   * 当前两个视图分支渲染的都是 `div`，React 会复用同一个节点，连带把滚动偏移一起保住 ——
   * 也就是说现在「只落一次也不出错」是**捡来的**，取决于一个跟本功能无关的 JSX 巧合
   * （实测：把容器换成 `section`，`scrollTop` 立刻从 340 变 0，第 3 段停在容器下方 480px）。
   * 落位逻辑不该建立在它上面，所以这里显式落位：节点复不复用，结果都一样。
   *
   * 判据是「视图」而不是 `blocks`：`prepared` / `labels` 变化会让 `blocks` 换引用，
   * 拿它当判据会在用户正读着的时候把他拽回落位点。
   */
  const landedRef = useRef(false);
  useEffect(() => {
    if (view !== 'blocks') {
      landedRef.current = false; // 离开本视图 → 下次进来要重新落位
      return;
    }
    if (!blocks || landedRef.current) return;
    landedRef.current = true;
    const target = currentRef.current > 1 ? currentRef.current : toUnit(initialUnit);
    if (target <= 1) return;
    unitEls.current.get(target)?.scrollIntoView({ block: 'start' });
  }, [view, blocks, initialUnit]);

  useEffect(() => {
    if (ready && total > 0) onUnitChange?.(current, total);
  }, [current, total, ready, onUnitChange]);

  /* ── 联网提示：联网必须是可见、可撤回的行为 ─────────────────────────────── */

  const stats = prepared?.stats;
  const netHint =
    stats && (stats.remoteLoaded > 0 || stats.remoteBlocked > 0 || stats.unresolved > 0) ? (
      <div className="mr-hint" data-testid="html-remote-hint">
        <mdui-sym-warning />
        <span>
          {stats.remoteLoaded > 0 && <>这份文件引用了 {stats.remoteLoaded} 项外部资源（图片 / 样式），正在联网加载。</>}
          {stats.remoteBlocked > 0 && <>有 {stats.remoteBlocked} 项外部资源未加载（联网加载已关闭）。</>}
          {stats.unresolved > 0 && <>另有 {stats.unresolved} 项引用本地相对路径，单文件导入无法解析。</>}
        </span>
        {stats.remoteLoaded > 0 && (
          <mdui-button variant="text" data-testid="html-offline-once" onClick={() => setOfflineOnce(true)}>
            本次离线
          </mdui-button>
        )}
      </div>
    ) : null;

  const viewGroupRef = useMduiEvent('mdui-segmented-button-group', 'change', (_e, el) => {
    const next = el.value;
    if (next === 'raw' || next === 'blocks') changeView(next);
  });

  return (
    <div className="mr-root" data-testid="material-reader">
      <div className="mr-bar">
        <span className="mr-bar__pos" data-testid="reader-page-indicator">
          {ready ? `第 ${current} / ${total} 段` : '载入中…'}
        </span>
        <div className="mr-bar__spacer" />
        <mdui-segmented-button-group
          ref={viewGroupRef}
          selects="single"
          value={view}
          data-testid="html-view"
        >
          <mdui-segmented-button value="raw">原样</mdui-segmented-button>
          <mdui-segmented-button value="blocks">分段</mdui-segmented-button>
        </mdui-segmented-button-group>
      </div>

      {error && (
        <div className="mr-hint" data-testid="reader-error">
          <mdui-sym-error />
          HTML 打开失败：{error}
        </div>
      )}
      {!error && frameBlocked && view === 'raw' && (
        <div className="mr-hint" data-testid="html-frame-blocked">
          <mdui-sym-warning />
          浏览器没有把这个沙箱文档交给页面读取，划词与段号跳转在本视图不可用（可切到「分段」视图）。
        </div>
      )}
      {!error && netHint}

      {error ? null : view === 'raw' ? (
        prepared ? (
          <div className="mr-frame-wrap">
            <iframe
              ref={frameRef}
              className="mr-frame"
              title="HTML 原样视图"
              /* 唯一授予的权限，且绝不能再加 allow-scripts —— 见文件头 */
              sandbox="allow-same-origin"
              srcDoc={prepared.doc}
              onLoad={onFrameLoad}
              data-testid="html-frame"
            />
          </div>
        ) : (
          <div className="mr-docx__skel">
            <mdui-circular-progress />
            正在排版文档…
          </div>
        )
      ) : (
        <div className="mr-scroll" ref={scrollRef}>
          <article className="mr-html">
            {blocks?.map((block) => (
              <section
                key={block.unit}
                className={block.unit === mark ? 'mr-html__block mr-html__block--mark' : 'mr-html__block'}
                data-unit={block.unit}
                data-askable="html"
                data-ask-unit={block.unit}
                data-ask-label={block.label}
                ref={(el) => {
                  if (el) unitEls.current.set(block.unit, el);
                  else unitEls.current.delete(block.unit);
                }}
              >
                <span className="mr-html__badge">第 {block.unit} 段</span>
                <div dangerouslySetInnerHTML={{ __html: block.html }} />
              </section>
            ))}
          </article>
          {!ready && (
            <div className="mr-docx__skel">
              <mdui-circular-progress />
              正在排版文档…
            </div>
          )}
        </div>
      )}
    </div>
  );
}
