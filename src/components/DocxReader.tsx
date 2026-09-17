import { useCallback, useEffect, useRef, useState } from 'react';
import { db, type MaterialBlockRow } from '../store/db';
import type { MaterialReaderHandle } from '../materials/types';
import '../materials/material-reader.css';

/**
 * Word 阅读器。
 *
 * 渲染直接用项目里已有的 `docx-preview`（讲义旧版预览用的就是它），输出真实 DOM，
 * 划词是浏览器原生能力，不需要像 PDF 那样自己搭文本层。
 *
 * ## 段落定位（划词提问与引用跳转都依赖它）
 *
 * 难点：抽取阶段产出的单元（`materialBlocks.unit`）与 docx-preview 渲染出来的 DOM 元素
 * 并不是现成的一一对应。这里靠**同一套「跳过空块、按文档顺序编号」的规则**把两者对齐：
 *
 * - DOM 侧：取 `section.docx` 下所有的 `p` / `table`（剔掉嵌套在别的 p/table 里的），
 *   丢掉 `textContent` 为空的，剩下的按顺序就是内容块。
 *   空块两边都会被丢：`<w:p/>` 抽不出文字，docx-preview 也渲染成空 `<p>`；
 *   **只含图片的段落**两边都算空（一个没有 `<w:t>`，一个 textContent 为 ''）—— 规则一致。
 * - 数据侧：`materialBlocks` 里**按 unit 去重**后再对齐。必须去重：长段落会被 `splitLongText`
 *   切成多块共用同一个 unit，而 DOM 里它还是一个 `<p>`，不去重就会错位。
 *
 * 这个不变式由 `scripts/e2e-materials.mjs` 断言（DOM 块数 === 去重后的 unit 数），
 * 一旦 Word 模板引入新结构就会在测试里炸出来，而不是让引用悄悄跳到错的段落。
 */

interface Props {
  blob: Blob;
  materialId: string;
  initialUnit?: number;
  handleRef: React.RefObject<MaterialReaderHandle | null>;
  onUnitChange?: (unit: number, total: number) => void;
}

export default function DocxReader({ blob, materialId, initialUnit, handleRef, onUnitChange }: Props) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [current, setCurrent] = useState(1);

  const scrollRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const unitEls = useRef(new Map<number, HTMLElement>());

  const flash = useCallback((el: HTMLElement) => {
    el.classList.remove('mr-flash');
    void el.offsetWidth;
    el.classList.add('mr-flash');
    window.setTimeout(() => el.classList.remove('mr-flash'), 900);
  }, []);

  const goto = useCallback(
    (unit: number) => {
      const el = unitEls.current.get(Math.max(1, Math.floor(unit)));
      if (!el) return;
      el.scrollIntoView({ block: 'start', behavior: 'smooth' });
      flash(el);
      setCurrent(unit);
    },
    [flash],
  );

  useEffect(() => {
    handleRef.current = { scrollToUnit: goto };
    return () => {
      handleRef.current = null;
    };
  }, [handleRef, goto]);

  // ── 渲染 + 段落打标 ──────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setError(null);
    unitEls.current.clear();

    (async () => {
      const { renderAsync } = await import('docx-preview');
      const body = bodyRef.current;
      if (!body) return;
      body.replaceChildren();
      await renderAsync(blob, body, undefined, {
        inWrapper: true,
        // 连续流阅读：分页留白在窄屏上很浪费，而且分页会把段落切断影响定位
        breakPages: false,
        ignoreHeight: true,
        // 页眉页脚多是页码/文件名之类的噪声，阅读视图不要它们
        renderHeaders: false,
        renderFooters: false,
        renderFootnotes: true,
        useBase64URL: true,
      });
      if (cancelled) return;

      // 数据侧：按 unit 去重（长段落被切成多块时共用一个 unit）
      const rows: MaterialBlockRow[] = await db.materialBlocks
        .where('materialId')
        .equals(materialId)
        .sortBy('idx');
      const labelByUnit = new Map<number, string>();
      for (const r of rows) {
        if (!labelByUnit.has(r.unit)) {
          // 去掉「（1/2）」这类切块后缀，位置描述要干净
          labelByUnit.set(r.unit, r.unitLabel.replace(/（\d+\/\d+）$/, ''));
        }
      }
      const units = [...labelByUnit.keys()].sort((a, b) => a - b);

      // DOM 侧：同一套「跳过空块」的规则
      const section = body.querySelector('section.docx') ?? body;
      const domBlocks = ([...section.querySelectorAll('p, table')] as HTMLElement[]).filter(
        (el) => !el.parentElement?.closest('p, table') && (el.textContent ?? '').trim().length > 0,
      );

      if (units.length > 0 && units.length !== domBlocks.length) {
        // 不阻断阅读：错位只影响跳转落点，不该让整个文档打不开。但必须在测试里被发现。
        console.warn(
          `[材料] Word 段落数与 DOM 块数不一致（${units.length} vs ${domBlocks.length}），` +
            '引用跳转可能落到相邻段落。请检查 docx-preview 的输出结构是否变了。',
        );
      }

      domBlocks.forEach((el, i) => {
        const unit = units[i] ?? i + 1;
        const label = labelByUnit.get(unit) ?? `第 ${unit} 段`;
        el.dataset.unit = String(unit);
        el.dataset.askable = 'docx';
        el.dataset.askLabel = label;
        // 同一 unit 只登记第一个块（跳转落到该段开头即可）
        if (!unitEls.current.has(unit)) unitEls.current.set(unit, el);
      });

      setTotal(units.length || domBlocks.length);
      setReady(true);
    })().catch((e) => {
      if (!cancelled) setError(e instanceof Error ? e.message : String(e));
    });

    return () => {
      cancelled = true;
    };
  }, [blob, materialId]);

  // ── 当前位置跟踪（顶部窄带命中法，与 PdfReader 一致） ────────────────────
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || !ready || unitEls.current.size === 0) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const n = Number((e.target as HTMLElement).dataset.unit);
          if (n > 0) setCurrent(n);
        }
      },
      { root, rootMargin: '-8px 0px -88% 0px' },
    );
    for (const el of unitEls.current.values()) io.observe(el);
    return () => io.disconnect();
  }, [ready]);

  useEffect(() => {
    if (ready && total > 0) onUnitChange?.(current, total);
  }, [current, total, ready, onUnitChange]);

  // 首屏落到断点续读的位置
  const jumpedRef = useRef(false);
  useEffect(() => {
    if (jumpedRef.current || !ready || !initialUnit || initialUnit <= 1) return;
    jumpedRef.current = true;
    unitEls.current.get(initialUnit)?.scrollIntoView({ block: 'start' });
  }, [ready, initialUnit]);

  return (
    <div className="mr-root" data-testid="material-reader">
      <div className="mr-bar">
        <span className="mr-bar__pos" data-testid="reader-page-indicator">
          {ready ? `第 ${current} / ${total} 段` : '载入中…'}
        </span>
        <div className="mr-bar__spacer" />
      </div>
      {error && (
        <div className="mr-hint" data-testid="reader-error">
          <mdui-sym-error />
          Word 打开失败：{error}
        </div>
      )}
      <div className="mr-scroll" ref={scrollRef}>
        <div className="mr-docx" ref={bodyRef} />
        {!ready && !error && (
          <div className="mr-docx__skel">
            <mdui-circular-progress />
            正在排版文档…
          </div>
        )}
      </div>
    </div>
  );
}
