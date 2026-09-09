import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { App, Button, Popconfirm, Progress, Segmented, Select, Space, Tooltip } from 'antd';
import { BulbOutlined, CameraOutlined, CloseOutlined, CopyOutlined, DeleteOutlined, DownloadOutlined, FormOutlined, PlusOutlined, RightOutlined } from '@ant-design/icons';
import { Bubble, Sender } from '@ant-design/x';
import { XMarkdown, type ComponentProps } from '@ant-design/x-markdown';
import type { MediaPlayerInstance } from '@vidstack/react';
import { db, type ChatImage, type ChatSessionRow, type QuizState, type SegmentRow } from '../store/db';
import { getSettings, useSettings } from '../store/settings';
import { ensureEmbeddingIndex, type EmbedProgress } from '../pipelines/embedIndex';
import { runAgentLoop } from '../harness/agent';
import { QA_TOOLS, LIST_FRAMES_TOOL, createToolExecutor } from '../harness/tools';
import { PROMPTS } from '../harness/prompts';
import { estimateTokens, fitHistoryToBudget, subtitleWindow } from '../harness/context';
import { loadEnabledSkillMeta, skillMetaBlock } from '../skills/store';
import { captureFrame, resolveVideoEl, type Snapshot } from '../media/snapshot';
import { isVisionModel, supportsThinking } from '../api/modelCaps';
import { chatOnce, textOf, type ChatMessage, type ContentPart, type ReasoningEffort } from '../api/siliconflow';
import { fmtTime } from '../utils/vtt';
import { linkifyFrames, linkifyTimestamps } from '../utils/linkify';
import { buildSessionMarkdown, exportFileName } from '../utils/chatExport';
import { copyText } from '../utils/clipboard';
import { useIsMobile } from '../utils/useMobile';
import { ThinkLine, StreamParagraph } from './motion';
import ModelPicker from './ModelPicker';
import QuizCard from './QuizCard';

interface Props {
  videoId: string;
  videoName: string;
  playerRef: React.RefObject<MediaPlayerInstance | null>;
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
        style={{ cursor: 'pointer', fontVariantNumeric: 'tabular-nums' }}
      >
        {alt || `[图@${fmtTime(secs)}]`}
      </a>
    );
  }
  return (
    <span style={{ position: 'relative', display: 'inline-block', margin: '4px 0', verticalAlign: 'top' }}>
      {url ? (
        <img
          src={url}
          alt={alt ?? ''}
          onClick={() => onSeek(frame.ts)}
          style={{ maxHeight: 140, maxWidth: '100%', borderRadius: 4, display: 'block', cursor: 'pointer' }}
        />
      ) : (
        <span style={{ display: 'inline-block', width: 200, height: 112, borderRadius: 4, background: 'rgba(0,0,0,.06)' }} />
      )}
      <span
        style={{
          position: 'absolute',
          left: 2,
          bottom: 2,
          fontSize: 10,
          color: '#fff',
          background: 'rgba(0,0,0,.55)',
          borderRadius: 2,
          padding: '0 2px',
        }}
      >
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
    <div style={{ marginBottom: 6, fontSize: 12 }}>
      <div
        onClick={() => setOpen((v) => !v)}
        style={{ cursor: 'pointer', opacity: 0.6, userSelect: 'none', display: 'flex', alignItems: 'center', gap: 4 }}
      >
        <RightOutlined
          style={{ fontSize: 10, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}
        />
        {active ? '思考中…' : '思考过程'}
      </div>
      {open && (
        <div
          style={{
            whiteSpace: 'pre-wrap',
            opacity: 0.75,
            borderLeft: '2px solid #ddd',
            paddingLeft: 8,
            marginTop: 4,
            maxHeight: 240,
            overflow: 'auto',
          }}
        >
          {reasoning}
        </div>
      )}
    </div>
  );
}

export default function ChatPanel({ videoId, videoName, playerRef }: Props) {
  const { message } = App.useApp();
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [hasSubtitles, setHasSubtitles] = useState(false);
  const [indexProgress, setIndexProgress] = useState<EmbedProgress | null>(null);
  const [indexReady, setIndexReady] = useState(false);
  const [sessions, setSessions] = useState<ChatSessionRow[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [shots, setShots] = useState<Snapshot[]>([]);
  // 讲义抽帧元数据：决定 list_frames 工具/提示词注入，也供 AI 气泡里的画面引用渲染
  const [framesMeta, setFramesMeta] = useState<FrameMeta[]>([]);
  const llmModel = useSettings((s) => s.llmModel);
  const thinking = useSettings((s) => s.thinkingEnabled);
  const effort = useSettings((s) => s.thinkingEffort);
  const ctxWin = useSettings((s) => s.contextWindow);
  const updateSettings = useSettings((s) => s.update);
  const listRef = useRef<{ scrollTo: (o: { top: 'bottom'; behavior?: ScrollBehavior }) => void } | null>(null);
  // 手机端：思考开关上移到会话行，第二行只留 ModelPicker（+思考深度），省一行高度
  const isMobile = useIsMobile();

  /** 截取当前视频画面，加入待发送列表（最多 4 张） */
  const addShot = () => {
    const video = resolveVideoEl(playerRef);
    const t = playerRef.current?.currentTime ?? 0;
    if (!video) return message.warning('视频未就绪');
    const snap = captureFrame(video, t);
    if (!snap) return message.warning('截图失败，请稍候重试');
    if (shots.length >= 4) return message.info('最多附带 4 张截图');
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

  /** 自定义链接渲染：#seek-N 跳转播放器，其余外链新窗口打开 */
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
            style={{ cursor: 'pointer', fontVariantNumeric: 'tabular-nums' }}
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
    [seekTo],
  );

  // 上下文用量估算（system + 历史 + 当前输入/截图），仅作 UI 提示
  const ctxEst = useMemo(() => {
    const sys = estimateTokens(PROMPTS.qaSystem(videoName));
    // 历史只发送 content，reasoning 不计入
    const hist = msgs.reduce((s, m) => s + estimateTokens(m.content), 0);
    const cur = estimateTokens(input) + shots.length * 1200; // 每张图约 1.2k tokens
    return sys + hist + cur;
  }, [msgs, input, shots, videoName]);
  const ratio = ctxEst / ctxWin;
  const ctxColor = ratio > 0.9 ? '#ff4d4f' : ratio > 0.7 ? '#fa8c16' : '#bbb';

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
        if (!cancelled) message.error(`建立问答索引失败：${e instanceof Error ? e.message : String(e)}`);
      } finally {
        if (!cancelled) setIndexProgress(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [videoId]);

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
    if (msgs.length === 0) return void message.info('当前会话还没有内容');
    const ok = await copyText(sessionMarkdown());
    if (ok) message.success(`已复制整个会话（Markdown，${msgs.length} 条消息）`);
    else message.error('复制失败：剪贴板不可用，可改用「导出 .md」');
  };

  /** 导出整个会话为 .md 文件（归档/跨设备带走） */
  const downloadSession = () => {
    if (msgs.length === 0) return void message.info('当前会话还没有内容');
    const url = URL.createObjectURL(new Blob([sessionMarkdown()], { type: 'text/markdown;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = exportFileName(videoName, activeTitle);
    a.click();
    URL.revokeObjectURL(url);
    message.success('已导出 Markdown 文件');
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
    message.success('已删除会话');
  };

  const send = async (question: string) => {
    const q = question.trim();
    if ((!q && shots.length === 0) || loading || activeId == null) return;
    if (!indexReady) {
      message.warning('问答索引尚未就绪');
      return;
    }
    const sessionId = activeId;
    const settings = getSettings();
    const curShots = [...shots].sort((a, b) => a.ts - b.ts);

    // 降级链 tier 3 前置检查：模型无图能力且未配视觉模型时直接拦截，不清空输入与截图，保留草稿
    if (curShots.length > 0 && !isVisionModel(settings.llmModel) && !settings.visionModel) {
      message.error('当前模型不支持图片，请在设置中配置视觉模型或切换多模态模型');
      return;
    }

    setInput('');
    setShots([]);
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
      const marker = curShots.map((s) => `[截图@${fmtTime(s.ts)}]`).join('');
      const displayContent = marker + q;
      const userImages: ChatImage[] = curShots.map((s) => ({ ts: s.ts, thumb: s.thumb }));
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

      // 截图进上下文的降级链：tier 1 多模态模型直接看图；tier 2 视觉模型先描述成文字
      let imageParts: ContentPart[] | null = null;
      let descBlock = '';
      let descFailed = false;
      if (curShots.length > 0) {
        if (isVisionModel(settings.llmModel)) {
          // 每张图前插入时间戳文本，模型才能把画面归属到 [截图@mm:ss]
          imageParts = curShots.flatMap(
            (s): ContentPart[] => [
              { type: 'text', text: `[截图@${fmtTime(s.ts)}]` },
              { type: 'image_url', image_url: { url: s.dataUrl } },
            ],
          );
        } else {
          // 前置检查已保证 visionModel 非空
          const results = await Promise.allSettled(
            curShots.map((s) =>
              chatOnce(settings, {
                model: settings.visionModel,
                messages: [
                  {
                    role: 'user',
                    content: [
                      { type: 'image_url', image_url: { url: s.dataUrl } },
                      { type: 'text', text: PROMPTS.shotDescribe(q) },
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
              const at = `[截图@${fmtTime(curShots[i].ts)}]`;
              return r.status === 'fulfilled'
                ? `${at} 画面：${textOf(r.value)}`
                : `${at}（画面描述失败，仅参考时间戳与字幕）`;
            })
            .join('\n');
        }
      }

      // 截图时刻前后的字幕窗口（多时刻窗口按段去重合并）
      let subBlock = '';
      if (curShots.length > 0) {
        const segs = await db.segments
          .where('videoId')
          .equals(videoId)
          .filter((r) => r.status === 1 && !!r.text)
          .sortBy('idx');
        const byIdx = new Map<number, SegmentRow>();
        for (const s of curShots) {
          for (const seg of subtitleWindow(segs, s.ts)) byIdx.set(seg.idx, seg);
        }
        subBlock = [...byIdx.values()]
          .sort((a, b) => a.idx - b.idx)
          .map((seg) => `[${fmtTime(seg.start)}] ${seg.text}`)
          .join('\n');
      }

      // 构造上下文：system + 按 token 预算截取的历史 + 当前问题
      // Level 1：技能元数据清单进系统提示词，agent 按需用 use_skill 加载正文
      const skillMetas = await loadEnabledSkillMeta();
      // 每次发送前刷新帧元数据（讲义可能在本面板挂载后生成）：有帧才注册 list_frames 工具并注入引用规则
      const meta = await loadFramesMeta();
      const hasFrames = meta.length > 0;
      const systemPrompt = PROMPTS.qaSystem(
        videoName,
        skillMetas.length > 0 ? skillMetaBlock(skillMetas) : undefined,
        hasFrames,
      );
      const history = await db.chats.where('sessionId').equals(sessionId).sortBy('createdAt');
      // 末条即刚落库的当前问题，按降级链路组装（历史保持纯文本，截图不重复发送）
      // descBlock 已含 [截图@...] 标记，不再重复裸 marker 前缀
      const currentText =
        q +
        (descBlock ? `\n${descBlock}` : '') +
        (subBlock ? `\n截图时刻前后字幕：\n${subBlock}` : '');
      const budget =
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
      const executeTool = createToolExecutor(videoId, (data) => {
        quizState = { data, picks: data.questions.map(() => -1) };
        patchAi({ quiz: quizState });
      });
      await runAgentLoop(
        messages,
        hasFrames ? [...QA_TOOLS, LIST_FRAMES_TOOL] : QA_TOOLS,
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
            let hint = '正在检索字幕…';
            try {
              const args = JSON.parse(argsJson || '{}') as { query?: string; name?: string };
              if (name === 'search_transcript' && args.query) hint = `正在检索：${args.query}`;
              if (name === 'get_transcript_range') hint = '正在查看字幕原文…';
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
        message.warning('部分截图描述失败，回答仅参考了时间戳与字幕');
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

  // 新消息滚动到底部
  useEffect(() => {
    listRef.current?.scrollTo({ top: 'bottom' });
  }, [msgs]);

  if (!hasSubtitles) {
    return (
      <div style={{ color: '#999', padding: 16, textAlign: 'center' }}>
        请先在「字幕」页生成字幕，然后才能针对课程内容提问
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0, paddingBottom: 8 }}>
        <Select
          size="small"
          style={{ flex: 1, minWidth: 0 }}
          value={activeId ?? undefined}
          onChange={(sid) => setActiveId(sid)}
          disabled={loading}
          options={sessions.map((s) => ({ value: s.id!, label: s.title }))}
        />
        <Tooltip title="新开会话">
          <Button size="small" icon={<PlusOutlined />} onClick={createSession} disabled={loading} />
        </Tooltip>
        <Tooltip title="复制整个会话（Markdown）">
          <Button
            size="small"
            icon={<CopyOutlined />}
            onClick={copySession}
            disabled={loading || msgs.length === 0}
            data-testid="copy-session-btn"
          />
        </Tooltip>
        <Tooltip title="导出 .md 文件">
          <Button
            size="small"
            icon={<DownloadOutlined />}
            onClick={downloadSession}
            disabled={loading || msgs.length === 0}
            data-testid="export-session-btn"
          />
        </Tooltip>
        <Popconfirm title="删除当前会话？" okText="删除" cancelText="取消" onConfirm={deleteSession}>
          <Button size="small" danger icon={<DeleteOutlined />} disabled={loading} />
        </Popconfirm>
        {isMobile && supportsThinking(llmModel) && (
          <Tooltip title="开启思考">
            <Button
              size="small"
              type={thinking ? 'primary' : 'text'}
              icon={<BulbOutlined />}
              onClick={() => updateSettings({ thinkingEnabled: !thinking })}
            />
          </Tooltip>
        )}
      </div>

      {indexProgress && (
        <div style={{ padding: '4px 0 12px', flexShrink: 0 }}>
          <Progress
            percent={Math.round((indexProgress.done / Math.max(1, indexProgress.total)) * 100)}
            size="small"
            status="active"
          />
          <div style={{ fontSize: 12, color: '#888' }}>{indexProgress.message}</div>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0 8px', flexShrink: 0 }}>
        <ModelPicker slot="chat" field="llmModel" />
        {supportsThinking(llmModel) && !isMobile && (
          <Space size={4}>
            <Tooltip title="开启思考">
              <Button
                size="small"
                type={thinking ? 'primary' : 'text'}
                icon={<BulbOutlined />}
                onClick={() => updateSettings({ thinkingEnabled: !thinking })}
              />
            </Tooltip>
            {thinking && (
              <Segmented
                size="small"
                value={effort}
                options={[
                  { label: '低', value: 'low' },
                  { label: '高', value: 'high' },
                  { label: '最大', value: 'max' },
                ]}
                onChange={(v) => updateSettings({ thinkingEffort: v as ReasoningEffort })}
              />
            )}
          </Space>
        )}
        {supportsThinking(llmModel) && isMobile && thinking && (
          <Segmented
            size="small"
            value={effort}
            options={[
              { label: '低', value: 'low' },
              { label: '高', value: 'high' },
              { label: '最大', value: 'max' },
            ]}
            onChange={(v) => updateSettings({ thinkingEffort: v as ReasoningEffort })}
          />
        )}
      </div>

      <div style={{ flex: 1, overflow: 'hidden', padding: '4px 0' }}>
        <Bubble.List
          ref={listRef as React.RefObject<never>}
          style={{ height: '100%' }}
          items={msgs.map((m) => ({
            key: m.key,
            role: m.role,
            content: m.error ? m.content : m.hint && !m.content ? m.hint : m.content,
            // 思考流出时立即上屏思考块，而非 loading 占位
            loading: m.streaming && !m.content && !m.hint && !m.reasoning,
            status: m.streaming ? 'updating' : m.error ? 'error' : undefined,
            extraInfo:
              (m.images && m.images.length > 0) || m.reasoning
                ? { images: m.images, reasoning: m.reasoning }
                : undefined,
          }))}
          role={{
            ai: {
              placement: 'start',
              variant: 'borderless',
              contentRender: (content, info) => {
                // 工具调用期间的状态行（"正在检索…"）：thinking-states  shimmer + 交换
                const msg = msgs.find((x) => x.key === info.key);
                if (msg?.hint && !msg.content) {
                  return <ThinkLine text={String(content ?? '')} />;
                }
                // 思考过程（经 extraInfo 透传，与用户气泡截图同机制）
                const reasoning = (info.extraInfo as { reasoning?: string } | undefined)?.reasoning;
                return (
                  <div>
                    {reasoning && (
                      <ReasoningBlock reasoning={reasoning} active={info.status === 'updating' && !msg?.content} />
                    )}
                    <XMarkdown
                      content={linkifyTimestamps(linkifyFrames(String(content ?? '')))}
                      components={{ a: SeekLink, p: StreamParagraph, img: FrameImage }}
                      streaming={{
                        hasNextChunk: info.status === 'updating',
                        tail: info.status === 'updating',
                      }}
                    />
                    {msg?.quiz && (
                      <QuizCard
                        quiz={msg.quiz.data}
                        picks={msg.quiz.picks}
                        onAnswer={(qi, oi) => handleAnswer(String(info.key), qi, oi)}
                        onSeek={seekTo}
                      />
                    )}
                  </div>
                );
              },
            },
            user: {
              placement: 'end',
              contentRender: (content, info) => {
                // 截图缩略图行（经 extraInfo 透传），点击跳转到对应画面
                const images = (info.extraInfo as { images?: ChatImage[] } | undefined)?.images;
                return (
                  <div>
                    {images && images.length > 0 && (
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                        {images.map((img, i) => (
                          <span key={i} style={{ position: 'relative', display: 'inline-block' }}>
                            <img
                              src={img.thumb}
                              alt=""
                              onClick={() => seekTo(img.ts)}
                              style={{ height: 56, borderRadius: 4, display: 'block', cursor: 'pointer' }}
                            />
                            <span
                              style={{
                                position: 'absolute',
                                left: 2,
                                bottom: 2,
                                fontSize: 10,
                                color: '#fff',
                                background: 'rgba(0,0,0,.55)',
                                borderRadius: 2,
                                padding: '0 2px',
                              }}
                            >
                              {fmtTime(img.ts)}
                            </span>
                          </span>
                        ))}
                      </div>
                    )}
                    {content}
                  </div>
                );
              },
            },
          }}
        />
        {msgs.length === 0 && (
          <div style={{ color: '#999', padding: 16, textAlign: 'center' }}>
            针对课程内容提问，回答中的时间戳可点击跳转
          </div>
        )}
      </div>

      <div style={{ flexShrink: 0, paddingTop: 8 }}>
        <Sender
          value={input}
          onChange={setInput}
          onSubmit={send}
          loading={loading}
          disabled={!indexReady}
          placeholder={indexReady ? '输入问题，回车发送' : '等待索引就绪…'}
          prefix={
            <>
              <Button
                type="text"
                size="small"
                icon={<CameraOutlined />}
                disabled={!indexReady || shots.length >= 4 || loading}
                onClick={addShot}
                title="截取当前画面（最多 4 张）"
                data-testid="shot-btn"
              />
              <Button
                type="text"
                size="small"
                icon={<FormOutlined />}
                disabled={!indexReady || loading}
                onClick={() => send('根据课程内容出 3 道单选题考考我，选项要有干扰性')}
                title="出题考我"
                data-testid="quiz-btn"
              />
            </>
          }
          header={
            shots.length > 0 ? (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: '4px 0' }}>
                {shots.map((s, i) => (
                  <span key={i} style={{ position: 'relative', display: 'inline-block' }}>
                    <img src={s.thumb} alt="" style={{ height: 48, borderRadius: 4, display: 'block' }} />
                    <span
                      style={{
                        position: 'absolute',
                        left: 2,
                        bottom: 2,
                        fontSize: 10,
                        color: '#fff',
                        background: 'rgba(0,0,0,.55)',
                        borderRadius: 2,
                        padding: '0 2px',
                      }}
                    >
                      {fmtTime(s.ts)}
                    </span>
                    <CloseOutlined
                      onClick={() => setShots((prev) => prev.filter((_, j) => j !== i))}
                      style={{
                        position: 'absolute',
                        top: -6,
                        right: -6,
                        fontSize: 10,
                        background: '#fff',
                        borderRadius: '50%',
                        padding: 2,
                        boxShadow: '0 0 2px rgba(0,0,0,.3)',
                        cursor: 'pointer',
                      }}
                    />
                  </span>
                ))}
              </div>
            ) : undefined
          }
        />
        <div
          style={{
            textAlign: 'right',
            fontSize: 11,
            color: ctxColor,
            paddingTop: 2,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          ≈{(ctxEst / 1000).toFixed(1)}k / {Math.round(ctxWin / 1000)}k
          {ratio > 0.9 && ' · 建议开启新话题'}
        </div>
      </div>
    </div>
  );
}
