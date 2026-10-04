import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { XMarkdown } from '@ant-design/x-markdown';
import { db, type MaterialBlockRow } from '../store/db';
import { getMaterialFile } from '../store/fileStore';
import type { MaterialReaderHandle } from '../materials/types';
import { extractMdUnits } from '../materials/md';
// ⚠️ **只要类型**。写成普通 import 会把整棵 CodeMirror 依赖图拖进 MdReader 的静态图，
// 那正是这个文件用 React.lazy 隔离掉的那 120KB（理由见上面那段注释）。
import type { MdEditorHandle } from '../md-editor/MdEditor';
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
   * 阅读态当前渲染的原文。`null` = 还没读出来（首屏骨架 / 换材料）。
   *
   * 它是 state 而不是每次 render 现读：编辑态退出来时要把用户改过的内容带回阅读态，
   * 而那一瞬不能靠「重新读 blob」——`blob` 是落盘前那一版的不可变快照（见下面 ①）。
   * 于是编辑期间另有一份草稿接着（draftRef），退出时先接回来，
   * 紧接着保存成功触发的重读会把盘上那一版换进来（两者逐字相同）。
   */
  const [text, setText] = useState<string | null>(null);
  /** 段标签（来自库里的分块结果）：随 materialId 变，保存成功后也变（块集换过了，见下面 ②） */
  const [labels, setLabels] = useState<ReadonlyMap<number, string>>(NO_LABELS);
  const [error, setError] = useState<string | null>(null);
  const [mark, setMark] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);

  /**
   * 「这份材料已经换过一版」的标记，值是 save.ts 的 savedAt（毫秒时间戳）。
   *
   * 它只当**依赖项**用，不当「这是不是当前材料」的判据（那是 readForRef 的事）：
   * savedAt「每次成功落盘必变」，每次落盘都换一个值，于是依赖必然失效。
   * 刻意不自己计数 —— 计数在 StrictMode 双挂载下会被多拨一轮，
   * 多出来的那个 token 会凭空再读一次文件（无害，但白做功且让日志失真）。
   */
  const [savedAt, setSavedAt] = useState<number | null>(null);

  /** 上一次读的是哪份材料。见下面 ① 里它把「换材料」与「同材料重读」分开的那段。 */
  const readForRef = useRef<string | null>(null);

  /**
   * 编辑态的最新全文（逐键更新，走 ref 不走 state）。
   *
   * 走 ref：每次按键都会调 onDirty，写 state 会让整个阅读器（含工具条、切段观察器）
   * 跟着每个键重渲染一遍，而阅读区此时根本没挂载。
   *
   * 它的职责现在只剩一个：**「完成」那一瞬把内容接回来**。
   * flush 成功之后盘上那一版与这份草稿必然逐字相同（flush 写的就是它），
   * 所以它不是第二份真相，只是让切换不必等一次 OPFS 重读；
   * 真正说了算的还是下面 ① 从盘上重读回来的那一版。
   */
  const draftRef = useRef<string | null>(null);

  /** 编辑面交上来的 flush。null = 编辑面还没挂上（lazy chunk 还在路上）或已经卸载 */
  const editorRef = useRef<MdEditorHandle | null>(null);

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
  //
  // 触发它的是两件事，同一个出口：
  //   - **换材料**（materialId 变）：读 MaterialReader 传进来的 blob，并把阅读器整个复位；
  //   - **同材料重读**（savedAt 变）：回 OPFS 重读盘上那一版。
  //
  // 分开判据而不是看 savedAt 是不是 null：复位那一段里有 setEditing(false)，
  // 而它一旦因为「顺便又跑了一趟」而误触发，就会把用户从正在编辑的文档里踢出去
  // （丢的是没落盘的那部分）。只有 materialId 真的变了才允许复位。
  useEffect(() => {
    let cancelled = false;
    const switched = readForRef.current !== materialId;
    readForRef.current = materialId;
    const reload = !switched && savedAt !== null;
    if (switched) {
      setText(null);
      setError(null);
      // 换材料必须把编辑态一起复位：草稿属于上一篇材料，留着会在新文章里凭空多出内容。
      draftRef.current = null;
      setEditing(false);
    }
    /**
     * 重读为什么不复用 `blob` 这个 prop：Blob 是**不可变快照**，对同一个对象再 text()
     * 永远拿落盘前那一版（MaterialReader 只在换材料时读一次）。
     *
     * 而阅读视图该显示什么，唯一说了算的是盘上那份。落盘是三步（写 blob → 重建块 →
     * 清阅读位置，详见 save.ts 的 persistMd），中间可能只成了一半 —— 只让编辑器的
     * 汇报驱动界面，就会在「原文存下了、检索还是旧的」这种状态下显示一份与检索不一致的正文。
     */
    const read = reload
      ? getMaterialFile(materialId).then((fresh) => fresh?.text() ?? null)
      : blob.text();
    void read.then(
      (raw) => {
        if (cancelled) return;
        if (raw === null) {
          /**
           * 只有重读会走到这里（初读时 blob 已经在手上，不可能是 null）：文件读不回来了。
           * **不清正文** —— 清了就只剩一块空白，而用户刚刚才把这一版写上去；
           * 讲清楚「显示的还是上一次读到的版本」比假装没事好。
           */
          setError('保存之后没能从磁盘重新读到这份材料（文件可能已被删除），正文暂时还是上一次读到的版本。');
          return;
        }
        setText(raw);
        // 读到正文就说明「正文这一侧」没有失败：上一次留下的「重读失败」不该一直挂着
        // （段标签那边的失败会由 ② 自己重新报，它在同一个 savedAt 上也会重跑）。
        setError(null);
      },
      (e: unknown) => {
        if (cancelled) return;
        const detail = e instanceof Error ? e.message : String(e);
        setError(reload ? `保存后重新读取失败：${detail}` : `Markdown 打开失败：${detail}`);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [blob, materialId, savedAt]);

  // ② 段标签。
  //
  // 刻意与 ① 拆成两个 effect：如果合成一个，正文每改一个字都要重查一遍 materialBlocks。
  //
  // savedAt 在依赖里，是因为它意味着**块集换过了**：save.ts 的 persistMd 重建了整张
  // materialBlocks 表，unit 与 unitLabel 的对应关系随之改变。不重查的话，
  // 阅读视图会拿新正文配旧段标签（问答按段号引用时跳到的标题就不对了）。
  // 换材料时顺带多跑一趟是无害的：查询按 materialId 过滤，拿回来的只会是当前这份的标签。
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
  }, [materialId, savedAt]);

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
   * 「阅读 → 编辑」。以**当前已知的那一版**为初值，而不是重新读 blob：
   * 见 draftRef 那段注释 —— 它保证「退出再立刻进」也不会退回旧内容。
   */
  const enterEdit = useCallback(() => {
    if (text === null) return;
    draftRef.current = text;
    setEditing(true);
  }, [text]);

  /**
   * 「编辑 → 阅读」：**先存再退**。
   *
   * 保存发生在 MdEditor 里（那里才有 saver 与 OPFS 句柄），这里是唯一的调用方：
   * `await flush()` 的承诺是「这一版确实在盘上」，没落成它会 reject。
   *
   * 失败就**不切**。此刻 EditorView 还活着、用户敲的字一个字都没丢，
   * 而失败原因就显示在编辑面自己的提示条上（原文没写下去 / 原文存下了但检索还是旧的 /
   * 只剩阅读位置没重置 —— 三种后果不同，用户该做的事也不同，见 save.ts 的 MdSaveError）。
   * 静默切回阅读态等于宣布「保存成功」，用户会以为存好了然后关掉页面。
   */
  const exitEdit = useCallback(async () => {
    const editor = editorRef.current;
    if (!editor) {
      // 编辑面还没挂上（lazy chunk 还在路上）：没有改动，也就没什么可存的
      setEditing(false);
      return;
    }
    try {
      await editor.flush();
    } catch {
      return;
    }
    // 存成了：把草稿立刻接回来，切回阅读态不必等那次 OPFS 重读（① 会用盘上那版覆盖它，
    // 两者逐字相同，所以谁先落地都看不出差别）。
    const draft = draftRef.current;
    setEditing(false);
    if (draft !== null && draft !== text) setText(draft);
  }, [text]);

  const handleDirty = useCallback((next: string) => {
    draftRef.current = next;
  }, []);

  /** 编辑面挂上/卸载时交上来的 flush 句柄（存到 ref：切按钮时不该触发重渲染） */
  const handleEditor = useCallback((h: MdEditorHandle | null) => {
    editorRef.current = h;
  }, []);

  /** 落盘成功 → 记下这一刻，作为 ① 与 ② 的重跑信号 */
  const handleSaved = useCallback((at: number) => {
    setSavedAt(at);
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
          {/* 文案自带「发生了什么」的前缀（见上面 ① 里的两处 setError），
              所以这里不再统一加「Markdown 打开失败：」—— 保存后重读失败不是打开失败。 */}
          <span>{error}</span>
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
          {/*
            initialText 传的是**当前已知的那一版**：进入编辑前 text 一定已就绪（enterEdit 的前提），
            而它要么来自 blob、要么来自上一次保存成功后的 OPFS 重读 —— 不会是落盘前的旧内容。
            materialId 必传：它是落盘的目标文件、也是 agent 桥的注册键。
          */}
          <MdEditor
            initialText={text ?? ''}
            materialId={materialId}
            onDirty={handleDirty}
            onSaved={handleSaved}
            onHandle={handleEditor}
          />
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