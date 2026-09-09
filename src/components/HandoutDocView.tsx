/**
 * 讲义结构化视图：按 IR 块渲染公文风格 HTML（替代 docx-preview 只读预览）。
 * 每个文字块支持：触摸端左滑 / 桌面端 hover → 「AI 改写」（预设+自由输入，预览后接受）或「手动编辑」；
 * 修改经 persistHandoutEdit 重建 DOCX 写回同一行，下载的 DOCX 与预览始终一致。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { App, Button, Input, Modal } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { db, type HandoutRow } from '../store/db';
import type { Block } from '../handout/ir';
import type { HandoutSection } from '../handout/docx';
import { h1Num, h2Num } from '../handout/styles';
import { ensureHandoutPreviewFonts } from '../handout/previewFonts';
import { blockToText, persistHandoutEdit, rewriteBlockWithLLM } from '../pipelines/handoutEdit';

/** 编辑目标：课程概述段 / 章节标题 / 节内某个内容块 */
type Target = { kind: 'summary' } | { kind: 'heading'; sec: number } | { kind: 'block'; sec: number; idx: number };

const keyOf = (t: Target): string =>
  t.kind === 'summary' ? 'sum' : t.kind === 'heading' ? `h${t.sec}` : `s${t.sec}b${t.idx}`;

/** 滑动操作区宽度（AI 改写 + 编辑 两个按钮） */
const SWIPE_W = 136;

export default function HandoutDocView({ handout }: { handout: HandoutRow }) {
  const { message } = App.useApp();
  const [doc, setDoc] = useState<{ summary: string; sections: HandoutSection[] } | null>(null);
  const [videoName, setVideoName] = useState('');
  const [frameUrls, setFrameUrls] = useState<Map<number, string>>(new Map());
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<Target | null>(null);
  const [aiTarget, setAiTarget] = useState<Target | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiDraft, setAiDraft] = useState<{ key: string; block: Block } | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const savingRef = useRef(0);

  useEffect(() => ensureHandoutPreviewFonts(), []);

  // 初始化 / 切换到另一份讲义时重载（编辑落盘 update 同一行，id 不变，不会触发重置）
  useEffect(() => {
    try {
      const outline = JSON.parse(handout.outlineJson) as { summary?: string };
      const sections = JSON.parse(handout.sectionsJson ?? '[]') as HandoutSection[];
      setDoc({ summary: outline.summary ?? '', sections });
    } catch {
      setDoc(null);
    }
    setOpenKey(null);
    setEditTarget(null);
    setAiTarget(null);
    setAiDraft(null);
  }, [handout.id, handout.outlineJson, handout.sectionsJson]);

  useEffect(() => {
    void db.videos.get(handout.videoId).then((v) => setVideoName(v?.name ?? ''));
  }, [handout.videoId]);

  // 配图：frames 表（VL 帧）→ objectURL；重新生成讲义（id 变化）时 frames 已刷新，需重读
  useEffect(() => {
    let alive = true;
    const urls: string[] = [];
    void db.frames
      .where('videoId')
      .equals(handout.videoId)
      .toArray()
      .then((rows) => {
        if (!alive) return;
        const m = new Map<number, string>();
        for (const r of rows) {
          const u = URL.createObjectURL(r.blob);
          m.set(Math.floor(r.ts), u);
          urls.push(u);
        }
        setFrameUrls(m);
      });
    return () => {
      alive = false;
      urls.forEach((u) => URL.revokeObjectURL(u));
      setFrameUrls(new Map());
    };
  }, [handout.videoId, handout.id]);

  // 「已保存」提示短暂停留后消失
  useEffect(() => {
    if (saveState !== 'saved') return;
    const t = setTimeout(() => setSaveState('idle'), 2500);
    return () => clearTimeout(t);
  }, [saveState]);

  const getBlock = (t: Target): Block | null => {
    if (!doc) return null;
    if (t.kind === 'summary') return { type: 'lead', text: doc.summary };
    if (t.kind === 'heading') return { type: 'h2', text: doc.sections[t.sec]?.heading ?? '' };
    return doc.sections[t.sec]?.blocks[t.idx] ?? null;
  };

  /** 落盘：更新内存 IR + 后台重建 DOCX（连续修改由 persistHandoutEdit 队列合并） */
  const commitDoc = (next: { summary: string; sections: HandoutSection[] }) => {
    setDoc(next);
    savingRef.current += 1;
    setSaveState('saving');
    persistHandoutEdit(handout.id!, next.sections, next.summary)
      .catch((e) => message.error(`讲义保存失败：${e instanceof Error ? e.message : String(e)}`))
      .finally(() => {
        savingRef.current -= 1;
        if (savingRef.current === 0) setSaveState('saved');
      });
  };

  const applyEdit = (t: Target, b: Block) => {
    if (!doc) return;
    if (t.kind === 'summary') {
      if ('text' in b) commitDoc({ ...doc, summary: b.text });
      return;
    }
    const sections = doc.sections.map((s, i) => {
      if (i !== t.sec) return s;
      if (t.kind === 'heading') return 'text' in b ? { ...s, heading: b.text } : s;
      const blocks = s.blocks.slice();
      blocks[t.idx] = b;
      return { ...s, blocks };
    });
    commitDoc({ ...doc, sections });
  };

  const submitAi = async (t: Target, instruction: string) => {
    const block = getBlock(t);
    if (!block || !doc) return;
    setAiBusy(true);
    try {
      const secIdx = t.kind === 'summary' ? -1 : t.sec;
      const heading = secIdx >= 0 ? doc.sections[secIdx]?.heading : undefined;
      let prev: string | undefined;
      let next: string | undefined;
      if (t.kind === 'block') {
        const arr = doc.sections[t.sec].blocks;
        prev = arr[t.idx - 1] ? blockToText(arr[t.idx - 1]).slice(0, 120) : undefined;
        next = arr[t.idx + 1] ? blockToText(arr[t.idx + 1]).slice(0, 120) : undefined;
      }
      const rewritten = await rewriteBlockWithLLM(block, instruction, { title: handout.title, heading, prev, next });
      setAiDraft({ key: keyOf(t), block: rewritten });
    } catch (e) {
      message.error(`AI 改写失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setAiBusy(false);
    }
  };

  if (!doc) {
    return (
      <div style={{ color: '#999', padding: 16, textAlign: 'center' }}>
        讲义内容解析失败，请重新生成讲义
      </div>
    );
  }

  const created = new Date(handout.createdAt);
  const dateStr = `${created.getFullYear()}年${created.getMonth() + 1}月${created.getDate()}日`;

  const renderEditable = (
    t: Target,
    block: Block,
    label: string | undefined,
    /** 显示层变换（如节标题加「一、」编号）；编辑/AI 改写始终面对原始文本 */
    displayTransform?: (b: Block) => Block,
  ) => {
    const k = keyOf(t);
    const draft = aiDraft?.key === k ? aiDraft.block : null;
    const show = (b: Block) => (displayTransform ? displayTransform(b) : b);
    return (
      <EditableBlock
        key={k}
        hasAi={block.type !== 'figure'}
        locked={editTarget !== null || aiBusy}
        swipeOpen={openKey === k}
        onSwipeOpen={() => setOpenKey(k)}
        onSwipeClose={() => setOpenKey(null)}
        onStartEdit={() => {
          setOpenKey(null);
          setAiTarget(null);
          setAiDraft(null);
          setEditTarget(t);
        }}
        onStartAi={
          block.type === 'figure'
            ? undefined
            : () => {
                setOpenKey(null);
                setEditTarget(null);
                setAiDraft(null);
                setAiTarget(t);
              }
        }
      >
        {editTarget && keyOf(editTarget) === k ? (
          <BlockEditor
            block={block}
            onSave={(b) => {
              applyEdit(t, b);
              setEditTarget(null);
            }}
            onCancel={() => setEditTarget(null)}
          />
        ) : (
          <>
            {draft && (
              <div className="hd-ai-old">
                <BlockBody block={show(block)} label={label} frameUrls={frameUrls} />
              </div>
            )}
            <div className={draft ? 'hd-ai-new' : undefined}>
              <BlockBody block={show(draft ?? block)} label={label} frameUrls={frameUrls} />
            </div>
            {draft ? (
              <div className="hd-ai-bar">
                <Button
                  size="small"
                  onClick={() => {
                    setAiDraft(null);
                    setAiTarget(null);
                  }}
                >
                  放弃
                </Button>
                <Button
                  size="small"
                  type="primary"
                  onClick={() => {
                    applyEdit(t, draft);
                    setAiDraft(null);
                    setAiTarget(null);
                  }}
                >
                  接受
                </Button>
              </div>
            ) : (
              aiTarget &&
              keyOf(aiTarget) === k && (
                <AiPanel
                  busy={aiBusy}
                  onSubmit={(instruction) => void submitAi(t, instruction)}
                  onClose={() => setAiTarget(null)}
                />
              )
            )}
          </>
        )}
      </EditableBlock>
    );
  };

  return (
    <div className="hd-scroll" onScroll={() => openKey && setOpenKey(null)}>
      <div className="hd-doc">
        <div className="hd-save-state">
          {saveState === 'saving' ? '正在保存修改…' : saveState === 'saved' ? '修改已保存' : ' '}
        </div>
        <div className="hd-title">{handout.title}</div>
        <div className="hd-meta">
          {videoName && <div>课程：{videoName}</div>}
          <div>{dateStr}</div>
        </div>

        {doc.summary.trim() &&
          renderEditable({ kind: 'summary' }, { type: 'lead', text: doc.summary }, undefined)}

        {doc.sections.map((sec, si) => {
          let figNo = 1;
          let tblNo = 1;
          let h2No = 0;
          return (
            <section key={si}>
              {renderEditable({ kind: 'heading', sec: si }, { type: 'h2', text: sec.heading }, undefined, (b) =>
                b.type === 'h2' ? { ...b, text: `${h1Num(si)}、${b.text}` } : b,
              )}
              {sec.blocks.map((b, bi) => {
                let label: string | undefined;
                if (b.type === 'h2') label = h2Num(h2No++);
                else if (b.type === 'figure') label = `图 ${si + 1}-${figNo++}`;
                else if (b.type === 'table') label = `表 ${si + 1}-${tblNo++}`;
                return renderEditable({ kind: 'block', sec: si, idx: bi }, b, label);
              })}
            </section>
          );
        })}

        <div className="hd-date">{dateStr}　　</div>
        <div className="hd-tip">左滑文字块可 AI 改写或手动修改；最终以导出的 DOCX 版式为准</div>
      </div>
    </div>
  );
}

/** 单块容器：触摸左滑露操作按钮（pan-y 保证垂直滚动优先），桌面 hover 浮按钮 */
function EditableBlock({
  children,
  hasAi,
  locked,
  swipeOpen,
  onSwipeOpen,
  onSwipeClose,
  onStartEdit,
  onStartAi,
}: {
  children: ReactNode;
  hasAi: boolean;
  /** 编辑进行中 / AI 生成中：禁用手势与操作入口 */
  locked: boolean;
  swipeOpen: boolean;
  onSwipeOpen: () => void;
  onSwipeClose: () => void;
  onStartEdit: () => void;
  onStartAi?: () => void;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ x: number; y: number; dragging: boolean; base: number } | null>(null);
  const actionsW = hasAi ? SWIPE_W : 68;

  useEffect(() => {
    const el = contentRef.current;
    if (el) el.style.transform = swipeOpen ? `translateX(${-actionsW}px)` : '';
  }, [swipeOpen, actionsW]);

  return (
    <div className={`hd-swipe${swipeOpen ? ' is-open' : ''}`}>
      {!locked && (
        <div className="hd-swipe-actions" style={{ width: actionsW }}>
          {hasAi && (
            <button type="button" className="hd-act hd-act-ai" onClick={onStartAi}>
              AI 改写
            </button>
          )}
          <button type="button" className="hd-act hd-act-edit" onClick={onStartEdit}>
            编辑
          </button>
        </div>
      )}
      <div
        ref={contentRef}
        className="hd-swipe-content"
        style={{ touchAction: 'pan-y' }}
        onTouchStart={
          locked
            ? undefined
            : (e) => {
                const t = e.touches[0];
                gesture.current = { x: t.clientX, y: t.clientY, dragging: false, base: swipeOpen ? -actionsW : 0 };
                contentRef.current?.classList.add('is-dragging');
              }
        }
        onTouchMove={
          locked
            ? undefined
            : (e) => {
                const g = gesture.current;
                const el = contentRef.current;
                if (!g || !el) return;
                const t = e.touches[0];
                const dx = t.clientX - g.x;
                const dy = t.clientY - g.y;
                if (!g.dragging) {
                  if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) * 1.2) g.dragging = true;
                  else if (Math.abs(dy) > 8) {
                    gesture.current = null;
                    el.classList.remove('is-dragging');
                    return;
                  } else return;
                }
                const pos = Math.max(-actionsW, Math.min(0, g.base + dx));
                el.style.transform = `translateX(${pos}px)`;
              }
        }
        onTouchEnd={
          locked
            ? undefined
            : (e) => {
                const g = gesture.current;
                const el = contentRef.current;
                el?.classList.remove('is-dragging');
                if (!g || !el) return;
                gesture.current = null;
                if (!g.dragging) return;
                const pos = Math.max(-actionsW, Math.min(0, g.base + (e.changedTouches[0].clientX - g.x)));
                if (pos < -actionsW * 0.35) {
                  el.style.transform = `translateX(${-actionsW}px)`;
                  onSwipeOpen();
                } else {
                  el.style.transform = '';
                  onSwipeClose();
                }
              }
        }
        onClick={() => swipeOpen && onSwipeClose()}
      >
        {children}
      </div>
      {!locked && (
        <span className="hd-hover-actions">
          {hasAi && (
            <Button size="small" onClick={onStartAi}>
              AI 改写
            </Button>
          )}
          <Button size="small" onClick={onStartEdit}>
            编辑
          </Button>
        </span>
      )}
    </div>
  );
}

/** 只读块渲染（编号 label 由外层按节内顺序计算，与 DOCX 渲染器同规则） */
function BlockBody({
  block,
  label,
  frameUrls,
}: {
  block: Block;
  label?: string;
  frameUrls: Map<number, string>;
}) {
  switch (block.type) {
    case 'lead':
    case 'para':
      return <p className="hd-para">{block.text}</p>;
    case 'note':
      return <p className="hd-note">{block.text}</p>;
    case 'h2':
      // label 为空 = 节标题（编号已由 displayTransform 拼好）；否则为「（一）」级小节标题
      return label === undefined ? (
        <h2 className="hd-h1">{block.text}</h2>
      ) : (
        <p className="hd-h2">
          {label}
          {block.text}
        </p>
      );
    case 'list':
      return (
        <>
          {block.items.map((it, i) => (
            <p key={i} className="hd-para hd-li">
              {block.ordered ? (
                <>
                  <span className="hd-li-marker">{i + 1}. </span>
                  {it}
                </>
              ) : (
                <>● {it}</>
              )}
            </p>
          ))}
        </>
      );
    case 'table':
      return (
        <div className="hd-table-wrap">
          <div className="hd-table-title">
            {label} {block.caption ?? '数据对比'}
          </div>
          <table className="hd-table">
            <thead>
              <tr>
                {block.header.map((h, i) => (
                  <th key={i}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((c, j) => (
                    <td key={j}>{c}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'figure': {
      const url = frameUrls.get(Math.floor(block.ts));
      return (
        <figure className="hd-figure">
          {url ? (
            <img src={url} alt={block.caption ?? '课程画面'} />
          ) : (
            <div className="hd-figure-missing">画面不可用</div>
          )}
          <figcaption className="hd-figcaption">
            {label} {block.caption ?? '课程画面'}
          </figcaption>
        </figure>
      );
    }
  }
}

const AI_PRESETS = ['更精简', '更详细', '更口语化', '换个说法'];

/** AI 改写输入面板：预设快捷项 + 自由输入 */
function AiPanel({
  busy,
  onSubmit,
  onClose,
}: {
  busy: boolean;
  onSubmit: (instruction: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const submit = (v: string) => {
    const t = v.trim();
    if (t && !busy) onSubmit(t);
  };
  return (
    <div className="hd-ai-panel">
      <div className="hd-chips">
        {AI_PRESETS.map((p) => (
          <button key={p} type="button" className="hd-chip" disabled={busy} onClick={() => submit(p)}>
            {p}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="描述想要的改法，如：补一个例子"
          onPressEnter={(e) => {
            e.preventDefault();
            submit(text);
          }}
          disabled={busy}
        />
        <Button type="primary" loading={busy} disabled={!text.trim()} onClick={() => submit(text)}>
          生成
        </Button>
        <Button type="text" onClick={onClose} disabled={busy}>
          收起
        </Button>
      </div>
    </div>
  );
}

/** 手动编辑器：文本类原地 TextArea；列表逐条编辑；表格弹窗改文字（结构不变） */
function BlockEditor({
  block,
  onSave,
  onCancel,
}: {
  block: Block;
  onSave: (b: Block) => void;
  onCancel: () => void;
}) {
  const { message } = App.useApp();

  if (block.type === 'table') return <TableEditor block={block} onSave={onSave} onCancel={onCancel} />;

  if (block.type === 'list') {
    return <ListEditor block={block} onSave={onSave} onCancel={onCancel} />;
  }

  const single = block.type === 'figure';
  const initial = block.type === 'figure' ? (block.caption ?? '') : block.text;
  return (
    <TextEditor
      initial={initial}
      single={single}
      placeholder={single ? '图注' : ''}
      onSave={(text) => {
        const t = text.trim();
        if (!t) {
          message.warning('内容不能为空');
          return;
        }
        onSave(block.type === 'figure' ? { ...block, caption: t } : { ...block, text: t });
      }}
      onCancel={onCancel}
    />
  );
}

function TextEditor({
  initial,
  single,
  placeholder,
  onSave,
  onCancel,
}: {
  initial: string;
  single?: boolean;
  placeholder?: string;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  return (
    <div className="hd-editor">
      {single ? (
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} />
      ) : (
        <Input.TextArea
          value={text}
          onChange={(e) => setText(e.target.value)}
          autoSize={{ minRows: 2 }}
          placeholder={placeholder}
        />
      )}
      <div className="hd-editor-bar">
        <Button size="small" onClick={onCancel}>
          取消
        </Button>
        <Button size="small" type="primary" onClick={() => onSave(text)}>
          保存
        </Button>
      </div>
    </div>
  );
}

function ListEditor({
  block,
  onSave,
  onCancel,
}: {
  block: Extract<Block, { type: 'list' }>;
  onSave: (b: Block) => void;
  onCancel: () => void;
}) {
  const { message } = App.useApp();
  const [items, setItems] = useState<string[]>(block.items);
  return (
    <div className="hd-editor">
      {items.map((it, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'flex-start' }}>
          <Input.TextArea
            value={it}
            autoSize={{ minRows: 1 }}
            onChange={(e) => setItems(items.map((x, j) => (j === i ? e.target.value : x)))}
          />
          <Button
            size="small"
            type="text"
            danger
            icon={<DeleteOutlined />}
            onClick={() => setItems(items.filter((_, j) => j !== i))}
          />
        </div>
      ))}
      <Button size="small" type="dashed" icon={<PlusOutlined />} onClick={() => setItems([...items, ''])}>
        添加条目
      </Button>
      <div className="hd-editor-bar">
        <Button size="small" onClick={onCancel}>
          取消
        </Button>
        <Button
          size="small"
          type="primary"
          onClick={() => {
            const next = items.map((s) => s.trim()).filter(Boolean);
            if (next.length === 0) {
              message.warning('至少保留一条内容');
              return;
            }
            onSave({ ...block, items: next });
          }}
        >
          保存
        </Button>
      </div>
    </div>
  );
}

function TableEditor({
  block,
  onSave,
  onCancel,
}: {
  block: Extract<Block, { type: 'table' }>;
  onSave: (b: Block) => void;
  onCancel: () => void;
}) {
  const { message } = App.useApp();
  const [caption, setCaption] = useState(block.caption ?? '');
  const [header, setHeader] = useState<string[]>(block.header);
  const [rows, setRows] = useState<string[][]>(block.rows);
  return (
    <Modal
      title="编辑表格（仅文字，结构不变）"
      open
      onCancel={onCancel}
      onOk={() => {
        const h = header.map((s) => s.trim());
        if (h.some((s) => !s)) {
          message.warning('表头不能为空');
          return;
        }
        onSave({
          ...block,
          caption: caption.trim() || undefined,
          header: h,
          rows: rows.map((r) => r.map((c) => c.trim())),
        });
      }}
      okText="保存"
      cancelText="取消"
      width="min(560px, calc(100vw - 32px))"
    >
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 12, color: '#888', marginBottom: 2 }}>表名</div>
        <Input value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="表名（可留空）" />
      </div>
      <table className="hd-table hd-table-edit">
        <thead>
          <tr>
            {header.map((h, i) => (
              <th key={i}>
                <Input
                  size="small"
                  value={h}
                  onChange={(e) => setHeader(header.map((x, j) => (j === i ? e.target.value : x)))}
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j}>
                  <Input.TextArea
                    size="small"
                    autoSize={{ minRows: 1 }}
                    value={c}
                    onChange={(e) =>
                      setRows(rows.map((row, ri) => (ri === i ? row.map((x, cj) => (cj === j ? e.target.value : x)) : row)))
                    }
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
