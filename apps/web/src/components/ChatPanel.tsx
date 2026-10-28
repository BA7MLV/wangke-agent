import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Dropdown, ListBox, Select, TextArea, Tooltip } from '@heroui/react';
import { useImeEnter } from '../utils/imeEnter';
import type { ComponentProps } from '@ant-design/x-markdown';
import { MaterialImage, SourceImage } from './MaterialImage';
import { parseMaterialImageHref } from '../materials/imageRefs';
import { Markdown as XMarkdown } from './markdown/Markdown';
import { systemMaterialPath } from '../materials/systemFiles';
import type { MediaPlayerInstance } from '@vidstack/react';
import { db, type ChatImage, type ChatSessionRow, type ChatToolCall, type QuizState, type SegmentRow } from '../store/db';
import { catalogOf, decisionConfigOf, getSettings, modelOverridesOf, targetOrNull, useSettings, visionTargetOrNull } from '../store/settings';
import { runAgentLoop, noAnswerNotice, type AgentStopInfo } from '../harness/agent';
import { resolveMaxRounds } from '../harness/loopGuard';
import { mdEditorOpen } from '../harness/tools';
import { courseResourceTools, createResourceExecutor } from '../harness/resources';
import { PROMPTS } from '../harness/prompts';
import { estimateTokens, subtitleWindow } from '../harness/context';
import { EMPTY_COMPRESSION, prepareSessionHistory, retainedContext, useContextCompressionStore } from '../store/contextCompression';
import ContextUsageButton from './ContextUsageButton';
import ComposerExpand, { useComposerSize } from './ComposerExpand';
import { useContextCompression } from './useContextCompression';
import { loadSessionSkillMeta, skillMetaBlock } from '../skills/store';
import { handoutDraft, prepareHandoutPrompt } from '../skills/handout';
import { captureFrame, resolveVideoEl, type Snapshot } from '../media/snapshot';
import { isVisionModel, supportsThinking } from '../api/modelCaps';
import { chatOnce, textOf, type ChatMessage, type ContentPart, type ThinkingLevel } from '../api/siliconflow';
import { fmtTime } from '../utils/vtt';
import { linkifyFrames, linkifyTimestamps, linkifyUnits } from '../utils/linkify';
import { isToolFailure, summarizeToolResult, toolDetail, toolHint } from '../utils/toolTrace';
import { fmtUnitRef, type UnitKind } from '../materials/units.ts';
import type { MaterialReaderHandle } from '../materials/types';
import { useSelectionAsk, formatCitation, EXPLAIN_PROMPT, MAX_REFS, type Citation } from '../store/selectionAsk';
import { buildSessionMarkdown, exportFileName, markdownToPlainText } from '../utils/chatExport';
import { copyText } from '../utils/clipboard';
import { messageTime } from '../utils/messageTime';
import { useMediaQuery } from '../utils/useMobile';
import { useModelMetaRevision } from '../utils/useModelMeta';
import {
  Panel,
  PanelBar,
  PanelBody,
  PanelPlaceholder,
  Sym,
  toast,
  confirmDialog,
} from '../ui';
import { StreamParagraph, useMessageEnter } from './motion';
import ResponseProcess from './ResponseProcess';
import type { ProcessPhase } from '../utils/responseProcess';
import VirtualMessages, { type VirtualMessagesHandle } from './VirtualMessages';
import { useMessageDeletion } from './useMessageDeletion';
import { useChatScroll } from './useChatScroll';
import ChatHistorySkeleton from './ChatHistorySkeleton';
import { readChatPage, readChatHistory } from '../store/chatHistory';
import { framePatch } from '../utils/framePatch';
import { MarkdownCode, MarkdownPre } from './mermaid/markdown';
import { MarkdownTable } from './MdTable';
import { MarkdownStreamingProvider } from './markdown/streaming';
import ModelPicker from './ModelPicker';
import SkillPicker from './SkillPicker';
import QuizCard from './QuizCard';
import { canUpdateQuizPick, quizHistoryContent, type QuizPick } from '../harness/quiz';
import WidgetMessage from './WidgetMessage';
import StreamingHtmlPreview from './StreamingHtmlPreview';
import { ArtifactEditProvider } from './ArtifactEditor';
import AssistantContent from './AssistantContent';
import { useResolvedDark } from '../ui/theme';
import type { WidgetPayload } from '../harness/widgetRuntime';
import { nextVisualRound, readPartialWidgetArguments } from '../utils/streamingHtml';
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
  /**
   * 材料的原始格式（视频课程不传）。**只有 `'md'` 有编辑面**，
   * `edit_markdown` 工具与「材料可编辑」那条提示词都据此开关（见 send 里那段注释）。
   *
   * 为什么与 materialKind 分开两个 prop：kind 是**定位单位**（页码 / 段落号），
   * format 是**文件格式**（能不能改）。`'html'` 与 `'md'` 的定位单位相同但一个能改一个不能，
   * 合成一个 prop 就得在两边各自反推「这个 kind 是不是可编辑的」，那是两处会漂移的判断。
   */
  materialFormat?: 'pdf' | 'docx' | 'md' | 'html';
}

interface ChatMsg {
  processPhase?: ProcessPhase;
  /** 本轮启动时刻，切页重挂时不重置过程计时（不落库）。 */
  processStartedAt?: number;
  key: string;
  role: 'user' | 'ai';
  content: string;
  /** 落库时间：手机端长按用户气泡时显示（与主页对话一致） */
  createdAt?: number;
  /** 用户消息附带的截图缩略图 */
  images?: ChatImage[];
  /** 思考过程（推理模型 reasoning_content 的回调累计值） */
  reasoning?: string;
  /** 思考耗时（毫秒）：首个思考 token → 末个。落库，历史消息也显示 */
  reasoningMs?: number;
  /**
   * 首个思考 token 的时刻（毫秒时间戳）。
   *
   * **不落库**：它只服务「思考中」那几秒的实时计时（`ReasoningChain` 的 `since`），
   * 历史消息用的是终值 `reasoningMs`。存进库里只会多一个没人读、还会过期的字段。
   */
  reasoningStartedAt?: number;
  /** 工具调用期间的提示（如"正在检索…"） */
  hint?: string;
  /**
   * 这一轮调过的工具（含正在跑的那次）。落库，历史消息也回放 ——
   * 见 `components/ToolTrace.tsx` 顶部那段「为什么要有这一块」。
   */
  tools?: ChatToolCall[];
  /** 答题卡（present_quiz 工具产出） */
  quiz?: QuizState;
  /** 沙箱图形卡（show_widget 的 html 形态产出） */
  widget?: WidgetPayload;
  widgets?: WidgetPayload[];
  /** show_widget 参数尚未完整到达时的静态安全预览（不落库） */
  widgetPreview?: { html: string };
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

/**
 * 一条消息下面的操作行。
 *
 * 与主页「AI 助手」页的 `MessageActions` 保持同一套交互：复制 / 重试 / 分支 / 更多，
 * 悬浮或键盘焦点进入才显形，触屏常显；用户消息的动作行挂在气泡**外面**，
 * 避免悬停时气泡底色多长出一条图标行。见 pages/CourseChat.tsx 的同名组件。
 */
function MessageActions({
  content,
  isUser,
  busy,
  canRetry,
  retryHint,
  onRetry,
  onFork,
  onExport,
  onDelete,
}: {
  content: string;
  isUser: boolean;
  busy: boolean;
  canRetry: boolean;
  retryHint: string;
  onRetry: () => void;
  onFork: () => void;
  onExport: () => void;
  onDelete: () => void;
}) {
  const copy = (text: string, okMsg: string) => {
    void (async () => {
      const ok = await copyText(text);
      if (ok) toast.success(okMsg);
      else toast.error('复制失败：剪贴板不可用');
    })();
  };

  const action = (
    label: string,
    icon: React.ReactNode,
    onPress: () => void,
    testId: string,
    disabled = false,
  ) => (
    <Tooltip>
      <Tooltip.Trigger>
        <Button
          isIconOnly
          variant="tertiary"
          size="sm"
          className="chat-action"
          aria-label={label}
          isDisabled={disabled}
          data-testid={testId}
          onPress={onPress}
        >
          {icon}
        </Button>
      </Tooltip.Trigger>
      <Tooltip.Content>
        <p>{label}</p>
      </Tooltip.Content>
    </Tooltip>
  );

  const copyLabel = isUser ? '复制这条提问' : '复制这条回答';

  return (
    <div className="chat-message-actions" data-testid="chat-message-actions">
      {action(
        copyLabel,
        <Sym name="content_copy" />,
        () => copy(content, `已复制${isUser ? '这条提问' : '这条回答'}（Markdown）`),
        'chat-copy-message',
      )}

      {action(retryHint, <Sym name="refresh" />, onRetry, 'chat-retry-message', busy || !canRetry)}

      {action('从这条消息分叉出新会话', <Sym name="fork" />, onFork, 'chat-fork-message', busy)}
      {action('删除这条消息', <Sym name="delete" />, onDelete, 'chat-delete-message', busy)}

      {!isUser && (
        <Dropdown>
          {/* Dropdown.Trigger 自己渲染 <button>，不能在里面再套 HeroUI Button */}
          <Dropdown.Trigger
            className="chat-action"
            aria-label="更多操作"
            data-testid="chat-message-more"
          >
            <Sym name="more_horiz" />
          </Dropdown.Trigger>
          <Dropdown.Popover placement="bottom start">
            <Dropdown.Menu
              onAction={(key) => {
                if (key === 'copy-plain') copy(markdownToPlainText(content), '已复制这条回答（纯文本）');
                else if (key === 'export') onExport();
              }}
            >
              <Dropdown.Item id="copy-plain" textValue="复制纯文本" data-testid="chat-copy-plain">
                <span className="chat-menu-item">复制纯文本</span>
              </Dropdown.Item>
              <Dropdown.Item id="export" textValue="导出本次会话" data-testid="chat-export-session">
                <span className="chat-menu-item">导出本次会话</span>
              </Dropdown.Item>
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      )}
    </div>
  );
}

/** 长消息默认展示六行；触屏长按可查看时间、复制完整提问与操作。 */
function UserMessageBubble({ message, busy, canRetry, onRetry, onFork, onDelete }: {
  message: ChatMsg;
  busy: boolean;
  canRetry: boolean;
  onRetry: () => void;
  onFork: () => void;
  onDelete: () => void;
}) {
  const touchMenu = useMediaQuery('(hover: none), (pointer: coarse), (max-width: 640px)');
  const textRef = useRef<HTMLSpanElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const text = textRef.current;
    if (!text) return;
    const measure = () => setOverflows(text.scrollHeight > parseFloat(getComputedStyle(text).lineHeight) * 6 + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(text);
    return () => observer.disconnect();
  }, [message.content, touchMenu]);
  const content = (
    <span ref={textRef} id={`chat-user-text-${message.key}`} className="chat-user-text"
      data-collapsed={overflows && !expanded}>
      <UserContent content={message.content || '图片消息'} />
    </span>
  );
  return (
    <div className="chat-user-content">
      <div className="chat-bubble chat-bubble--user">
        {!touchMenu ? content : (
          <Dropdown trigger="longPress">
            <Dropdown.Trigger className="chat-user-trigger"
              aria-label="用户消息，长按查看时间和操作" data-testid="chat-user-message-trigger">
              {content}
            </Dropdown.Trigger>
            <Dropdown.Popover placement="bottom end" className="chat-message-menu">
              {message.createdAt != null && (
                <time className="chat-message-time" dateTime={new Date(message.createdAt).toISOString()}
                  data-testid="chat-message-time">
                  {messageTime(message.createdAt)}
                </time>
              )}
              <Dropdown.Menu
                aria-label="提问操作"
                disabledKeys={busy || message.rowId == null ? ['retry', 'fork', 'delete'] : canRetry ? [] : ['retry']}
                onAction={(key) => {
                  if (key === 'retry') onRetry();
                  else if (key === 'fork') onFork();
                  else if (key === 'delete') onDelete();
                  else if (key === 'copy') void copyText(message.content).then((ok) => {
                    if (ok) toast.success('已复制这条提问（Markdown）');
                    else toast.error('复制失败：剪贴板不可用');
                  });
                }}
              >
                <Dropdown.Item id="copy" textValue="复制" data-testid="chat-user-copy">
                  <Sym name="content_copy" />复制
                </Dropdown.Item>
                <Dropdown.Item id="retry" textValue="重试" data-testid="chat-user-retry">
                  <Sym name="refresh" />重试
                </Dropdown.Item>
                <Dropdown.Item id="fork" textValue="分支出新会话" data-testid="chat-user-fork">
                  <Sym name="fork" />分支出新会话
                </Dropdown.Item>
                <Dropdown.Item id="delete" textValue="删除这条消息" data-testid="chat-user-delete">
                  <Sym name="delete" />删除这条消息
                </Dropdown.Item>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
        )}
        {overflows && (
          <Button size="sm" variant="tertiary" className="chat-user-expand"
            aria-expanded={expanded} aria-controls={`chat-user-text-${message.key}`}
            data-testid="chat-user-expand" onPress={() => setExpanded((value) => !value)}>
            {expanded ? '收起' : '展开'}<Sym name="keyboard_arrow_down" />
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * 正在跑的那一轮的 abort 句柄。
 *
 * 模块级而不是组件 state：停止按钮要在 React 渲染之外读到它（放进 state 只会平白多几次
 * 渲染；「有没有在跑」看 `loading` 就够）。**只能有一个**：问答面板与课程助手同屏时
 * 各自的 send 都会写它，但生成中用户看不到另一个面板的停止键。
 */
let inflightAbort: AbortController | null = null;

export default function ChatPanel({
  videoId,
  videoName,
  playerRef,
  readerRef,
  materialKind,
  materialFormat,
}: Props) {
  const { t: settingsText } = useTranslation('settings');
  /** 材料课程（PDF / Word / Markdown / HTML）：没有字幕、没有播放器，检索与引用都走材料那一套 */
  const isMaterial = materialKind !== undefined;
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const historyRequest = useRef(false);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const localRequest = useRef(false);
  const [indexReady, setIndexReady] = useState(false);
  /** 缺少可检索正文时的说明，不阻止聊天或截图提问。 */
  const [indexNote, setIndexNote] = useState<string | null>(null);
  const [sessions, setSessions] = useState<ChatSessionRow[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  /** 新追加的消息（发出去的提问 + 助手占位）播一次上浮淡入，见 useMessageEnter */
  const entering = useMessageEnter(msgs.map((m) => m.key), activeId);
  const historySession = useRef(activeId);
  historySession.current = activeId;
  const [loadedSessionId, setLoadedSessionId] = useState<number | null>(null);
  /**
   * 当前会话的技能白名单（`undefined` = 不限定，见 `ChatSessionRow.skillIds`）。
   *
   * 与 `activeId` 同步切换，**不做跨会话记忆**：它是会话的属性，不是面板的属性。
   * 发送时这个值要同时喂给「提示词清单」和「工具白名单」两处，只改一处会得到
   * 「模型看不到某技能、但调了却能成功」的错配。
   */
  const [skillIds, setSkillIds] = useState<number[] | undefined>(undefined);
  const [mcpServerIds, setMcpServerIds] = useState<string[] | undefined>();
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [handoutPreparing, setHandoutPreparing] = useState(false);
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
  // 输入框 ref：TextArea 的受控值从 onChange 拿，但「选区提问」那个 effect 要聚焦它。
  // 声明放在这里（而不是靠近 JSX）是因为那个 effect 在组件体上方就要用到 ——
  // 常量声明在使用之后会被 TS 判为 use-before-declaration。
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const composerOverflow = useComposerSize(composerInput, input);
  /** 输入法选词中的回车不是发送（含 Safari 先 compositionend 再 keydown 的情况，见 utils/imeEnter）。 */
  const ime = useImeEnter();
  // 讲义抽帧元数据：决定 list_frames 工具/提示词注入，也供 AI 气泡里的画面引用渲染
  const [framesMeta, setFramesMeta] = useState<FrameMeta[]>([]);
  const llmModel = useSettings((s) => s.llmModel);
  // 思考能力要按**这家供应商**的能力数据源查（同一模型 id 在别家可能不支持思考）
  const llmCatalog = useSettings((s) => catalogOf(s, s.llmModel.providerId));
  const llmCapabilities = useSettings((s) => modelOverridesOf(s, s.llmModel));
  const thinking = useSettings((s) => s.thinkingEnabled);
  const effort = useSettings((s) => s.thinkingEffort);
  const ctxWin = useSettings((s) => s.contextWindow);
  const agentInstructions = useSettings((s) => s.agentInstructions);
  const compressionEnabled = useSettings((s) => s.jev.contextCompression && !!decisionConfigOf(s).apiKey.trim());
  const contextPlan = useContextCompressionStore((s) => activeId == null ? EMPTY_COMPRESSION : s.sessions[activeId] ?? EMPTY_COMPRESSION);
  /**
   * 思考能力分两层，工具行上给什么控件就看这两层：
   *
   * - 能思考 + 声明了深度档位 → 一条 6 档滑块（第一档「不思考」就是关，不再单摆灯泡）
   * - 能思考但只有开关（Qwen3.5 系、部分 DeepSeek）→ 一枚灯泡
   * - 不会思考 → 什么都没有
   */
  const canThink = supportsThinking(llmCatalog, llmModel.model, llmCapabilities);
  /** 滑块当前值：关着思考就是第一档（档位本身留着，下次打开还是它） */
  const thinkingLevel: ThinkingLevel = thinking ? effort : 'none';
  // 沙箱 widget 是独立文档，拿不到 mdui 的 CSS 令牌，所以明暗得由宿主算完显式传进去。
  // （`useResolvedDark` 原先只服务 antd，这里是第二个消费者 —— 理由同为「明暗是 JS 算的」。）
  const widgetDark = useResolvedDark(useSettings((s) => s.theme));
  // 消息流滚动容器（原 Bubble.List 的 ref 只暴露 scrollTo，现在自己持有真实元素）
  const listRef = useRef<HTMLDivElement | null>(null);
  const deletionState = useRef({ loading, activeId });
  deletionState.current = { loading, activeId };
  const { deleteMessage, deleting } = useMessageDeletion(listRef, activeId, async (key) => {
    const message = msgs.find((item) => item.key === key);
    if (deletionState.current.loading || deletionState.current.activeId !== activeId
      || activeId == null || !message || message.streaming || message.rowId == null) return false;
    const deleted = await db.transaction('rw', db.chats, async () => {
      const row = await db.chats.get(message.rowId!);
      if (!row || row.sessionId !== activeId) return false;
      await db.chats.delete(message.rowId!);
      return true;
    });
    if (!deleted) return false;
    if (deletionState.current.activeId === activeId) {
      setMsgs((current) => current.filter((item) => item.key !== key));
    }
    return true;
  });
  // 思考深度能不能调取决于模型自己声明了什么，而元数据是启动后异步拉回来的
  useModelMetaRevision();

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
  const handleAnswer = (key: string, qi: number, oi: QuizPick) => {
    // Revealing an explanation is a reading interaction, not new model output.
    pauseFollowing();
    setMsgs((prev) =>
      prev.map((m) => {
        if (m.key !== key || !m.quiz || !canUpdateQuizPick(m.quiz.data.questions[qi], m.quiz.picks[qi], oi)) return m;
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
      if (h.startsWith('#source-image/')) return <MaterialImage href={h} label={children} linkOnly onSource={readerRef && parseMaterialImageHref(h)?.courseId === videoId ? (unit) => { if (unit) readerRef.current?.scrollToUnit(unit); } : undefined} />;
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
    [seekTo, readerRef, videoId],
  );

  // 上下文用量估算（system + 历史 + 当前输入/截图/引用），仅作 UI 提示
  const ctxBreakdown = useMemo(() => {
    // 注意 estimateTokens：两个 qaSystem 返回的都是**提示词文本**，忘了包就变成字符串拼接
    // 末尾的 canEditMd 参数：这里用「格式是 md」代替 send 里的完整判断（材料 + 编辑面开着）——
    // 注册表是模块级的，点「编辑」不会触发本组件重渲染，按状态算就得把它塞进 useMemo 依赖。
    // 于是按「最坏情况 = 多带一条可编辑规则」估：估高只是用量条早一点变色，估低会让用户以为还有余量。
    const sysText = isMaterial
      ? PROMPTS.qaSystemMaterial(videoName, materialKind!, undefined, shots.length, refs.length, materialFormat === 'md', agentInstructions)
      : PROMPTS.qaSystem(videoName, undefined, undefined, shots.length, refs.length, agentInstructions);
    const sys = estimateTokens(sysText);
    // 历史只发送 content，reasoning 不计入
    const historyRows = compressionEnabled ? retainedContext(msgs, contextPlan) : msgs;
    const hist = historyRows.reduce((s, m) => s + estimateTokens(m.content), 0);
    // 引用块会随本轮一起发出去，得算进去（一段 1200 字上限 ≈ 1.2k tokens），否则用量条会低估
    const refTokens = refs.reduce((n, c) => n + estimateTokens(c.text) + 12, 0);
    const cur = estimateTokens(input) + shots.length * 1200 + refTokens; // 每张图约 1.2k tokens
    return { system: sys, history: hist, current: cur };
  }, [msgs, input, shots, refs, videoName, isMaterial, materialKind, materialFormat, contextPlan, compressionEnabled, agentInstructions]);
  const ctxEst = ctxBreakdown.system + ctxBreakdown.history + ctxBreakdown.current;
  const contextCompression = useContextCompression({
    sessionId: activeId, tokens: ctxEst, windowTokens: ctxWin, query: input,
    busy: loading || !indexReady || activeId !== loadedSessionId,
  });
  const ratio = ctxEst / ctxWin;
  // 用量告警分三档（>90% 危险 / >70% 注意），色走 MD3 语义令牌
  const ctxLevel = ratio > 0.9 ? 'bad' : ratio > 0.7 ? 'warn' : '';

  /** 自定义图片渲染：#frame-秒 渲染课程画面缩略图（点击跳转），其余按原样 */
  const FrameImage = useCallback(
    ({ src, alt }: ComponentProps & { src?: string; alt?: string }) => {
      if (src?.startsWith('#frame-')) {
        return <FrameThumb secs={Number(src.slice(7))} alt={alt} frames={framesMeta} onSeek={seekTo} />;
      }
      if (src?.startsWith('#source-image/')) return <MaterialImage href={src} label={alt} onSource={readerRef && parseMaterialImageHref(src)?.courseId === videoId ? (unit) => { if (unit) readerRef.current?.scrollToUnit(unit); } : undefined} />;
      return <SourceImage src={src} alt={alt} />;
    },
    [framesMeta, seekTo, readerRef, videoId],
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

  /**
   * 初始化会话列表 + 判断「能不能提问」。
   *
   * 2026-09-24：检索改为词法后，这里**不再有建索引这一步**。原来是一段
   * 「查向量计数 → 缺就建 → 建好才置 indexReady」的流程，也带来过一整类 bug
   * （索引过期后计数仍然达标，于是永远不重建）。没有索引就没有这些问题。
    * 现在只检查有没有可检索的正文以显示提示；没有字幕也允许提问。
   */
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

      if (systemMaterialPath(videoId)) {
        setIndexNote(null);
        setIndexReady(true);
        return;
      }
      // ── 阅读材料：检索的是文本块（materialBlocks）──
      if (isMaterial) {
        const blockCount = await db.materialBlocks.where('materialId').equals(videoId).count();
        if (cancelled) return;
        // 没有可检索文字也能读取图片目录、展示原图或框选提问，不能把整个聊天锁死。
        if (blockCount === 0) {
          setIndexNote(
            materialKind === 'page'
              ? '这份材料没有可检索文字；可以让助手展示页面图，或在阅读区框选图片提问'
              : '这份材料没有可检索正文；可以让助手查找并展示文件里的图片',
          );
          setIndexReady(true);
          return;
        }
        setIndexNote(null);
        setIndexReady(true);
        return;
      }

      const segCount = await db.segments
        .where('videoId')
        .equals(videoId)
        .filter((r) => r.status === 1 && !!r.text)
        .count();
      if (cancelled) return;
      setIndexNote(segCount === 0
        ? '尚未生成字幕，暂时无法检索课程正文；可以直接聊天或附带截图提问'
        : null);
      setIndexReady(true);
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
      // 复用 composerInput（TextArea 的 ref），不额外造一个 ref。
      composerInput.current?.focus();
    }
    // send 每轮渲染都是新引用，放进依赖会无限触发；这里只在 pendingAsk 变化时消费一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAsk]);

  // 进入面板时预载帧元数据（历史消息里的画面引用回放需要）
  useEffect(() => {
    void loadFramesMeta();
  }, [loadFramesMeta]);

  // 切换会话时加载该会话的历史消息与技能范围
  useEffect(() => {
    if (activeId == null) {
      setMsgs([]);
      setSkillIds(undefined);
      setMcpServerIds(undefined);
      return;
    }
    let cancelled = false;
    setMsgs([]);
    setHasOlder(false);
    setLoadingOlder(false);
    setHistoryError(false);
    historyRequest.current = false;
    (async () => {
      // 技能范围从库里现查而不是读 sessions state：会话行可能刚被别处改过，
      // 且这样 effect 只依赖 activeId，不会因为 sessions 数组变化而重载整个历史。
      const row = await db.chatSessions.get(activeId);
      const page = await readChatPage(activeId);
      const history = page.rows;
      if (!cancelled) setSkillIds(row?.skillIds);
      if (!cancelled) setMcpServerIds(row?.mcpServerIds);
      if (!cancelled) {
        setHasOlder(page.hasOlder);
        setMsgs(history.map((r) => ({
          key: `h-${r.id}`,
          role: r.role === 'user' ? 'user' : 'ai',
          content: r.content,
          createdAt: r.createdAt,
          images: r.images,
          reasoning: r.reasoning,
          reasoningMs: r.reasoningMs,
          tools: r.tools,
          quiz: r.quiz,
          widget: r.widget,
          widgets: r.widgets,
          rowId: r.id,
        })));
        setLoadedSessionId(activeId);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  // A server-owned QA turn may originate on another device, or outlive this panel.
  useEffect(() => {
    let cancelled = false;
    let previous = '';
    const refresh = async (event: Event) => {
      if (localRequest.current) return;
      const { tasks, dataChanged } = (event as CustomEvent<{ tasks: import('@wangke/contracts/cloud').CloudTask[]; dataChanged: boolean }>).detail;
      const list = await db.chatSessions.where('videoId').equals(videoId).sortBy('createdAt');
      if (cancelled || localRequest.current) return;
      setSessions(list);
      if (activeId == null) return;
      const task = tasks.find(t => t.kind === 'qa' && t.input.sessionId === activeId);
      const running = task && ['queued', 'running', 'waiting_user'].includes(task.status);
      if (!dataChanged && !task) return;
      const signature = JSON.stringify([task?.id, task?.status, task?.progress]);
      if (!dataChanged && signature === previous) return;
      previous = signature;
      const page = await readChatPage(activeId);
      if (cancelled || localRequest.current) return;
      const messages: ChatMsg[] = page.rows.map(row => ({ ...row, key: `h-${row.id}`, rowId: row.id, role: row.role === 'user' ? 'user' : 'ai' }));
      if (running) messages.push({ key: `cloud-${task.id}`, role: 'ai', content: String(task.progress?.content ?? ''), reasoning: String(task.progress?.reasoning ?? ''), streaming: true });
      else if (task && ['failed', 'interrupted', 'cancelled'].includes(task.status)) messages.push({ key: `cloud-${task.id}`, role: 'ai', content: task.error || '任务已停止，可重新提问。' });
      setMsgs(messages); setHasOlder(page.hasOlder); setLoading(Boolean(running)); setLoadedSessionId(activeId);
    };
    const listener = (event: Event) => { void refresh(event).catch(() => setHistoryError(true)); };
    window.addEventListener('cloud-tasks-changed', listener);
    return () => { cancelled = true; window.removeEventListener('cloud-tasks-changed', listener); };
  }, [activeId, videoId]);

  const loadOlder = useCallback(async () => {
    const first = msgs[0];
    if (activeId == null || !hasOlder || historyRequest.current || first?.rowId == null) return;
    historyRequest.current = true;
    setLoadingOlder(true);
    setHistoryError(false);
    try {
      const cursor = await db.chats.get(first.rowId);
      if (!cursor) return;
      const page = await readChatPage(activeId, cursor);
      if (historySession.current !== activeId) return;
      setMsgs((current) => [...page.rows.map((row): ChatMsg => ({
        ...row, key: `h-${row.id}`, rowId: row.id, role: row.role === 'user' ? 'user' : 'ai',
      })), ...current]);
      setHasOlder(page.hasOlder);
    } catch {
      if (historySession.current === activeId) setHistoryError(true);
    } finally {
      if (historySession.current === activeId) {
        historyRequest.current = false;
        setLoadingOlder(false);
      }
    }
  }, [activeId, hasOlder, msgs]);

  const activeTitle = sessions.find((s) => s.id === activeId)?.title ?? '新会话';

  /** 当前会话 → Markdown 全文（复制与导出共用） */
  const sessionMarkdown = async () => {
    const rows = activeId == null ? [] : await readChatHistory(activeId);
    const ids = new Set(rows.map((row) => row.id));
    const all = [...rows.map((row) => ({ ...row, role: row.role === 'user' ? 'user' : 'ai' })), ...msgs.filter((m) => !ids.has(m.rowId))];
    return buildSessionMarkdown({
      title: activeTitle,
      videoName,
      messages: all.map((m) => ({
        role: m.role === 'user' ? ('user' as const) : ('assistant' as const),
        content: m.content,
        reasoning: m.reasoning,
        quiz: m.quiz,
      })),
    });
  };

  /** 一键复制整个会话（Markdown 源码；流式进行中禁用，避免复制到半截回答） */
  const copySession = async () => {
    if (msgs.length === 0) return void toast.info('当前会话还没有内容');
    const ok = await copyText(await sessionMarkdown());
    if (ok) toast.success('已复制整个会话（Markdown）');
    else toast.error('复制失败：剪贴板不可用，可改用「导出 .md」');
  };

  /** 导出整个会话为 .md 文件（归档/跨设备带走） */
  const downloadSession = async () => {
    if (msgs.length === 0) return void toast.info('当前会话还没有内容');
    const url = URL.createObjectURL(new Blob([await sessionMarkdown()], { type: 'text/markdown;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = exportFileName(videoName, activeTitle);
    a.click();
    URL.revokeObjectURL(url);
    toast.success('已导出 Markdown 文件');
  };

  /**
   * 改当前会话的技能范围。
   *
   * UI 先落地、库写异步补上：勾选框是「点一下就该有反馈」的控件，等 IndexedDB 回来再重渲染
   * 会有一帧迟滞。写失败也只是下次切回来时回到旧范围，不会留下坏状态。
   */
  const updateMcpServerIds = async (next: string[] | undefined) => {
    if (activeId == null) return;
    await db.chatSessions.where('id').equals(activeId).modify(row => {
      if (next === undefined) delete row.mcpServerIds;
      else row.mcpServerIds = next;
    });
    const { cloud } = await import('../cloud/state');
    if (cloud.enabled) await (await import('../cloud/sync')).flushCloud();
    if (historySession.current === activeId) setMcpServerIds(next);
  };
  const updateSkillIds = (next: number[] | undefined) => {
    if (activeId == null) return;
    setSkillIds(next);
    void db.chatSessions
      .where('id')
      .equals(activeId)
      .modify((row) => {
        // 「不限定」= 字段不存在，而不是「字段值为 undefined」—— 后者经过结构化克隆后
        // 到底留下 undefined 还是 null 依赖实现，删掉字段最干净、读回来必然 undefined。
        if (next === undefined) delete row.skillIds;
        else row.skillIds = next;
      });
  };

  const addHandout = async () => {
    if (loading || handoutPreparing || activeId == null || activeId !== loadedSessionId) return;
    setHandoutPreparing(true);
    try {
      const prepared = await prepareHandoutPrompt(skillIds);
      if (historySession.current !== activeId) return;
      if (prepared.skillIds !== skillIds) updateSkillIds(prepared.skillIds);
      setInput((draft) => handoutDraft(draft, prepared.prompt));
      toast.info('已添加讲义提示词，可修改后发送');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '讲义提示词加载失败，请重试');
    } finally {
      setHandoutPreparing(false);
    }
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

    // 文本模型与视觉模型可能分属不同供应商，各查各的能力数据源
    const chatTarget = targetOrNull(settings, settings.llmModel);
    const visionTarget = visionTargetOrNull(settings);
    const llmSeesImages = chatTarget ? isVisionModel(chatTarget.catalogId, chatTarget.model, chatTarget.capabilities) : false;

    // 降级链 tier 3 前置检查：模型无图能力且未配视觉模型时直接拦截，不清空输入与截图，保留草稿
    if (curShots.length > 0 && !llmSeesImages && !visionTarget) {
      toast.error('当前模型不支持图片，请在设置中配置视觉模型或切换多模态模型');
      return;
    }

    setInput('');
    setShots([]);
    setRefs([]);
    refsRef.current = [];
    setLoading(true);
    localRequest.current = true;

    const userKey = nextKey();
    const aiKey = nextKey();
    const isFirstMsg = msgs.length === 0;
    let answer = '';
    let reasoning = '';
    /**
     * 思考用时的首末时刻（毫秒时间戳，0 = 还没开始/还没记上）。
     *
     * 取**首个 → 末个**思考 token 而不是「请求发出 → 请求结束」：agent 循环里思维会
     * 中断去调工具（检索字幕、出题…），那几秒不是思考，拿整个请求时长当思考用时
     * 会把工具调用也算进去 —— 「已思考用时 24 秒」里可能有 20 秒在等接口。
     */
    let reasoningFrom = 0;
    let reasoningTo = 0;
    /**
     * 最后一轮旁白 + 最后一次工具提示。
     *
      * `onRoundStart` 会清空检索旁白（保留已交付的可视内容），轮次用尽时模型可能一个字都不说
     * （不给 tools 时它仍会返回「空正文 + tool_calls」）。存一份是为了让兜底文案能说清
     * 「它干了什么、你想做什么」，而不是只留一句「（未获得回答）」。见 harness/agent.ts。
     */
    let lastNarration = '';
    let lastHint = '';
    /**
     * 这一轮的工具链。与 `lastHint` 的分工：hint 是**当前那一步**（会被下一个 delta 清掉），
     * 工具链是**流水账**（谁调了、拿到了什么、花了多久），落库后还能回看。
     */
    const toolCalls: ChatToolCall[] = [];
    /**
     * 正在跑的那个工具的开始时刻。工具在 agent 循环里是**顺序**执行的
     * （`harness/agent.ts` 里 `for (const call of msg.tool_calls)` + `await`），
     * 所以一个变量够用，不需要按调用 id 建表。
     */
    let toolStartedAt = 0;
    /** 实际跑过的轮数（`onRoundStart` 记的）：兜底文案只能印真实值，不能拿设置里的上限顶 */
    let roundsRan = 0;
    /**
     * 护栏停下的情况。用数组而不是 `let`：赋值在回调里，TS 在读它的地方仍会当成
     * `null`（`x?.granted` 会报「property does not exist on never」），数组下标不做这种收窄。
     */
    const stopped: AgentStopInfo[] = [];
    let widgetPreview: { html: string } | undefined;
    let widgetState: WidgetPayload | undefined;
    const widgets: WidgetPayload[] = [];
    const abort = new AbortController();
    inflightAbort = abort;
    const updates = framePatch<ChatMsg>((patch) =>
      setMsgs((prev) => prev.map((m) => (m.key === aiKey ? { ...m, ...patch } : m))));
    const patchAi = updates.write;

    try {
      // 先上屏用户气泡与 AI 占位，此后描述/落库/问答任何一步抛错都能落到占位气泡上
      //
      // 引用块放在最前面：模型对「开头是引用、后面是问题」的结构最敏感，
      // 也让用户回看历史时一眼看到「我当时引的是哪一段」。
      const quoteBlock = curRefs.map(formatCitation).join('\n\n');
      const marker = curShots.map(shotTag).join('');
      const displayContent = (quoteBlock ? `${quoteBlock}\n\n` : '') + marker + q;
      const createdAt = Date.now();
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
          createdAt,
          images: userImages.length > 0 ? userImages : undefined,
        },
        { key: aiKey, role: 'ai', content: '', streaming: true, processStartedAt: Date.now() },
      ]);

      const { remoteTasks } = await import('../cloud/state');
      if (remoteTasks()) {
        const { runQa } = await import('../harness/qaRunner');
        const result = await runQa({ videoId, sessionId, text: (quoteBlock ? `${quoteBlock}\n\n` : '') + q,
          displayText: displayContent, chatImages: userImages, videoName, skillIds,
          materialKind, materialFormat, refsCount: curRefs.length, shotCount: curShots.length,
          images: curShots.flatMap(s => [{ type: 'text' as const, text: shotTag(s) }, { type: 'image_url' as const, image_url: { url: s.dataUrl } }]),
        }, { signal: abort.signal,
          onTools: tools => patchAi({ tools, hint: tools.at(-1)?.status === 'running' ? tools.at(-1)?.name : undefined }),
          onDelta: text => { answer += text; updates.stream({ content: answer, processPhase: 'answering' }); },
          onReasoning: text => { reasoning += text; updates.stream({ reasoning, processPhase: 'thinking' }); },
          onRoundStart: () => { answer = ''; patchAi({ content: '' }); },
        });
        patchAi({ ...result, streaming: false, hint: undefined });
        return;
      }
      // 用户消息立即落库：tier 2 描述可能耗时数秒，避免期间关页丢失已上屏消息
      const userRowId = await db.chats.add({
        videoId,
        sessionId,
        role: 'user',
        content: displayContent,
        createdAt,
        ...(userImages.length > 0 ? { images: userImages } : {}),
      });
      setMsgs((prev) => prev.map((m) => m.key === userKey ? { ...m, rowId: userRowId } : m));

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
          : llmSeesImages
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
        if (llmSeesImages) {
          // 每张图前插入位置文本，模型才能把画面归属到对应的标记
          imageParts = curShots.flatMap(
            (s): ContentPart[] => [
              { type: 'text', text: shotTag(s) },
              { type: 'image_url', image_url: { url: s.dataUrl } },
            ],
          );
        } else if (visionTarget) {
          // 前置检查已保证走到这里 visionTarget 非空；描述提示词带上该处上下文，并声明以画面为准。
          // 视觉模型可能配在另一家供应商，所以用 visionTarget（自带那家的端点），不是 settings。
          const results = await Promise.allSettled(
            curShots.map((s) =>
              chatOnce(visionTarget, {
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
                signal: abort.signal,
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
      // Level 1：技能元数据清单进系统提示词，agent 按需用 use_skill 加载正文。
      // 走 loadSessionSkillMeta：会话限定了范围时，清单只列范围内的技能（未限定则等价于全量）。
      // ⚠️ 这里与下方 executeTool 的 allowedSkillIds 必须传同一个 skillIds —— 清单收窄与
      // 工具放行是同一件事的两面，只改一处会造成「看不到却能调通」或「看得到却被拒」的错配。
      const skillMetas = await loadSessionSkillMeta(skillIds);
      // 每次发送前刷新帧元数据（讲义可能在本面板挂载后生成）：有帧才注册 list_frames 工具并注入引用规则
      // 材料没有画面可引用，直接跳过这次查询
      const meta = isMaterial ? [] : await loadFramesMeta();
      const hasFrames = meta.length > 0;
      /**
       * 这份材料此刻能不能被直接改：**格式是 md，且编辑面确实开着**。
       *
       * 第二个条件依赖「用户此刻点开了编辑」——注册一个当下不可用的工具只会诱发无效调用
       * （模型会先调一次、拿到「没有打开编辑面」、再白烧一轮），与 list_frames 只在有抽帧时
       * 注册是同一个思路：按课程**实际具备的能力**给工具。
       * 代价是中途关掉编辑会退化：那一轮仍会调它、回执会引导用户重新点开「编辑」。
       *
       * 在 send 里算而不是在组件体里：编辑面是模块级注册表，用户点「编辑」不会让本组件重渲染，
       * 挂在组件体里算出来的值会一直是旧的那次（false）。
       *
       * ⚠️ `&&` 短路不是可有可无的写法优化：mdEditorOpen 会动态 import md-editor/bridge，
       * 那条链上挂着 CodeMirror。让它只在**确实可能是 md 材料**时才走，
       * 视频课与 PDF / Word / HTML 材料就完全不会去碰那个 chunk（理由见 harness/tools.ts 里那段）。
       */
      const canEditMd = materialFormat === 'md' && (await mdEditorOpen(videoId));
      const skillBlock = skillMetas.length > 0 ? skillMetaBlock(skillMetas) : undefined;
      // ⚠️ 工具与提示词必须用**同一个** canEditMd：只注册工具不给提示词，模型多半想不到去用它；
      // 只给提示词不给工具，它会写一段「我已修改」而其实什么都没发生 —— 比不给更糟。
      const systemPrompt = isMaterial
        ? PROMPTS.qaSystemMaterial(videoName, materialKind!, skillBlock, curShots.length, curRefs.length, canEditMd, settings.agentInstructions)
        : PROMPTS.qaSystem(videoName, skillBlock, hasFrames, curShots.length, curRefs.length, settings.agentInstructions);
      const history = await readChatHistory(sessionId);
      // 末条即刚落库的当前问题，按降级链路组装（历史保持纯文本，截图不重复发送）
      // descBlock 已含 [截图@...] 标记，不再重复裸 marker 前缀
      // ⚠️ 引用块要同时进两处：displayContent（上屏 + 落库，用户回看历史时能看到自己引了什么）
      // 和 currentText（真正发给模型的那条）。漏掉后者的话，模型只能看到一个「这段」而不知道指什么。
      const currentText =
        (quoteBlock ? `${quoteBlock}\n\n` : '') +
        (shotLead ? `${shotLead}\n` : '') +
        q +
        (descBlock ? `\n${descBlock}` : '') +
        (subBlock ? `\n截图时刻前后字幕：\n${subBlock}` : '');
      const budget =
        settings.contextWindow -
        estimateTokens(systemPrompt) -
        estimateTokens(currentText) -
        (imageParts ? curShots.length * 1200 : 0) - // 多模态图片每张约 1.2k tokens
        4096; // 输出预留
      const recent = await prepareSessionHistory(sessionId, history.slice(0, -1).map((row) => ({ ...row, content: quizHistoryContent(row) })), Math.max(2000, budget), currentText, decisionConfigOf(settings), {
        signal: abort.signal,
        onStart: () => patchAi({ hint: 'Jev 正在筛选历史上下文…' }),
        onCompressed: (turns) => patchAi({ hint: `已省略 ${turns} 个旧轮次，原始记录保留` }),
      });
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
      // Keep every validated visual; the returned references place them in the explanation.
      const executeTool = createResourceExecutor({
        courseId: videoId,
        editable: canEditMd,
        hasFrames,
        allowedSkillIds: skillIds,
        // 材料：kind 决定走 search_material；视频：undefined 走 search_transcript
        kind: materialKind,
        onQuiz: (data) => {
          quizState = { data, picks: data.questions.map(() => -1) };
          patchAi({ quiz: quizState });
        },
        onWidget: (w) => {
          widgetState = w;
          widgets.push(w);
          // 工具校验完成后切换到最终的隔离 iframe。清掉预览，避免同一张
          // 图短暂出现两份；中间帧从未执行过模型提供的脚本。
          widgetPreview = undefined;
          patchAi({ widget: w, widgets: [...widgets], widgetPreview: undefined, hint: undefined });
        },
      });
      /**
       * 本轮工具集：只给**当下真的能用**的能力。
       * 材料没有字幕、没有画面（工具集本身就少两样），md 且编辑面开着才多一个 edit_markdown。
       */
      const tools = courseResourceTools(canEditMd);
      await runAgentLoop(
        messages,
        tools,
        executeTool,
        {
          mcpSessionId: sessionId,
          // 档位一律传下去（关着就是 'none'）：thinkingParams 按模型声明决定发哪个字段 ——
          // 只有开关的模型拿不到深度参数，但 `enable_thinking` 照发。
          // 「关着」也传 'none' 而不是不传：不传等于连 `enable_thinking: false` 都不发，
          // 混合思考模型（默认开着的那种）就压根没被关掉。
          thinkingEffort: canThink ? thinkingLevel : undefined,
          onReasoningDelta: (t) => {
            reasoning += t;
            const now = Date.now();
            const first = !reasoningFrom;
            if (first) reasoningFrom = now;
            reasoningTo = now;
            // 起点随首个 token 一起上屏：思考中那行「已用时 x 秒」按它算，
            // 落库用不到（历史用终值 reasoningMs），所以不写进 ChatRow
            updates.stream({ reasoning, processPhase: 'thinking', ...(first ? { reasoningStartedAt: now } : {}) });
          },
          onToolCallDelta: (call) => {
            updates.stream({ processPhase: 'preparing' });
            // show_widget 的 code 是一个 JSON 字符串，不能直接把参数片段
            // 当 HTML。只在 format 已明确为 html 后，解码已经完整的
            // JSON 字符串前缀，再交给静态安全预览组件。
            if (call.name !== 'show_widget') return;
            const partial = readPartialWidgetArguments(call.arguments);
            if (partial.format !== 'html' || !partial.code) return;
            const html = partial.code.slice(0, 60_000);
            widgetPreview = { html };
            updates.stream({ widgetPreview, hint: '正在生成交互图形…' });
          },
          onDelta: (text) => {
            answer += text;
            updates.stream({ content: answer, hint: undefined, processPhase: 'answering' });
          },
          onRoundStart: () => {
            // 只清检索旁白；已交付的 HTML / 图卡及后续讲解继续保留。
            if (answer.trim()) lastNarration = answer.trim();
            answer = nextVisualRound(answer, widgets.length > 0);
            roundsRan++;
            widgetPreview = undefined;
            patchAi({ content: answer, hint: undefined, widgetPreview: undefined, processPhase: 'preparing' });
          },
          onToolStart: (name, argsJson) => {
            /**
             * 状态行与工具链**同时**更新，但两者不是一回事：
             * 状态行（hint）是那个一闪而过的「正在检索：傅里叶」，工具链是留得住的流水账。
             *
             * 这段原先是一串 `if (name === 'search_transcript') …`，与课程助手那边的
             * `toolHint()` 各写一份、还各漏了几个工具 —— 现在两边共用 `utils/toolTrace.ts`。
             */
            const hint = toolHint(name, argsJson);
            lastHint = hint;
            toolStartedAt = Date.now();
            toolCalls.push({ name, detail: toolDetail(name, argsJson), status: 'running', reasoningOffset: reasoning.length });
            patchAi({ hint, tools: [...toolCalls], processPhase: 'tool' });
          },
          onToolEnd: (name, result) => {
            // 顺序执行 ⇒ 正在跑的那条就是末尾那条。不按名字反查：同一个工具可能被连调多次
            const current = toolCalls[toolCalls.length - 1];
            if (current && current.name === name && current.status === 'running') {
              const ms = toolStartedAt ? Date.now() - toolStartedAt : undefined;
              toolCalls[toolCalls.length - 1] = {
                ...current,
                status: isToolFailure(result) ? 'error' : 'done',
                result: summarizeToolResult(result),
                ...(ms != null ? { ms } : {}),
              };
              patchAi({ tools: [...toolCalls], processPhase: 'preparing', hint: undefined });
            }
            // 参数校验 / 安全预检的软失败也不能把半成品留在最终回答里；
            // 模型下一轮会根据工具回执重试。
            if (name === 'show_widget') {
              widgetPreview = undefined;
              patchAi({ widgetPreview: undefined });
            }
            toolStartedAt = 0;
          },
          onStop: (info) => {
            stopped.push(info);
          },
          signal: abort.signal,
        },
        // 检索轮次上限来自设置（默认 6，选「不限」则为 Infinity；另有循环检测与 token 预算兜着）
        resolveMaxRounds(settings.agentRounds),
      );

      const finalAnswer = answer.trim();
      /** 思考耗时：一帧都没来过就别记 0（那会让「已思考用时 0.0 秒」看着像 bug） */
      const reasoningMs = reasoningFrom ? reasoningTo - reasoningFrom : undefined;
      if (finalAnswer || quizState || widgetState) {
        patchAi({ streaming: false, hint: undefined, reasoningMs });
        const rowId = (await db.chats.add({
          videoId,
          sessionId,
          role: 'assistant',
          content: finalAnswer,
          createdAt: Date.now(),
          reasoning: reasoning || undefined,
          reasoningMs,
          ...(toolCalls.length > 0 ? { tools: toolCalls } : {}),
          ...(quizState ? { quiz: quizState } : {}),
          ...(widgetState ? { widget: widgetState } : {}),
          ...(widgets.length ? { widgets } : {}),
        })) as number;
        patchAi({ rowId });
      } else {
        // 空回答兜底，避免留下永久空气泡。**要说清是哪道闸停下的**：只写「（未获得回答）」的话，
        // 用户看到的就是「点了没反应」，既不知道它查了多少轮，也不知道自己该做什么。
        const closeOut = stopped[stopped.length - 1];
        patchAi({
          streaming: false,
          hint: undefined,
          reasoningMs,
          content: noAnswerNotice({
            // 没有 closeOut 只可能是「循环正常结束却一个字没说」——那正是 `empty` 这条闸管的事，
            // 猜成 `rounds` 会印出「已到轮次上限」这种从未发生过的原因（实测文案：0 次工具调用）
            reason: closeOut?.reason ?? 'empty',
            rounds: closeOut?.rounds ?? roundsRan,
            ...(closeOut?.detail ? { detail: closeOut.detail } : {}),
            requestedTools: closeOut?.requestedTools ?? [],
            narration: lastNarration,
            hint: lastHint,
          }),
        });
      }
      // tier 2 有截图描述失败时，回答完成后一次性提示
      if (descFailed) {
        toast.warning('部分截图描述失败，回答仅参考了时间戳与字幕');
      }
    } catch (e) {
      // 用户按了停止：不是错误。保留已流出的内容，只补一句「已停止」，并且**落库**
      // （否则刷新就没了，「停止」等于白生成一轮）
      if (abort.signal.aborted) {
        const partial = answer.trim() || lastNarration.trim();
        const content = partial ? `${partial}\n\n_（已停止生成）_` : '_（已停止生成）_';
        // 停在思考中途也要计时：那正是用户最想知道的「它已经想了多久」
        const reasoningMs = reasoningFrom ? Date.now() - reasoningFrom : undefined;
        widgetPreview = undefined;
        patchAi({ streaming: false, hint: undefined, content, reasoningMs, widgetPreview: undefined });
        // 立刻恢复可输入：下面还要落一次库，等它落完才解锁的话，用户按完停止还得干等
        setLoading(false);
        const rowId = (await db.chats.add({
          videoId,
          sessionId,
          role: 'assistant',
          content,
          createdAt: Date.now(),
          reasoning: reasoning || undefined,
          reasoningMs,
          ...(toolCalls.length > 0 ? { tools: toolCalls } : {}),
          ...(widgetState ? { widget: widgetState } : {}),
          ...(widgets.length ? { widgets } : {}),
        })) as number;
        patchAi({ rowId });
      } else {
        const errMsg = e instanceof Error ? e.message : String(e);
        if (widgetState) {
          // A validated widget is already useful even if the follow-up text
          // request fails. Persist it instead of leaving the successful tool
          // result only in the in-memory streaming row.
          const partial = answer.trim();
          const reasoningMs = reasoningFrom ? Date.now() - reasoningFrom : undefined;
          patchAi({
            streaming: false,
            hint: undefined,
            widgetPreview: undefined,
            reasoningMs,
            content: partial,
          });
          setLoading(false);
          const rowId = (await db.chats.add({
            videoId,
            sessionId,
            role: 'assistant',
            content: partial,
            createdAt: Date.now(),
            reasoning: reasoning || undefined,
            reasoningMs,
            ...(toolCalls.length > 0 ? { tools: toolCalls } : {}),
            widget: widgetState,
            widgets,
          })) as number;
          patchAi({ rowId });
        } else {
          patchAi({
            streaming: false,
            hint: undefined,
            error: true,
            widgetPreview: undefined,
            reasoningMs: reasoningFrom ? Date.now() - reasoningFrom : undefined,
            // 已流出部分内容时保留并追加中断说明，否则整体替换为错误提示
            content: answer.trim() ? `${answer}\n\n> 回答中断：${errMsg}` : `回答失败：${errMsg}`,
          });
        }
      }
    } finally {
      if (inflightAbort === abort) inflightAbort = null;
      localRequest.current = false;
      setLoading(false);
    }
  };

  /**
   * 消息重试。语义与主页一致：
   * - 提问上的重试 = 重新回答这句话（删掉这一问一答，用同样的问题重跑）
   * - 回答上的重试 = 重新生成（只对最后一条完整回答成立）
   *
   * 判据在 UI 与这里各挡一道：删掉历史中间的一段是一次不可见的批量删除，
   * 要改中间那一步应该用「分支」。
   */
  const retryMessage = async (key: string) => {
    if (loading || activeId == null) return;
    const idx = msgs.findIndex((m) => m.key === key);
    const message = msgs[idx];
    if (!message) return;

    // 流式请求失败时，助手占位尚未落库，但用户问题已经落库；允许从这条失败消息继续，
    // 不要求先有一个 assistant rowId。删除原问题后交给 send 重新创建一轮，避免上下文重复。
    if (message.role === 'ai' && message.rowId == null && message.error) {
      const previous = msgs[idx - 1];
      if (!previous || previous.role !== 'user' || previous.rowId == null) return;
      await db.chats.delete(previous.rowId);
      setMsgs((prev) => prev.filter((m) => m.key !== message.key && m.key !== previous.key));
      await send(previous.content);
      return;
    }

    const rows = await readChatHistory(activeId);
    const rowIdx = rows.findIndex((row) => row.id === message.rowId);
    if (rowIdx < 0) return;

    if (message.role === 'user') {
      if (msgs[idx + 1]?.role !== 'ai' || idx !== msgs.length - 2) return;
      const tail = rows.slice(rowIdx);
      await db.transaction('rw', db.chats, async () => {
        for (const row of tail) if (row.id != null) await db.chats.delete(row.id);
      });
      setMsgs((prev) => prev.slice(0, idx));
      await send(message.content);
      return;
    }

    if (idx !== msgs.length - 1) return;
    let userIdx = -1;
    for (let i = rowIdx - 1; i >= 0; i--) {
      if (rows[i].role === 'user') {
        userIdx = i;
        break;
      }
    }
    if (userIdx < 0) return;
    const userRow = rows[userIdx];
    await db.transaction('rw', db.chats, async () => {
      if (message.rowId != null) await db.chats.delete(message.rowId);
      await db.chats.delete(userRow.id!);
    });
    setMsgs((prev) => prev.filter((m) => m.key !== message.key && m.rowId !== userRow.id));
    await send(userRow.content);
  };

  /** 从某条消息处分叉出新会话（复制到这条为止，原会话不动）。 */
  const forkMessage = async (message: ChatMsg) => {
    if (loading || activeId == null || message.rowId == null) return;
    const source = sessions.find((s) => s.id === activeId);
    if (!source) return;
    const rows = await readChatHistory(activeId);
    const cut = rows.findIndex((row) => row.id === message.rowId);
    if (cut < 0) return;
    const kept = rows.slice(0, cut + 1);
    if (kept.length === 0) return;
    const now = Date.now();
    const newId = await db.transaction('rw', [db.chatSessions, db.chats], async () => {
      const sid = (await db.chatSessions.add({
        videoId,
        title: `${source.title} · 分支`,
        createdAt: now,
        ...(source.skillIds !== undefined ? { skillIds: [...source.skillIds] } : {}),
        ...(source.mcpServerIds !== undefined ? { mcpServerIds: [...source.mcpServerIds] } : {}),
      })) as number;
      for (const row of kept) {
        // Interaction snapshots belong to the original message; a fork starts from defaults.
        const { id: _id, sessionId: _sessionId, widgetState: _widgetState, widgetStates: _widgetStates, ...rest } = row;
        await db.chats.add({ ...rest, videoId, sessionId: sid });
      }
      return sid;
    });
    setSessions((prev) => [...prev, {
      id: newId,
      videoId,
      title: `${source.title} · 分支`,
      createdAt: now,
      ...(source.skillIds !== undefined ? { skillIds: [...source.skillIds] } : {}),
      ...(source.mcpServerIds !== undefined ? { mcpServerIds: [...source.mcpServerIds] } : {}),
    }]);
    setActiveId(newId);
    toast.success('已从这条消息分支出新会话');
  };

  /** 停止生成：断掉当前的 LLM 请求与 agent 循环（已流出的内容保留） */
  const stopGenerating = () => {
    inflightAbort?.abort();
    void import('../cloud/state').then(async ({ remoteTasks }) => {
      if (remoteTasks() && activeId != null) await (await import('../cloud/tasks')).cancelResourceTasks(`session:${activeId}`);
    }).catch(error => toast.error((error as Error).message));
  };

  // 会话下拉：selectedKey 是字符串（HeroUI 的 Key），会话 id 是数字 —— 回传时转回数字。
  // 取消选择（key 为 null）时不动当前会话，保留原来「只处理有效值」的行为。
  const selectSession = (key: React.Key | null) => {
    if (key == null) return;
    const n = Number(key);
    if (Number.isFinite(n)) setActiveId(n);
  };
  // Token updates are coalesced; actual content resizing (including final action
  // rows and async previews) is also reported by VirtualMessages.
  const lastMsg = msgs[msgs.length - 1];
  const scrollSignal = [
    msgs.length,
    lastMsg?.key ?? '',
    lastMsg?.content.length ?? 0,
    lastMsg?.reasoning?.length ?? 0,
    lastMsg?.streaming ? 1 : 0,
    lastMsg?.hint ?? '',
    // 工具链每多一次调用也要跟到底：那一行是**新长出来的高度**，
    // 不跟的话它会顶到可视区外，用户只看到「字数没变但内容跳了一下」
    lastMsg?.tools?.length ?? 0,
    lastMsg?.quiz ? 1 : 0,
    lastMsg?.widget ? 1 : 0,
    lastMsg?.widgetPreview?.html.length ?? 0,
  ].join('|');
  const virtualMessagesRef = useRef<VirtualMessagesHandle>(null);
  const { pinIfSticking: pinList, pauseFollowing } = useChatScroll(listRef, {
    sessionKey: activeId, revision: scrollSignal, messages: msgs, virtualRef: virtualMessagesRef,
    onReachStart: () => { if (!historyError) void loadOlder(); },
  });

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
    variant?: 'primary' | 'tertiary',
  ) => (
    <Tooltip>
      <Tooltip.Trigger>
        <Button
          isIconOnly
          variant={variant ?? 'tertiary'}
          size="sm"
          data-testid={testId}
          aria-label={label}
          isDisabled={disabled}
          onPress={onClick}
        >
          {icon}
        </Button>
      </Tooltip.Trigger>
      <Tooltip.Content>
        <p>{label}</p>
      </Tooltip.Content>
    </Tooltip>
  );

  return (
    <Panel testId="panel-chat">
      <PanelBar wrap={false} testId="chat-toolbar">
        <Select
          className="chat-session-select"
          selectedKey={activeId != null ? String(activeId) : null}
          onSelectionChange={selectSession}
          isDisabled={loading}
          data-testid="chat-session"
          aria-label="切换会话"
        >
          <Select.Trigger>
            <Select.Value className="chat-session-title" title={activeTitle} />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              {sessions.map((s) => (
                <ListBox.Item key={s.id} id={String(s.id)} textValue={s.title}>
                  {s.title}
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
        {iconBtn('chat-new-session', '新开会话', <Sym name="add" />, createSession, loading)}
        {iconBtn('copy-session-btn', '复制整个会话（Markdown）', <Sym name="content_copy" />, copySession, loading || msgs.length === 0)}
        {iconBtn('export-session-btn', '导出 .md 文件', <Sym name="download" />, downloadSession, loading || msgs.length === 0)}
        {iconBtn('chat-delete-session', '删除当前会话', <Sym name="delete" />, confirmDeleteSession, loading)}
      </PanelBar>
      <SkillPicker value={skillIds} onChange={updateSkillIds} mcpValue={mcpServerIds} onMcpChange={updateMcpServerIds} isOpen={skillsOpen} onOpenChange={setSkillsOpen} hideTrigger />

      {/* 消息流：AI 靠左、用户靠右。两种气泡的形状差是 MD3 聊天的标志 ——
          靠对话侧收小圆角、另一侧全圆角。流式 markdown / 思考块 / 题卡都留在 AI 气泡内。 */}
      <div className="chat-message-viewport">
      <PanelBody bodyRef={listRef} className="chat-list-wrap" testId="chat-list">
        {activeId != null && loadedSessionId !== activeId && <ChatHistorySkeleton />}
        {msgs.length === 0 && (activeId == null || loadedSessionId === activeId) && (
          <PanelPlaceholder testId="chat-empty">针对课程内容提问，回答中的时间戳可点击跳转</PanelPlaceholder>
        )}
        {msgs.length > 0 && <div className="chat-panel-history" aria-live="polite">
          {hasOlder && <button type="button" disabled={loadingOlder} onClick={() => void loadOlder()}>
            {loadingOlder ? '正在加载历史消息…' : historyError ? '加载失败，点击重试' : '加载更早消息'}
          </button>}
        </div>}
        {msgs.length > 0 && <VirtualMessages key={activeId} items={msgs} scrollRef={listRef} ref={virtualMessagesRef} onResize={pinList}>{(m, index) => {
          const isUser = m.role === 'user';
          /** 与主页同一套判据：回答只重试最后一条；提问只重试「答复就在末尾」的那一句 */
          const canRetry = !isUser && index === msgs.length - 1;
          const canRetryAsk = isUser && msgs[index + 1]?.role === 'ai' && index === msgs.length - 2;
          return (
            <div
              key={m.key}
              className={(isUser ? 'chat-msg chat-msg--user' : 'chat-msg chat-msg--ai')
                + (entering.has(m.key) ? ' t-msg-enter' : '')}
              data-testid={isUser ? 'chat-msg-user' : 'chat-msg-ai'}
              data-streaming={m.streaming ? 'true' : undefined}
              data-error={m.error ? 'true' : undefined}
              data-chat-message={m.key}
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
                  <UserMessageBubble
                    message={m}
                    busy={loading || deleting}
                    canRetry={canRetryAsk}
                    onRetry={() => void retryMessage(m.key)}
                    onFork={() => void forkMessage(m)}
                    onDelete={() => void deleteMessage(m.key)}
                  />
                  {!m.streaming && m.rowId != null && (
                    <MessageActions
                      content={m.content}
                      isUser
                      busy={loading || deleting}
                      canRetry={canRetryAsk}
                      retryHint="重新回答这句话（删掉这一问一答，用同样的问题重跑一次）"
                      onRetry={() => void retryMessage(m.key)}
                      onFork={() => void forkMessage(m)}
                      onExport={downloadSession}
                      onDelete={() => void deleteMessage(m.key)}
                    />
                  )}
                </>
              ) : (
                <>
                  <ArtifactEditProvider rowId={m.rowId} content={m.content} disabled={loading || !!m.streaming || !!m.error}
                    onSaved={(row) => setMsgs((prev) => prev.map((item) => item.rowId === row.id ? { ...item, content: row.content, widget: row.widget, widgets: row.widgets } : item))}>
                  <div className="chat-bubble chat-bubble--ai">
                    <ResponseProcess key={m.key} reasoning={m.reasoning} calls={m.tools} streaming={!!m.streaming}
                      phase={m.processPhase} hint={m.hint} since={m.processStartedAt ?? m.reasoningStartedAt}
                      elapsedMs={m.reasoningMs} />
                    <div aria-hidden="true" data-chat-answer-start={m.content || m.quiz || m.widget || m.widgetPreview ? '' : undefined} />
                        <WidgetMessage message={m} content={m.content} dark={widgetDark} rowId={m.rowId}
                          disabled={loading || !!m.streaming || !!m.error} onPrompt={(text) => void send(text)}>
                        {(markdown) => !markdown ? null : (
                          <AssistantContent content={markdown} streaming={!!m.streaming}>
                            {(part, streaming) => (
                              <MarkdownStreamingProvider value={streaming}>
                                <XMarkdown
                                  // 材料只跑 linkifyUnits：#seek- 需要一个存在的播放器，
                                  // 材料没有播放器，留着会生成点了没反应的死链；
                                  // #frame- 画面引用同理（材料没有抽帧）。
                                  content={
                                    isMaterial && materialKind
                                      ? linkifyUnits(part, materialKind)
                                      : linkifyTimestamps(linkifyFrames(part))
                                  }
                                  components={{ a: SeekLink, p: StreamParagraph, img: FrameImage, code: MarkdownCode, pre: MarkdownPre, table: MarkdownTable }}
                                  streaming={{ hasNextChunk: streaming, tail: streaming }}
                                />
                              </MarkdownStreamingProvider>
                            )}
                          </AssistantContent>
                        )}
                        </WidgetMessage>
                        {m.quiz && (
                          <QuizCard
                            notebookSource={{ courseId: videoId, name: videoName }}
                            quiz={m.quiz.data}
                            picks={m.quiz.picks}
                            onAnswer={(qi, oi) => handleAnswer(m.key, qi, oi)}
                            onReview={loading || m.streaming ? undefined : (text) => void send(text)}
                            onSeek={seekTo}
                            // 材料没有播放器：解析里的时间戳不 linkify，免得出现点了没反应的死链
                            seekable={!isMaterial}
                          />
                        )}
                        {m.widgetPreview && (
                          <StreamingHtmlPreview html={m.widgetPreview.html} />
                        )}
                  </div>
                  </ArtifactEditProvider>
                  {!m.streaming && m.content && m.rowId != null && (
                    <MessageActions
                      content={m.content}
                      isUser={false}
                      busy={loading || deleting}
                      canRetry={canRetry}
                      retryHint={m.error ? '继续回答这句话' : '重新生成这条回答'}
                      onRetry={() => void retryMessage(m.key)}
                      onFork={() => void forkMessage(m)}
                      onExport={downloadSession}
                      onDelete={() => void deleteMessage(m.key)}
                    />
                  )}
                </>
              )}
            </div>
          );
        }}</VirtualMessages>}
      </PanelBody>
      </div>

      {/* 缺少可检索正文时提示能力边界，不禁用输入区 */}
      {indexNote && (
        <div className="chat-note" data-testid="chat-index-note">
          <Sym name="warning" className="chat-note__icon" />
          <span>{indexNote}</span>
        </div>
      )}

      {/* 输入区与首页一致：添加、文本、模型和发送共用一行，长文本按需增高。
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
                <Button
                  isIconOnly
                  variant="tertiary"
                  size="sm"
                  className="chat-ref__remove"
                  aria-label="移除引用"
                  data-testid="ref-chip-remove"
                  onPress={() => {
                    const next = refs.filter((_, j) => j !== i);
                    refsRef.current = next;
                    setRefs(next);
                  }}
                >
                  <Sym name="close" />
                </Button>
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
                <Button
                  isIconOnly
                  variant="tertiary"
                  size="sm"
                  className="chat-shot__remove"
                  aria-label="移除截图"
                  onPress={() => setShots((prev) => prev.filter((_, j) => j !== i))}
                >
                  <Sym name="close" />
                </Button>
              </span>
            ))}
          </div>
        )}
        <div className="chat-composer__row">
          <ComposerExpand visible={composerOverflow} key={activeId} value={input} onChange={setInput} />
          {/* testid 挂在外层容器上：e2e 的选择器是 `[data-testid="chat-input"] textarea`，
              需要「容器 → textarea」的层级（mdui 时代是自定义元素 + shadow 里的 textarea，
              HeroUI 是单元素，用一层 div 补回同样的结构）。 */}
          <div className="chat-input" data-testid="chat-input">
            <TextArea
              fullWidth
              rows={1}
              aria-label="给学习助手发送消息"
              placeholder={indexReady ? '输入问题，回车发送' : '等待索引就绪…'}
              disabled={!indexReady}
              value={input}
              ref={composerInput}
              onChange={(e) => setInput(e.target.value)}
              /**
               * 移动端键盘的回车键改成「发送」：Android Chrome 认 enterkeyhint，
               * 会把按键的文案与语义从「换行」换成「发送」（iOS Safari 暂不认，
               * 但加上没有副作用）。没有它，手机上要找一颗小小的发送图标，
               * 而回车键就在拇指底下。
               */
              enterKeyHint="send"
              {...ime.compositionProps}
              /** 聚焦即吸底：键盘弹出会顶矮面板，先一步把最新消息留在可视区里 */
              onFocus={pinList}
              onKeyDown={(e) => {
                if (!ime.isSubmitEnter(e)) return;
                e.preventDefault();
                void send(input);
              }}
            />
          </div>
          <div className="chat-composer__tools">
          <Dropdown isOpen={addOpen} onOpenChange={setAddOpen}>
            <Button isIconOnly variant="tertiary" size="sm" data-testid="panel-chat-add"
              aria-label="添加截图、讲义、出题、技能范围或调整模型" isDisabled={activeId == null || activeId !== loadedSessionId}>
              <Sym name="add" />
            </Button>
            <Dropdown.Popover placement="top start">
              <div className="px-2 py-1">
                <ModelPicker slot="chat" field="llmModel" variant="chip" showThinking thinkingDepthDisabled={loading} onClose={() => setAddOpen(false)} />
              </div>
              <Dropdown.Menu aria-label="添加到学习问答"
                disabledKeys={[
                  ...(!indexReady || loading ? ['shot', 'quiz', 'question-bank', 'bank-practice'] : []),
                  ...(!indexReady || loading || handoutPreparing ? ['handout'] : []),
                  ...(shots.length >= 4 ? ['shot'] : []),
                ]}
                onAction={(key) => {
                  if (key === 'shot') addShot();
                  else if (key === 'quiz') void send('根据课程内容出 3 道单选题考考我，选项要有干扰性');
                  else if (key === 'question-bank') void send('请按「原题题库」技能，逐页提取这份资料的原题，保留题号、题干、选项和原图引用，核对原文答案及解析，并用 edit 保存到 /courses/current/questions.md。已有题库就读最新版后继续，不覆盖用户修改。缺答案和无法辨读的题明确标注；预算不足先保存已完成部分并说明尚未覆盖范围，不要重新编题。保存后给我题库链接，并展示第一批原题供我直接作答和批改。');
                  else if (key === 'bank-practice') void send(`请从题库最新版开始做原题。${materialFormat === 'md' ? '先 read 当前 Markdown 原文：若它本身含原题 quiz 数据块，使用 /courses/current/material，否则使用 /courses/current/questions.md。' : '题库路径为 /courses/current/questions.md。'}调用 present_quiz 的 path 参数，每批最多 5 题，不要改写或提前透露答案。若题库尚不存在，请说明并引导先提取原题。`);
                  else if (key === 'handout') void addHandout();
                  else if (key === 'skills') setSkillsOpen(true);
                }}>
                {!isMaterial && <Dropdown.Item id="shot" textValue="截取当前画面" data-testid="shot-btn"><Sym name="photo_camera" />截取当前画面</Dropdown.Item>}
                <Dropdown.Item id="quiz" textValue="出题考我" data-testid="quiz-btn"><Sym name="quiz" />出题考我</Dropdown.Item>
                {isMaterial && <Dropdown.Item id="question-bank" textValue="提取原题为题库" data-testid="question-bank-extract"><Sym name="description" />提取原题为题库</Dropdown.Item>}
                {isMaterial && <Dropdown.Item id="bank-practice" textValue="开始做原题" data-testid="question-bank-practice"><Sym name="quiz" />开始做原题</Dropdown.Item>}
                <Dropdown.Item id="handout" textValue="生成讲义" data-testid="handout-prompt"><Sym name="description" />生成讲义</Dropdown.Item>
                <Dropdown.Item id="skills" textValue={settingsText('mcp.scopeTitle')}><Sym name="extension" />{settingsText('mcp.scopeTitle')}{skillIds !== undefined || mcpServerIds !== undefined ? ' · 已限定' : ''}</Dropdown.Item>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
          {/* 上文用量环：只留环，不再跟一串 `≈2.1k / 131k` 文字 —— 常驻的估值
              在工具行上太吵（详情在环的弹层里），文字还会把发送键从最右侧挤开。
              环排在发送键**前面**，发送键永远占最右那一格。 */}
          <div className={ctxLevel ? `chat-ctx chat-ctx--${ctxLevel}` : 'chat-ctx'} data-testid="chat-ctx">
            <ContextUsageButton
              tokens={ctxEst} windowTokens={ctxWin} breakdown={ctxBreakdown} testId="panel-context-usage"
              compression={contextCompression.state} onCompress={contextCompression.compress}
              isDisabled={loading || !indexReady || activeId == null || activeId !== loadedSessionId}
            />
          </div>
          {/* 生成中：发送键**变成**停止键。单课程问答没有课程上下文要等用户，
              所以不用给「提问卡悬着」开口子（那边是例外）。 */}
          {loading ? (
            <Tooltip>
              <Tooltip.Trigger>
                <Button
                  isIconOnly
                  variant="secondary"
                  size="sm"
                  className="chat-send"
                  data-testid="chat-stop"
                  aria-label="停止生成"
                  onPress={stopGenerating}
                >
                  <Sym name="stop" />
                </Button>
              </Tooltip.Trigger>
              <Tooltip.Content>
                <p>停止生成</p>
              </Tooltip.Content>
            </Tooltip>
          ) : (
            <Tooltip>
              <Tooltip.Trigger>
                <Button
                  isIconOnly
                  variant="primary"
                  size="sm"
                  className="chat-send"
                  data-testid="chat-send"
                  aria-label="发送"
                  isDisabled={!indexReady}
                  onPress={() => send(input)}
                >
                  <Sym name="arrow_upward" />
                </Button>
              </Tooltip.Trigger>
              <Tooltip.Content>
                <p>发送</p>
              </Tooltip.Content>
            </Tooltip>
          )}
          </div>
        </div>
      </div>
    </Panel>
  );
}
