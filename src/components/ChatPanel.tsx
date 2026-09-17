import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { XMarkdown, type ComponentProps } from '@ant-design/x-markdown';
import type { MediaPlayerInstance } from '@vidstack/react';
import { db, type ChatImage, type ChatSessionRow, type QuizState, type SegmentRow } from '../store/db';
import { getSettings, useSettings } from '../store/settings';
import { ensureEmbeddingIndex, type EmbedProgress } from '../pipelines/embedIndex';
import { ensureMaterialIndex, materialIndexCount } from '../pipelines/embedMaterial';
import { runAgentLoop } from '../harness/agent';
import { QA_TOOLS, MATERIAL_QA_TOOLS, LIST_FRAMES_TOOL, createToolExecutor } from '../harness/tools';
import { PROMPTS } from '../harness/prompts';
import { estimateTokens, fitHistoryToBudget, subtitleWindow } from '../harness/context';
import { loadEnabledSkillMeta, skillMetaBlock } from '../skills/store';
import { captureFrame, resolveVideoEl, type Snapshot } from '../media/snapshot';
import { isVisionModel, supportsThinking } from '../api/modelCaps';
import { chatOnce, textOf, type ChatMessage, type ContentPart, type ReasoningEffort } from '../api/siliconflow';
import { fmtTime } from '../utils/vtt';
import { linkifyFrames, linkifyTimestamps, linkifyUnits } from '../utils/linkify';
import { fmtUnitRef, type UnitKind } from '../materials/units.ts';
import type { MaterialReaderHandle } from '../materials/types';
import { useSelectionAsk, formatCitation, EXPLAIN_PROMPT, MAX_REFS, type Citation } from '../store/selectionAsk';
import { buildSessionMarkdown, exportFileName } from '../utils/chatExport';
import { copyText } from '../utils/clipboard';
import { useIsMobile } from '../utils/useMobile';
import { Panel, PanelBar, PanelSpacer, PanelProgress, PanelBody, PanelPlaceholder, toast, confirmDialog, useMduiEvent } from '../ui';
import { ThinkLine, StreamParagraph } from './motion';
import { MarkdownCode, MarkdownPre } from './mermaid/markdown';
import ModelPicker from './ModelPicker';
import QuizCard from './QuizCard';
import './chat-panel.css';

interface Props {
  videoId: string;
  videoName: string;
  /** 视频：播放器实例；材料：传一个恒为 null 的 ref（材料没有播放器） */
  playerRef: React.RefObject<MediaPlayerInstance | null>;
  /**
   * 阅读器句柄（只有材料课程有）。用于把回答里的 `[第3页]` 引用变成「点一下就滚过去」。
   * 与 playerRef 完全对称：视频靠 playerRef 跳时间，材料靠 readerRef 跳页/段。
   */
  readerRef?: React.RefObject<MaterialReaderHandle | null>;
  /**
   * 材料的定位单元类型：`'page'`（PDF）/ `'para'`（Word）。
   * **不传 = 视频课程**，此时走字幕检索 + 时间戳引用。
   */
  materialKind?: UnitKind;
}

interface ChatMsg {
  key: string;
  role: 'user' | 'ai';
  content: string;
  /** 用户消息附带的截图缩略图 */
  images?: ChatImage[];
  /** 思考过程（推理模型 reasoning_content 的回调累计值） */
  reasoning?: string;
  /** 工具调用期间的提示（如"正在检索…"） */
  hint?: string;
  /** 答题卡（present_quiz 工具产出） */
  quiz?: QuizState;
  /** 落库后的 chats 行 id（作答状态回写用） */
  rowId?: number;
  streaming?: boolean;
  error?: boolean;
}

let keySeq = 0;
const nextKey = () => `${Date.now()}-${keySeq++}`;

/** 幻灯片帧元数据（blob 按需经 id 单取，不进 React 状态） */
interface FrameMeta {
  id: number;
  ts: number;
}

/**
 * AI 回答里的课程画面引用（[图@mm:ss] → #frame-秒 → 本组件）。
 * 就近匹配（±2s，时间戳经 fmtTime/parse 往返有秒级误差）后从 db.frames 取 blob 渲染缩略图，
 * 点击跳转播放器；匹配不到画面时降级为可点击的时间戳链接。
 */
function FrameThumb({
  secs,
  alt,
  frames,
  onSeek,
}: {
  secs: number;
  alt?: string;
  frames: FrameMeta[];
  onSeek: (t: number) => void;
}) {
  const frame = useMemo(() => {
    let best: FrameMeta | null = null;
    for (const f of frames) {
      const d = Math.abs(f.ts - secs);
      if (d <= 2 && (!best || d < Math.abs(best.ts - secs))) best = f;
    }
    return best;
  }, [secs, frames]);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!frame) return;
    let cancelled = false;
    let objUrl: string | null = null;
    void db.frames.get(frame.id).then((row) => {
      if (cancelled || !row) return;
      objUrl = URL.createObjectURL(row.blob);
      setUrl(objUrl);
    });
    return () => {
      cancelled = true;
      if (objUrl) URL.revokeObjectURL(objUrl);
      setUrl(null);
    };
  }, [frame]);

  if (!frame) {
    return (
      <a
        onClick={(e) => {
          e.preventDefault();
          onSeek(secs);
        }}
        className="chat-ts"
      >
        {alt || `[图@${fmtTime(secs)}]`}
      </a>
    );
  }
  return (
    <span className="chat-frame-wrap">
      {url ? (
        <img
          src={url}
          alt={alt ?? ''}
          onClick={() => onSeek(frame.ts)}
          className="chat-frame-img"
        />
      ) : (
        <span className="chat-frame-img chat-frame-img--pending" />
      )}
      <span className="chat-ts-chip">
        {fmtTime(frame.ts)}
      </span>
    </span>
  );
}

/**
 * AI 气泡上方的可折叠思考过程块。
 * active（流式中且正文未出）时默认展开呈"思考中"；active 消失后自动收起，
 * 之后/历史消息默认收起，点击摘要行展开。样式保持低调：12px、半透、左竖线。
 */
function ReasoningBlock({ reasoning, active }: { reasoning: string; active: boolean }) {
  const [open, setOpen] = useState(active);
  useEffect(() => {
    if (!active) setOpen(false);
  }, [active]);
  return (
    <div className="chat-reason">
      <div className="chat-reason__toggle" onClick={() => setOpen((v) => !v)}>
        <mdui-sym-chevron-right className={open ? 'chat-reason__chevron chat-reason__chevron--open' : 'chat-reason__chevron'} />
        {active ? '思考中…' : '思考过程'}
      </div>
      {open && <div className="chat-reason__body">{reasoning}</div>}
    </div>
  );
}

/**
 * 用户气泡内容：把开头的**引用块**（`> ` 前缀的连续行）单独渲染成引用样式。
 *
 * 为什么要拆：引用块落库时存的是 Markdown blockquote 原文，而用户气泡是**纯文本渲染**
 * （不走 markdown），直接吐出来会把 `> ` 露在脸上。拆开渲染既好看，也让人一眼分清
 * 「这是我引的原文」与「这是我问的问题」。
 *
 * 没有引用块时行为与从前完全一致（原样渲染 `content`），既有消息与 e2e 都不受影响。
 */
function UserContent({ content }: { content: string }) {
  const lines = content.split('\n');
  const quoted: string[] = [];
  let i = 0;
  while (i < lines.length && lines[i].startsWith('> ')) {
    quoted.push(lines[i].slice(2));
    i++;
  }
  if (quoted.length === 0) return <>{content}</>;
  const rest = lines.slice(i).join('\n').trim();
  // formatCitation 的首行固定是「[选自 位置]」，抽出来单独当来源标签
  const src = /^\[选自\s*(.+?)\]$/.exec(quoted[0] ?? '');
  const body = src ? quoted.slice(1).join('\n') : quoted.join('\n');
  return (
    <>
      <span className="chat-quote" data-testid="chat-quote">
        <span className="chat-quote__src">{src ? `选自 ${src[1]}` : '引用原文'}</span>
        <span className="chat-quote__text">{body}</span>
      </span>
      {rest && <span className="chat-quote__ask">{rest}</span>}
    </>
  );
}

export default function ChatPanel({
  videoId,
  videoName,
  playerRef,
  readerRef,
  materialKind,
}: Props) {
  /** 材料课程（PDF / Word）：没有字幕、没有播放器，检索与引用都走材料那一套 */
  const isMaterial = materialKind !== undefined;
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [hasSubtitles, setHasSubtitles] = useState(isMaterial);
  const [indexProgress, setIndexProgress] = useState<EmbedProgress | null>(null);
  const [indexReady, setIndexReady] = useState(false);
  /**
   * 索引为什么不可用（材料专属文案）。扫描件 / 空文档永远不会就绪，
   * 光禁掉输入框而不说明原因，用户只会以为是坏了 —— 尤其窄屏下阅读区不可见时。
   */
  const [indexNote, setIndexNote] = useState<string | null>(null);
  const [sessions, setSessions] = useState<ChatSessionRow[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [shots, setShots] = useState<Snapshot[]>([]);
  /**
   * 划词/框选带进来的引用条（最多 MAX_REFS 条）。
   * 做成独立的 chip 列表而不是把引用拼进 textarea：用户能看清自己引了什么、能单条删掉。
   */
  const [refs, setRefs] = useState<Citation[]>([]);
  /** 选区提问的投递（来自 SelectionAsk 浮层 / PDF 框选） */
  const pendingAsk = useSelectionAsk((s) => s.pending);
  const takeAsk = useSelectionAsk((s) => s.take);
  /** 发送时读最新引用：send 会被 effect 同步调用，闭包里的 refs 可能还没更新 */
  const refsRef = useRef<Citation[]>([]);
  useEffect(() => {
    refsRef.current = refs;
  }, [refs]);
  // 输入框 ref：mdui-text-field 的 input 事件没有 payload，值要从元素上读。
  // 声明放在这里（而不是靠近 JSX）是因为「选区提问」的 effect 要用它来聚焦输入框 ——
  // 常量声明在使用之后会被 TS 判为 use-before-declaration。
  const composerInput = useMduiEvent('mdui-text-field', 'input', (_e, el) => setInput(el.value));
  // 讲义抽帧元数据：决定 list_frames 工具/提示词注入，也供 AI 气泡里的画面引用渲染
  const [framesMeta, setFramesMeta] = useState<FrameMeta[]>([]);
  const llmModel = useSettings((s) => s.llmModel);
  const thinking = useSettings((s) => s.thinkingEnabled);
  const effort = useSettings((s) => s.thinkingEffort);
  const ctxWin = useSettings((s) => s.contextWindow);
  const updateSettings = useSettings((s) => s.update);
  // 消息流滚动容器（原 Bubble.List 的 ref 只暴露 scrollTo，现在自己持有真实元素）
  const listRef = useRef<HTMLDivElement | null>(null);
  // 手机端：思考开关上移到会话行，第二行只留 ModelPicker（+思考深度），省一行高度
  const isMobile = useIsMobile();

  /** 截取当前视频画面，加入待发送列表（最多 4 张） */
  const addShot = () => {
    const video = resolveVideoEl(playerRef);
    const t = playerRef.current?.currentTime ?? 0;
    if (!video) return toast.warning('视频未就绪');
    const snap = captureFrame(video, t);
    if (!snap) return toast.warning('截图失败，请稍候重试');
    if (shots.length >= 4) return toast.info('最多附带 4 张截图');
    setShots((prev) => [...prev, snap]);
  };

  const seekTo = useCallback(
    (t: number) => {
      if (playerRef.current) playerRef.current.currentTime = t + 0.01;
    },
    [playerRef],
  );

  /** 题卡作答：更新消息状态；已落库的同步回写 IndexedDB */
  const handleAnswer = (key: string, qi: number, oi: number) => {
    setMsgs((prev) =>
      prev.map((m) => {
        if (m.key !== key || !m.quiz || m.quiz.picks[qi] >= 0) return m;
        const picks = [...m.quiz.picks];
        picks[qi] = oi;
        const quiz = { ...m.quiz, picks };
        if (m.rowId != null) void db.chats.update(m.rowId, { quiz });
        return { ...m, quiz };
      }),
    );
  };

  /** 自定义链接渲染：#seek-N 跳播放器、#unit-N 跳材料对应页/段，其余外链新窗口打开 */
  const SeekLink = useCallback(
    ({ href, children }: ComponentProps & { href?: string }) => {
      const h = href ?? '';
      if (h.startsWith('#seek-')) {
        const secs = Number(h.slice(6));
        return (
          <a
            onClick={(e) => {
              e.preventDefault();
              seekTo(secs);
            }}
            className="chat-ts"
          >
            {children}
          </a>
        );
      }
      // 阅读材料的引用：[第3页] → #unit-3，点一下滚动阅读器并高亮
      if (h.startsWith('#unit-')) {
        const unit = Number(h.slice(6));
        return (
          <a
            onClick={(e) => {
              e.preventDefault();
              readerRef?.current?.scrollToUnit(unit);
            }}
            className="chat-ts"
          >
            {children}
          </a>
        );
      }
      return (
        <a href={h} target="_blank" rel="noreferrer">
          {children}
        </a>
      );
    },
    [seekTo, readerRef],
  );

  // 上下文用量估算（system + 历史 + 当前输入/截图/引用），仅作 UI 提示
  const ctxEst = useMemo(() => {
    // 注意 estimateTokens：两个 qaSystem 返回的都是**提示词文本**，忘了包就变成字符串拼接
    const sysText = isMaterial
      ? PROMPTS.qaSystemMaterial(videoName, materialKind!, undefined, shots.length, refs.length)
      : PROMPTS.qaSystem(videoName, undefined, undefined, shots.length, refs.length);
    const sys = estimateTokens(sysText);
    // 历史只发送 content，reasoning 不计入
    const hist = msgs.reduce((s, m) => s + estimateTokens(m.content), 0);
    // 引用块会随本轮一起发出去，得算进去（一段 1200 字上限 ≈ 1.2k tokens），否则用量条会低估
    const refTokens = refs.reduce((n, c) => n + estimateTokens(c.text) + 12, 0);
    const cur = estimateTokens(input) + shots.length * 1200 + refTokens; // 每张图约 1.2k tokens
    return sys + hist + cur;
  }, [msgs, input, shots, refs, videoName, isMaterial, materialKind]);
  const ratio = ctxEst / ctxWin;
  // 用量告警分三档（>90% 危险 / >70% 注意），色走 MD3 语义令牌
  const ctxLevel = ratio > 0.9 ? 'bad' : ratio > 0.7 ? 'warn' : '';

  /** 自定义图片渲染：#frame-秒 渲染课程画面缩略图（点击跳转），其余按原样 */
  const FrameImage = useCallback(
    ({ src, alt }: ComponentProps & { src?: string; alt?: string }) => {
      if (src?.startsWith('#frame-')) {
        return <FrameThumb secs={Number(src.slice(7))} alt={alt} frames={framesMeta} onSeek={seekTo} />;
      }
      return <img src={src} alt={alt} />;
    },
    [framesMeta, seekTo],
  );

  /** 读取讲义抽帧元数据（幻灯片帧，blob 不进状态） */
  const loadFramesMeta = useCallback(async () => {
    const rows = await db.frames
      .where('videoId')
      .equals(videoId)
      .filter((r) => r.kind === 'slide')
      .sortBy('ts');
    const meta = rows.map((r) => ({ id: r.id!, ts: r.ts }));
    setFramesMeta(meta);
    return meta;
  }, [videoId]);

  // 初始化会话列表 + 检查/建立问答索引
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let list = await db.chatSessions.where('videoId').equals(videoId).sortBy('createdAt');
      if (list.length === 0) {
        const now = Date.now();
        const id = (await db.chatSessions.add({ videoId, title: '新会话', createdAt: now })) as number;
        list = [{ id, videoId, title: '新会话', createdAt: now }];
      }
      if (cancelled) return;
      setSessions(list);
      setActiveId(list[list.length - 1].id!);

      // ── 阅读材料：索引的是文本块（materialBlocks / materialEmbeddings） ──
      if (isMaterial) {
        // 材料没有「字幕」，但 hasSubtitles 在上游是「内容是否就绪」的语义，材料解析完就算就绪
        setHasSubtitles(true);
        const blockCount = await db.materialBlocks.where('materialId').equals(videoId).count();
        if (cancelled) return;
        // 没有可检索文本：indexReady 保持 false，并给出**能操作的**说明。
        // 话术必须按格式分：扫描件只可能是 PDF（有页面但取不到字），
        // Word 取不到字就是「没有正文」—— 与 chunk.ts 的 judgeMaterialText 同一套区分。
        if (blockCount === 0) {
          if (!cancelled) {
            setIndexNote(
              materialKind === 'page'
                ? '这份材料没有文本层（扫描件），无法参与检索；可以在阅读区划词或框选区域提问'
                : '这份材料没有正文，没有可供检索的内容',
            );
          }
          return;
        }
        const embCount = await materialIndexCount(videoId);
        if (embCount >= blockCount) {
          if (!cancelled) setIndexReady(true);
          return;
        }
        try {
          await ensureMaterialIndex(videoId, (p) => {
            if (!cancelled) setIndexProgress(p);
          });
          if (!cancelled) setIndexReady(true);
        } catch (e) {
          if (!cancelled) toast.error(`建立材料索引失败：${e instanceof Error ? e.message : String(e)}`);
        } finally {
          if (!cancelled) setIndexProgress(null);
        }
        return;
      }

      const segCount = await db.segments
        .where('videoId')
        .equals(videoId)
        .filter((r) => r.status === 1 && !!r.text)
        .count();
      if (cancelled) return;
      setHasSubtitles(segCount > 0);
      if (segCount === 0) return;

      const embCount = await db.embeddings.where('videoId').equals(videoId).count();
      if (embCount >= segCount) {
        if (!cancelled) setIndexReady(true);
        return;
      }
      // 自动补建索引
      try {
        await ensureEmbeddingIndex(videoId, (p) => {
          if (!cancelled) setIndexProgress(p);
        });
        if (!cancelled) setIndexReady(true);
      } catch (e) {
        if (!cancelled) toast.error(`建立问答索引失败：${e instanceof Error ? e.message : String(e)}`);
      } finally {
        if (!cancelled) setIndexProgress(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [videoId, isMaterial]);

  /**
   * 消费「选区提问」的投递：浮层点「解释这段」或「就这段提问」后进到这里。
   *
   * 两种模式的分工：
   * - `compose`：只把引用压进引用条并聚焦输入框，用户自己补问题（多数情况）
   * - `explain`：直接用默认提问发送，省一步（「这段什么意思」这种不用再打字）
   *
   * 引用条满了就丢掉最旧的一条：用户刚点的这条显然比三分钟前那条更相关。
   */
  useEffect(() => {
    if (!pendingAsk) return;
    const { cite, mode } = pendingAsk;
    takeAsk();
    // 直接基于 refsRef 算下一份并同步写回：同一次事件里 setState 还没落地，
    // 而 explain 模式要立刻把这份引用发出去，不能用 state 读
    const next =
      refsRef.current.length >= MAX_REFS
        ? [...refsRef.current.slice(refsRef.current.length - MAX_REFS + 1), cite]
        : [...refsRef.current, cite];
    refsRef.current = next;
    setRefs(next);
    if (mode === 'explain') {
      void send(EXPLAIN_PROMPT, next);
    } else {
      // compose：引用已进引用条，焦点交给输入框，用户直接补问题。
      // 复用 composerInput（useMduiEvent 返回的就是元素 ref），不额外造一个 ref。
      composerInput.current?.focus();
    }
    // send 每轮渲染都是新引用，放进依赖会无限触发；这里只在 pendingAsk 变化时消费一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAsk]);

  // 进入面板时预载帧元数据（历史消息里的画面引用回放需要）
  useEffect(() => {
    void loadFramesMeta();
  }, [loadFramesMeta]);

  // 切换会话时加载该会话的历史消息
  useEffect(() => {
    if (activeId == null) {
      setMsgs([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const history = await db.chats.where('sessionId').equals(activeId).sortBy('createdAt');
      if (!cancelled) {
        setMsgs(history.map((r) => ({
          key: `h-${r.id}`,
          role: r.role === 'user' ? 'user' : 'ai',
          content: r.content,
          images: r.images,
          reasoning: r.reasoning,
          quiz: r.quiz,
          rowId: r.id,
        })));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  const activeTitle = sessions.find((s) => s.id === activeId)?.title ?? '新会话';

  /** 当前会话 → Markdown 全文（复制与导出共用） */
  const sessionMarkdown = () =>
    buildSessionMarkdown({
      title: activeTitle,
      videoName,
      messages: msgs.map((m) => ({
        role: m.role === 'user' ? ('user' as const) : ('assistant' as const),
        content: m.content,
        reasoning: m.reasoning,
        quiz: m.quiz,
      })),
    });

  /** 一键复制整个会话（Markdown 源码；流式进行中禁用，避免复制到半截回答） */
  const copySession = async () => {
    if (msgs.length === 0) return void toast.info('当前会话还没有内容');
    const ok = await copyText(sessionMarkdown());
    if (ok) toast.success(`已复制整个会话（Markdown，${msgs.length} 条消息）`);
    else toast.error('复制失败：剪贴板不可用，可改用「导出 .md」');
  };

  /** 导出整个会话为 .md 文件（归档/跨设备带走） */
  const downloadSession = () => {
    if (msgs.length === 0) return void toast.info('当前会话还没有内容');
    const url = URL.createObjectURL(new Blob([sessionMarkdown()], { type: 'text/markdown;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = exportFileName(videoName, activeTitle);
    a.click();
    URL.revokeObjectURL(url);
    toast.success('已导出 Markdown 文件');
  };

  /** 新开会话 */
  const createSession = async () => {
    const now = Date.now();
    const id = (await db.chatSessions.add({ videoId, title: '新会话', createdAt: now })) as number;
    setSessions((prev) => [...prev, { id, videoId, title: '新会话', createdAt: now }]);
    setActiveId(id);
  };

  /** 删除当前会话（删光后自动补一个空会话） */
  const deleteSession = async () => {
    if (activeId == null) return;
    await db.transaction('rw', [db.chats, db.chatSessions], async () => {
      await db.chats.where('sessionId').equals(activeId).delete();
      await db.chatSessions.delete(activeId);
    });
    const rest = sessions.filter((s) => s.id !== activeId);
    if (rest.length === 0) {
      const now = Date.now();
      const id = (await db.chatSessions.add({ videoId, title: '新会话', createdAt: now })) as number;
      setSessions([{ id, videoId, title: '新会话', createdAt: now }]);
      setActiveId(id);
    } else {
      setSessions(rest);
      setActiveId(rest[rest.length - 1].id!);
    }
    toast.success('已删除会话');
  };

  /**
   * 发送一轮提问。
   *
   * `extraRefs` 用于「解释这段」：那一步在 effect 里触发，走 refsRef 传进来，
   * 免得依赖 state 的落地时序。普通输入框发送不传，用当前引用条。
   */
  const send = async (question: string, extraRefs?: Citation[]) => {
    const q = question.trim();
    const curRefs = extraRefs ?? refsRef.current;
    // 引用也算内容：只划了词没打字也应能发送
    if ((!q && shots.length === 0 && curRefs.length === 0) || loading || activeId == null) return;
    if (!indexReady) {
      toast.warning('问答索引尚未就绪');
      return;
    }
    const sessionId = activeId;
    const settings = getSettings();
    /**
     * 框选截图与视频截图共用同一条多模态通道：把引用里的裁图折进 shots，
     * 下面的「多模态直读 / 视觉模型描述 / 不支持则拦截」三级降级链就**一行都不用改**。
     * 材料的锚点是页号，正好复用 Snapshot.ts 这个字段（语义由 isMaterial 决定）。
     */
    const refShots: Snapshot[] = curRefs
      .filter((c) => c.image)
      .map((c) => ({ dataUrl: c.image!.dataUrl, thumb: c.image!.thumb, ts: c.unit ?? 0 }));
    const curShots = [...shots, ...refShots].sort((a, b) => a.ts - b.ts);

    /** 素材标记：视频是 [截图@mm:ss]，材料是 [选区@第N页] */
    const shotTag = (s: Snapshot) =>
      isMaterial ? `[选区@${fmtUnitRef(materialKind!, s.ts)}]` : `[截图@${fmtTime(s.ts)}]`;

    // 降级链 tier 3 前置检查：模型无图能力且未配视觉模型时直接拦截，不清空输入与截图，保留草稿
    if (curShots.length > 0 && !isVisionModel(settings.llmModel) && !settings.visionModel) {
      toast.error('当前模型不支持图片，请在设置中配置视觉模型或切换多模态模型');
      return;
    }

    setInput('');
    setShots([]);
    setRefs([]);
    refsRef.current = [];
    setLoading(true);

    const userKey = nextKey();
    const aiKey = nextKey();
    const isFirstMsg = msgs.length === 0;
    let answer = '';
    let reasoning = '';
    const patchAi = (patch: Partial<ChatMsg>) =>
      setMsgs((prev) => prev.map((m) => (m.key === aiKey ? { ...m, ...patch } : m)));

    try {
      // 先上屏用户气泡与 AI 占位，此后描述/落库/问答任何一步抛错都能落到占位气泡上
      //
      // 引用块放在最前面：模型对「开头是引用、后面是问题」的结构最敏感，
      // 也让用户回看历史时一眼看到「我当时引的是哪一段」。
      const quoteBlock = curRefs.map(formatCitation).join('\n\n');
      const marker = curShots.map(shotTag).join('');
      const displayContent = (quoteBlock ? `${quoteBlock}\n\n` : '') + marker + q;
      const userImages: ChatImage[] = curShots.map((s) =>
        isMaterial
          ? {
              ts: s.ts,
              thumb: s.thumb,
              label: `${fmtUnitRef(materialKind!, s.ts)}选区`,
              kind: 'page-selection' as const,
            }
          : { ts: s.ts, thumb: s.thumb },
      );
      setMsgs((prev) => [
        ...prev,
        {
          key: userKey,
          role: 'user',
          content: displayContent,
          images: userImages.length > 0 ? userImages : undefined,
        },
        { key: aiKey, role: 'ai', content: '', streaming: true },
      ]);

      // 用户消息立即落库：tier 2 描述可能耗时数秒，避免期间关页丢失已上屏消息
      await db.chats.add({
        videoId,
        sessionId,
        role: 'user',
        content: displayContent,
        createdAt: Date.now(),
        ...(userImages.length > 0 ? { images: userImages } : {}),
      });

      // 首条提问自动作为会话标题（纯截图提问用时间戳标记兜底）
      if (isFirstMsg) {
        const t = q || marker;
        const title = t.length > 18 ? `${t.slice(0, 18)}…` : t;
        await db.chatSessions.update(sessionId, { title });
        setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, title } : s)));
      }

      // 截图来源处的上下文。
      // 视频：该时刻前后的**字幕窗口**（多时刻按段去重合并）；
      // 材料：该页/段的**原文**（替代字幕，作用一样 —— 让视觉模型认图时带着上下文，
      //      否则它容易把画面里的小字认错）。
      // 先于看图描述计算：tier 2 的视觉模型也要带着这份上下文认图。
      const shotWindows = new Map<number, string>();
      let subBlock = '';
      if (curShots.length > 0) {
        if (isMaterial) {
          for (const s of curShots) {
            const rows = await db.materialBlocks
              .where('materialId')
              .equals(videoId)
              .filter((r) => r.unit === s.ts)
              .toArray();
            shotWindows.set(s.ts, rows.map((r) => r.text).join('\n'));
          }
        } else {
          const segs = await db.segments
            .where('videoId')
            .equals(videoId)
            .filter((r) => r.status === 1 && !!r.text)
            .sortBy('idx');
          const byIdx = new Map<number, SegmentRow>();
          for (const s of curShots) {
            const win = subtitleWindow(segs, s.ts);
            shotWindows.set(s.ts, win.map((seg) => `[${fmtTime(seg.start)}] ${seg.text}`).join('\n'));
            for (const seg of win) byIdx.set(seg.idx, seg);
          }
          subBlock = [...byIdx.values()]
            .sort((a, b) => a.idx - b.idx)
            .map((seg) => `[${fmtTime(seg.start)}] ${seg.text}`)
            .join('\n');
        }
      }

      // 截图进上下文的降级链：tier 1 多模态模型直接看图；tier 2 视觉模型先描述成文字。
      // 材料的措辞与视频分开：材料是「框选出来的区域」，且没有字幕可作背景。
      const shotLead =
        curShots.length === 0
          ? ''
          : isVisionModel(settings.llmModel)
            ? isMaterial
              ? `本轮附带 ${curShots.length} 张选区截图：正文中 [选区@第N${materialKind === 'para' ? '段' : '页'}] 标记后紧跟的就是该处框出来的画面。截图是最高优先级证据，请先按画面实际内容作答，材料文字只作背景；两者冲突时以截图为准。`
              : `本轮附带 ${curShots.length} 张截图：正文中 [截图@mm:ss] 标记后紧跟的就是该时刻的画面。截图是最高优先级证据，请先按画面实际内容作答，字幕只作背景；两者冲突时以截图为准。`
            : isMaterial
              ? `本轮提问附带了 ${curShots.length} 张选区截图，下面「[选区@第N${materialKind === 'para' ? '段' : '页'}] 画面：…」是视觉模型对每张图的逐字转述，忠实于画面、为最高优先级证据；与材料文字冲突时以画面为准。`
              : `本轮提问附带了 ${curShots.length} 张截图，下面「[截图@mm:ss] 画面：…」是视觉模型对每张图的逐字转述，忠实于画面、为最高优先级证据；与字幕冲突时以画面为准。`;
      let imageParts: ContentPart[] | null = null;
      let descBlock = '';
      let descFailed = false;
      if (curShots.length > 0) {
        if (isVisionModel(settings.llmModel)) {
          // 每张图前插入位置文本，模型才能把画面归属到对应的标记
          imageParts = curShots.flatMap(
            (s): ContentPart[] => [
              { type: 'text', text: shotTag(s) },
              { type: 'image_url', image_url: { url: s.dataUrl } },
            ],
          );
        } else {
          // 前置检查已保证 visionModel 非空；描述提示词带上该处上下文，并声明以画面为准
          const results = await Promise.allSettled(
            curShots.map((s) =>
              chatOnce(settings, {
                model: settings.visionModel,
                messages: [
                  {
                    role: 'user',
                    content: [
                      { type: 'image_url', image_url: { url: s.dataUrl } },
                      { type: 'text', text: PROMPTS.shotDescribe(q, shotWindows.get(s.ts)) },
                    ],
                  },
                ],
                max_tokens: 512,
              }),
            ),
          );
          descFailed = results.some((r) => r.status === 'rejected');
          descBlock = results
            .map((r, i) => {
              const at = shotTag(curShots[i]);
              return r.status === 'fulfilled'
                ? `${at} 画面：${textOf(r.value)}`
                : `${at}（画面描述失败，仅参考位置与${isMaterial ? '材料原文' : '字幕'}）`;
            })
            .join('\n');
        }
      }

      // 构造上下文：system + 按 token 预算截取的历史 + 当前问题
      // Level 1：技能元数据清单进系统提示词，agent 按需用 use_skill 加载正文
      const skillMetas = await loadEnabledSkillMeta();
      // 每次发送前刷新帧元数据（讲义可能在本面板挂载后生成）：有帧才注册 list_frames 工具并注入引用规则
      // 材料没有画面可引用，直接跳过这次查询
      const meta = isMaterial ? [] : await loadFramesMeta();
      const hasFrames = meta.length > 0;
      const skillBlock = skillMetas.length > 0 ? skillMetaBlock(skillMetas) : undefined;
      const systemPrompt = isMaterial
        ? PROMPTS.qaSystemMaterial(videoName, materialKind!, skillBlock, curShots.length, curRefs.length)
        : PROMPTS.qaSystem(videoName, skillBlock, hasFrames, curShots.length, curRefs.length);
      const history = await db.chats.where('sessionId').equals(sessionId).sortBy('createdAt');
      // 末条即刚落库的当前问题，按降级链路组装（历史保持纯文本，截图不重复发送）
      // descBlock 已含 [截图@...] 标记，不再重复裸 marker 前缀
      // ⚠️ 引用块要同时进两处：displayContent（上屏 + 落库，用户回看历史时能看到自己引了什么）
      // 和 currentText（真正发给模型的那条）。漏掉后者的话，模型只能看到一个「这段」而不知道指什么。
      const currentText =
        (quoteBlock ? `${quoteBlock}\n\n` : '') +
        (shotLead ? `${shotLead}\n` : '') +
        q +
        (descBlock ? `\n${descBlock}` : '') +
        (subBlock ? `\n截图时刻前后字幕：\n${subBlock}` : '');      const budget =
        settings.contextWindow -
        estimateTokens(systemPrompt) -
        estimateTokens(currentText) -
        (imageParts ? curShots.length * 1200 : 0) - // 多模态图片每张约 1.2k tokens
        4096; // 输出预留
      const recent = fitHistoryToBudget(history.slice(0, -1), Math.max(2000, budget));
      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        ...recent.map((r) => ({ role: r.role, content: r.content }) as ChatMessage),
      ];
      if (imageParts) {
        messages.push({
          role: 'user',
          content: [...imageParts, { type: 'text', text: currentText }],
        });
      } else {
        messages.push({ role: 'user', content: currentText });
      }

      // present_quiz 校验通过后回调：题卡数据上屏（初始全部未作答）
      let quizState: QuizState | undefined;
      const executeTool = createToolExecutor(videoId, {
        // 材料：kind 决定走 search_material；视频：undefined 走 search_transcript
        kind: materialKind,
        onQuiz: (data) => {
          quizState = { data, picks: data.questions.map(() => -1) };
          patchAi({ quiz: quizState });
        },
      });
      await runAgentLoop(
        messages,
        // 材料用材料工具集（没有 search_transcript）；视频按是否有抽帧加 list_frames
        isMaterial ? MATERIAL_QA_TOOLS : hasFrames ? [...QA_TOOLS, LIST_FRAMES_TOOL] : QA_TOOLS,
        executeTool,
        {
          thinkingEffort: thinking && supportsThinking(llmModel) ? effort : undefined,
          onReasoningDelta: (t) => {
            reasoning += t;
            patchAi({ reasoning });
          },
          onDelta: (text) => {
            answer += text;
            patchAi({ content: answer, hint: undefined });
          },
          onRoundStart: () => {
            // 新一轮开始 = 上一轮流出的内容只是检索旁白，清空等待最终回答
            answer = '';
            patchAi({ content: '', hint: undefined });
          },
          onToolStart: (name, argsJson) => {
            let hint = isMaterial ? '正在检索材料…' : '正在检索字幕…';
            try {
              const args = JSON.parse(argsJson || '{}') as { query?: string; name?: string };
              if (name === 'search_transcript' && args.query) hint = `正在检索：${args.query}`;
              if (name === 'search_material' && args.query) hint = `正在检索材料：${args.query}`;
              if (name === 'get_transcript_range') hint = '正在查看字幕原文…';
              if (name === 'get_material_range') hint = '正在查看材料原文…';
              if (name === 'list_frames') hint = '正在查看课程画面…';
              if (name === 'present_quiz') hint = '正在出题…';
              if (name === 'use_skill') hint = `正在加载技能：${args.name ?? ''}`;
              if (name === 'read_skill_reference') hint = '正在查阅参考文档…';
            } catch {
              /* ignore */
            }
            patchAi({ hint });
          },
        },
        // 检索轮次上限来自设置（默认 6）；达到上限 agent 内部会强制无工具收尾作答
        settings.agentRounds,
      );

      const finalAnswer = answer.trim();
      if (finalAnswer || quizState) {
        patchAi({ streaming: false, hint: undefined });
        const rowId = (await db.chats.add({
          videoId,
          sessionId,
          role: 'assistant',
          content: finalAnswer,
          createdAt: Date.now(),
          reasoning: reasoning || undefined,
          ...(quizState ? { quiz: quizState } : {}),
        })) as number;
        patchAi({ rowId });
      } else {
        // 空回答兜底，避免留下永久空气泡
        patchAi({ streaming: false, hint: undefined, content: '（未获得回答）' });
      }
      // tier 2 有截图描述失败时，回答完成后一次性提示
      if (descFailed) {
        toast.warning('部分截图描述失败，回答仅参考了时间戳与字幕');
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      patchAi({
        streaming: false,
        hint: undefined,
        error: true,
        // 已流出部分内容时保留并追加中断说明，否则整体替换为错误提示
        content: answer.trim() ? `${answer}\n\n> 回答中断：${errMsg}` : `回答失败：${errMsg}`,
      });
    } finally {
      setLoading(false);
    }
  };

  // 会话下拉：mdui-select 的值是字符串，会话 id 是数字 —— 两端都要转换
  const sessionSelectRef = useMduiEvent('mdui-select', 'change', (_e, el) => {
    const n = Number(el.value);
    if (Number.isFinite(n)) setActiveId(n);
  });
  // 输入框：mdui-text-field 的 input 事件没有 payload，值要从元素上读（composerInput 声明在组件上方）
  // 思考深度：低 / 高 / 最大
  const effortRef = useMduiEvent('mdui-segmented-button-group', 'change', (_e, el) =>
    updateSettings({ thinkingEffort: el.value as ReasoningEffort }),
  );

  // 新消息滚动到底部。
  // 必须延后一帧：markdown 流式渲染的 DOM 高度在本帧还没算完，首帧滚动会停在半路。
  // 历史注：原来 Bubble.List 的滚动容器是「回调 ref → useState」注册的，首帧调 scrollTo
  // 时它内部还是 undefined（`const { scrollHeight } = undefined` 直接抛 TypeError），那次
  // 异常发生在挂载期、React 会把整棵页面树卸掉重挂 —— 现在自己持有真实元素，`?.` 已足够，
  // 但延后一帧仍然是必要的（否则滚不到底）。
  //
  // 依赖**不能**是 msgs 本身：作答题卡、落库回写 rowId 这类「原地交互」也会换 msgs 的引用，
  // 于是点一下选项就重新吸一次底 —— 而此刻解析块刚插进来、内容正好长高 Δ，列表又被贴到
  // 新底部，整屏（含刚点的那个选项）就往上跳 Δ。这里只认「消息变多 / 末尾正文增长」。
  // 题卡是否挂上也算一条：它是在气泡末尾追加的新内容，该跟到底部；
  // 而 picks 的变化不影响这个信号，所以作答不会触发滚动。
  const lastMsg = msgs[msgs.length - 1];
  const scrollSignal = [
    msgs.length,
    lastMsg?.key ?? '',
    lastMsg?.content.length ?? 0,
    lastMsg?.reasoning?.length ?? 0,
    lastMsg?.hint ?? '',
    lastMsg?.quiz ? 1 : 0,
  ].join('|');
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const el = listRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(id);
  }, [scrollSignal]);

  if (!hasSubtitles) {
    return (
      <Panel testId="panel-chat">
        <PanelPlaceholder testId="chat-empty">
          {isMaterial
            ? '这份材料还没有解析出可检索的文本，暂时无法提问'
            : '请先在「字幕」页生成字幕，然后才能针对课程内容提问'}
        </PanelPlaceholder>
      </Panel>
    );
  }

  /** 删除当前会话前确认（危险操作：确认按钮上错误色，文案写清动作） */
  const confirmDeleteSession = async () => {
    const ok = await confirmDialog({
      headline: '删除当前会话？',
      description: '会话里的全部问答记录都会被删除，无法恢复。',
      confirmText: '删除',
      cancelText: '取消',
      danger: true,
    });
    if (ok) void deleteSession();
  };

  /** 顶部一排小图标按钮（新开 / 复制 / 导出 / 删除 / 思考开关） */
  const iconBtn = (
    testId: string,
    label: string,
    icon: React.ReactNode,
    onClick: () => void,
    disabled?: boolean,
  ) => (
    <mdui-tooltip content={label}>
      <mdui-button-icon data-testid={testId} aria-label={label} disabled={disabled} onClick={onClick}>
        {icon}
      </mdui-button-icon>
    </mdui-tooltip>
  );

  return (
    <Panel testId="panel-chat">
      <PanelBar wrap={false} testId="chat-toolbar">
        <mdui-select
          ref={sessionSelectRef}
          className="chat-session-select"
          value={activeId != null ? String(activeId) : undefined}
          disabled={loading}
          data-testid="chat-session"
        >
          {sessions.map((s) => (
            <mdui-menu-item key={s.id} value={String(s.id)}>
              {s.title}
            </mdui-menu-item>
          ))}
        </mdui-select>
        {iconBtn('chat-new-session', '新开会话', <mdui-sym-add />, createSession, loading)}
        {iconBtn('copy-session-btn', '复制整个会话（Markdown）', <mdui-sym-content-copy />, copySession, loading || msgs.length === 0)}
        {iconBtn('export-session-btn', '导出 .md 文件', <mdui-sym-download />, downloadSession, loading || msgs.length === 0)}
        {iconBtn('chat-delete-session', '删除当前会话', <mdui-sym-delete />, confirmDeleteSession, loading)}
        {isMobile && supportsThinking(llmModel) && (
          <mdui-tooltip content={thinking ? '关闭思考' : '开启思考'}>
            <mdui-button-icon
              data-testid="chat-thinking-toggle"
              aria-label={thinking ? '关闭思考' : '开启思考'}
              variant={thinking ? 'filled' : 'standard'}
              onClick={() => updateSettings({ thinkingEnabled: !thinking })}
            >
              <mdui-sym-lightbulb />
            </mdui-button-icon>
          </mdui-tooltip>
        )}
      </PanelBar>

      {indexProgress && (
        <PanelProgress
          testId="chat-index-progress"
          percent={Math.round((indexProgress.done / Math.max(1, indexProgress.total)) * 100)}
          text={indexProgress.message}
        />
      )}

      <PanelBar wrap={false} testId="chat-model-bar">
        <ModelPicker slot="chat" field="llmModel" />
        <PanelSpacer />
        {supportsThinking(llmModel) && !isMobile && (
          <mdui-tooltip content={thinking ? '关闭思考' : '开启思考'}>
            <mdui-button-icon
              data-testid="chat-thinking-toggle"
              aria-label={thinking ? '关闭思考' : '开启思考'}
              variant={thinking ? 'filled' : 'standard'}
              onClick={() => updateSettings({ thinkingEnabled: !thinking })}
            >
              <mdui-sym-lightbulb />
            </mdui-button-icon>
          </mdui-tooltip>
        )}
        {supportsThinking(llmModel) && thinking && (
          <mdui-segmented-button-group ref={effortRef} selects="single" value={effort} data-testid="chat-effort">
            <mdui-segmented-button value="low">低</mdui-segmented-button>
            <mdui-segmented-button value="high">高</mdui-segmented-button>
            <mdui-segmented-button value="max">最大</mdui-segmented-button>
          </mdui-segmented-button-group>
        )}
      </PanelBar>

      {/* 消息流：AI 靠左、用户靠右。两种气泡的形状差是 MD3 聊天的标志 ——
          靠对话侧收小圆角、另一侧全圆角。流式 markdown / 思考块 / 题卡都留在 AI 气泡内。 */}
      <PanelBody bodyRef={listRef} className="chat-list-wrap" testId="chat-list">
        {msgs.length === 0 && (
          <PanelPlaceholder testId="chat-empty">针对课程内容提问，回答中的时间戳可点击跳转</PanelPlaceholder>
        )}
        {msgs.map((m) => {
          const isUser = m.role === 'user';
          return (
            <div
              key={m.key}
              className={isUser ? 'chat-msg chat-msg--user' : 'chat-msg chat-msg--ai'}
              data-testid={isUser ? 'chat-msg-user' : 'chat-msg-ai'}
              data-streaming={m.streaming ? 'true' : undefined}
              data-error={m.error ? 'true' : undefined}
            >
              {isUser ? (
                <>
                  {m.images && m.images.length > 0 && (
                    <div className="chat-shots">
                      {m.images.map((img, i) => (
                        <span key={i} className="chat-shot">
                          {/* 材料的截图锚点是页/段号：点击滚到那一页，标签也写「第 N 页」而不是时间 */}
                          <img
                            src={img.thumb}
                            alt=""
                            onClick={() =>
                              img.kind === 'page-selection'
                                ? readerRef?.current?.scrollToUnit(img.ts)
                                : seekTo(img.ts)
                            }
                            className="chat-shot__img"
                          />
                          <span className="chat-ts-chip">
                            {img.kind === 'page-selection' && materialKind
                              ? fmtUnitRef(materialKind, img.ts)
                              : fmtTime(img.ts)}
                          </span>
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="chat-bubble chat-bubble--user">
                    <UserContent content={m.content} />
                  </div>
                </>
              ) : (
                <div className="chat-bubble chat-bubble--ai">
                  {m.hint && !m.content ? (
                    <ThinkLine text={m.hint} />
                  ) : (
                    <>
                      {m.reasoning && (
                        <ReasoningBlock reasoning={m.reasoning} active={!!m.streaming && !m.content} />
                      )}
                      <XMarkdown
                        // 材料只跑 linkifyUnits：#seek- 需要一个存在的播放器，
                        // 材料没有播放器，留着会生成点了没反应的死链；
                        // #frame- 画面引用同理（材料没有抽帧）。
                        content={
                          isMaterial && materialKind
                            ? linkifyUnits(m.content, materialKind)
                            : linkifyTimestamps(linkifyFrames(m.content))
                        }
                        components={{ a: SeekLink, p: StreamParagraph, img: FrameImage, code: MarkdownCode, pre: MarkdownPre }}
                        streaming={{ hasNextChunk: !!m.streaming, tail: !!m.streaming }}
                      />
                      {m.quiz && (
                        <QuizCard
                          quiz={m.quiz.data}
                          picks={m.quiz.picks}
                          onAnswer={(qi, oi) => handleAnswer(m.key, qi, oi)}
                          onSeek={seekTo}
                          // 材料没有播放器：解析里的时间戳不 linkify，免得出现点了没反应的死链
                          seekable={!isMaterial}
                        />
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </PanelBody>

      {/* 索引不可用的原因（扫描件）。必须显式说明，否则用户只会看到输入框是灰的 */}
      {indexNote && (
        <div className="chat-note" data-testid="chat-index-note">
          <mdui-sym-warning />
          <span>{indexNote}</span>
        </div>
      )}

      {/* 输入区：截图/出题在左，输入框居中，发送在右。
          Enter 发送、Shift+Enter 换行；isComposing 时放行（中文输入法选词的回车不是提交意图）。 */}
      <div className="chat-composer" data-testid="chat-composer">
        {/*
          引用条：划词/框选带进来的原文片段（最多 MAX_REFS 条）。
          单独一行而不是塞进输入框文本里 —— 用户能一眼看清引了什么、能单条删掉，
          也不会污染自己正在写的句子。
        */}
        {refs.length > 0 && (
          <div className="chat-refs" data-testid="chat-refs">
            {refs.map((c, i) => (
              <span
                key={`${c.source}-${c.unit ?? c.time ?? 0}-${i}`}
                className="chat-ref"
                data-testid="chat-ref-chip"
              >
                {c.image && <img src={c.image.thumb} alt="" className="chat-ref__img" />}
                <span className="chat-ref__body">
                  {c.unitLabel && <span className="chat-ref__where">{c.unitLabel}</span>}
                  <span className="chat-ref__text" title={c.text}>
                    {c.text}
                  </span>
                </span>
                <mdui-button-icon
                  className="chat-ref__remove"
                  aria-label="移除引用"
                  data-testid="ref-chip-remove"
                  onClick={() => {
                    const next = refs.filter((_, j) => j !== i);
                    refsRef.current = next;
                    setRefs(next);
                  }}
                >
                  <mdui-sym-close />
                </mdui-button-icon>
              </span>
            ))}
          </div>
        )}
        {shots.length > 0 && (
          <div className="chat-shots chat-shots--pending">
            {shots.map((s, i) => (
              <span key={i} className="chat-shot">
                <img src={s.thumb} alt="" className="chat-shot__img chat-shot__img--sm" />
                <span className="chat-ts-chip">
                  {isMaterial ? fmtUnitRef(materialKind!, s.ts) : fmtTime(s.ts)}
                </span>
                <mdui-button-icon
                  className="chat-shot__remove"
                  aria-label="移除截图"
                  onClick={() => setShots((prev) => prev.filter((_, j) => j !== i))}
                >
                  <mdui-sym-close />
                </mdui-button-icon>
              </span>
            ))}
          </div>
        )}
        <div className="chat-composer__row">
          {/* 截图按钮只在有播放器时出现：材料没有正在播放的画面可截，框选走阅读器的「框选」按钮 */}
          {!isMaterial && (
            <mdui-tooltip content="截取当前画面（最多 4 张）">
              <mdui-button-icon
                data-testid="shot-btn"
                aria-label="截取当前画面"
                disabled={!indexReady || shots.length >= 4 || loading}
                onClick={addShot}
              >
                <mdui-sym-photo-camera />
              </mdui-button-icon>
            </mdui-tooltip>
          )}
          <mdui-tooltip content="出题考我">
            <mdui-button-icon
              data-testid="quiz-btn"
              aria-label="出题考我"
              disabled={!indexReady || loading}
              onClick={() => send('根据课程内容出 3 道单选题考考我，选项要有干扰性')}
            >
              <mdui-sym-quiz />
            </mdui-button-icon>
          </mdui-tooltip>
          <mdui-text-field
            className="chat-input"
            data-testid="chat-input"
            variant="outlined"
            rows={2}
            placeholder={indexReady ? '输入问题，回车发送' : '等待索引就绪…'}
            disabled={!indexReady}
            value={input}
            ref={composerInput}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.shiftKey) return;
              if (e.nativeEvent.isComposing) return;
              e.preventDefault();
              void send(input);
            }}
          />
          <mdui-tooltip content="发送">
            <mdui-button-icon
              className="chat-send"
              data-testid="chat-send"
              aria-label="发送"
              variant="filled"
              loading={loading}
              disabled={!indexReady}
              onClick={() => send(input)}
            >
              <mdui-sym-send />
            </mdui-button-icon>
          </mdui-tooltip>
        </div>
        <div className={ctxLevel ? `chat-ctx chat-ctx--${ctxLevel}` : 'chat-ctx'} data-testid="chat-ctx">
          ≈{(ctxEst / 1000).toFixed(1)}k / {Math.round(ctxWin / 1000)}k
          {ratio > 0.9 && ' · 建议开启新话题'}
        </div>
      </div>
    </Panel>
  );
}
