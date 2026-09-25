import { useCallback, useEffect, useRef, useState } from 'react';
import { db, type MaterialBlockRow } from '../store/db';
import { extractHtmlUnits, sanitizeHtmlFragment } from '../materials/html';
import type { MaterialReaderHandle } from '../materials/types';
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
  handleRef: React.RefObject<MaterialReaderHandle | null>;
  onUnitChange?: (unit: number, total: number) => void;
}

/** 安全的 HTML 阅读器：按抽取段落渲染，支持断点续读、引用跳转与划词提问。 */
export default function HtmlReader({ blob, materialId, initialUnit, handleRef, onUnitChange }: Props) {
  const [blocks, setBlocks] = useState<Block[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mark, setMark] = useState<number | null>(null);
  const [current, setCurrent] = useState(1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const unitEls = useRef(new Map<number, HTMLElement>());

  const goto = useCallback((unit: number) => {
    const n = Math.max(1, Math.floor(unit));
    const el = unitEls.current.get(n);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setMark(n);
    setCurrent(n);
  }, []);

  useEffect(() => {
    handleRef.current = { scrollToUnit: goto };
    return () => {
      handleRef.current = null;
    };
  }, [handleRef, goto]);

  useEffect(() => {
    let cancelled = false;
    setBlocks(null);
    setError(null);
    unitEls.current.clear();
    (async () => {
      const units = extractHtmlUnits(await blob.text());
      const rows: MaterialBlockRow[] = await db.materialBlocks
        .where('materialId')
        .equals(materialId)
        .sortBy('idx');
      if (cancelled) return;
      const labelByUnit = new Map<number, string>();
      for (const row of rows) {
        if (!labelByUnit.has(row.unit)) labelByUnit.set(row.unit, row.unitLabel.replace(/（\d+\/\d+）$/, ''));
      }
      setBlocks(units.map((unit) => ({
        unit: unit.unit,
        label: labelByUnit.get(unit.unit) ?? `第 ${unit.unit} 段`,
        html: sanitizeHtmlFragment(unit.html),
        kind: unit.kind ?? 'body',
      })));
    })().catch((e) => {
      if (!cancelled) setError(e instanceof Error ? e.message : String(e));
    });
    return () => {
      cancelled = true;
    };
  }, [blob, materialId]);

  const ready = blocks !== null;
  const total = blocks?.length ?? 0;

  useEffect(() => {
    const root = scrollRef.current;
    if (!root || !ready || unitEls.current.size === 0) return;
    const io = new IntersectionObserver(
      (entries) => {
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
  }, [ready, blocks]);

  useEffect(() => {
    if (ready && total > 0) onUnitChange?.(current, total);
  }, [current, total, ready, onUnitChange]);

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
          HTML 打开失败：{error}
        </div>
      )}
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
