import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { XMarkdown } from '@ant-design/x-markdown';
import { db, type MaterialBlockRow } from '../store/db';
import type { MaterialReaderHandle } from '../materials/types';
import { extractMdUnits } from '../materials/md';
import { MarkdownCode, MarkdownPre } from './mermaid/markdown';
import { Shimmer } from './motion';
import '../materials/material-reader.css';

/**
 * 所见即所得编辑面走**动态 import**：CodeMirror 连同 markdown 语言包约 120KB gzip，
 * 而本组件在**每一份 md 材料上都会加载**。绝大多数用户只读材料、不编辑，
 * 不该为编辑面付首屏的体积与解析时间。
 *
 * 隔离成独立文件（src/md-editor/MdEditor.tsx）正是为了让这行 lazy 能把整棵
 * CodeMirror 依赖图切成单独的 chunk —— 直接在本文件 import 就做不到。
 */
const MdEditor = lazy(() => import('../md-editor/MdEditor'));

const MD_COMPONENTS = { code: MarkdownCode, pre: MarkdownPre };

/**
 * 「段标签还没查到」的稳定空表。
 * 模块级常量而不是 useState 的初始值：每次渲染 new 一个 Map 会让
 * 下面那个 useMemo 每次都重算，白白重切一遍段落。
 */
const NO_LABELS: ReadonlyMap<number, string> = new Map();

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
 * Markdown 阅读器（阅读态 + 所见即所得编辑态）。
 *
 * 渲染走问答正文同一套 XMarkdown（围栏出图继承过来）。
 * 定位单元优先用文件原文切段（与抽取规则同一函数），库里的块只用来补位置标签。
 * 不用分块后的文本拼回去：归一化会吃掉围栏和换行。
 */
export default function MdReader({ blob, materialId, initialUnit, handleRef, onUnitChange }: Props) {
  /**
   * 阅读态当前渲染的原文。`null` = 还没从 blob 读出来（首屏骨架）。
   *
   * 为什么它是 state 而不是每次 render 现读：编辑态退出来时要把用户改过的内容
   * 带回阅读态，而那**不能**靠重新读 blob —— blob 里还是落盘前的旧版本，
   * 当前阶段又没有保存管线（下一个任务才有）。从 blob 读一次存进来，
   * 之后阅读/编辑两个方向都在这一份文本上改。
   */
  const [text, setText] = useState<string | null>(null);
  /** 段标签（来自库里的分块结果），只随 materialId 变 —— 与正文内容无关。 */
  const [labels, setLabels] = useState<ReadonlyMap<number, string>>(NO_LABELS);
  const [error, setError] = useState<string | null>(null);
  const [mark, setMark] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);

  /**
   * 编辑态的最新全文。
   *
   * 刻意放 ref 而不放 state：每次按键都会调 onDirty，写 state 会让整个阅读器
   * （含工具条、切段观察器）跟着每个键重渲染一遍，而阅读区此时根本没挂载。
   * 只有「退出编辑」这一个时刻才需要读它 —— 那时统一写回 text。
   */
  const draftRef = useRef<string | null>(null);

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

  // ① 读文件全文。
  useEffect(() => {
    let cancelled = false;
    setText(null);
    setError(null);
    // 换材料必须把编辑态一起复位：草稿属于上一篇材料，留着会在新文章里凭空多出内容。
    draftRef.current = null;
    setEditing(false);
    void blob
      .text()
      .then((raw) => {
        if (!cancelled) setText(raw);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [blob]);

  // ② 段标签。
  //
  // 刻意与 ① 拆成两个 effect：如果合成一个，正文每改一个字都要重查一遍 materialBlocks。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const rows: MaterialBlockRow[] = await db.materialBlocks
        .where('materialId')
        .equals(materialId)
        .sortBy('idx');
      if (cancelled) return;
      const next = new Map<number, string>();
      for (const r of rows) {
        if (!next.has(r.unit)) next.set(r.unit, r.unitLabel.replace(/（\d+\/\d+）$/, ''));
      }
      setLabels(next);
    })().catch((e: unknown) => {
      if (!cancelled) setError(e instanceof Error ? e.message : String(e));
    });
    return () => {
      cancelled = true;
    };
  }, [materialId]);

  /**
   * 切段。纯函数，所以可以放 useMemo 而不是「setState + effect」那一套：
   * 两个异步源（正文、标签）都齐了才算得出 blocks，任一变化重算即可。
   *
   * 代价是退出编辑时（text 被换成草稿）会重切一次段落 —— 那是一次性的，
   * 比重构前那种「每次按键跑一遍」好得多（重构前没有这个中间态，见上）。
   */
  const blocks = useMemo<Block[] | null>(() => {
    if (text === null) return null;
    const units = extractMdUnits(text);
    if (units.length > 0) {
      return units.map((u) => ({
        unit: u.unit,
        label: labels.get(u.unit) ?? `第 ${u.unit} 段`,
        text: u.text,
        kind: u.kind ?? 'body',
      }));
    }
    return text.trim() ? [{ unit: 1, label: '第 1 段', text: text.trim(), kind: 'body' }] : [];
  }, [text, labels]);

  const ready = blocks !== null;
  const total = blocks?.length ?? 0;

  /**
   * 「阅读 → 编辑」。以**当前阅读文本**为初值，而不是重新读 blob：
   * 见上面 draftRef 那段注释 —— 这一阶段 blob 里还是旧的。
   */
  const enterEdit = useCallback(() => {
    if (text === null) return;
    draftRef.current = text;
    setEditing(true);
  }, [text]);

  /**
   * 「编辑 → 阅读」。把草稿带回去。
   *
   * 这一步是「往返不丢编辑」的全部实现：编辑态里 EditorView 是被销毁的
   * （退出就卸载），内容靠 draftRef 这个 ref 活下来。没有它的话，
   * 点一次「完成」就会把用户敲的字全丢掉 —— 而当前阶段又没有保存管线兜底。
   * 落盘管线接上之后（下一个任务），这一句会变成「先存再退」，本函数可以删掉。
   */
  const exitEdit = useCallback(() => {
    const draft = draftRef.current;
    setEditing(false);
    if (draft !== null && draft !== text) setText(draft);
  }, [text]);

  const handleDirty = useCallback((next: string) => {
    draftRef.current = next;
  }, []);

  useEffect(() => {
    const root = scrollRef.current;
    // 编辑态没有 .mr-scroll（滚动交给 CodeMirror 自己的 scroller），
    // 段号定位在这里没有意义 —— 顺带把观察器拆掉，别让它继续观察已卸载的节点。
    if (editing) return;
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
  }, [ready, blocks, editing]);

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
          {/* 编辑态不显示「第 N / M 段」：段号是阅读态的定位单位，
              编辑面里没有段落分界（也没挂 unitEls），显示它是在报一个看不见的东西。
              e2e 只在阅读态断言这个元素的文案（scripts/e2e-materials.mjs），
              所以这里换文案不影响它们。 */}
          {editing ? '编辑中' : ready ? `第 ${current} / ${total} 段` : <Shimmer text="载入中…" />}
        </span>
        <div className="mr-bar__spacer" />
        {ready && (
          <mdui-button
            variant={editing ? 'tonal' : 'outlined'}
            data-testid="md-edit-toggle"
            onClick={editing ? exitEdit : enterEdit}
          >
            {editing ? <mdui-sym-check slot="icon" /> : <mdui-sym-edit slot="icon" />}
            {editing ? '完成' : '编辑'}
          </mdui-button>
        )}
      </div>
      {error && (
        <div className="mr-hint" data-testid="reader-error">
          <mdui-sym-error />
          Markdown 打开失败：{error}
        </div>
      )}
      {editing ? (
        <Suspense
          fallback={
            <div className="mr-docx__skel">
              <mdui-circular-progress />
              正在加载编辑器…
            </div>
          }
        >
          <MdEditor initialText={text ?? ''} onDirty={handleDirty} />
        </Suspense>
      ) : (
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
      )}
    </div>
  );
}