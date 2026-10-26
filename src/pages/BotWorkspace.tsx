import { memo, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Button,
  Dropdown,
  Input,
  Modal,
  Label,
  Spinner,
  TextField,
  cn,
} from '@heroui/react';
import { PageShell, Sym, toast, promptDialog, confirmDialog, type RecentItem } from '../ui';
import { useAppNav } from '../components/appNav';
import { serverClient, ServerApiError, type ApprovalDto, type ThreadDetail, type Session } from '../api/serverClient';
import type { AgentProfileDto, MessageDto, ProjectDetailDto, SseEvent, ThreadDto } from '@wangke/contracts';
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import MessageComposer from '../components/MessageComposer';
import VirtualMessages from '../components/VirtualMessages';
import { groupMessages, timeOf, type Row } from './botMessages';
import './bot-workspace.css';
import BotMcpScope from '../mcp/BotMcpScope';
import { MODAL_CONTAINER_CLASS } from '../ui/modalContainer';
import { useTranslation } from 'react-i18next';
import ProjectSettings from '../projects/ProjectSettings';
import ProjectFiles from '../projects/ProjectFiles';
import { projectError } from '../projects/errors';
import '../projects/projects.css';

function parseAttachment(content: string): { name: string; size?: number; uploading?: boolean } {
  try {
    const value = JSON.parse(content) as { originalName?: unknown; sizeBytes?: unknown; uploading?: unknown };
    return {
      name: typeof value.originalName === 'string' ? value.originalName : '附件',
      size: typeof value.sizeBytes === 'number' ? value.sizeBytes : undefined,
      uploading: value.uploading === true,
    };
  } catch {
    return { name: content.slice(0, 80) || '附件' };
  }
}

function formatBytes(size?: number) {
  if (size === undefined) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/* ─────────────────────────── 单条气泡 ─────────────────────────── */

const Bubble = memo(function Bubble({
  row,
  approval,
  onReact,
  onResolve,
  projectId,
}: {
  row: Row;
  approval?: ApprovalDto;
  onReact: (messageId: string) => void;
  onResolve: (approvalId: string, approved: boolean) => void;
  projectId?: string;
}) {
  const { message, first, last, stamp } = row;
  const mine = message.role === 'user';
  // 只有刚到的消息播入场动效；虚拟列表滚回来重新挂载的旧消息不再动一遍。
  const [fresh] = useState(() => Date.now() - timeOf(message) < 4000);
  const pending = message.id.startsWith('pending-');

  let body;
  if (message.kind === 'progress') {
    // 进度用「正在输入」的三点气泡，正文是 Bot 当前在做的事。
    body = (
      <div className="imsg-bubble imsg-bubble--typing" role="status">
        <span className="imsg-typing" aria-hidden="true"><i /><i /><i /></span>
        {message.content && <span className="imsg-typing__text">{message.content}</span>}
      </div>
    );
  } else if (message.kind === 'attachment') {
    const file = parseAttachment(message.content);
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
        {file.size !== undefined && <span className="imsg-file__size">{formatBytes(file.size)}</span>}
      </div>
    );
  } else if (message.kind === 'approval' || message.kind === 'question') {
    const waiting = message.kind === 'approval' && approval?.status === 'pending';
    body = (
      <div className="imsg-bubble imsg-bubble--action">
        <p className="imsg-text">{message.content}</p>
        {waiting && approval && (
          <div className="imsg-actions">
            <Button size="sm" variant="secondary" onPress={() => onResolve(approval.id, false)}>拒绝</Button>
            <Button size="sm" variant="primary" onPress={() => onResolve(approval.id, true)}>批准</Button>
          </div>
        )}
        {approval && approval.status !== 'pending' && (
          <span className="imsg-resolved" data-status={approval.status}>
            <Sym name={approval.status === 'approved' ? 'check' : 'close'} />
            {approval.status === 'approved' ? '已批准' : '已拒绝'}
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
  } else {
    body = (
      <div className="imsg-bubble" onDoubleClick={mine || pending ? undefined : () => onReact(message.id)}>
        <p className="imsg-text">{message.content}</p>
      </div>
    );
  }

  return (
    <>
      {stamp && <div className="imsg-stamp">{stamp}</div>}
      <div
        className={cn('imsg-row', mine ? 'imsg-row--mine' : 'imsg-row--theirs')}
        data-first={first || undefined}
        data-last={last || undefined}
        data-pending={pending || undefined}
        data-fresh={fresh || undefined}
      >
        {body}
      </div>
    </>
  );
});

/* ─────────────────────────── 登录 / 初始化 ─────────────────────────── */

function passkeyError(error: unknown, action: '登录' | '注册') {
  if (error instanceof ServerApiError && error.code === 'webauthn_not_configured') return 'Passkey 当前不可用';
  if ((error instanceof DOMException || error instanceof Error) && error.name === 'NotAllowedError') return `Passkey ${action}已取消`;
  return `Passkey ${action}失败，请稍后重试`;
}

const errorText: Record<string, string> = {
  invalid_credentials: '用户名或密码不对',
  invalid_or_expired_bootstrap_secret: '安装 secret 无效或已过期',
  admin_password_must_be_12_to_256_characters: '密码至少 12 位',
  bootstrap_closed: '已经初始化过了，请直接登录',
};

function AccessForm({ initialized, onDone }: { initialized: boolean; onDone: () => void }) {
  const [username, setUsername] = useState('Administrator');
  const [password, setPassword] = useState('');
  const [secret, setSecret] = useState('');
  const [name, setName] = useState('Administrator');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const secretFileRef = useRef<HTMLInputElement>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (!initialized) await serverClient.bootstrapInitialize(password, secret, name);
      else await serverClient.login(username, password);
      onDone();
    } catch (e) {
      setError(e instanceof ServerApiError ? errorText[e.code] ?? e.code : '连不上服务');
    } finally {
      setBusy(false);
    }
  };

  const passkeyLogin = async () => {
    if (!browserSupportsWebAuthn()) {
      setError('这个浏览器不支持 Passkey');
      return;
    }
    setPasskeyBusy(true);
    setError('');
    try {
      const optionsJSON = await serverClient.passkeyLoginOptions();
      const response = await startAuthentication({ optionsJSON });
      await serverClient.passkeyLoginVerify(response);
      onDone();
    } catch (e) {
      setError(passkeyError(e, '登录'));
    } finally {
      setPasskeyBusy(false);
    }
  };

  const readSecret = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) setSecret((await file.text()).trim());
    event.target.value = '';
  };

  return (
    <div className="bot-access">
      <form className="bot-access__form" onSubmit={submit} data-shake={error ? 'true' : undefined} key={error}>
        <div className="bot-access__icon" aria-hidden="true"><Sym name="smart_toy" /></div>
        <h2 className="bot-access__title">{initialized ? '登录' : '创建管理员'}</h2>

        <div className="bot-access__group">
          {!initialized ? (
            <>
              <TextField fullWidth>
                <Label className="sr-only">管理员名称</Label>
                <Input placeholder="管理员名称" value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" />
              </TextField>
              <TextField fullWidth>
                <Label className="sr-only">安装 secret</Label>
                <div className="bot-access__secret">
                  <Input type="password" placeholder="安装 secret" value={secret} onChange={(event) => setSecret(event.target.value)} autoComplete="off" required />
                  <Button type="button" isIconOnly size="sm" variant="tertiary" aria-label="从文件读取 secret" onPress={() => secretFileRef.current?.click()}>
                    <Sym name={secret ? 'check' : 'upload'} />
                  </Button>
                </div>
              </TextField>
              <input ref={secretFileRef} className="bot-hidden-file" type="file" accept=".txt,.env" aria-label="从文件读取 secret" onChange={readSecret} />
            </>
          ) : (
            <TextField fullWidth>
              <Label className="sr-only">用户名</Label>
              <Input placeholder="用户名" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" />
            </TextField>
          )}
          <TextField fullWidth>
            <Label className="sr-only">密码</Label>
            <Input
              type="password"
              placeholder={initialized ? '密码' : '密码（至少 12 位）'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={initialized ? 'current-password' : 'new-password'}
              required
            />
          </TextField>
        </div>

        {error && <p className="bot-access__error" role="alert">{error}</p>}

        <Button type="submit" variant="primary" fullWidth isDisabled={busy || passkeyBusy}>
          {busy ? <Spinner size="sm" color="current" /> : initialized ? '登录' : '继续'}
        </Button>
        {initialized && (
          <Button type="button" variant="tertiary" fullWidth onPress={() => void passkeyLogin()} isDisabled={busy || passkeyBusy}>
            {passkeyBusy ? <Spinner size="sm" color="current" /> : <Sym name="key" />}
            使用 Passkey
          </Button>
        )}
      </form>
    </div>
  );
}

/* ─────────────────────────── 页面 ─────────────────────────── */

const EMPTY: MessageDto[] = [];

export default function BotWorkspace() {
  const { projectId } = useParams();
  return <Workspace key={projectId ?? 'bots'} projectId={projectId} />;
}

function Workspace({ projectId }: { projectId?: string }) {
  const { t } = useTranslation('settings');
  const { t: tp } = useTranslation('projects');
  const navigate = useNavigate();
  const location = useLocation();
  const [search, setSearch] = useSearchParams();
  const initialThreadId = useRef(search.get('thread'));
  const filesOpen = Boolean(projectId && location.pathname.endsWith('/files'));
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
  const [status, setStatus] = useState<{ initialized: boolean } | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [connectError, setConnectError] = useState('');
  /** 线程列表只拿摘要；详情（消息）只为当前打开的线程拉 —— 原来每次刷新都把所有线程的全部消息拉一遍。 */
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

  const active = activeId ? details[activeId] ?? null : null;
  const activeSummary = threads.find((thread) => thread.id === activeId) ?? null;
  const availableAgents = agents.filter(agent => agent.enabled && (!projectId || project?.grants.some(g => g.agentId === agent.id)));
  const visibleThreads = threads.filter(thread => (showArchived || !thread.archived) && (projectId || (thread.agentId ?? agents[0]?.id) === agentId));
  const canChat = !listLoading && !listError && !project?.archived && !activeSummary?.archived && availableAgents.some(a => a.id === (activeSummary?.agentId ?? agentId));
  const messages = active?.messages ?? EMPTY;
  const rows = useMemo(() => groupMessages(messages), [messages]);
  const approvalByMessage = useMemo(() => {
    const map = new Map<string, ApprovalDto>();
    for (const approval of active?.approvals ?? []) map.set(approval.messageId, approval);
    return map;
  }, [active?.approvals]);

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
      if (requested) { setActiveId(requested.id); setAgentId(requested.agentId ?? firstAgent?.id ?? ''); if (requested.archived) setShowArchived(true); }
      else setAgentId(id => id && profiles.agents.some(a => a.id === id) ? id : firstAgent?.id ?? '');
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
      .catch((e) => { if (!ignore) setConnectError(e instanceof ServerApiError ? e.code : '连不上 Bot 服务'); });
    return () => { ignore = true; loadVersion.current++; };
  }, [refresh]);

  // 打开线程时才拉它的消息。
  useEffect(() => {
    if (!activeId || details[activeId]) return;
    let cancelled = false;
    setDetailError('');
    void serverClient.thread(activeId).then((detail) => {
      if (!cancelled) setDetails((old) => ({ ...old, [activeId]: detail }));
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
    setSearch({ thread: thread.id }, { replace: true });
    return thread;
  };
  const newDraft = () => { setActiveId(null); setSearch({}, { replace: true }); };

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
      if (target.title === tp('newTitle')) {
        const updated = await serverClient.updateThread(target.id, { title: content.slice(0, 60) }).catch(() => null);
        if (updated) setThreads(old => old.map(thread => thread.id === updated.id ? updated : thread));
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
    if (!active || !file) return;
    setUploadBusy(true);
    const nonce = crypto.randomUUID();
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
      toast.error('没能点赞');
    }
  }, []);

  const resolveApproval = useCallback(async (approvalId: string, approved: boolean) => {
    if (!activeId) return;
    try {
      const resolved = await serverClient.resolveApproval(approvalId, approved);
      patchActive(activeId, (thread) => ({ ...thread, approvals: thread.approvals?.map((approval) => approval.id === approvalId ? resolved : approval) }));
    } catch {
      toast.error('审批没有提交成功');
    }
  }, [activeId, patchActive]);

  const stop = async () => {
    if (!active) return;
    try {
      const result = await serverClient.stopThread(active.id);
      toast.info(result.stopped ? '已停止' : '没有正在运行的任务');
    } catch {
      toast.error('停止失败');
    }
  };

  const addPasskey = async () => {
    if (!browserSupportsWebAuthn()) { toast.error('这个浏览器不支持 Passkey'); return; }
    try {
      const optionsJSON = await serverClient.passkeyRegisterOptions();
      const response = await startRegistration({ optionsJSON });
      await serverClient.passkeyRegisterVerify(response);
      toast.success('Passkey 已添加');
    } catch (e) {
      toast.error(passkeyError(e, '注册'));
    }
  };

  const logout = async () => {
    try {
      await serverClient.logout();
      setSession({ authenticated: false, user: null });
      setThreads([]);
      setDetails({});
    } catch {
      toast.error('退出失败');
    }
  };

  const editThread = async (thread: ThreadDto, action: 'rename' | 'archive' | 'delete') => {
    try {
      if (action === 'delete') {
        if (!await confirmDialog({ headline: tp('deleteConfirm', { name: thread.title }), description: tp('sessionDeleteHint'), confirmText: tp('delete'), cancelText: tp('cancel'), danger: true })) return;
        await serverClient.deleteThread(thread.id);
        setThreads(old => old.filter(row => row.id !== thread.id));
        if (activeId === thread.id) newDraft();
        setDetails(old => { const next = { ...old }; delete next[thread.id]; return next; });
        return;
      }
      let title: string | null = null;
      if (action === 'rename') {
        title = await promptDialog({ headline: tp('rename'), defaultValue: thread.title ?? '', confirmText: tp('save'), cancelText: tp('cancel') });
        if (!title) return;
      }
      const updated = await serverClient.updateThread(thread.id, title ? { title } : { archived: !thread.archived });
      setThreads(old => old.map(row => row.id === thread.id ? updated : row));
      patchActive(thread.id, detail => ({ ...detail, ...updated }));
      if (updated.archived && activeId === thread.id) newDraft();
    } catch (error) { toast.error(projectError(error)); }
  };
  const recent: RecentItem[] = visibleThreads.map((thread) => ({
    id: thread.id,
    label: `${thread.archived ? `${tp('archived')} · ` : ''}${thread.title || tp('newTitle')}`,
    active: thread.id === activeId,
    onClick: () => { setActiveId(thread.id); setSearch({ thread: thread.id }, { replace: true }); if (filesOpen) navigate(`/projects/${projectId}?thread=${thread.id}`); },
    menu: [
      { key: 'rename', label: tp('rename'), icon: <Sym name="edit" />, onAction: () => void editThread(thread, 'rename') },
      { key: 'archive', label: tp(thread.archived ? 'restore' : 'archive'), icon: <Sym name="archive" />, onAction: () => void editThread(thread, 'archive') },
      { key: 'delete', label: tp('delete'), icon: <Sym name="delete" />, danger: true, onAction: () => void editThread(thread, 'delete') },
    ],
  }));
  const createAgent = async () => {
    const name = await promptDialog({ headline: tp('newBot'), placeholder: tp('name'), confirmText: tp('save'), cancelText: tp('cancel') });
    if (!name) return;
    try { const agent = await serverClient.createAgent({ name }); setAgents(old => [...old, agent]); setAgentId(agent.id); newDraft(); }
    catch (error) { toast.error(projectError(error)); }
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

  return (
    <PageShell
      title={project?.name ?? activeSummary?.title ?? tp('botChat')}
      subtitle={projectId ? activeSummary?.title : agents.find(a => a.id === agentId)?.name}
      onBack={projectId ? () => navigate('/projects') : undefined}
      rail={nav}
      recent={{ label: tp(projectId ? 'sessions' : 'botSessions'), items: recent }}
      actions={(
        <div className="bot-toolbar">
          <Button isIconOnly variant="tertiary" size="sm" aria-label={tp('newSession')} isDisabled={sendBusy || project?.archived} onPress={newDraft}>
            <Sym name="edit" />
          </Button>
          <Dropdown>
            <Button isIconOnly variant="tertiary" size="sm" aria-label="更多">
              <Sym name="more_horiz" />
            </Button>
            <Dropdown.Popover placement="bottom end">
              <Dropdown.Menu
                aria-label="Bot 操作"
                disabledKeys={[...(!active ? ['stop', 'mcp'] : []), ...(projectId ? ['mcp'] : [])]}
                onAction={(key) => {
                  if (key === 'stop') void stop();
                  else if (key === 'mcp') setMcpOpen(true);
                  else if (key === 'passkey') void addPasskey();
                  else if (key === 'logout') void logout();
                }}
              >
                <Dropdown.Item id="stop" textValue="停止当前任务"><Sym name="stop" />停止当前任务</Dropdown.Item>
                <Dropdown.Item id="mcp" textValue={t('mcp.scope')}><Sym name="extension" />{t('mcp.scope')}</Dropdown.Item>
                <Dropdown.Item id="passkey" textValue="添加 Passkey"><Sym name="key" />添加 Passkey</Dropdown.Item>
                <Dropdown.Item id="logout" textValue="退出登录" variant="danger"><Sym name="key_off" />退出登录</Dropdown.Item>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
        </div>
      )}
      fill
      rootClassName="bot-page"
    >
      <div className="bot-scope-bar">
        {projectId && <div className="project-tabs"><Button size="sm" variant={!filesOpen ? 'secondary' : 'ghost'} onPress={() => navigate(`/projects/${projectId}${activeId ? `?thread=${activeId}` : ''}`)}>{tp('chat')}</Button><Button size="sm" variant={filesOpen ? 'secondary' : 'ghost'} onPress={() => navigate(`/projects/${projectId}/files`)}>{tp('files')}</Button><Button size="sm" variant="ghost" isDisabled={!project} onPress={() => setSettingsOpen(true)}>{tp('settings')}</Button></div>}
        {!filesOpen && <>
          <label>{tp('bot')}<select aria-label={tp('bot')} value={activeSummary?.agentId ?? agentId} disabled={sendBusy || listLoading} onChange={e => { setAgentId(e.target.value); newDraft(); }}>{availableAgents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
          {!projectId && <Button size="sm" variant="ghost" onPress={() => void createAgent()}>{tp('newBot')}</Button>}
          <label><input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} />{tp('showArchived')}</label>
        </>}
        {project && <p className="project-muted">{tp(project.archived ? 'readOnly' : 'projectOnly')}</p>}
      </div>
      {listError && <div className="project-error" role="alert">{listError}<Button onPress={() => void refresh()}>{tp('retry')}</Button></div>}
      {settingsOpen && project && <ProjectSettings project={project} agents={agents} onChange={next => { setProject(next); const first = next.grants.find(g => agents.some(a => a.id === g.agentId && a.enabled)); if (!next.grants.some(g => g.agentId === agentId)) setAgentId(first?.agentId ?? ''); }} onClose={() => setSettingsOpen(false)} />}
      <Modal.Root isOpen={mcpOpen} onOpenChange={setMcpOpen}><Modal.Backdrop><Modal.Container size="md" className={MODAL_CONTAINER_CLASS}><Modal.Dialog>
        <Modal.Header><Modal.Heading>{t('mcp.scope')}</Modal.Heading></Modal.Header>
        <Modal.Body>{mcpOpen && activeId ? <BotMcpScope key={activeId} threadId={activeId} /> : null}</Modal.Body>
        <Modal.Footer><Button onPress={() => setMcpOpen(false)}>{t('mcp.save')}</Button></Modal.Footer>
      </Modal.Dialog></Modal.Container></Modal.Backdrop></Modal.Root>
      {filesOpen ? project && <ProjectFiles key={project.id} project={project} /> : <section className="bot-conversation" aria-label="Bot 对话">
        <div
          ref={scrollRef}
          className="bot-messages"
          aria-live="polite"
          onScroll={(event) => {
            const el = event.currentTarget;
            stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
          }}
        >
          {listLoading ? <div className="bot-center"><Spinner /></div> : !activeId ? (
            <div className="bot-center">
              <p>{projectId && !availableAgents.length ? tp('noAgent') : tp('newSession')}</p>
            </div>
          ) : !active ? (
            <div className="bot-center">{detailError ? <div className="project-error" role="alert">{detailError}<Button onPress={() => setDetailRevision(v => v + 1)}>{tp('retry')}</Button></div> : <Spinner color="current" />}</div>
          ) : (
            <VirtualMessages items={rows} scrollRef={scrollRef} onResize={followEnd} key={active.id}>
              {(row) => (
                <Bubble
                  row={row}
                  approval={approvalByMessage.get(row.message.id)}
                  onReact={react}
                  onResolve={resolveApproval}
                  projectId={projectId}
                />
              )}
            </VirtualMessages>
          )}
        </div>

        <MessageComposer
          className="bot-composer"
          ariaLabel="Bot 任务内容"
          placeholder="消息"
          value={draft}
          onChange={setDraft}
          onSubmit={() => void send()}
          disabled={!canChat || sendBusy || Boolean(activeId && !active)}
          onAttach={active ? () => uploadInputRef.current?.click() : undefined}
          attachBusy={uploadBusy}
        />
        <input ref={uploadInputRef} className="bot-hidden-file" type="file" aria-label="添加附件" onChange={upload} disabled={!active || !canChat || uploadBusy} />
      </section>}
    </PageShell>
  );
}
