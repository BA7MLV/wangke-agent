import { useCallback, useEffect, useRef, useState } from 'react';
import { XMarkdown } from '@ant-design/x-markdown';
import { db, type MaterialBlockRow } from '../store/db';
import type { MaterialReaderHandle } from '../materials/types';
import { extractMdUnits } from '../materials/md';
import { MarkdownCode, MarkdownPre } from './mermaid/markdown';
import '../materials/material-reader.css';

const MD_COMPONENTS = { code: MarkdownCode, pre: MarkdownPre };

interface Block {
  unit: number;
  label: string;
  text: string;
  kind: string;
}

interface Props {
  blob: Blob;
  materialId: string;
  initialUnit?: number;
  handleRef: React.RefObject<MaterialReaderHandle | null>;
  onUnitChange?: (unit: number, total: number) => void;
}

/**
 * Markdown 阅读器。
 *
 * 渲染走问答正文同一套 XMarkdown（围栏出图继承过来）。
 * 定位单元优先用文件原文切段（与抽取规则同一函数），库里的块只用来补位置标签。
 * 不用分块后的文本拼回去：归一化会吃掉围栏和换行。
 */
export default function MdReader({ blob, materialId, initialUnit, handleRef, onUnitChange }: Props) {
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
      const raw = await blob.text();
      const units = extractMdUnits(raw);
      const rows: MaterialBlockRow[] = await db.materialBlocks
        .where('materialId')
        .equals(materialId)
        .sortBy('idx');
      if (cancelled) return;
      const labelByUnit = new Map<number, string>();
      for (const r of rows) {
        if (!labelByUnit.has(r.unit)) labelByUnit.set(r.unit, r.unitLabel.replace(/（\d+\/\d+）$/, ''));
      }
      const next: Block[] =
        units.length > 0
          ? units.map((u) => ({
              unit: u.unit,
              label: labelByUnit.get(u.unit) ?? `第 ${u.unit} 段`,
              text: u.text,
              kind: u.kind ?? 'body',
            }))
          : raw.trim()
            ? [{ unit: 1, label: '第 1 段', text: raw.trim(), kind: 'body' }]
            : [];
      setBlocks(next);
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
          Markdown 打开失败：{error}
        </div>
      )}
      <div className="mr-scroll" ref={scrollRef}>
        <div className="mr-md">
          {blocks?.map((b) => (
            <div
              key={b.unit}
              className={
                b.unit === mark
                  ? 'mr-md__block mr-md__block--mark'
                  : b.kind === 'title'
                    ? 'mr-md__block mr-md__block--title'
                    : 'mr-md__block'
              }
              data-unit={b.unit}
              data-askable="md"
              data-ask-unit={b.unit}
              data-ask-label={b.label}
              ref={(el) => {
                if (el) unitEls.current.set(b.unit, el);
                else unitEls.current.delete(b.unit);
              }}
            >
              <span className="mr-md__badge">第 {b.unit} 段</span>
              <XMarkdown components={MD_COMPONENTS} content={b.text} />
            </div>
          ))}
        </div>
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
