import { Suspense, lazy, memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ChangeEvent } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Avatar, Button, Dropdown, ListBox, Modal, Spinner, cn } from '@heroui/react';
import { PageShell, Sym, toast, promptDialog, confirmDialog } from '../ui';
import { useAppNav } from '../components/appNav';
import { openSettings } from '../components/settingsDialogStore';
import { cloud } from '../cloud/state';
import ModeShell, { AppMenu, ModeSwitch, MoreMenu, useAppMenuActions, type MenuAction } from '../components/ModeShell';
import { serverClient, ServerApiError, type ApprovalDto, type ThreadDetail, type Session } from '../api/serverClient';
import type { AgentProfileDto, MessageDto, ProjectDetailDto, SseEvent, ThreadDto } from '@wangke/contracts';
import { browserSupportsWebAuthn, startRegistration } from '@simplewebauthn/browser';
import MessageComposer from '../components/MessageComposer';
import VirtualMessages from '../components/VirtualMessages';
import { formatListTime, groupMessages, timeOf, type DeliveryStatus, type Row } from './botMessages';
import AccessForm from './BotAccess';
import './bot-workspace.css';
import './bot-home.css';
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
 * Bot 首页与对话页，按「信息」App 的结构来：
 *   左栏是联系人式的会话列表（头像、名字、最后一句、时间），右栏是对话；
 *   手机上两栏变成两屏，点进会话推入、左上角箭头返回。
 * Bot 当成一个人看待：顶栏只有头像和名字，不再有「BOT」徽标和副标题。
 */

function parseAttachment(content: string, fallback: string): { name: string; size?: number; uploading?: boolean } {
  try {
    const value = JSON.parse(content) as { originalName?: unknown; sizeBytes?: unknown; uploading?: unknown };
    return {
      name: typeof value.originalName === 'string' ? value.originalName : fallback,
      size: typeof value.sizeBytes === 'number' ? value.sizeBytes : undefined,
      uploading: value.uploading === true,
    };
  } catch {
    return { name: content.slice(0, 80) || fallback };
  }
}

function formatBytes(size?: number) {
  if (size === undefined) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/** 窄屏：两栏收成两屏。和 bot-home.css 里的断点保持一致。 */
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

/** Telegram 式的送达标记：一个勾 = 服务器收下，两个勾 = 对方已读。 */
function Ticks({ status }: { status: DeliveryStatus }) {
  if (status === 'sending') return <svg className="imsg-ticks" viewBox="0 0 16 11" aria-hidden="true"><circle cx="8" cy="5.5" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M8 3.4v2.3l1.5 1" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>;
  return (
    <svg className="imsg-ticks" data-status={status} viewBox="0 0 16 11" aria-hidden="true">
      <path d="M1.5 5.8 4.6 8.9 11 2.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      {status === 'read' && <path d="M7.2 8.4 7.7 8.9 14.2 2.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
}

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
  const { t } = useTranslation();
  const { message, first, last, stamp, status } = row;
  const mine = message.role === 'user';
  // 只有刚到的消息播入场动效；虚拟列表滚回来重新挂载的旧消息不再动一遍。
  const [fresh] = useState(() => Date.now() - timeOf(message) < 4000);
  const pending = message.id.startsWith('pending-');
  const statusLabel = status ? t(status === 'read' ? 'botHome.read' : status === 'sent' ? 'botHome.delivered' : 'botHome.sending') : undefined;
  /* 时间和勾放在气泡右下角（Telegram 的做法：正文末尾留一块等宽的占位，真正的时间绝对定位在角上，
     最后一行够短就和文字同行，太长就自动换到下一行）。 */
  const meta = (
    <span className="imsg-meta" title={statusLabel}>
      <time dateTime={message.createdAt}>{row.time}</time>
      {status && <Ticks status={status} />}
      {statusLabel && <span className="sr-only">{statusLabel}</span>}
    </span>
  );
  const gap = <span className="imsg-meta-gap" data-mine={mine || undefined} aria-hidden="true" />;

  let body;
  if (message.kind === 'progress') {
    // 进度用「正在输入」的三点气泡，正文是 Bot 当前在做的事。
    body = (
      <div className="imsg-bubble imsg-bubble--typing" role="status" aria-label={message.content || t('botHome.typingShort')}>
        <span className="imsg-typing" aria-hidden="true"><i /><i /><i /></span>
        {message.content && <span className="imsg-typing__text">{message.content}</span>}
      </div>
    );
  } else if (message.kind === 'attachment') {
    const file = parseAttachment(message.content, t('botHome.attachment'));
    let download: string | undefined;
    try {
      const attachment = JSON.parse(message.content);
      if (projectId && attachment.projectId === projectId && typeof attachment.projectPath === 'string') download = serverClient.projectDownloadUrl(projectId, attachment.projectPath);
      else if (!projectId && typeof attachment.fileId === 'string') download = serverClient.fileDownloadUrl(attachment.fileId);
    } catch { /* The message may be a plain-text attachment description. */ }
    body = (
      <div className="imsg-bubble imsg-bubble--file">
        <span className="imsg-file__icon" aria-hidden="true">
          {file.uploading ? <Spinner size="sm" color="current" /> : <Sym name="description" />}
        </span>
        {download ? <a className="imsg-file__name" href={download} download>{file.name}</a> : <span className="imsg-file__name">{file.name}</span>}
        <span className="imsg-file__size">{formatBytes(file.size)}{gap}</span>
        {meta}
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
      <div className="imsg-bubble imsg-bubble--rich" onDoubleClick={pending ? undefined : () => onReact(message.id)}>
        <Suspense fallback={<p className="imsg-text">{message.content}</p>}>
          <BotRich content={message.content} />
        </Suspense>
        <div className="imsg-meta-row">{meta}</div>
      </div>
    );
  } else {
    body = (
      <div className="imsg-bubble" onDoubleClick={mine || pending ? undefined : () => onReact(message.id)}>
        <p className="imsg-text">{message.content}{gap}</p>
        {meta}
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
      {row.lastMine && status && status !== 'sending' && <div className="imsg-receipt" data-status={status}>{statusLabel}</div>}
    </>
  );
});

/* ─────────────────────────── 页面 ─────────────────────────── */

const EMPTY: MessageDto[] = [];

export default function BotWorkspace() {
  const { projectId } = useParams();
  return <Workspace key={projectId ?? 'bots'} projectId={projectId} />;
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

function Workspace({ projectId }: { projectId?: string }) {
  const { t, i18n } = useTranslation();
  const { t: ts } = useTranslation('settings');
  const { t: tp } = useTranslation('projects');
  const locale = i18n.language;
  const navigate = useNavigate();
  const location = useLocation();
  const [search, setSearch] = useSearchParams();
  const initialThreadId = useRef(search.get('thread'));
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
  const nav = useAppNav(projectId ? 'projects' : 'bot');
  const appMenuItems = useAppMenuActions();
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
  const [uploadBusy, setUploadBusy] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement>(null);
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
    const grouped = groupMessages(messages, locale, { running: activeRunning });
    // Bot 在处理、又还没发出进度时，补一枚「正在输入」气泡，像对面的人在打字。
    const tail = messages[messages.length - 1];
    if (activeRunning && tail && tail.kind !== 'progress') {
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
      .catch((e) => { if (!ignore) setConnectError(e instanceof ServerApiError ? e.code : t('botHome.offline')); });
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

  /* 滚动时浮出当前这一天的日期（Telegram 的 sticky date）。虚拟列表里 position: sticky 用不了，
     所以滚动时找到最上面那一行，读它的 data-day；停下一秒后淡出。 */
  const [floatDay, setFloatDay] = useState<string | null>(null);
  const floatTimer = useRef(0);
  const floatFrame = useRef(0);
  const onScrollDate = useCallback((el: HTMLDivElement) => {
    cancelAnimationFrame(floatFrame.current);
    floatFrame.current = requestAnimationFrame(() => {
      const top = el.getBoundingClientRect().top + 8;
      const hit = [...el.querySelectorAll<HTMLElement>('.imsg-row[data-day]')].find(row => row.getBoundingClientRect().bottom > top);
      setFloatDay(el.scrollTop > 24 ? hit?.dataset.day ?? null : null);
      window.clearTimeout(floatTimer.current);
      floatTimer.current = window.setTimeout(() => setFloatDay(null), 1200);
    });
  }, []);
  useEffect(() => () => { window.clearTimeout(floatTimer.current); cancelAnimationFrame(floatFrame.current); }, []);

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
    setSearch({ thread: thread.id }, { replace: true });
    return thread;
  };
  const leaveFiles = () => { if (filesOpen) navigate(`/projects/${projectId}`); };
  const newDraft = () => { setActiveId(null); setSearch({}, { replace: true }); };
  /** 和某个 Bot 开始一段新对话：落在它的问候页。 */
  const startWith = (id: string) => { setAgentId(id); newDraft(); leaveFiles(); setPane('chat'); };
  const openThread = (thread: ThreadDto) => {
    setActiveId(thread.id);
    if (thread.agentId) setAgentId(thread.agentId);
    setPane('chat');
    if (filesOpen) navigate(`/projects/${projectId}?thread=${thread.id}`);
    else setSearch({ thread: thread.id }, { replace: true });
  };

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
    if (!canChat || !draft.trim() || sendLock.current || (activeId && !active)) return;
    sendLock.current = true; setSendBusy(true);
    const content = draft.trim();
    const nonce = crypto.randomUUID();
    const sourceKey = draftKey;
    let targetId: string | undefined;
    let pending: MessageDto | undefined;
    try {
      const target = active ?? await create();
      if (!target) return;
      targetId = target.id;
      pending = appendPending(target.id, 'text', content, nonce);
      setDrafts(old => ({ ...old, [sourceKey]: '' }));
      settlePending(target.id, pending.id, await serverClient.sendMessage(target.id, content, nonce));
      setRunning(old => ({ ...old, [target.id]: true }));
      if (target.title === tp('newTitle')) {
        const updated = await serverClient.updateThread(target.id, { title: content.slice(0, 60) }).catch(() => null);
        if (updated) mergeThread(updated);
      }
    } catch (error) {
      if (targetId && pending) settlePending(targetId, pending.id, null);
      setDrafts(old => ({ ...old, [targetId ?? sourceKey]: content }));
      toast.error(projectError(error));
    } finally { sendLock.current = false; setSendBusy(false); }
  };

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !canChat) return;
    setUploadBusy(true);
    const nonce = crypto.randomUUID();
    let active: { id: string } | null = null;
    try { active = (activeId ? details[activeId] : null) ?? await create(); }
    catch (error) { toast.error(projectError(error)); }
    if (!active) { setUploadBusy(false); return; }
    const pending = appendPending(active.id, 'attachment', JSON.stringify({ originalName: file.name, sizeBytes: file.size, uploading: true }), nonce);
    try {
      let content: string;
      if (projectId) {
        const uploaded = await serverClient.uploadProjectFile(projectId, file.name, file);
        content = JSON.stringify({ projectId, projectPath: uploaded.path, originalName: file.name, sizeBytes: file.size });
      } else {
        const uploaded = await serverClient.uploadFile(file);
        content = JSON.stringify({ fileId: uploaded.id, originalName: uploaded.originalName, mimeType: uploaded.mimeType, sizeBytes: uploaded.sizeBytes, sha256: uploaded.sha256 });
      }
      settlePending(active.id, pending.id, await serverClient.sendAttachment(active.id, content, nonce));
    } catch (error) {
      settlePending(active.id, pending.id, null);
      toast.error(projectError(error));
    } finally {
      setUploadBusy(false);
    }
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

  if (!status) {
    return (
      <PageShell title="Bot" rail={nav}>
        <div className="bot-center">
          {connectError ? <p className="bot-center__error">{connectError}</p> : <Spinner size="lg" color="current" />}
        </div>
      </PageShell>
    );
  }

  if (!session?.authenticated) {
    return (
      <PageShell title="Bot" rail={nav}>
        <AccessForm initialized={status.initialized} onDone={reload} />
      </PageShell>
    );
  }

  /* ── 菜单 ── */

  const accountActions: MenuAction[] = [
    { key: 'passkey', label: t('botHome.passkey'), icon: <Sym name="key" />, onAction: () => void addPasskey() },
    { key: 'logout', label: t('botHome.logout'), icon: <Sym name="key_off" />, danger: true, onAction: () => void logout() },
  ];
  const runActions: MenuAction[] = [
    { key: 'stop', label: t('botHome.stop'), icon: <Sym name="stop" />, disabled: !active, onAction: () => void stop() },
    ...(!projectId && cloud.enabled ? [{ key: 'permissions', label: t('botHome.permissions'), icon: <Sym name="tune" />, onAction: () => openSettings('data') }] : []),
    ...(!projectId ? [{ key: 'mcp', label: ts('mcp.scope'), icon: <Sym name="extension" />, disabled: !active, onAction: () => setMcpOpen(true) }] : []),
  ];
  const threadMenu: MenuAction[] = activeSummary ? [
    { key: 'rename', label: tp('rename'), icon: <Sym name="edit" />, onAction: () => void editThread(activeSummary, 'rename') },
    { key: 'archive', label: tp(activeSummary.archived ? 'restore' : 'archive'), icon: <Sym name={activeSummary.archived ? 'archive_restore' : 'archive'} />, onAction: () => void editThread(activeSummary, 'archive') },
    ...runActions,
    { key: 'delete', label: tp('delete'), icon: <Sym name="delete" />, danger: true, onAction: () => void editThread(activeSummary, 'delete') },
  ] : [];

  const landing = !activeId && !filesOpen;
  const chatTitle = filesOpen ? tp('files') : currentAgent?.name ?? '';

  /* ── 对话区（两种模式共用） ── */

  const conversation = filesOpen ? (project && <div className="bh-files"><ProjectFiles key={project.id} project={project} /></div>) : <>
    <div className="bh-scroll-wrap">
      {floatDay && <div className="imsg-float-date" aria-hidden="true"><span>{floatDay}</span></div>}
      <div
        ref={scrollRef}
        className="bot-messages"
        aria-live="polite"
        onScroll={(event) => {
          const el = event.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
          onScrollDate(el);
        }}
      >
        {listLoading ? <div className="bot-center"><Spinner color="current" /></div> : landing ? (
          <div className="bh-hello">
            {projectId && !availableAgents.length ? <p className="bh-hello__note">{tp('noAgent')}</p> : <>
              <BotAvatar agent={currentAgent} size={narrow ? 96 : 112} className="bh-hello__avatar" />
              <p className="bh-hello__name">{currentAgent?.name}</p>
              <p className="bh-hello__note">{t(projectId ? 'botHome.projectPurpose' : 'botHome.purpose')}</p>
              {!projectId && <Button variant="ghost" size="sm" onPress={() => navigate('/course-chat')}>{t('botHome.courseLink')}</Button>}
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
      className="bot-composer"
      ariaLabel={t('botHome.composer')}
      placeholder={project?.archived ? tp('readOnly') : t('botHome.taskPlaceholder')}
      value={draft}
      onChange={setDraft}
      onSubmit={() => void send()}
      disabled={!canChat || sendBusy || Boolean(activeId && !active)}
      busy={activeRunning}
      onStop={() => void stop()}
      onAttach={() => uploadInputRef.current?.click()}
      attachBusy={uploadBusy}
      attachLabel={t('botHome.attach')}
    />
    <input ref={uploadInputRef} className="bot-hidden-file" type="file" aria-label={t('botHome.attach')} onChange={upload} disabled={!canChat || uploadBusy} />
  </>;

  const modals = <>
    {settingsOpen && project && <ProjectSettings project={project} agents={agents} onChange={next => { setProject(next); const first = next.grants.find(g => agents.some(a => a.id === g.agentId && a.enabled)); if (!next.grants.some(g => g.agentId === agentId)) setAgentId(first?.agentId ?? ''); }} onClose={() => setSettingsOpen(false)} />}
    <Modal.Root isOpen={mcpOpen} onOpenChange={setMcpOpen}><Modal.Backdrop><Modal.Container size="md" className={MODAL_CONTAINER_CLASS}><Modal.Dialog>
      <Modal.Header><Modal.Heading>{ts('mcp.scope')}</Modal.Heading></Modal.Header>
      <Modal.Body>{mcpOpen && activeId ? <BotMcpScope key={activeId} threadId={activeId} /> : null}</Modal.Body>
      <Modal.Footer><Button onPress={() => setMcpOpen(false)}>{ts('mcp.save')}</Button></Modal.Footer>
    </Modal.Dialog></Modal.Container></Modal.Backdrop></Modal.Root>
  </>;

  /* ── 聊天模式：只有一条对话 ── */

  if (chatMode) {
    return (
      <ModeShell mode="chat">
        <section className="bh-chat bh-chat--solo" data-landing={landing || undefined} aria-label={chatTitle ? t('botHome.conversation', { name: chatTitle }) : undefined}>
          <header className="bh-chat__bar">
            <div className="bh-chat__side">
              <span className="ms-mobile-only"><BotAvatar agent={currentAgent} size={30} /></span>
            </div>
            <div className="bh-chat__center">
              <ModeSwitch mode="chat" />
              {!landing && (
                <h1 className="bh-chat__who ms-desktop-only">
                  <BotAvatar agent={currentAgent} size={28} />
                  <span className="bh-chat__name">{chatTitle}</span>
                </h1>
              )}
            </div>
            <div className="bh-chat__side bh-chat__side--end">
              <span className="ms-desktop-only"><MoreMenu label={t('botHome.more')} actions={[...runActions, ...accountActions]} testId="bh-chat-more" /></span>
              <span className="ms-mobile-only"><AppMenu extra={[...runActions, ...accountActions]} /></span>
            </div>
          </header>
          {conversation}
        </section>
        {modals}
      </ModeShell>
    );
  }

  /* ── 项目模式：左边会话列表，右边对话或文件 ── */

  const listMenu: MenuAction[] = [
    { key: 'archived', label: t(showArchived ? 'botHome.hideArchived' : 'botHome.showArchived'), icon: <Sym name="archive" />, onAction: () => setShowArchived(v => !v) },
    ...accountActions,
  ];

  const listPane = (
    <aside className="bh-list" data-testid="nav-rail" aria-label={t('botHome.listLabel')} inert={narrow && pane === 'chat'}>
      <header className="bh-list__bar">
        <Button isIconOnly variant="ghost" className="bh-icon-btn bh-back" aria-label={tp('back')} onPress={() => navigate('/projects')}>
          <Sym name="chevron_left" />
        </Button>
        <div className="flex-1" />
        <Button isIconOnly variant="ghost" className="bh-icon-btn" aria-label={tp('settings')} isDisabled={!project} onPress={() => setSettingsOpen(true)}>
          <Sym name="tune" />
        </Button>
        <MoreMenu label={t('botHome.more')} actions={narrow ? [...listMenu, ...appMenuItems] : listMenu} testId="bh-list-more" />
        <Button isIconOnly variant="ghost" className="bh-icon-btn" aria-label={t('botHome.compose')} isDisabled={sendBusy || project?.archived || !availableAgents.length} onPress={() => startWith(currentAgentId || availableAgents[0]?.id || '')}>
          <Sym name="edit" />
        </Button>
      </header>
      <h1 className="bh-list__title" data-testid="page-title">{project?.name ?? ''}</h1>

      <div className="bh-segment" role="group">
        <Button size="sm" variant="ghost" className="bh-segment__item" data-active={!filesOpen || undefined} onPress={() => { navigate(`/projects/${projectId}${activeId ? `?thread=${activeId}` : ''}`); setPane('chat'); }}>{tp('chat')}</Button>
        <Button size="sm" variant="ghost" className="bh-segment__item" data-active={filesOpen || undefined} onPress={() => { navigate(`/projects/${projectId}/files`); setPane('chat'); }}>{tp('files')}</Button>
      </div>

      {/* 项目里可以选和哪个 Bot 开新会话：一排头像，像「信息」置顶的联系人。 */}
      {availableAgents.length > 1 && (
        <div className="bh-pins" role="group" aria-label={t('botHome.contacts')}>
          {availableAgents.map(agent => (
            <Button key={agent.id} variant="ghost" className="bh-pin" aria-pressed={!activeId && !filesOpen && agent.id === agentId}
              data-current={agent.id === currentAgentId || undefined} onPress={() => startWith(agent.id)}>
              <BotAvatar agent={agent} size={narrow ? 64 : 52} />
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
            /* 手机上列表是单独一屏，不留选中高亮（和 iOS 一样），再点同一条也能推进去。 */
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
                  <BotAvatar agent={agent} size={44} />
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
      <header className="bh-chat__bar">
        <div className="bh-chat__side">
          {narrow && (
            <Button isIconOnly variant="ghost" className="bh-icon-btn bh-back" aria-label={t('botHome.back')} onPress={() => setPane('list')}>
              <Sym name="chevron_left" />
            </Button>
          )}
        </div>
        {!landing && (
          <h2 className="bh-chat__who">
            {!filesOpen && <BotAvatar agent={currentAgent} size={narrow ? 32 : 28} />}
            <span className="bh-chat__name">{chatTitle}</span>
          </h2>
        )}
        <div className="bh-chat__side bh-chat__side--end">
          {threadMenu.length > 0 && !filesOpen && <MoreMenu label={t('botHome.more')} actions={threadMenu} testId="bh-thread-more" />}
        </div>
      </header>
      {conversation}
    </section>
  );

  return (
    <ModeShell mode="projects">
      <div className="bh" data-pane={pane} data-narrow={narrow || undefined}>
        {listPane}
        {chatPane}
        {modals}
      </div>
    </ModeShell>
  );
}
