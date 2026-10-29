import { Suspense, lazy, memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Avatar, Button, Dropdown, ListBox, Modal, Spinner, cn } from '@heroui/react';
import { PageShell, Sym, toast, promptDialog, confirmDialog } from '../ui';
import { useAppNav } from '../components/appNav';
import { openSettings } from '../components/settingsDialogStore';
import { cloud } from '../cloud/state';
import { MoreMenu, type MenuAction } from '../ui';
import { useBotPanel } from '../store/botPanel';
import { serverClient, ServerApiError, type ApprovalDto, type ThreadDetail, type Session } from '../api/serverClient';
import type { AgentProfileDto, MessageDto, ProjectDetailDto, SseEvent, ThreadDto } from '@wangke/contracts';
import { parseBotAttachments, parseLegacyBotAttachments, MAX_BOT_ATTACHMENTS, type BotAttachment } from '@wangke/contracts';
import { BotAttachmentDraft, BotMessageAttachments, type BotDraftFile } from '../components/BotAttachments';
import { botProgressText } from '@wangke/contracts/cloud';
import { browserSupportsWebAuthn, startRegistration } from '@simplewebauthn/browser';
import MessageComposer from '../components/MessageComposer';
import VirtualMessages from '../components/VirtualMessages';
import { formatListTime, groupMessages, timeOf, type Row } from './botMessages';
import DeliveryReceipt from '../components/DeliveryReceipt';
import AccessForm from './BotAccess';
import './bot.css';
import BotMcpScope from '../mcp/BotMcpScope';
import { MODAL_CONTAINER_CLASS } from '../ui/modalContainer';
import { useTranslation } from 'react-i18next';
import ProjectSettings from '../projects/ProjectSettings';
import ProjectFiles from '../projects/ProjectFiles';
import { projectError } from '../projects/errors';
import '../projects/projects.css';

/** 富内容渲染器（Markdown / 代码 / 表格 / HTML artifact）按需加载，纯文字聊天不下载它。 */
const BotRich = lazy(() => import('./BotRich'));
/** 看起来像 Markdown 的回复才走富渲染：普通聊天句子保持轻量的纯文本气泡。 */
const looksRich = (text: string) => /(^|\n)\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|\|.*\|)|```|\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|\$\$?[^$]+\$/.test(text);

/*
 * Bot 的两处落点，共用同一个对话区与同一份样式（bot.css）：
 *   - 主页右侧的 Bot 栏（BotPanel）：一条连续的对话，标题即会话切换器；
 *   - 项目页（默认导出）：PageShell 里左列会话、右列对话或文件；手机上两列变两屏。
 * 视觉与课程问答一致：没有气泡尾巴、送达勾和浮动日期。
 */

/** 窄屏：两栏收成两屏。和 bot.css 里的断点保持一致。 */
const NARROW_QUERY = '(max-width: 760px)';
function useNarrow() {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(NARROW_QUERY);
    const onChange = (event: MediaQueryListEvent) => setNarrow(event.matches);
    setNarrow(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

/* ─────────────────────────── 头像 ─────────────────────────── */

/** iOS 通讯录式的字母头像：英文取前两个词的首字母，其他语言取第一个字。 */
function monogram(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  if (words.length > 1 && /^[a-z]/i.test(words[0]) && /^[a-z]/i.test(words[1])) return (words[0][0] + words[1][0]).toUpperCase();
  return [...words[0]][0].toUpperCase();
}

const BotAvatar = memo(function BotAvatar({ agent, size = 40, className }: { agent?: AgentProfileDto | null; size?: number; className?: string }) {
  const name = agent?.name ?? '';
  const raw = agent?.avatar?.trim() ?? '';
  const src = /^(https?:|data:image\/|\/)/.test(raw) ? raw : undefined;
  // 头像字段里放一个 emoji 也能用。
  const glyph = raw && !src && [...raw].length <= 2 ? raw : monogram(name);
  return (
    <Avatar className={cn('bh-avatar', className)} style={{ '--bh-avatar': `${size}px` } as CSSProperties} aria-hidden="true">
      {src && <Avatar.Image src={src} alt="" />}
      <Avatar.Fallback className="bh-avatar__fallback">{glyph}</Avatar.Fallback>
    </Avatar>
  );
});

/* ─────────────────────────── 单条气泡 ─────────────────────────── */

const Bubble = memo(function Bubble({
  row,
  approval,
  onReact,
  onResolve,
  projectId,
  rich,
}: {
  row: Row;
  approval?: ApprovalDto;
  onReact: (messageId: string) => void;
  onResolve: (approvalId: string, approved: boolean) => void;
  projectId?: string;
  /** 项目里 Bot 的文字回复一律走富渲染；聊天里只有像 Markdown 的才走。 */
  rich?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { message, first, last, stamp, status } = row;
  const mine = message.role === 'user';
  // 只有刚到的消息播入场动效；虚拟列表滚回来重新挂载的旧消息不再动一遍。
  const [fresh] = useState(() => Date.now() - timeOf(message) < 4000);
  const pending = message.id.startsWith('pending-');
  const attachment = message.kind === 'attachment' ? parseBotAttachments(message.content)
    : mine && message.kind === 'text' ? parseLegacyBotAttachments(message.content) : null;
  let body;
  if (message.kind === 'progress') {
    const progress = botProgressText(message.content, i18n.language);
    // 进度用「正在输入」的三点气泡，正文是 Bot 当前在做的事。
    body = (
      <div className="imsg-bubble imsg-bubble--typing" role="status" aria-label={progress || t('botHome.typingShort')}>
        <span className="imsg-typing" aria-hidden="true"><i /><i /><i /></span>
        {progress && <span className="imsg-typing__text">{progress}</span>}
      </div>
    );
  } else if (attachment) {
    body = (
      <div className="bot-attachment-message">
        <BotMessageAttachments files={attachment.files} projectId={projectId} />
        {attachment.text && <div className="imsg-bubble"><p className="imsg-text">{attachment.text}</p></div>}
      </div>
    );
  } else if (message.kind === 'approval' || message.kind === 'question') {
    const waiting = message.kind === 'approval' && approval?.status === 'pending';
    body = (
      <div className="imsg-bubble imsg-bubble--action">
        <p className="imsg-text">{message.content}</p>
        {waiting && approval && (
          <div className="imsg-actions">
            <Button size="sm" variant="secondary" onPress={() => onResolve(approval.id, false)}>{t('botHome.reject')}</Button>
            <Button size="sm" variant="primary" onPress={() => onResolve(approval.id, true)}>{t('botHome.approve')}</Button>
          </div>
        )}
        {approval && approval.status !== 'pending' && (
          <span className="imsg-resolved" data-status={approval.status}>
            <Sym name={approval.status === 'approved' ? 'check' : 'close'} />
            {approval.status === 'approved' ? t('botHome.approved') : t('botHome.rejected')}
          </span>
        )}
      </div>
    );
  } else if (message.kind === 'widget') {
    // Bot 线程不执行任意 widget，只把源码当作代码块安全地展示。
    body = (
      <div className="imsg-bubble imsg-bubble--code">
        <pre>{message.content.slice(0, 1000)}</pre>
      </div>
    );
  } else if (!mine && (rich || looksRich(message.content))) {
    body = (
      <div className="imsg-bubble imsg-bubble--rich" title={row.time} onDoubleClick={pending ? undefined : () => onReact(message.id)}>
        <Suspense fallback={<p className="imsg-text">{message.content}</p>}>
          <BotRich content={message.content} />
        </Suspense>
      </div>
    );
  } else {
    body = (
      <div className="imsg-bubble" title={row.time} onDoubleClick={mine || pending ? undefined : () => onReact(message.id)}>
        <p className="imsg-text">{message.content}</p>
      </div>
    );
  }

  return (
    <>
      {stamp && <div className="imsg-stamp"><span>{stamp}</span></div>}
      <div
        className={cn('imsg-row', mine ? 'imsg-row--mine' : 'imsg-row--theirs')}
        data-first={first || undefined}
        data-last={last || undefined}
        data-pending={pending || undefined}
        data-fresh={fresh || undefined}
        data-day={row.day}
      >
        {body}
      </div>
      {/* iMessage：只在自己最后一条下面写一次「已读 / 已送达」。 */}
      {row.lastMine && status && <DeliveryReceipt status={status} createdAt={timeOf(message)} />}
    </>
  );
});

/* ─────────────────────────── 页面 ─────────────────────────── */

const EMPTY: MessageDto[] = [];

/** 项目页（#/projects/:id 与其 /files）。 */
export default function BotWorkspace() {
  const { projectId } = useParams();
  return <Workspace key={projectId ?? 'bots'} projectId={projectId} />;
}

/**
 * Bot 辅助栏：对话主页右侧的一项功能，而不是一个独立页面。
 * 宽屏并排在主列右边，窄屏由 PageShell 放进全屏面板。
 */
export function BotPanel({ onClose }: { onClose: () => void }) {
  return <Workspace embedded onClose={onClose} />;
}

/** 列表预览只要一句人话：去掉 Markdown 记号、代码块和表格竖线。 */
function plainPreview(text: string) {
  return text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/^\s*\|?\s*:?-{2,}.*$/gm, ' ')
    .replace(/[|*_`#>~]+/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function lastText(messages: MessageDto[] | undefined) {
  if (!messages) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].kind === 'text') return messages[i];
  return undefined;
}

function Workspace({ projectId, embedded = false, onClose }: { projectId?: string; embedded?: boolean; onClose?: () => void }) {
  const { t, i18n } = useTranslation();
  const { t: ts } = useTranslation('settings');
  const { t: tp } = useTranslation('projects');
  const locale = i18n.language;
  const navigate = useNavigate();
  const location = useLocation();
  const [search, setSearch] = useSearchParams();
  // 渲染只读取请求；消费放在 effect 中，否则每次重渲染都会提前清掉新到的跳转请求。
  const initialThreadId = useRef(embedded ? useBotPanel.getState().requestedThread : search.get('thread'));
  /** 内嵌在主页时 URL 属于对话页，Bot 的线程不写进地址栏。 */
  const setThreadParam = (value: Record<string, string>) => { if (!embedded) setSearch(value, { replace: true }); };
  const filesOpen = Boolean(projectId && location.pathname.endsWith('/files'));
  const narrow = useNarrow();
  /** 窄屏时显示哪一屏。宽屏两栏并排，这个值不起作用。 */
  const [pane, setPane] = useState<'list' | 'chat'>(() => (initialThreadId.current || filesOpen ? 'chat' : 'list'));
  const [mcpOpen, setMcpOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [project, setProject] = useState<ProjectDetailDto | null>(null);
  const [agents, setAgents] = useState<AgentProfileDto[]>([]);
  const [agentId, setAgentId] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [detailError, setDetailError] = useState('');
  const [detailRevision, setDetailRevision] = useState(0);
  const [sendBusy, setSendBusy] = useState(false);
  const sendLock = useRef(false);
  const loadVersion = useRef(0);
  const nav = useAppNav('home');
  const [status, setStatus] = useState<{ initialized: boolean } | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [connectError, setConnectError] = useState('');
  /** 线程列表只拿摘要；详情（消息）只为当前打开的线程拉。 */
  const [threads, setThreads] = useState<ThreadDto[]>([]);
  const [details, setDetails] = useState<Record<string, ThreadDetail>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draftKey = activeId ?? `new:${agentId}`;
  const draft = drafts[draftKey] ?? '';
  const setDraft = (value: string) => setDrafts(old => ({ ...old, [draftKey]: value }));
  const [attachmentDrafts, setAttachmentDrafts] = useState<Record<string, BotDraftFile[]>>({});
  const draftFiles = attachmentDrafts[draftKey] ?? [];
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const cursorRef = useRef(0);
  /** 每个线程有没有任务在跑：决定「正在输入」和已读。 */
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const chatMode = !projectId;

  const active = activeId ? details[activeId] ?? null : null;
  const activeSummary = threads.find((thread) => thread.id === activeId) ?? null;
  const availableAgents = agents.filter(agent => agent.enabled && (!projectId || project?.grants.some(g => g.agentId === agent.id)));
  const agentOf = useCallback((thread: ThreadDto | null) => agents.find(a => a.id === (thread?.agentId ?? agents[0]?.id)) ?? null, [agents]);
  const currentAgentId = activeSummary ? activeSummary.agentId ?? agents[0]?.id ?? '' : agentId;
  const currentAgent = agents.find(a => a.id === currentAgentId) ?? null;
  const canChat = !listLoading && !listError && !project?.archived && !activeSummary?.archived && availableAgents.some(a => a.id === currentAgentId);
  const messages = active?.messages ?? EMPTY;
  const activeRunning = Boolean(activeId && running[activeId]);
  const rows = useMemo(() => {
    // Optimistic "running" only controls the stop/typing UI, not a read receipt.
    const grouped = groupMessages(messages, locale);
    // 只显示无执行细节的输入指示，历史工具进度已在分组前过滤。
    const tail = grouped.at(-1)?.message;
    if (activeRunning && tail) {
      const typing: MessageDto = { id: 'typing', threadId: tail.threadId, clientNonce: null, seq: Number.MAX_SAFE_INTEGER, role: 'assistant', kind: 'progress', content: '', createdAt: new Date().toISOString(), replyTo: null };
      grouped.push({ key: 'typing', message: typing, first: true, last: true, stamp: null, day: grouped[grouped.length - 1]?.day ?? '', time: '' });
    }
    return grouped;
  }, [messages, locale, activeRunning]);
  const approvalByMessage = useMemo(() => {
    const map = new Map<string, ApprovalDto>();
    for (const approval of active?.approvals ?? []) map.set(approval.messageId, approval);
    return map;
  }, [active?.approvals]);

  /** 列表行：最后一句话优先用已经拉到的消息，没拉过的线程用列表接口带回的 preview。 */
  const listRows = useMemo(() => threads
    .filter(thread => showArchived || !thread.archived)
    .map(thread => {
      const last = lastText(details[thread.id]?.messages);
      const time = last && last.createdAt > thread.updatedAt ? last.createdAt : thread.updatedAt;
      return { thread, preview: plainPreview(last?.content ?? thread.preview ?? ''), time };
    })
    .sort((a, b) => b.time.localeCompare(a.time)), [threads, details, showArchived]);

  const patchActive = useCallback((threadId: string, update: (thread: ThreadDetail) => ThreadDetail) => {
    setDetails((old) => old[threadId] ? { ...old, [threadId]: update(old[threadId]) } : old);
  }, []);

  const refresh = useCallback(async () => {
    const version = ++loadVersion.current;
    setListError(''); setListLoading(true);
    try {
      const [result, profiles, nextProject] = await Promise.all([serverClient.threads(projectId), serverClient.agents(), projectId ? serverClient.project(projectId) : Promise.resolve(null)]);
      if (loadVersion.current !== version) return;
      const bots = result.threads.filter(thread => thread.mode === 'bot' && (projectId ? thread.projectId === projectId : !thread.projectId));
      setThreads(bots); setAgents(profiles.agents); setProject(nextProject);
      const firstAgent = profiles.agents.find(a => a.enabled && (!nextProject || nextProject.grants.some(g => g.agentId === a.id)));
      const requested = bots.find(thread => thread.id === initialThreadId.current);
      // 聊天模式只有一条连续的对话：默认接着最近那条往下聊。
      const latest = !projectId ? bots.find(thread => !thread.archived) : undefined;
      const target = requested ?? latest;
      if (target) { setActiveId(target.id); setAgentId(target.agentId ?? firstAgent?.id ?? ''); if (target.archived) setShowArchived(true); }
      else setAgentId(id => id && profiles.agents.some(a => a.id === id) ? id : firstAgent?.id ?? '');
      // 还没有任何会话时，手机上直接落在问候页，而不是一张空列表。
      if (!requested && !bots.some(thread => !thread.archived)) setPane('chat');
      initialThreadId.current = null;
    } catch (error) { if (loadVersion.current === version) setListError(projectError(error)); }
    finally { if (loadVersion.current === version) setListLoading(false); }
  }, [projectId]);

  useEffect(() => {
    let ignore = false;
    void Promise.all([serverClient.bootstrapStatus(), serverClient.session()])
      .then(([nextStatus, nextSession]) => {
        if (ignore) return;
        setStatus(nextStatus);
        setSession(nextSession);
        if (nextSession.authenticated) void refresh();
      })
      .catch((e) => { if (!ignore) setConnectError(t('botHome.offline')); });
    return () => { ignore = true; loadVersion.current++; };
  }, [refresh, t]);

  // 打开线程时才拉它的消息。
  useEffect(() => {
    if (!activeId || details[activeId]) return;
    let cancelled = false;
    setDetailError('');
    void serverClient.thread(activeId).then((detail) => {
      if (cancelled) return;
      setDetails((old) => ({ ...old, [activeId]: detail }));
      setRunning(old => ({ ...old, [activeId]: Boolean(detail.running) }));
    }).catch(error => { if (!cancelled) setDetailError(projectError(error)); });
    return () => { cancelled = true; };
  }, [activeId, details, detailRevision]);

  // 事件流：每个线程独立游标，切换时从 0 回放（服务端按 message.id 去重）。
  const activeLoaded = Boolean(active);
  useEffect(() => {
    // 等详情到手再开事件流，否则详情请求在路上时到达的事件会被丢掉。
    if (!activeId || !activeLoaded || !session?.authenticated || filesOpen) return;
    const controller = new AbortController();
    let stopped = false;
    cursorRef.current = 0;
    const receive = (event: SseEvent, id: number) => {
      cursorRef.current = Math.max(cursorRef.current, id);
      if (!('message' in event)) return;
      // 对面有了正式回应（回复、提问、审批），就不再显示「正在输入」。
      if (event.message.role !== 'user' && event.message.kind !== 'progress') setRunning(old => ({ ...old, [activeId]: false }));
      patchActive(activeId, (thread) => thread.messages.some((message) => message.id === event.message.id)
        ? { ...thread, messages: thread.messages.map((message) => message.id === event.message.id ? event.message : message) }
        : { ...thread, messages: [...thread.messages, event.message].sort((a, b) => a.seq - b.seq) });
      if (event.message.kind === 'approval') void serverClient.thread(activeId).then(detail => {
        if (!controller.signal.aborted) patchActive(activeId, thread => ({ ...thread, approvals: detail.approvals }));
      }).catch(() => {});
    };
    const run = async () => {
      while (!stopped) {
        try {
          await serverClient.events(activeId, cursorRef.current, receive, controller.signal);
        } catch {
          if (controller.signal.aborted) break;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 800));
      }
    };
    void run();
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [activeId, activeLoaded, session?.authenticated, patchActive, filesOpen]);

  // 吸底：用户停在底部时，新消息和高度变化都把视图留在最新一条；往上翻了就不打扰。
  const followEnd = useCallback(() => {
    const scroll = scrollRef.current;
    if (scroll && stickRef.current) scroll.scrollTop = scroll.scrollHeight;
  }, []);
  useEffect(() => {
    stickRef.current = true;
  }, [activeId]);
  useEffect(followEnd, [rows.length, followEnd]);

  const create = async () => {
    if (!agentId || project?.archived) return null;
    const thread = await serverClient.createThread(tp('newTitle'), { projectId, agentId });
    setThreads((old) => [thread, ...old]);
    setDetails((old) => ({ ...old, [thread.id]: { ...thread, messages: [] } }));
    setActiveId(thread.id);
    setThreadParam({ thread: thread.id });
    return thread;
  };
  const leaveFiles = () => { if (filesOpen) navigate(`/library/folders/${projectId}/chat`); };
  const newDraft = () => { setActiveId(null); setThreadParam({}); };
  /** 和某个 Bot 开始一段新对话：落在它的问候页。 */
  const startWith = (id: string) => { setAgentId(id); newDraft(); leaveFiles(); setPane('chat'); };
  const openThread = (thread: ThreadDto) => {
    setActiveId(thread.id);
    if (thread.agentId) setAgentId(thread.agentId);
    setPane('chat');
    if (filesOpen) navigate(`/library/folders/${projectId}/chat?thread=${thread.id}`);
    else setThreadParam({ thread: thread.id });
  };

  /* 已经打开着 Bot 栏时又点了「接管」之类的链接：切到那条线程。 */
  const requestedThread = useBotPanel((state) => state.requestedThread);
  useEffect(() => {
    if (!embedded || !requestedThread || listLoading) return;
    const id = useBotPanel.getState().consumeRequest();
    const hit = threads.find((thread) => thread.id === id);
    if (hit) openThread(hit);
    else if (id) { initialThreadId.current = id; void refresh(); }
    // openThread 每次渲染都是新函数；这里只该在请求到来时跑一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embedded, requestedThread, listLoading, threads, refresh]);

  const appendPending = (threadId: string, kind: MessageDto['kind'], content: string, nonce: string): MessageDto => {
    const pending: MessageDto = {
      id: `pending-${nonce}`, threadId, clientNonce: nonce, seq: Number.MAX_SAFE_INTEGER,
      role: 'user', kind, content, createdAt: new Date().toISOString(), replyTo: null,
    };
    patchActive(threadId, (thread) => ({ ...thread, messages: [...thread.messages, pending] }));
    stickRef.current = true;
    return pending;
  };
  const settlePending = (threadId: string, pendingId: string, accepted: MessageDto | null) => {
    patchActive(threadId, (thread) => ({
      ...thread,
      messages: accepted
        ? thread.messages.map((message) => message.id === pendingId ? accepted : message).filter((message, index, list) => list.findIndex((other) => other.id === message.id) === index).sort((a, b) => a.seq - b.seq)
        : thread.messages.filter((message) => message.id !== pendingId),
    }));
  };
  const mergeThread = (updated: ThreadDto) => setThreads(old => old.map(thread => thread.id === updated.id ? { ...thread, ...updated } : thread));

  const send = async () => {
    if (!canChat || (!draft.trim() && !draftFiles.length) || sendLock.current || (activeId && !active)) return;
    sendLock.current = true; setSendBusy(true);
    const content = draft.trim();
    const nonce = crypto.randomUUID();
    const sourceKey = draftKey;
    const files = draftFiles;
    let targetId: string | undefined;
    let pending: MessageDto | undefined;
    let clearedDraft = false;
    try {
      const target = active ?? await create();
      if (!target) return;
      targetId = target.id;
      // A first send creates a thread; move its draft without touching other conversations.
      if (sourceKey !== target.id) {
        setDrafts(old => { const next = { ...old, [target.id]: old[sourceKey] ?? '' }; delete next[sourceKey]; return next; });
        setAttachmentDrafts(old => { const next = { ...old, [target.id]: old[sourceKey] ?? [] }; delete next[sourceKey]; return next; });
      }
      const uploaded = await Promise.allSettled(files.map(async item => {
        if (item.uploaded) return item.uploaded;
        try {
          let uploadedFile: BotAttachment;
          if (projectId) {
            const result = await serverClient.uploadProjectFile(projectId, item.file.name, item.file);
            uploadedFile = { projectId, projectPath: result.path, originalName: item.file.name, mimeType: item.file.type, sizeBytes: item.file.size };
          } else {
            const result = await serverClient.uploadFile(item.file);
            uploadedFile = { fileId: result.id, originalName: result.originalName, mimeType: result.mimeType, sizeBytes: result.sizeBytes };
          }
          setAttachmentDrafts(old => ({ ...old, [target.id]: (old[target.id] ?? []).map(file => file.id === item.id ? { ...file, uploaded: uploadedFile, error: undefined } : file) }));
          return uploadedFile;
        } catch (error) {
          setAttachmentDrafts(old => ({ ...old, [target.id]: (old[target.id] ?? []).map(file => file.id === item.id ? { ...file, error: projectError(error) } : file) }));
          throw error;
        }
      }));
      const failed = uploaded.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      const attachments = uploaded.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
      const payload = attachments.length ? JSON.stringify({ ...attachments[0], attachments, caption: content }) : content;
      pending = appendPending(target.id, attachments.length ? 'attachment' : 'text', payload, nonce);
      // Keep edits made during upload. A failed send restores the submitted draft.
      if ((drafts[sourceKey] ?? '').trim() === content) {
        clearedDraft = true;
        setDrafts(old => old[target.id]?.trim() === content ? { ...old, [target.id]: '' } : old);
      }
      settlePending(target.id, pending.id, await (attachments.length
        ? serverClient.sendAttachment(target.id, payload, nonce)
        : serverClient.sendMessage(target.id, payload, nonce)));
      setAttachmentDrafts(old => ({ ...old, [target.id]: (old[target.id] ?? []).filter(item => !files.some(file => file.id === item.id)) }));
      setRunning(old => ({ ...old, [target.id]: true }));
      if (target.title === tp('newTitle')) {
        const updated = await serverClient.updateThread(target.id, { title: (content || files[0]?.file.name || '').slice(0, 60) }).catch(() => null);
        if (updated) mergeThread(updated);
      }
    } catch (error) {
      if (targetId && pending) settlePending(targetId, pending.id, null);
      if (clearedDraft) setDrafts(old => ({ ...old, [targetId ?? sourceKey]: old[targetId ?? sourceKey] || content }));
      toast.error(projectError(error));
    } finally { sendLock.current = false; setSendBusy(false); }
  };

  const addFiles = (files: File[]) => {
    if (!canChat) return;
    if (files.some(file => !file.size || file.size > 20 * 1024 * 1024)) { toast.error('附件不能为空，单个附件不能超过 20 MB'); return; }
    if (files.length + draftFiles.length > MAX_BOT_ATTACHMENTS) { toast.error(`最多添加 ${MAX_BOT_ATTACHMENTS} 个附件`); return; }
    const items = files.map(file => ({ id: crypto.randomUUID(), file }));
    setAttachmentDrafts(old => ({ ...old, [draftKey]: [...(old[draftKey] ?? []), ...items].slice(0, MAX_BOT_ATTACHMENTS) }));
  };

  const react = useCallback(async (messageId: string) => {
    try {
      await serverClient.react(messageId, '👍');
      toast.success('👍');
    } catch {
      toast.error(t('botHome.reactFailed'));
    }
  }, [t]);

  const resolveApproval = useCallback(async (approvalId: string, approved: boolean) => {
    if (!activeId) return;
    try {
      const resolved = await serverClient.resolveApproval(approvalId, approved);
      patchActive(activeId, (thread) => ({ ...thread, approvals: thread.approvals?.map((approval) => approval.id === approvalId ? resolved : approval) }));
    } catch {
      toast.error(t('botHome.approvalFailed'));
    }
  }, [activeId, patchActive, t]);

  const stop = async () => {
    if (!active) return;
    try {
      const result = await serverClient.stopThread(active.id);
      setRunning(old => ({ ...old, [active.id]: false }));
      toast.info(result.stopped ? t('botHome.stopped') : t('botHome.notRunning'));
    } catch {
      toast.error(t('botHome.stopFailed'));
    }
  };

  const addPasskey = async () => {
    if (!browserSupportsWebAuthn()) { toast.error(t('botHome.passkeyUnsupported')); return; }
    try {
      const optionsJSON = await serverClient.passkeyRegisterOptions();
      const response = await startRegistration({ optionsJSON });
      await serverClient.passkeyRegisterVerify(response);
      toast.success(t('botHome.passkeyAdded'));
    } catch (e) {
      if (e instanceof ServerApiError && e.code === 'webauthn_not_configured') toast.error(t('botHome.passkeyUnavailable'));
      else if ((e instanceof DOMException || e instanceof Error) && e.name === 'NotAllowedError') toast.error(t('botHome.passkeyCancelled'));
      else toast.error(t('botHome.passkeyFailed'));
    }
  };

  const logout = async () => {
    try {
      await serverClient.logout();
      setSession({ authenticated: false, user: null });
      setThreads([]);
      setDetails({});
    } catch {
      toast.error(t('botHome.logoutFailed'));
    }
  };

  const editThread = async (thread: ThreadDto, action: 'rename' | 'archive' | 'delete') => {
    try {
      if (action === 'delete') {
        if (!await confirmDialog({ headline: tp('deleteConfirm', { name: thread.title }), description: tp('sessionDeleteHint'), confirmText: tp('delete'), cancelText: tp('cancel'), danger: true })) return;
        await serverClient.deleteThread(thread.id);
        setThreads(old => old.filter(row => row.id !== thread.id));
        if (activeId === thread.id) { newDraft(); setPane('list'); }
        setDetails(old => { const next = { ...old }; delete next[thread.id]; return next; });
        return;
      }
      let title: string | null = null;
      if (action === 'rename') {
        title = await promptDialog({ headline: tp('rename'), defaultValue: thread.title ?? '', confirmText: tp('save'), cancelText: tp('cancel') });
        if (!title) return;
      }
      const updated = await serverClient.updateThread(thread.id, title ? { title } : { archived: !thread.archived });
      mergeThread(updated);
      patchActive(thread.id, detail => ({ ...detail, ...updated }));
      if (updated.archived && activeId === thread.id && !showArchived) { newDraft(); setPane('list'); }
    } catch (error) { toast.error(projectError(error)); }
  };

  const reload = () => {
    void Promise.all([serverClient.bootstrapStatus(), serverClient.session()]).then(([nextStatus, nextSession]) => {
      setStatus(nextStatus);
      setSession(nextSession);
      if (nextSession.authenticated) return refresh();
      return undefined;
    });
  };

  /* 内嵌在主页右侧时，加载 / 登录态也待在这块面板里，不另起一页。 */
  const panelBar = (extra?: ReactNode) => (
    <header className="bot-panel__bar">
      <h2 className="bot-panel__title">{currentAgent?.name || 'Bot'}</h2>
      <div className="bot-panel__actions">
        {extra}
        <Button isIconOnly variant="ghost" className="rounded-full" aria-label={t('botHome.close')} data-testid="bot-panel-close" onPress={onClose}>
          <Sym name="close" />
        </Button>
      </div>
    </header>
  );
  const frame = (body: ReactNode, title = 'Bot') => embedded
    ? <section className="bot-panel" aria-label="Bot">{panelBar()}{body}</section>
    : <PageShell title={title} rail={nav} onBack={() => navigate('/library')}>{body}</PageShell>;

  if (!status) {
    return frame(
      <div className="bot-center">
        {connectError
          ? <div className="bot-center__error" role="alert"><p>{connectError}</p><Button size="sm" variant="secondary" onPress={reload}>{tp('retry')}</Button></div>
          : <Spinner size="lg" color="current" />}
      </div>,
    );
  }

  if (!session?.authenticated) {
    return frame(<AccessForm initialized={status.initialized} onDone={reload} />);
  }

  /* ── 菜单 ── */

  const accountActions: MenuAction[] = [
    { key: 'passkey', label: t('botHome.passkey'), icon: <Sym name="key" />, onAction: () => void addPasskey() },
    { key: 'logout', label: t('botHome.logout'), icon: <Sym name="key_off" />, danger: true, onAction: () => void logout() },
  ];
  const runActions: MenuAction[] = [
    { key: 'stop', label: t('botHome.stop'), icon: <Sym name="stop" />, disabled: !activeRunning, onAction: () => void stop() },
    ...(!projectId ? [{ key: 'permissions', label: t('botHome.permissions'), icon: <Sym name="tune" />, onAction: () => openSettings(cloud.enabled ? 'bot' : 'agent') }] : []),
    ...(!projectId ? [{ key: 'mcp', label: ts('mcp.scope'), icon: <Sym name="extension" />, disabled: !active, onAction: () => setMcpOpen(true) }] : []),
  ];
  const threadMenu: MenuAction[] = activeSummary ? [
    { key: 'rename', label: tp('rename'), icon: <Sym name="edit" />, onAction: () => void editThread(activeSummary, 'rename') },
    { key: 'archive', label: tp(activeSummary.archived ? 'restore' : 'archive'), icon: <Sym name={activeSummary.archived ? 'archive_restore' : 'archive'} />, onAction: () => void editThread(activeSummary, 'archive') },
    ...runActions,
    { key: 'delete', label: tp('delete'), icon: <Sym name="delete" />, danger: true, onAction: () => void editThread(activeSummary, 'delete') },
  ] : [];

  const landing = !activeId && !filesOpen;
  const chatTitle = filesOpen ? tp('files') : activeSummary?.title && activeSummary.title !== tp('newTitle') ? activeSummary.title : currentAgent?.name ?? '';

  /* ── 对话区（Bot 栏与项目共用） ── */

  const conversation = filesOpen ? (project && <div className="bh-files"><ProjectFiles key={project.id} project={project} /></div>) : <>
    <div className="bh-scroll-wrap">
      <div
        ref={scrollRef}
        className="bot-messages"
        aria-live="polite"
        onScroll={(event) => {
          const el = event.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
      >
        {listLoading ? <div className="bot-center"><Spinner color="current" /></div> : landing ? (
          <div className="bh-hello">
            {projectId && !availableAgents.length ? <p className="bh-hello__note">{tp('noAgent')}</p> : <>
              <BotAvatar agent={currentAgent} size={72} className="bh-hello__avatar" />
              <p className="bh-hello__name">{currentAgent?.name}</p>
            </>}
          </div>
        ) : !active ? (
          <div className="bot-center">{detailError ? <div className="bh-inline-error" role="alert">{detailError}<Button size="sm" variant="secondary" onPress={() => setDetailRevision(v => v + 1)}>{tp('retry')}</Button></div> : <Spinner color="current" />}</div>
        ) : (
          <VirtualMessages items={rows} scrollRef={scrollRef} onResize={followEnd} key={active.id}>
            {(row) => (
              <Bubble
                row={row}
                approval={approvalByMessage.get(row.message.id)}
                onReact={react}
                onResolve={resolveApproval}
                projectId={projectId}
                rich={Boolean(projectId)}
              />
            )}
          </VirtualMessages>
        )}
      </div>
    </div>

    <MessageComposer
      key={draftKey}
      className="bot-composer"
      ariaLabel={t('botHome.composer')}
      placeholder={project?.archived ? tp('readOnly') : t('botHome.taskPlaceholder')}
      value={draft}
      onChange={setDraft}
      onSubmit={() => void send()}
      disabled={!canChat || Boolean(activeId && !active)}
      sending={sendBusy}
      hasAttachments={draftFiles.length > 0}
      busy={activeRunning}
      onStop={() => void stop()}
      onFiles={addFiles}
      onFocus={followEnd}
      onScope={active && !projectId ? () => setMcpOpen(true) : undefined}
      onSettings={() => projectId ? setSettingsOpen(true) : openSettings(cloud.enabled ? 'bot' : 'agent')}
      attachLabel={t('botHome.attach')}
      accessory={draftFiles.length ? <BotAttachmentDraft files={draftFiles} sending={sendBusy} onRemove={id => setAttachmentDrafts(old => ({ ...old, [draftKey]: (old[draftKey] ?? []).filter(file => file.id !== id) }))} /> : undefined}
    />
  </>;

  const modals = <>
    {settingsOpen && project && <ProjectSettings project={project} agents={agents} onChange={next => { setProject(next); const first = next.grants.find(g => agents.some(a => a.id === g.agentId && a.enabled)); if (!next.grants.some(g => g.agentId === agentId)) setAgentId(first?.agentId ?? ''); }} onClose={() => setSettingsOpen(false)} />}
    <Modal.Root isOpen={mcpOpen} onOpenChange={setMcpOpen}><Modal.Backdrop><Modal.Container size="md" className={MODAL_CONTAINER_CLASS}><Modal.Dialog>
      <Modal.Header><Modal.Heading>{ts('mcp.scope')}</Modal.Heading></Modal.Header>
      <Modal.Body>{mcpOpen && activeId ? <BotMcpScope key={activeId} threadId={activeId} /> : null}</Modal.Body>
      <Modal.Footer><Button onPress={() => setMcpOpen(false)}>{ts('mcp.save')}</Button></Modal.Footer>
    </Modal.Dialog></Modal.Container></Modal.Backdrop></Modal.Root>
  </>;

  /* ── Bot 栏：标题即会话切换器（HIG pull-down），右侧「新对话」「更多」「关闭」 ── */

  if (embedded) {
    const recentThreads = listRows.filter(row => !row.thread.archived).slice(0, 30);
    const historyMenu = (
      <Dropdown>
        <Button variant="ghost" className="bot-panel__switcher" aria-label={t('botHome.history')} data-testid="bot-panel-history">
          <BotAvatar agent={currentAgent} size={28} />
          <span className="bot-panel__switcher-name">{landing ? currentAgent?.name || 'Bot' : chatTitle}</span>
          <Sym name="keyboard_arrow_down" aria-hidden="true" />
        </Button>
        <Dropdown.Popover placement="bottom start" className="bot-panel__history">
          <Dropdown.Menu
            aria-label={t('botHome.history')}
            selectionMode="single"
            selectedKeys={activeId ? [activeId] : []}
            onAction={(key) => {
              const hit = threads.find(thread => thread.id === String(key));
              if (hit) openThread(hit);
            }}
          >
            {recentThreads.map(({ thread, time }) => (
              <Dropdown.Item key={thread.id} id={thread.id} textValue={thread.title || tp('newTitle')}>
                <span className="min-w-0 flex-1 truncate">{thread.title || tp('newTitle')}</span>
                <time className="shrink-0 text-xs text-muted" dateTime={time}>{formatListTime(time, locale)}</time>
              </Dropdown.Item>
            ))}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
    );
    return (
      <section className="bot-panel" data-landing={landing || undefined} aria-label="Bot" data-testid="bot-panel">
        <header className="bot-panel__bar">
          {recentThreads.length > 0 ? historyMenu : (
            <h2 className="bot-panel__switcher bot-panel__switcher--static">
              <BotAvatar agent={currentAgent} size={28} />
              <span className="bot-panel__switcher-name">{currentAgent?.name || 'Bot'}</span>
            </h2>
          )}
          <div className="bot-panel__actions">
            <Button isIconOnly variant="ghost" className="rounded-full" aria-label={t('botHome.compose')} data-testid="bot-panel-new"
              isDisabled={landing || sendBusy} onPress={() => { newDraft(); }}>
              <Sym name="edit" />
            </Button>
            <MoreMenu label={t('botHome.more')} actions={[...(activeSummary ? threadMenu : runActions), ...accountActions]} testId="bot-panel-more" />
            <Button isIconOnly variant="ghost" className="rounded-full" aria-label={t('botHome.close')} data-testid="bot-panel-close" onPress={onClose}>
              <Sym name="close" />
            </Button>
          </div>
        </header>
        {conversation}
        {modals}
      </section>
    );
  }

  /* ── 项目：左边会话列表，右边对话或文件，外面是全应用同一个 PageShell ── */

  const listMenu: MenuAction[] = [
    { key: 'archived', label: t(showArchived ? 'botHome.hideArchived' : 'botHome.showArchived'), icon: <Sym name="archive" />, onAction: () => setShowArchived(v => !v) },
  ];

  const listPane = (
    <aside className="bh-list" aria-label={t('botHome.listLabel')} inert={narrow && pane === 'chat'}>
      <div className="bh-segment" role="group">
        <Button size="sm" variant="ghost" className="bh-segment__item" aria-pressed={!filesOpen} data-active={!filesOpen || undefined} onPress={() => { navigate(`/library/folders/${projectId}/chat${activeId ? `?thread=${activeId}` : ''}`); setPane('chat'); }}>{tp('chat')}</Button>
        <Button size="sm" variant="ghost" className="bh-segment__item" aria-pressed={filesOpen} data-active={filesOpen || undefined} onPress={() => navigate(`/library?folder=${projectId}`)}>{tp('files')}</Button>
      </div>

      {availableAgents.length > 1 && (
        <div className="bh-pins" role="group" aria-label={t('botHome.contacts')}>
          {availableAgents.map(agent => (
            <Button key={agent.id} variant="ghost" className="bh-pin" aria-pressed={!activeId && !filesOpen && agent.id === agentId}
              data-current={agent.id === currentAgentId || undefined} onPress={() => startWith(agent.id)}>
              <BotAvatar agent={agent} size={52} />
              <span className="bh-pin__name">{agent.name}</span>
            </Button>
          ))}
        </div>
      )}

      <div className="bh-list__scroll">
        {listError ? (
          <div className="bh-inline-error" role="alert">{listError}<Button size="sm" variant="secondary" onPress={() => void refresh()}>{tp('retry')}</Button></div>
        ) : listLoading ? (
          <div className="bh-list__loading"><Spinner size="sm" color="current" /></div>
        ) : listRows.length > 0 && (
          <ListBox
            aria-label={t('botHome.listLabel')}
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={activeId && !filesOpen && !narrow ? [activeId] : []}
            onSelectionChange={(keys) => {
              const id = [...keys][0];
              const hit = threads.find(thread => thread.id === String(id));
              if (hit) openThread(hit);
            }}
            className="bh-threads"
          >
            {listRows.map(({ thread, preview, time }) => {
              const agent = agentOf(thread);
              const title = thread.title || tp('newTitle');
              return (
                <ListBox.Item key={thread.id} id={thread.id} textValue={title} className="bh-thread" data-archived={thread.archived || undefined}>
                  <BotAvatar agent={agent} size={40} />
                  <span className="bh-thread__body">
                    <span className="bh-thread__top">
                      <span className="bh-thread__name">{title}</span>
                      {thread.archived && <span className="bh-thread__flag" aria-label={t('botHome.archived')}><Sym name="archive" /></span>}
                      <time className="bh-thread__time" dateTime={time}>{formatListTime(time, locale)}</time>
                    </span>
                    <span className="bh-thread__preview">{preview || agent?.name}</span>
                  </span>
                </ListBox.Item>
              );
            })}
          </ListBox>
        )}
      </div>
    </aside>
  );

  const chatPane = (
    <section className="bh-chat" data-landing={landing || undefined} aria-label={chatTitle ? t('botHome.conversation', { name: chatTitle }) : undefined} inert={narrow && pane === 'list'}>
      {!landing && (
        <header className="bh-chat__bar">
          <h2 className="bh-chat__who">
            {!filesOpen && <BotAvatar agent={currentAgent} size={28} />}
            <span className="bh-chat__name">{chatTitle}</span>
          </h2>
          {threadMenu.length > 0 && !filesOpen && <MoreMenu label={t('botHome.more')} actions={threadMenu} testId="bh-thread-more" />}
        </header>
      )}
      {conversation}
    </section>
  );

  return (
    <PageShell
      title={project?.name ?? tp('title')}
      fill
      rail={nav}
      rootClassName="page-project"
      onBack={() => (narrow && pane === 'chat' ? setPane('list') : navigate(`/library?folder=${projectId}`))}
      actions={<>
        <Button isIconOnly variant="ghost" className="rounded-full" aria-label={tp('settings')} isDisabled={!project} onPress={() => setSettingsOpen(true)}>
          <Sym name="tune" />
        </Button>
        <MoreMenu label={t('botHome.more')} actions={[...listMenu, ...accountActions]} testId="bh-list-more" />
        <Button isIconOnly variant="ghost" className="rounded-full" aria-label={t('botHome.compose')} isDisabled={sendBusy || project?.archived || !availableAgents.length} onPress={() => startWith(currentAgentId || availableAgents[0]?.id || '')}>
          <Sym name="edit" />
        </Button>
      </>}
    >
      <div className="bh" data-pane={pane} data-narrow={narrow || undefined}>
        {listPane}
        {chatPane}
        {modals}
      </div>
    </PageShell>
  );
}
