import { useEffect, useLayoutEffect, useMemo, useRef, useCallback, useState } from 'react';
import type { ComponentProps } from '@ant-design/x-markdown';
import { Markdown as XMarkdown } from '../components/markdown/Markdown';
import { MaterialImage } from '../components/MaterialImage';
import { useNavigate } from 'react-router-dom';
import {
  Button,
  Chip,
  Dropdown,
  Input,
  TextArea,
  ToggleButton,
  ToggleButtonGroup,
  Toolbar,
  Tooltip,
} from '@heroui/react';
import { useAppNav } from '../components/appNav';
import { useRecentChats } from '../components/useRecentChats';
import { MarkdownCode, MarkdownPre } from '../components/mermaid/markdown';
import { MarkdownTable } from '../components/MdTable';
import ModelPicker from '../components/ModelPicker';
import ChatAddMenu from '../components/ChatAddMenu';
import { ChatAttachmentDraft, ChatMessageAttachments } from '../components/ChatAttachments';
import { useChatAttachments } from '../store/chatAttachments';
import VoiceInput from '../components/VoiceInput';
import { StreamParagraph, PendingReply, useMessageEnter } from '../components/motion';
import ResponseProcess from '../components/ResponseProcess';
import VirtualMessages, { type VirtualMessagesHandle } from '../components/VirtualMessages';
import ChatMessageNav from '../components/ChatMessageNav';
import ChatViewportFade from '../components/ChatViewportFade';
import { useMessageDeletion } from '../components/useMessageDeletion';
import ChatHistorySkeleton from '../components/ChatHistorySkeleton';
import { db } from '../store/db';
import AskCard from '../components/AskCard';
import FolderPlanCard from '../components/FolderPlanCard';
import StreamingHtmlPreview from '../components/StreamingHtmlPreview';
import ArtifactEditor, { ArtifactEditProvider } from '../components/ArtifactEditor';
import WidgetMessage from '../components/WidgetMessage';
import ContextUsageButton from '../components/ContextUsageButton';
import { useContextCompression } from '../components/useContextCompression';
import { EMPTY_COMPRESSION, retainedContext, useContextCompressionStore } from '../store/contextCompression';
import { useCourseChat, reflectArtifactEdit, type CourseChatMessage, type QueuedMessage, type SendMode } from '../store/courseChat';
import { useChatNotifications } from '../store/chatNotifications';
import { useSettingsDialog } from '../components/settingsDialogStore';
import { useSettings } from '../store/settings';
import { estimateTokens } from '../harness/context';
import { libraryAssistantSystemPrompt } from '../harness/libraryAssistant';
import { loadSessionSkillMeta, skillMetaBlock } from '../skills/store';
import { buildSessionMarkdown, exportFileName, markdownToPlainText } from '../utils/chatExport';
import { copyText } from '../utils/clipboard';
import { extractChatSources, type ChatSource } from '../utils/chatSources';
import { prefersReducedMotion } from '../utils/motion';
import { useMediaQuery, useViewportResize } from '../utils/useMobile';
import { messageTime } from '../utils/messageTime';
import { htmlPreviewSource } from '../utils/streamingHtml';
import { PageShell, Sym, toast, useResolvedDark, useSkeletonGate } from '../ui';
import { SettingsButton } from '../components/SettingsModal';
import './course-chat.css';

/**
 * 有课程时的快捷提问：全部围绕「问我的课程库」。
 *
 * 与通用那组的分野不是措辞，而是**依赖哪份数据** —— 这一组每一条都需要工具才能回答。
 */
const LIBRARY_STARTERS = [
  {
    icon: <Sym name="local_fire_department" />,
    label: '推荐下一门课',
    prompt: '根据我的资料和学习进度，推荐我下一门最值得学的课程，并说明理由。',
  },
  {
    icon: <Sym name="play_circle" />,
    label: '看看未完成课程',
    prompt: '列出我还没学完的课程，按完成进度从高到低整理，并建议先完成哪一门。',
  },
  {
    icon: <Sym name="toc" />,
    label: '梳理课程主题',
    prompt: '根据课程名称和已有内容，帮我梳理整个资料库覆盖了哪些主要主题。',
  },
  {
    icon: <Sym name="folder" />,
    label: '整理资料目录',
    prompt: '帮我把资料目录整理一下：先看现有分类和全部课程，再按一个统一的主轴给出分类方案。',
  },
] as const;

const LIBRARY_HEADLINES = [
  '问你的全部资料',
  '从你的资料里找答案',
  '一起探索你的课程库',
  '你的学习资料，随时可问',
  '想从哪份资料开始？',
] as const;

/**
 * 没有课程时的快捷提问：一条工具都不需要，纯通用能力。
 *
 * 旧实现在空库时只给一个「先去导入课程」按钮，等于告诉用户「不导入就没法用」。
 * 实际助手本身能答任何问题，导入课程只是让它多一份可引用的依据 —— 所以这里给的是
 * 能立刻用上的问题，导入课程降级成旁边一个次要入口。
 */
const GENERAL_STARTERS = [
  {
    icon: <Sym name="neurology" />,
    label: '讲清一个概念',
    prompt: '用通俗的语言给我讲清楚「注意力机制」是什么，配一个生活里的类比。',
  },
  {
    icon: <Sym name="calendar_month" />,
    label: '安排学习计划',
    prompt: '我想在两周内入门机器学习，帮我排一个每天 1 小时的学习计划，标出每天的重点。',
  },
  {
    icon: <Sym name="code" />,
    label: '写一段代码',
    prompt: '帮我写一个 TypeScript 的 LRU 缓存类，带完整类型标注，并讲清楚时间复杂度。',
  },
  {
    icon: <Sym name="style" />,
    label: '润色一段文字',
    prompt: '我写了一段项目周报但读着很乱，帮我重写一版：更短、更结论先行、每条都有数字。',
  },
] as const;

/**
 * 一条消息下面的操作行。
 *
 * 只放**能真跑**的动作 —— 摆一个点了没反应的菜单项比不摆更伤信任
 * （同一取舍见 `AppBarSearch` 的注释）。
 *
 * 三组动作按「这条消息是什么」分：
 * - **复制**：两者都有；
 * - **重试**：两者都有，但语义不同 —— 回答上是「接着写 / 重新生成」，提问上是
 *   「重新回答这句话」（删掉这一问一答再重发，见 store 的 `retryMessage`）。
 *   入口给两处是有意的：想换一次回答时，视线可能停在回答末尾，也可能停在自己刚打完的那句上；
 * - **分支**：两者都有。从提问处分叉（换个问法再问）与从回答处分叉（沿这个方向往下走）
 *   都是真实需求。
 *
 * 默认透明、鼠标移上来或键盘焦点进入才显形：长回答里每条下面都挂着四颗图标，
 * 会把正文流切碎。触屏助手操作常显，用户消息则长按气泡打开菜单。
 *
 * **助手与用户的操作行排布不同**：助手没有气泡，操作行跟着正文左对齐、排在正文之下；
 * 用户有气泡，操作行**挂在气泡外面**（另起一行、与气泡右缘对齐）—— 塞进气泡里的话，
 * 悬停时那块底色会跟着长出一条图标行，把气泡本身的内容挤变形（见 course-chat.css）。
 *
 * 见 docs/plans/2026-10-15-流式续传与分支-design.md §4。
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
  /** 用户消息：复制 / 重试 / 分支三颗（重试是「重新回答这句话」，见 store 的 `retryMessage`）。
   *  只有「更多」菜单（复制纯文本 / 导出会话）是助手专有。 */
  isUser: boolean;
  /** 生成中：分支与重试都不可用（库里还没有那条正在流的消息，切过去会缺一截） */
  busy: boolean;
  /** 这条消息能不能重试：提问要「它的回答就是最后一条」，回答要「中断过」或「是最后一条完整回答」 */
  canRetry: boolean;
  /** 重试键的 tooltip。两种语义（继续写 / 重新生成）必须说得不一样，否则用户不知道会得到什么 */
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

  /** 操作行里的一颗图标。外观 / 禁用 / tooltip 三样收在一处，免得四颗按钮各写一遍 */
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
          className="course-chat__action"
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
    <div className="course-chat__actions" data-testid="chat-message-actions">
      {action(
        copyLabel,
        <Sym name="content_copy" />,
        () => copy(content, `已复制${isUser ? '这条提问' : '这条回答'}（Markdown）`),
        'chat-copy-message',
      )}

      {/* 重试：中断过的回答是「接着写」，完整的最后一条是「重新生成」，
          提问上则是「重新回答这句话」——
          三种语义由调用方给出不同的说法（见 retryHint），一颗图标两种消息共用 */}
      {action(retryHint, <Sym name="refresh" />, onRetry, 'chat-retry-message', busy || !canRetry)}

      {action('从这条消息分叉出新会话', <Sym name="fork" />, onFork, 'chat-fork-message', busy)}
      {action('删除这条消息', <Sym name="delete" />, onDelete, 'chat-delete-message', busy)}

      {!isUser && (
        <Dropdown>
          {/* ⚠️ 与 ModelPicker 同一个坑：Dropdown.Trigger 自己渲染 <button>，
              里面不能再套 HeroUI 的 Button（会产出 `<button><button>`）。外观直接挂类名。 */}
          <Dropdown.Trigger
            className="course-chat__action"
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
                <span className="course-chat__menu-item">
                  复制纯文本
                </span>
              </Dropdown.Item>
              <Dropdown.Item id="export" textValue="导出本次会话" data-testid="chat-export-session">
                <span className="course-chat__menu-item">
                  导出本次会话
                </span>
              </Dropdown.Item>
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      )}
    </div>
  );
}

/** 长消息默认展示六行；触屏长按仍可查看时间、复制完整提问与操作。 */
function UserMessageBubble({ message, busy, canRetry, onRetry, onFork, onDelete }: {
  message: CourseChatMessage;
  busy: boolean;
  canRetry: boolean;
  onRetry: () => void;
  onFork: () => void;
  onDelete: () => void;
}) {
  const touchMenu = useMediaQuery('(hover: none), (pointer: coarse), (max-width: 640px)');
  const isNarrow = useMediaQuery('(max-width: 900px)');
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
  const content = <span ref={textRef} id={`user-text-${message.key}`} className="course-chat__user-text"
    data-collapsed={overflows && !expanded}>{message.content || '图片消息'}</span>;
  return (
    <div className="course-chat__user-content">
    <ChatMessageAttachments files={message.attachments} />
    <div className="course-chat__bubble course-chat__bubble--user">
    {!touchMenu ? content : (
    <Dropdown trigger="longPress">
      <Dropdown.Trigger className="course-chat__user-trigger"
        aria-label="用户消息，长按查看时间和操作" data-testid="chat-user-message-trigger">
        {content}
      </Dropdown.Trigger>
      <Dropdown.Popover placement="bottom end" className="course-chat__message-menu">
        {message.createdAt != null && (
          <time className="course-chat__message-time" dateTime={new Date(message.createdAt).toISOString()} data-testid="chat-message-time">
            {messageTime(message.createdAt)}
          </time>
        )}
        <Dropdown.Menu aria-label="提问操作" disabledKeys={busy || message.rowId == null ? ['retry', 'fork', 'delete'] : canRetry ? [] : ['retry']}
          onAction={(key) => {
            if (key === 'retry') onRetry();
            else if (key === 'fork') onFork();
            else if (key === 'delete') onDelete();
            else if (key === 'copy') void copyText(message.content).then((ok) => {
              if (ok) toast.success('已复制这条提问（Markdown）');
              else toast.error('复制失败：剪贴板不可用');
            });
          }}>
          <Dropdown.Item id="copy" textValue="复制" data-testid="chat-user-copy"><Sym name="content_copy" />复制</Dropdown.Item>
          <Dropdown.Item id="retry" textValue="重试" data-testid="chat-user-retry"><Sym name="refresh" />重试</Dropdown.Item>
          <Dropdown.Item id="fork" textValue="分支出新会话" data-testid="chat-user-fork"><Sym name="fork" />分支出新会话</Dropdown.Item>
          <Dropdown.Item id="delete" textValue="删除这条消息" data-testid="chat-user-delete"><Sym name="delete" />删除这条消息</Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
    )}
    {overflows && <Button size="sm" variant="tertiary" className="course-chat__user-expand"
      aria-expanded={expanded} aria-controls={`user-text-${message.key}`}
      data-testid="chat-user-expand" onPress={() => setExpanded((value) => !value)}>
      {expanded ? '收起' : '展开全文'}<Sym name="keyboard_arrow_down" />
    </Button>}
    </div>
    </div>
  );
}

/**
 * 来源直接显示文件名，点击文件名打开原文，不增加计数或折叠层级。
 *
 * 数据是从回答正文里**解析**出来的（见 utils/chatSources.ts 的说明），不是新字段 ——
 * 系统提示词本来就要求模型保留课程链接与时间戳。所以这里没有「模型没按格式写就为空」
 * 之外的失败模式：解析不到就不渲染这一行。
 */
function SourceList({ sources }: { sources: ChatSource[] }) {
  const navigate = useNavigate();
  if (sources.length === 0) return null;

  return (
    <div className="course-chat__sources" data-testid="chat-sources" aria-label="来源文件">
          {sources.map((source) => (
            <div key={source.courseId} className="course-chat__source" data-testid="chat-source-item">
              <a
                className="course-chat__source-link"
                title={`打开原文：${source.courseName}`}
                href={`#/player/${encodeURIComponent(source.courseId)}`}
                onClick={(event) => {
                  // 与正文里的课程链接同一套跳转：HashRouter 拥有 hash，别让浏览器重新加载
                  event.preventDefault();
                  navigate(`/player/${source.courseId}`);
                }}
              >
                <span className="course-chat__source-name">{source.courseName}</span>
              </a>
            </div>
          ))}
    </div>
  );
}

/**
 * AI 助手页（默认首页）。
 *
 * **有课与没课是两种模式，不是两种权限**：没导入任何课程时它照样能回答问题，
 * 只是答案来自通用知识而不是他的课程数据（模式切换见 harness/libraryAssistant.ts
 * 的 `libraryAssistantTools` 与 `libraryAssistantSystemPrompt`）。所以这个页面
 * 从不因为「库里是空的」而禁用输入框 —— 那样等于告诉用户「不导入就用不了」。
 *
 * 这个组件**刻意只剩视图职责**：会话，消息，流式中间态，悬着的提问/确认全在
 * `store/courseChat.ts`。原因是「切到别的页面再回来也要接着跑」——状态跟着路由走的话，
 * 离开页面就等于把正在生成的对话扔了（详见该 store 顶部的说明）。
 *
 * UI 为 HeroUI v3（Tailwind v4 + React Aria）：会话切换走 Select，输入走 TextArea，
 * 深度档位走 ToggleButtonGroup，提示走全局 toast / confirmDialog。
 */
/**
 * 数课程期间的骨架：与「标题 + 说明 + 一排快捷提问」逐块对齐。
 *
 * 高度不是拍脑袋，是照抄上面 `.course-chat__empty h2` / `> p` / `.course-chat__starter`
 * 三条真规则的口径（字号 × 行高、药丸 min-height 40px、starters 的 26px 上边距）——
 * 骨架和内容对不齐的话，读到数据那一刻会整块跳一下，比不出骨架更糟。
 */
function CourseCountSkeleton() {
  return (
    <div className="course-chat__empty-skel t-skel" role="status" aria-label="正在准备聊天">
      <div className="t-skel-skeleton is-pulsing" aria-hidden="true">
        <div className="course-chat__empty-skel__head" />
        <div className="course-chat__empty-skel__line" />
        <div className="course-chat__empty-skel__line course-chat__empty-skel__line--short" />
        <div className="course-chat__empty-skel__starters">
          {[0, 1, 2].map((i) => (
            <div className="course-chat__empty-skel__pill" key={i} />
          ))}
        </div>
      </div>
      <span className="sr-only">正在准备聊天…</span>
    </div>
  );
}

/**
 * 流式尾巴：一颗**黑色圆点**，替掉 XMarkdown 默认的 `▋`。
 *
 * 落在哪：XMarkdown 会把 `<xmd-tail>` 插进 markdown AST 的**最后一个文本 token**
 * 之后（见它 Parser 的 `configureTailInjection`）—— 也就是下一个字符将出现的位置。
 * 圆点跟着文字一起长，眼睛不用去屏幕底部找「生成到哪了」。
 *
 * 为什么是圆点：默认的方块 `▋` 与文字笔画一样重，长文本里会读成一个错字；
 * 竖线是终端传统，这个产品里没有对应物。圆点轻一档，闪一闪只表示
 * 「这儿还在写」，不假装自己是内容。
 *
 * 颜色取 `--foreground`（浅色主题下就是黑）：深色主题里死黑会看不见，
 * 而「跟文字同色的指示符」在任何主题里都成立 —— 用户要的「黑色圆形」
 * 在默认浅色主题下正是这个 token 的值。
 */
function StreamTailCircle() {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const dot = ref.current;
    if (!dot) return;
    let visible = true;
    const sync = () => { dot.style.animationPlayState = visible && !document.hidden ? 'running' : 'paused'; };
    const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; sync(); });
    observer.observe(dot);
    document.addEventListener('visibilitychange', sync);
    sync();
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', sync); };
  }, []);
  return <span ref={ref} className="course-chat__stream-dot" data-testid="chat-stream-dot" aria-hidden="true" />;
}

/**
 * 排队条：生成中投递、**还没交出去**的话。
 *
 * 三条设计（与 store 的三条不变量一一对应，见 courseChat.ts 文件头）：
 *
 * 1. **逐条可编辑**：排队的那几秒里用户常常后悔，能改就不必删了重打。
 *    改成空白 = 删掉（与 store 的 `updateQueued` 同款语义，留一条永远发不出去的
 *    空气泡没有意义）；
 * 2. **逐条可插队**（闪电键）：`sendQueuedNow`。想提前说一条就说一条，
 *    所以不需要拖拽排序 —— 桌面端 Codex 那套可拖拽队列在这里是过度设计；
 * 3. **整条可清空**（右上角）：停止生成之后想彻底收手时用。
 *
 * 位置在输入卡**正上方**：它和输入框是同一件事的两种状态（「已经排上的」
 * 与「正在打的」），分居两地会让用户以为队列是另一个功能区。
 */
function QueueBar({
  items,
  onEdit,
  onRemove,
  onSendNow,
  onClear,
}: {
  items: QueuedMessage[];
  onEdit: (id: string, text: string) => void;
  onRemove: (id: string) => void;
  onSendNow: (id: string) => void;
  onClear: () => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="course-chat__queue" data-testid="chat-queue">
      <div className="course-chat__queue-head">
        <span className="course-chat__queue-label">
          <Sym name="schedule" aria-hidden="true" />
          排队中 · {items.length}
        </span>
        <Tooltip>
          <Tooltip.Trigger>
            <Button
              isIconOnly
              variant="tertiary"
              size="sm"
              className="course-chat__queue-clear"
              aria-label="清空排队"
              data-testid="chat-queue-clear"
              onPress={onClear}
            >
              <Sym name="delete" />
            </Button>
          </Tooltip.Trigger>
          <Tooltip.Content>
            <p>清空排队</p>
          </Tooltip.Content>
        </Tooltip>
      </div>
      <div className="course-chat__queue-list">
        {items.map((item, index) => (
          <div className="course-chat__queue-item" key={item.id} data-testid="chat-queue-item">
            <span className="course-chat__queue-index" aria-hidden="true">
              {index + 1}
            </span>
            <Input
              className="course-chat__queue-input"
              aria-label={`第 ${index + 1} 条排队消息`}
              data-testid="chat-queue-input"
              value={item.text}
              onChange={(event) => onEdit(item.id, event.target.value)}
            />
            <Tooltip>
              <Tooltip.Trigger>
                <Button
                  isIconOnly
                  variant="tertiary"
                  size="sm"
                  className="course-chat__queue-btn"
                  aria-label="立刻插入这条，不等这一轮答完"
                  data-testid="chat-queue-send-now"
                  onPress={() => onSendNow(item.id)}
                >
                  <Sym name="bolt" />
                </Button>
              </Tooltip.Trigger>
              <Tooltip.Content>
                <p>立刻插入这条，不等这一轮答完</p>
              </Tooltip.Content>
            </Tooltip>
            <Tooltip>
              <Tooltip.Trigger>
                <Button
                  isIconOnly
                  variant="tertiary"
                  size="sm"
                  className="course-chat__queue-btn"
                  aria-label="删掉这条排队消息"
                  data-testid="chat-queue-remove"
                  onPress={() => onRemove(item.id)}
                >
                  <Sym name="close" />
                </Button>
              </Tooltip.Trigger>
              <Tooltip.Content>
                <p>删掉这条</p>
              </Tooltip.Content>
            </Tooltip>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 距底部多少像素以内算「贴底」。
 *
 * 不能写成 `=== 0`：字号、滚动条舍入、以及流式追加的那一帧都会留下零点几像素的
 * 残差，严格等于 0 会让「贴底」永远判 false —— 按钮于是常驻，还跟着新内容一直冒。
 * 24px 与 `ReasoningChain` 判「用户滚没滚」用的是同一把尺，两处的「贴底」别各算各的。
 */
const NEAR_BOTTOM_PX = 24;

export default function CourseChat() {
  const isNarrow = useMediaQuery('(max-width: 900px)');
  const [libraryHeadline] = useState(
    () => LIBRARY_HEADLINES[Math.floor(Math.random() * LIBRARY_HEADLINES.length)],
  );
  const navigate = useNavigate();
  const nav = useAppNav('chat');
  const listRef = useRef<HTMLDivElement | null>(null);
  /**
   * 输入框元素。两件事要用它：
   * ① 随内容自动长高（手机上键盘一弹，可视高度只剩一半，单行的输入框
   *    打三行字就见不着自己写了什么）；
   * ② 聚焦时把消息流吸底（键盘弹出会顶矮面板）。
   */
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const composerHoldRef = useRef<HTMLDivElement>(null);
  const composerWrapRef = useRef<HTMLDivElement>(null);
  const voiceDraftBase = useRef('');
  const [voiceEditVersion, setVoiceEditVersion] = useState(0);
  /**
   * 中文输入法是否正在选词（compositionstart → compositionend 之间）。
   *
   * `e.nativeEvent.isComposing` 覆盖多数浏览器，但部分 Android 输入法在
   * compositionend **之前**就派发 keydown 且不带 isComposing —— 那条 Enter
   * 是「确认候选词」，不是「发送」。用 composition 事件自己记一份状态兜底，
   * 是业界处理 IME 回车的双保险写法（ChatPanel 与 CourseChat 同款）。
   */
  const composingRef = useRef(false);
  /**
   * 消息流是否**粘**在底部：粘着时新内容自动跟到底，用户一旦自己往上滚就松开。
   *
   * 必须是 ref 而不是 state —— 它每次滚动都在变，挂 state 等于每滚一下重渲整棵消息树。
   * 同 `ReasoningChain` 的 `stickRef`。
   */
  const stickRef = useRef(true);
  /** 「回到底部」按钮。显隐直接写它的 `data-show`，理由同上：这只是 paint 提示，不 setState */
  const jumpBtnRef = useRef<HTMLButtonElement | null>(null);
  /** 上一次见到的 scrollTop：用来判断这次到底是**用户往上滚**，还是我们自己在吸底 */
  const lastTopRef = useRef(0);
  /**
   * 粘底时才吸底。聚焦输入框 / 键盘弹收（面板被顶矮一截，停在原 scrollTop 的
   * 最新消息会掉出可视区）都走它。
   */
  const pinIfSticking = useCallback(() => {
    const element = listRef.current;
    if (element && stickRef.current) element.scrollTop = element.scrollHeight;
  }, []);
  useViewportResize(pinIfSticking);
  useLayoutEffect(() => {
    const composer = composerWrapRef.current;
    const main = composer?.parentElement;
    if (!composer || !main) return;
    const measure = () => {
      main.style.setProperty('--chat-composer-height', `${composer.getBoundingClientRect().height}px`);
      pinIfSticking();
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(composer);
    return () => observer.disconnect();
  }, [pinIfSticking]);
  const ready = useCourseChat((s) => s.ready);
  const sessions = useCourseChat((s) => s.sessions);
  const activeId = useCourseChat((s) => s.activeId);
  const loaded = useCourseChat((s) => s.loaded);
  useLayoutEffect(() => {
    useChatAttachments.getState().bind(activeId);
  }, [activeId]);
  const { open: settingsOpen } = useSettingsDialog();
  useLayoutEffect(() => {
    const sync = () => useChatNotifications.getState().setViewing(
      loaded && !settingsOpen && document.visibilityState === 'visible' ? activeId : null,
    );
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => {
      document.removeEventListener('visibilitychange', sync);
      useChatNotifications.getState().setViewing(null);
    };
  }, [activeId, loaded, settingsOpen]);
  const messages = useCourseChat((s) => s.messages);
  /** 新追加的消息（发出去的提问 + 助手占位）播一次上浮淡入，见 useMessageEnter */
  const entering = useMessageEnter(messages.map((m) => m.key), activeId);
  const hasOlder = useCourseChat((s) => s.hasOlder);
  const loadingOlder = useCourseChat((s) => s.loadingOlder);
  const historyError = useCourseChat((s) => s.historyError);
  const loadOlder = useCourseChat((s) => s.loadOlder);
  const loading = useCourseChat((s) => s.loading);
  /**
   * 正在生成的会话 id（可能不止一条）。侧栏 Recent 行尾的 分支/归档/删除 据此
   * **只禁那条在跑的**：别的会话在后台跑不影响你操作一条空闲会话。
   */
  const draft = useCourseChat((s) => s.draft);
  const attachmentItems = useChatAttachments((state) => state.items);
  const hasDraft = !!draft.trim() || attachmentItems.length > 0;
  const attachmentsPending = attachmentItems.some((item) => !item.value);
  const courseCount = useCourseChat((s) => s.courseCount);
  const skillIds = useCourseChat((s) => s.skillIds);
  const contextCourses = useCourseChat((s) => s.contextCourses);
  const pendingAsk = useCourseChat((s) => s.pendingAsk);
  const pendingQuestion = pendingAsk ? messages.find((message) => message.key === pendingAsk.messageKey)?.ask : undefined;
  const composerAsk = pendingQuestion?.picked == null ? pendingQuestion : undefined;
  const pendingPlan = useCourseChat((s) => s.pendingPlan);
  const generating = loading && pendingAsk == null && pendingPlan == null;
  const planApplying = useCourseChat((s) => s.planApplying);
  const bootstrap = useCourseChat((s) => s.bootstrap);
  const refreshCourseCount = useCourseChat((s) => s.refreshCourseCount);
  const loadSession = useCourseChat((s) => s.loadSession);
  const createSession = useCourseChat((s) => s.createSession);
  const removeMessage = useCourseChat((s) => s.deleteMessage);
  const { deleteMessage, deleting } = useMessageDeletion(listRef, activeId, (key) => removeMessage(key, activeId));
  const recent = useRecentChats(true);
  const setDraft = useCourseChat((s) => s.setDraft);
  const send = useCourseChat((s) => s.send);
  const clearCourseContext = useCourseChat((s) => s.clearCourseContext);
  const answerAsk = useCourseChat((s) => s.answerAsk);
  const stop = useCourseChat((s) => s.stop);
  // ── 流式期间的输入（排队 / 插入）─────────────────────────────────────────
  /** 还没交出去的话（生成中投递的队列）。只在内存里，见 store 文件头第 3 条不变量 */
  const queued = useCourseChat((s) => s.queued);
  /** 当前默认投递方式：Enter 用它，Ctrl/⌘+Enter 用另一种 */
  const sendMode = useCourseChat((s) => s.sendMode);
  const setSendMode = useCourseChat((s) => s.setSendMode);
  const removeQueued = useCourseChat((s) => s.removeQueued);
  const updateQueued = useCourseChat((s) => s.updateQueued);
  const clearQueue = useCourseChat((s) => s.clearQueue);
  const sendQueuedNow = useCourseChat((s) => s.sendQueuedNow);
  const confirmPlan = useCourseChat((s) => s.confirmPlan);
  const cancelPlan = useCourseChat((s) => s.cancelPlan);
  const retryMessage = useCourseChat((s) => s.retryMessage);
  const forkSession = useCourseChat((s) => s.forkSession);
  /** 上下文窗口（输入 + 输出的总容量）：用量环的分母，也是历史裁剪的预算来源 */
  const ctxWin = useSettings((s) => s.contextWindow);
  const compressionEnabled = useSettings((s) => s.jev.contextCompression && !!s.jev.apiKey.trim());
  const widgetDark = useResolvedDark(useSettings((s) => s.theme));
  const contextPlan = useContextCompressionStore((s) => activeId == null ? EMPTY_COMPRESSION : s.sessions[activeId] ?? EMPTY_COMPRESSION);
  /**
   * 本轮技能元数据清单（`- 名称：用途` 的单行块）。
   *
   * 用量环要把它算进系统提示词 —— 它跟着本轮一起发出去，不数的话用量会低估。
   * 与 `send` 用的是同一个口子（`loadSessionSkillMeta` + `skillMetaBlock`），
   * 这样环上的数字才与真正发出去的提示词对齐。技能是异步从库里读的，所以先进 state；
   * `skillIds` 变了重取一次（清空范围则退回 `undefined` = 无技能段）。
   */
  const [skillBlock, setSkillBlock] = useState<string | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const metas = await loadSessionSkillMeta(skillIds);
      if (!cancelled) setSkillBlock(metas.length > 0 ? skillMetaBlock(metas) : undefined);
    })();
    return () => {
      cancelled = true;
    };
  }, [skillIds]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  /**
   * 输入框随内容自动长高（最多到 CSS 的 max-height，之后框内自己滚）。
   *
   * 手机上键盘一弹，整页高度少掉小一半，单行的输入框打三行字就见不着自己
   * 写了什么；而 `rows={1}` 的 textarea 默认不会长。先塌回 `auto` 再量
   * `scrollHeight`，否则每次只增不减。内联高度会被 CSS 的 max-height 夹住，
   * 超长文本在框内滚动，不会把输入卡顶出屏幕。
   */
  useLayoutEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    // The empty-state card reserves three lines, so dictation/typing cannot move
    // the heading and starter cards. Only an actual conversation may grow.
    if (messages.length === 0) {
      el.style.removeProperty('height');
      return;
    }
    el.style.height = '0px';
    const maxHeight = parseFloat(getComputedStyle(el).maxHeight);
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [draft, messages.length]);

  // 每次挂载都重新数一次课程：`courseCount` 是 bootstrap 时的快照，
  // 而「去课程库导入 → 切回对话页」是这里的常规动线，刷新晚了空状态会一直停在
  // 「先去导入课程」，哪怕库里已经有课了。
  useEffect(() => {
    void refreshCourseCount();
  }, [refreshCourseCount]);

  useEffect(() => {
    if (ready && activeId != null && !loaded) void loadSession(activeId);
  }, [ready, activeId, loaded, loadSession]);

  const onPlanConfirm = async () => {
    const result = await confirmPlan();
    if (result.error) toast.error(`整理方案执行失败：${result.error}`);
  };

  /**
   * 从一条消息分叉出新会话（对话里的「分支」）。
   *
   * 传 `rowId` 而不是 `message.key`：库里认的是行 id，而 `key` 是视图层的临时键
   * （`stored-<id>` 只是它在历史回放时的形态）。
   */
  const onForkMessage = async (message: CourseChatMessage) => {
    const id = activeId;
    if (id == null || message.rowId == null) return;
    const newId = await forkSession(id, message.rowId);
    if (newId != null) toast.success('已从这条消息分支出新会话');
  };

  const CourseLink = useCallback(
    ({ href, children }: ComponentProps & { href?: string }) => {
      const target = href ?? '';
      if (target.startsWith('#source-image/')) return <MaterialImage href={target} label={children} linkOnly />;
      if (target.startsWith('#/player/')) {
        return (
          <a
            href={target}
            onClick={(event) => {
              event.preventDefault();
              navigate(target.slice(1));
            }}
          >
            {children}
          </a>
        );
      }
      return (
        <a href={target} target="_blank" rel="noreferrer">
          {children}
        </a>
      );
    },
    [navigate],
  );

  const lastMessage = messages[messages.length - 1];
  const virtualMessagesRef = useRef<VirtualMessagesHandle>(null);
  const navigateToQuestion = useCallback(() => { stickRef.current = false; }, []);
  const scrollSignal = [
    messages.length,
    lastMessage?.key ?? '',
    lastMessage?.content.length ?? 0,
    lastMessage?.reasoning?.length ?? 0,
    lastMessage?.hint ?? '',
    lastMessage?.ask ? `${lastMessage.ask.question}${lastMessage.ask.picked ?? ''}` : '',
    lastMessage?.folderPlan?.applied ?? '',
  ].join('|');
  /**
   * 切会话（含首帧落位）回到粘底。
   *
   * 新会话必须从**最新一条**看起，不能继承上一个会话「用户滚上去读过」的状态 ——
   * 否则切过去会停在半空，而那颗回到底部的按钮还得自己冒出来提醒。
   * 声明在下面的滚动效果**之前**：同一 commit 里先复位、再吸附。
   */
  useEffect(() => {
    stickRef.current = true;
    lastTopRef.current = 0;
    if (jumpBtnRef.current) jumpBtnRef.current.dataset.show = 'false';
  }, [activeId]);

  /**
   * 用户滚到哪，就更新「还粘不粘底」和按钮显隐。
   *
   * `scroll` 不冒泡，只能挂在滚动容器自己身上（同 `ReasoningChain`）。
   *
   * ⚠️ 判「粘不粘底」**不能只看 `scrollTop` 离底部多远**：流式追加时内容一帧能长几十像素，
   * 我们自己那次吸底滚动的事件要等到事件循环稍后才派发，那时 `scrollHeight` 已经又长了一截，
   * 「离底部 > 24px」照样成立 —— 于是每来一个 token 都误判成「用户滚上去了」，粘底随即松手，
   * 流到一半就停在半空。真正说明用户**主动往上滚**的只有一件事：`scrollTop` 变小了
   * （我们自己的吸底只会把它推到最大，内容增长则压根不动它）。所以这里按**方向**判。
   *
   * 显隐写 `data-show`（不在 JSX 里声明这个属性）而不是挂 state：它每滚一下都在变，
   * 挂 state 会让整棵消息树跟着重渲。
   */
  useEffect(() => {
    const element = listRef.current;
    if (!element) return;
    const onScroll = () => {
      const top = element.scrollTop;
      const distance = element.scrollHeight - element.clientHeight - top;
      if (distance <= NEAR_BOTTOM_PX) stickRef.current = true;
      else if (top < lastTopRef.current - 1) stickRef.current = false;
      lastTopRef.current = top;
      const state = useCourseChat.getState();
      if (top < 40 && !stickRef.current && !state.historyError) void state.loadOlder();
      if (jumpBtnRef.current) jumpBtnRef.current.dataset.show = stickRef.current ? 'false' : 'true';
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => element.removeEventListener('scroll', onScroll);
  }, []);

  /**
   * 新消息 / 流式追加时滚到底部。
   *
   * 只在**还粘着底**时才跟：用户已经自己滚上去读历史了，每来一个 token 都把他拽回来
   * 是纯打扰（这条原来写死了总是吸附，正是「回到底部」按钮需要存在的原因本身）。
   * 松手之后由那颗按钮把人送回去。
   */
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const element = listRef.current;
      if (element && stickRef.current) element.scrollTop = element.scrollHeight;
    });
    return () => cancelAnimationFrame(id);
  }, [scrollSignal]);

  /** 回到底部：重新粘底并滚到最新。尊重系统「减少动态效果」偏好 —— 那时直接跳过去 */
  const jumpToLatest = () => {
    const element = listRef.current;
    if (!element) return;
    stickRef.current = true;
    element.scrollTo({
      top: element.scrollHeight,
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
  };

  const iconButton = (
    label: string,
    icon: React.ReactNode,
    onClick: () => void,
    options: {
      disabled?: boolean;
      variant?: 'primary' | 'secondary' | 'tertiary';
      testId?: string;
      className?: string;
    } = {},
  ) => (
    <Tooltip>
      <Tooltip.Trigger>
        <Button
          isIconOnly
          aria-label={label}
          variant={options.variant ?? 'tertiary'}
          size="sm"
          isDisabled={options.disabled}
          className={options.className}
          data-testid={options.testId}
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

  /**
   * 可以发消息了吗。
   *
   * 懒创建之后**不能**再带 `activeId != null`：草稿态（会话还没落库）是完全正常的状态，
   * 用户就是在那儿发出第一条消息的。带上它的话草稿态的输入框与发送键永远是禁用的，
   * 用户连第一条都发不出去 —— 这是本轮最容易踩、且症状最像「应用坏了」的一处。
   */
  const sessionReady = loaded;
  /** 有没有课程可用：决定提示词、工具集与空状态走哪一套。null = 还在数 */
  const hasCourses = (courseCount ?? 0) > 0;
  /**
   * 本轮上下文用量估算（系统提示词 + 历史 + 当前草稿），仅供工具行那枚环提示。
   *
   * 与 `store/courseChat` 的 `send` 同口径：系统提示词走 `libraryAssistantSystemPrompt`、
   * 历史只算 `content`（reasoning / 工具回执都不随下一轮重发）、草稿按当前输入框内容算。
   * 不做精确的分词计数，`estimateTokens` 本来就是「按字符量级的保守估值」——
   * 环的作用是让用户看出「快满了」，不是报一个能被审计的账。
   */
  const ctxBreakdown = useMemo(() => {
    const system = estimateTokens(libraryAssistantSystemPrompt(skillBlock, contextCourses, hasCourses));
    const historyRows = compressionEnabled ? retainedContext(messages, contextPlan) : messages;
    const history = historyRows.reduce((sum, message) => sum + estimateTokens(message.content), 0);
    return { system, history, current: estimateTokens(draft) };
  }, [skillBlock, contextCourses, hasCourses, messages, draft, contextPlan, compressionEnabled]);
  const ctxEst = ctxBreakdown.system + ctxBreakdown.history + ctxBreakdown.current;
  const contextCompression = useContextCompression({
    sessionId: activeId, tokens: ctxEst, windowTokens: ctxWin, query: draft,
    busy: loading || !loaded || pendingAsk != null || pendingPlan != null,
  });
  /**
   * 课程库还在数的期间要不要出骨架。
   *
   * 实测这一步是本机 IndexedDB 的 count，量级 1ms，所以正常情况下
   * `courseCount == null` 只会存在一两帧 —— 这时**什么都不渲染**才是对的
   * （原先那句「正在读取课程库…」反而把一次不可感知的等待变成了一次可见的闪动）。
   * 只有真的慢（慢设备、主线程被长任务占住）才会越过阈值露出骨架。
   *
   * ## 「数不出来」的兜底
   *
   * `courseCount` 只可能由 `bootstrap()` / `refreshCourseCount()` 写入，两者都是
   * `db.videos.count()` —— 读失败时它**永远停在 `null`**。只按「骨架 / 什么都不渲染」两档走，
   * 那会让骨架永久停在屏幕上（或落成一屏空白），比原来「闪一下文案」严重得多。
   * 所以再挂一道 3 秒的长门：越过它就认为这次计数没指望了，按「通用助手」那套渲染 ——
   * 宁可退化成没课时的样子（用户至少还能用、还能点去导入），也不要一屏空白或一屏骨架。
   */
  const coursesStuck = useSkeletonGate(courseCount == null, { delayMs: 3000, minVisibleMs: 0 });
  /** 真正出骨架的条件：还在数 **且** 没到「数不出来」的兜底线 */
  const coursesLoading = useSkeletonGate(courseCount == null) && !coursesStuck;
  /** 顶栏标题跟着当前会话走：标题栏写死「课程助手」的话，用户在 Recent 里切了会话，
      顶栏毫无反应，分不清自己看的是哪一段对话。 */
  const activeSession = sessions.find((session) => session.id === activeId);
  /**
   * 顶栏标题。
   *
   * 草稿态（`activeId == null`，会话还没落库）**留空**：顶栏标题这一栏回答的是
   * 「我在看哪条会话」，草稿态还没有会话，写「新会话」等于给一行还没写下的东西起名。
   * 用户口径（2026-10-16）：新会话默认**不在顶栏显示「新会话」**。
   * 找不到行（不该发生）时仍然退回页面名，不编一个假标题。
   */
  const activeTitle = activeSession?.title ?? (activeId == null ? '' : 'AI 助手');
  /**
   * 本轮循环是否还活着（或卡片是否**从断点恢复**成了可答）：两张卡的 `active` 由
   * `pendingAsk` / `pendingPlan` 的 `messageKey` 是否对上这条消息决定。刷新后从库里读回的卡
   * 会被重新武装（`restored: true`），所以它**不是死的** —— 作答即从断点续跑，
   * 见 docs/plans/2026-10-16-ask-user-resume-design.md。只有「旧数据没有检查点」或
   * 「循环被中断」时，卡片才退化成只读。
   */
  const loopAlive = pendingAsk != null || pendingPlan != null;

  /**
   * 导出整个会话为 .md。
   *
   * 课程名传「课程库」而不是某门课：这个会话是**跨课程**的（助手自己挑上下文），
   * 写死成当前选中的那门课会在文件头留下一句假话。
   */
  const exportSession = async () => {
    if (messages.length === 0) return void toast.info('当前会话还没有内容');
    const rows = activeId == null ? [] : await db.chats.where('sessionId').equals(activeId).sortBy('createdAt');
    const savedIds = new Set(rows.map((row) => row.id));
    const exportMessages = [
      ...rows.map((row) => ({ ...row, role: row.role === 'user' ? 'user' : 'ai' })),
      ...messages.filter((message) => !savedIds.has(message.rowId)),
    ];
    const markdown = buildSessionMarkdown({
      title: activeSession?.title ?? '新会话',
      videoName: '资料',
      messages: exportMessages.map((message) => ({
        role: message.role === 'user' ? ('user' as const) : ('assistant' as const),
        content: message.content,
        reasoning: message.reasoning,
      })),
    });
    const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = exportFileName('资料', activeSession?.title ?? '新会话');
    anchor.click();
    URL.revokeObjectURL(url);
    toast.success('已导出 Markdown 文件');
  };

  const renderCards = (message: CourseChatMessage) => (
    <>
      {message.ask && pendingAsk?.messageKey !== message.key && (
        <AskCard
          key={message.key}
          ask={message.ask}
          active={false}
          onPick={answerAsk}
        />
      )}
      {message.folderPlan && (
        <FolderPlanCard
          plan={message.folderPlan}
          active={pendingPlan?.messageKey === message.key}
          restored={pendingPlan?.messageKey === message.key && !!pendingPlan?.restored}
          busy={planApplying && pendingPlan?.messageKey === message.key}
          onConfirm={() => void onPlanConfirm()}
          onCancel={() => void cancelPlan()}
        />
      )}
    </>
  );

  return (
    <PageShell
      title={activeTitle}
      fill
      rootClassName="page-course-chat"
      rail={nav}
      /* 侧栏顶部**没有身份块**：上一版按 showcase 截图恢复过一块
         「网课学习助手 / 本机课程库 · N 门课程」，被用户当场否掉（2026-10-14 同日修订）。
         这块位置现在直接是主导航 —— 见 docs/plans/2026-10-14-对话页改版-design.md §2.3。 */
      recent={recent}
      railFooter={<SettingsButton variant="rail" testId="nav-rail-settings" />}
      actions={isNarrow ? (
        <Button
          isIconOnly
          variant="tertiary"
          className="course-chat__new-chat"
          aria-label="新建对话"
          data-testid="chat-new-session"
          onPress={() => {
            if (useCourseChat.getState().activeId == null) toast.info('已在新会话');
            else void createSession();
          }}
        >
          <Sym name="edit" />
        </Button>
      ) : undefined}
    >
      <div
        className={`course-chat${loaded && messages.length === 0 ? ' course-chat--empty' : ''}`}
        data-testid="course-chat-page"
      >
        <section className="course-chat__main" aria-label="AI 助手聊天">
          <div className="course-chat__timeline">
          <div className="course-chat__messages" ref={listRef} tabIndex={-1} data-testid="course-chat-messages">
            {!loaded && <ChatHistorySkeleton />}
            {loaded && messages.length === 0 && (
              <div className="course-chat__empty">
                {/* 空态里的标题、说明与快捷提问**都取决于库里有没有课**，
                    所以在 `courseCount` 到手之前一个字都不能写死 ——
                    写死的话先显示「有什么想聊的？」再翻成「问你的整个课程库」，
                    用户看到的是一次文案闪变（原先那句「正在读取课程库…」就是这个问题的补丁，
                    但补丁本身也会闪）。

                    三档：等超过阈值 → 出骨架；还在 200ms 宽限内 → 什么都不渲染；
                    读到了 → 真正的空态。另有 3 秒的超时兜底（`coursesStuck`），
                    免得「数不出来」变成一屏永久空白。 */}
                {coursesLoading ? (
                  <CourseCountSkeleton />
                ) : courseCount == null && !coursesStuck ? null : (
                  <>
                    <h2>{hasCourses ? libraryHeadline : '有什么想聊的？'}</h2>
                    <div className="course-chat__starters" aria-label="快捷提问">
                      <div className="course-chat__starters-heading">试试这样问</div>
                      <div className="course-chat__starter-list">
                        {(hasCourses ? LIBRARY_STARTERS : GENERAL_STARTERS).map((starter) => (
                          <Button
                            key={starter.label}
                            variant="secondary"
                            className="course-chat__starter"
                            data-testid={`chat-starter-${starter.label}`}
                            onPress={() => void send(starter.prompt)}
                            isDisabled={loading || !sessionReady}
                          >
                            <span className="course-chat__starter-icon" aria-hidden="true">
                              {starter.icon}
                            </span>
                            <span className="course-chat__starter-label">{starter.label}</span>
                            <Sym name="chevron_right" aria-hidden="true" />
                          </Button>
                        ))}
                      </div>
                    </div>
                    {/* 导入入口从「唯一的出路」降级成「可选的增强」。空库时它是主按钮
                        （那时库里确实没东西），有库时它只是标题下的一行小字。 */}
                    {!hasCourses && (
                      <Button
                        className="course-chat__import"
                        variant="tertiary"
                        size="sm"
                        onPress={() => navigate('/library')}
                        data-testid="chat-go-import"
                      >
                        <Sym name="add" />
                        导入课程，让回答有据可依
                      </Button>
                    )}
                  </>
                )}
              </div>
            )}

            {messages.length > 0 && <div className="chat-history-loader" aria-live="polite">
              {hasOlder && loadingOlder ? <PendingReply label="正在加载历史消息…" /> : hasOlder && (
                <button type="button" onClick={() => void loadOlder()}>
                  {historyError ?? '加载更早消息'}
                </button>
              )}
            </div>}
            {messages.length > 0 && <VirtualMessages key={activeId} items={messages} scrollRef={listRef}
              ref={virtualMessagesRef} scrollPaddingStart={88}>{(message, index) => {
              const user = message.role === 'user';
              const htmlPreview = !user ? htmlPreviewSource(message.content) : undefined;
              /**
               * 「重新生成」只对**最后一条**完整回答成立：改历史中间的一步要用「分支」
               * （删掉它后面所有消息是一次不可见的批量删除，用户会看到一条会话凭空少一段）。
               * 判据与 store 的 `retryMessage` 一致，两边都挡一道。
               */
              const canRetry = !!message.interrupted || index === messages.length - 1;
              /**
               * 提问上的「重试」= 重新回答这句话，所以它只在**这条提问的答复就是最后一条**时成立
               * （提问后面必须紧跟一条回答，且那条回答在末尾）。判据与 store 的 `retryMessage` 一致，
               * 两边都挡一道。
               */
              const canRetryAsk =
                user && messages[index + 1]?.role === 'ai' && index === messages.length - 2;
              return (
                <article
                  key={message.key}
                  className={
                    (user
                      ? 'course-chat__message course-chat__message--user'
                      : 'course-chat__message course-chat__message--ai')
                    + (entering.has(message.key) ? ' t-msg-enter' : '')
                  }
                  data-error={message.error ? 'true' : undefined}
                  data-chat-message={message.key}
                >
                  {/* AI 侧不挂头像气泡：showcase 里助手的回答是**直接铺在正文流里**的，
                      加一个头像就把每条回答切成了「卡片」，长回答读起来很累。 */}
                  {user ? (
                    <UserMessageBubble message={message} busy={loading || deleting} canRetry={canRetryAsk}
                      onRetry={() => void retryMessage(message.key)} onFork={() => void onForkMessage(message)}
                      onDelete={() => void deleteMessage(message.key)} />
                  ) : (
                    <div className="course-chat__bubble course-chat__bubble--ai">
                      <>
                        <ResponseProcess key={message.key} reasoning={message.reasoning} calls={message.tools}
                          streaming={!!message.streaming} phase={message.processPhase} hint={message.hint}
                          since={message.processStartedAt ?? message.reasoningStartedAt} elapsedMs={message.reasoningMs}
                          waiting={!!message.ask && !message.ask.picked || !!message.folderPlan && message.folderPlan.applied === 0} />
                        {/* 卡片排在正文**之前**：卡片是「先发生的那个动作」（第 1 轮问 / 提方案），
                            正文是用户回应之后（第 2 轮）才流出来的。反过来排会读成
                            「先给结论、下面才是问题」。 */}
                        {renderCards(message)}
                        {message.error && !message.streaming && canRetry && (
                          <div className="course-chat__failed" data-testid="chat-answer-failed" role="alert">
                            <Sym name="error" aria-hidden="true" />
                            <span className="course-chat__failed-text">{message.content}</span>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="course-chat__failed-continue"
                              data-testid="chat-error-continue"
                              isDisabled={loading}
                              onPress={() => void retryMessage(message.key)}
                            >
                              继续回答
                            </Button>
                          </div>
                        )}
                        <ArtifactEditProvider rowId={message.rowId} content={message.content}
                          disabled={loading || !!message.streaming || !!message.error || !!message.interrupted || !!message.ask && !message.ask.picked}
                          onSaved={reflectArtifactEdit}>
                        <WidgetMessage message={message} content={message.error ? '' : message.content} dark={widgetDark} rowId={message.rowId}
                          disabled={loading || !!message.streaming || !!message.error || !!message.interrupted || !!message.ask && !message.ask.picked}
                          onPrompt={(text) => void send(text)}>
                        {(markdown) => message.content && !message.error ? (
                          htmlPreview !== undefined ? (
                            <ArtifactEditor kind="html" location="html" source={htmlPreview}>
                            <StreamingHtmlPreview
                              html={htmlPreview}
                              isStreaming={!!message.streaming}
                              statusText="正在解析 HTML"
                            />
                            </ArtifactEditor>
                          ) : (
                            <XMarkdown
                              content={markdown}
                              components={{
                                a: CourseLink,
                                p: StreamParagraph,
                                code: MarkdownCode,
                                pre: MarkdownPre,
                                table: MarkdownTable,
                              }}
                              streaming={{
                                hasNextChunk: !!message.streaming,
                                /**
                                 * 流式中的尾巴换成一颗黑色圆点（见 `StreamTailCircle`）：
                                 * XMarkdown 把它插在最后一个文本 token 之后，圆点因此跟着
                                 * 文字一起长，正好落在下一个字符将出现的位置。
                                 *
                                 * 写完（`hasNextChunk: false`）时整条尾巴消失 ——
                                 * `shouldShowTail` 在库里是 `!!hasNextChunk && tailContent`，
                                 * 这里传 `false` 就是显式关掉。
                                 */
                                tail: message.streaming ? { component: StreamTailCircle } : false,
                              }}
                            />
                          )
                        ) : null}
                        </WidgetMessage>
                        {message.widgetPreview && (
                          <StreamingHtmlPreview html={message.widgetPreview.html} />
                        )}
                        </ArtifactEditProvider>
                        {/* 操作行与来源都只在**这一轮写完**之后出现：流式进行中时正文还在变，
                            这两个块的计数与内容每一帧都不一样，闪得人没法读。 */}
                        {/* 中断提示条。正文里**不嵌**「回答中断：xxx」那句（与「已停止生成」
                            不同）—— 这半截内容要能当 assistant 前缀发给模型接着写，
                            正文里夹一句系统口吻的说明会污染它。中断由这条提示条表达。 */}
                        {!message.streaming && message.interrupted && (
                          <div className="course-chat__interrupted" data-testid="chat-interrupted">
                            <Sym name="warning" />
                            <span className="course-chat__interrupted-text">
                              这条回答写到一半被中断了
                              {message.interruptReason ? `：${message.interruptReason}` : ''}
                            </span>
                            {/* 提示条里直接给入口，不指望用户去 hover 找那颗重试图标 ——
                                中断是一个「需要你现在决定」的状态，不该藏在悬停里 */}
                            <Button
                              size="sm"
                              variant="secondary"
                              className="course-chat__interrupted-continue"
                              data-testid="chat-continue"
                              isDisabled={loading}
                              onPress={() => void retryMessage(message.key)}
                            >
                              继续写
                            </Button>
                          </div>
                        )}
                        {!message.streaming && message.content && message.rowId != null && (
                          <MessageActions
                            content={message.content}
                            isUser={false}
                            busy={loading || deleting}
                            canRetry={canRetry}
                            /* 两种语义必须说得不一样，否则用户不知道点下去会得到什么 */
                            retryHint={message.interrupted ? '接着写（从断点继续，不重复已写内容）' : '重新生成这条回答'}
                            onRetry={() => void retryMessage(message.key)}
                            onFork={() => void onForkMessage(message)}
                            onExport={exportSession}
                            onDelete={() => void deleteMessage(message.key)}
                          />
                        )}
                        {!message.streaming && message.content && (
                          <SourceList sources={extractChatSources(message.content)} />
                        )}
                      </>
                    </div>
                  )}

                  {/* 提问的操作行**挂在气泡外面**（另起一行、右对齐）—— 复制这条提问 / 重新回答这句话 /
                      从这条提问分叉。塞回气泡里的话，悬停时那块底色会多长出一条图标行，
                      气泡本身跟着变形（见 MessageActions 的注释）。
                      还没落库的消息没有行可复制、也没有可重发的行，所以不显示。 */}
                  {user && !message.streaming && message.rowId != null && (
                    <MessageActions
                      content={message.content}
                      isUser
                      busy={loading || deleting}
                      canRetry={canRetryAsk}
                      retryHint="重新回答这句话（删掉这一问一答，用同样的问题重跑一次）"
                      onRetry={() => void retryMessage(message.key)}
                      onFork={() => void onForkMessage(message)}
                      onExport={exportSession}
                      onDelete={() => void deleteMessage(message.key)}
                    />
                  )}
                </article>
              );
            }}</VirtualMessages>}
          </div>

          <ChatMessageNav key={activeId} messages={messages} scrollRef={listRef}
            virtualRef={virtualMessagesRef} onNavigate={navigateToQuestion} />
          <ChatViewportFade />
          </div>

          {/* 正文独占上行；底部添加入口固定在左，发送操作固定在右。
              队列只在有待发消息时出现；长问题仍可自动增高。 */}
          <div className="course-chat__composer-wrap" ref={composerWrapRef}>
            {/* 回到底部：用户往上滚去读历史时，浮在输入卡正上方。
                默认隐藏，显隐由消息流的 scroll 监听直接写 `data-show`（见组件里的
                onScroll）—— 它每滚一下都在变，不挂 state、不带动整棵消息树重渲。
                不放进 JSX 声明 `data-show`：让 React 完全不碰这个属性，滚动时写的值
                才不会被下一次重渲抹掉。 */}
            <button
              type="button"
              ref={jumpBtnRef}
              className="course-chat__scroll-bottom"
              data-testid="chat-scroll-bottom"
              aria-label="回到底部"
              onClick={jumpToLatest}
            >
              <Sym name="arrow_downward" />
            </button>
            {/* 排队条与输入卡同框、压在它正上方：两者是同一件事的两种状态
                （「已经排上的」与「正在打的」），分居两地会让用户以为队列
                是另一个功能区。队列为空时整条不渲染。 */}
            <QueueBar
              items={queued}
              onEdit={updateQueued}
              onRemove={removeQueued}
              onSendNow={(id) => void sendQueuedNow(id)}
              onClear={clearQueue}
            />
            {generating && hasDraft && (
              <div className="course-chat__delivery-bar" data-testid="chat-delivery-bar" data-mode={sendMode}>
                <ToggleButtonGroup
                  className="course-chat__send-mode"
                  selectionMode="single"
                  disallowEmptySelection
                  size="sm"
                  aria-label="流式期间的投递方式"
                  selectedKeys={[sendMode]}
                  onSelectionChange={(keys) => {
                    const next = [...keys][0];
                    if (next) setSendMode(next as SendMode);
                  }}
                >
                  <ToggleButton id="queue" data-testid="chat-send-mode-queue" aria-describedby="chat-delivery-hint"><Sym name="schedule" />排队</ToggleButton>
                  <ToggleButton id="steer" data-testid="chat-send-mode-steer" aria-describedby="chat-delivery-hint"><Sym name="arrow_upward" />插入</ToggleButton>
                </ToggleButtonGroup>
                <p id="chat-delivery-hint" className="course-chat__send-hint" role="status">
                  {sendMode === 'queue' ? '发送后排队，本轮结束自动发出' : '发送后停止当前回复，立即回答新消息'}
                </p>
              </div>
            )}
            <div className="course-chat__composer" ref={composerHoldRef} data-asking={composerAsk ? 'true' : undefined}
              onDragOver={(event) => { if (event.dataTransfer.types.includes('Files') && !pendingAsk) event.preventDefault(); }}
              onDrop={(event) => { if (event.dataTransfer.files.length && !pendingAsk) { event.preventDefault(); useChatAttachments.getState().add(Array.from(event.dataTransfer.files)); } }}>
              {composerAsk && pendingAsk ? (
                <AskCard
                  key={`${activeId}:${pendingAsk.messageKey}`}
                  ask={composerAsk}
                  active
                  restored={pendingAsk.restored}
                  onPick={answerAsk}
                />
              ) : <>
              {/* 上下文属于这次提问的输入范围，和输入框放在同一张 chat 卡里；
                  不再悬在消息区上方，避免用户误以为它是另一条顶栏。 */}
              <div className="course-chat__composer-context">
              {contextCourses.length > 0 && (
                <div className="course-chat__context" data-testid="course-chat-context">
                  <span className="course-chat__context-label">
                    <Sym name="toc" aria-hidden="true" />
                    课程上下文
                  </span>
                  <div className="course-chat__context-chips">
                    {contextCourses.map((course) => (
                      <Chip key={course.id} className="course-chat__context-chip" variant="secondary" size="sm">
                        {course.name}
                        <Button isIconOnly size="sm" variant="tertiary" aria-label={`移除课程 ${course.name}`} isDisabled={loading}
                          onPress={() => void useCourseChat.getState().setCourseContext(contextCourses.filter((item) => item.id !== course.id).map((item) => item.id))}><Sym name="close" /></Button>
                      </Chip>
                    ))}
                  </div>
                  {iconButton('恢复自动选择课程', <Sym name="refresh" />, clearCourseContext, {
                    disabled: loading,
                    testId: 'chat-context-reset',
                  })}
                </div>
              )}
              <ChatAttachmentDraft />
              </div>
              <ChatAddMenu disabled={!sessionReady || !!pendingAsk} />
              <TextArea
                ref={composerRef}
                className="course-chat__input"
                aria-label="给 AI 助手发送消息"
                aria-description="长按输入栏说话，松开完成，上滑取消；识别后可编辑再发送"
                rows={1}
                fullWidth
                value={draft}
                onChange={(event) => {
                  setVoiceEditVersion((version) => version + 1);
                  setDraft(event.target.value);
                }}
                onPaste={(event) => {
                  const files = Array.from(event.clipboardData.files);
                  if (files.length && !pendingAsk) { event.preventDefault(); useChatAttachments.getState().add(files); }
                }}
                /**
                 * 移动端键盘的回车键改成「发送」：Android Chrome 认 enterkeyhint，
                 * 会把按键的文案与语义从「换行」换成「发送」（iOS Safari 暂不认，
                 * 但加上没有副作用）。没有它，手机上要找一颗小小的发送键，
                 * 而回车键就在拇指底下。
                 */
                enterKeyHint="send"
                /**
                 * 中文输入法选词期间不要发送：nativeEvent.isComposing 覆盖多数
                 * 浏览器，部分 Android 输入法则要靠 composition 事件兜底
                 * （见 composingRef 的注释）。
                 */
                onCompositionStart={() => {
                  composingRef.current = true;
                }}
                onCompositionEnd={() => {
                  composingRef.current = false;
                }}
                /** 聚焦即吸底：键盘弹出会顶矮面板，先一步把最新消息留在可视区里 */
                onFocus={pinIfSticking}
                /**
                 * **生成中不再禁用**（2026-10-16 修订）。
                 *
                 * 旧逻辑是 `disabled={!sessionReady || (loading && pendingAsk == null)}`：
                 * 想补一句话只能先按停止，而停止会把已经写了一半的回答作废。
                 * 用户真正的意图往往只是「等它答完，接着问下一句」—— 那条路现在是
                 * **排队**（Enter），输入框全程可打。
                 *
                 * 历史没就绪时禁用；等待作答时由 AskCard 接管输入栏。
                 */
                disabled={!sessionReady}
                placeholder={
                  generating
                        ? sendMode === 'queue'
                          ? '说一句排队，答完这轮自动接着问…'
                          : '说一句立刻插入，打断这轮换个问法…'
                        : '随便问点什么，或长按说话'
                }
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' || event.shiftKey) return;
                  if (event.nativeEvent.isComposing || composingRef.current) return;
                  event.preventDefault();
                  setVoiceEditVersion((version) => version + 1);
                  /**
                   * Enter = 当前模式（默认排队）；Ctrl/⌘+Enter = **另一种**。
                   *
                   * 与 Codex CLI 的 Enter/Tab 同构：两者都是「这一次怎么发」，
                   * 不改默认值 —— 默认值由工具行上那颗切换钮管（`sendMode`）。
                   * 没在生成中时 `mode` 传什么都一样（`send` 直接发），所以这里
                   * 不需要再判一次 `loading`。
                   */
                  const override: SendMode | undefined =
                    event.ctrlKey || event.metaKey ? (sendMode === 'queue' ? 'steer' : 'queue') : undefined;
                  void send(draft, override);
                }}
              />
               {/* Toolbar 负责方向键在输入区工具间循环。投递切换独立挂在输入卡上方。 */}
              <Toolbar
                className="course-chat__composer-tools"
                aria-label="输入区工具"
                orientation="horizontal"
              >
                {/* 模型 chip 那一格点开是张下拉面板：模型列表 + 思考开关 + 思考深度。
                    后两者原先是工具行上的两颗独立控件（灯泡 icon + 横向滑块），
                    但「用哪个模型」和「怎么答」改的是同一件事 —— 这一轮怎么答 ——
                    同一件事两个入口，用户得先想「思考深度是不是归模型管」才找得到。
                    `showThinking` 把它们收进同一个面板，工具行因此只剩四个控件。 */}
                <ModelPicker
                  slot="chat"
                  field="llmModel"
                  variant="chip"
                  showThinking
                  thinkingDepthDisabled={loading}
                />
                <span className="course-chat__context-usage-slot">
                  <ContextUsageButton
                    tokens={ctxEst} windowTokens={ctxWin} breakdown={ctxBreakdown} testId="chat-context-usage"
                    compression={contextCompression.state} onCompress={contextCompression.compress}
                    isDisabled={loading || !loaded || activeId == null || pendingAsk != null || pendingPlan != null}
                  />
                </span>
                {/* 发送与停止共用最右侧的操作位：生成中有草稿就发送，没有才停止。 */}
                {generating ? (
                  hasDraft ? iconButton(sendMode === 'queue' ? '排队发送' : '插入发送', <Sym name="arrow_upward" />,
                    () => void send(draft), { className: 'course-chat__send', testId: 'chat-send', disabled: !sessionReady || attachmentsPending })
                  : iconButton('停止生成（已写出的内容会保留）', <Sym name="stop" filled />, stop, {
                    className: 'course-chat__stop',
                    testId: 'chat-stop',
                  })
                ) : <VoiceInput
                  key={activeId ?? 'draft'}
                  holdTargetRef={composerHoldRef}
                  disabled={!sessionReady || attachmentsPending}
                  hasText={hasDraft}
                  editVersion={voiceEditVersion}
                  onStart={() => { voiceDraftBase.current = useCourseChat.getState().draft; }}
                  onText={(text) => {
                    const base = voiceDraftBase.current;
                    setDraft(base ? `${base} ${text}` : text);
                  }}
                  onSend={() => void send(useCourseChat.getState().draft)}
                  sendLabel={loading
                    ? sendMode === 'queue'
                      ? '排队发送：等这一轮答完自动发出去'
                      : '插入发送：立刻打断这一轮，换成这句'
                    : '发送'}
                />}
              </Toolbar>
              </>}
            </div>
          </div>
        </section>
      </div>
    </PageShell>
  );
}
