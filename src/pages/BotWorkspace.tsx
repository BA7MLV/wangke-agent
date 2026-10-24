import { memo, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import {
  Button,
  Dropdown,
  Input,
  Label,
  Spinner,
  TextField,
  cn,
} from '@heroui/react';
import { PageShell, Sym, toast, type RecentItem } from '../ui';
import { useAppNav } from '../components/appNav';
import { serverClient, ServerApiError, type ApprovalDto, type ThreadDetail, type Session } from '../api/serverClient';
import type { MessageDto, SseEvent, ThreadDto } from '@wangke/contracts';
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import MessageComposer from '../components/MessageComposer';
import VirtualMessages from '../components/VirtualMessages';
import { groupMessages, timeOf, type Row } from './botMessages';
import './bot-workspace.css';

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
}: {
  row: Row;
  approval?: ApprovalDto;
  onReact: (messageId: string) => void;
  onResolve: (approvalId: string, approved: boolean) => void;
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
    body = (
      <div className="imsg-bubble imsg-bubble--file">
        <span className="imsg-file__icon" aria-hidden="true">
          {file.uploading ? <Spinner size="sm" color="current" /> : <Sym name="description" />}
        </span>
        <span className="imsg-file__name">{file.name}</span>
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
  const nav = useAppNav('bot');
  const [status, setStatus] = useState<{ initialized: boolean } | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [connectError, setConnectError] = useState('');
  /** 线程列表只拿摘要；详情（消息）只为当前打开的线程拉 —— 原来每次刷新都把所有线程的全部消息拉一遍。 */
  const [threads, setThreads] = useState<ThreadDto[]>([]);
  const [details, setDetails] = useState<Record<string, ThreadDetail>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [uploadBusy, setUploadBusy] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const cursorRef = useRef(0);

  const active = activeId ? details[activeId] ?? null : null;
  const activeSummary = threads.find((thread) => thread.id === activeId) ?? null;
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
    const result = await serverClient.threads();
    const bots = result.threads.filter((thread) => thread.mode === 'bot');
    setThreads(bots);
    setActiveId((id) => id && bots.some((thread) => thread.id === id) ? id : bots[0]?.id ?? null);
  }, []);

  useEffect(() => {
    void Promise.all([serverClient.bootstrapStatus(), serverClient.session()])
      .then(([nextStatus, nextSession]) => {
        setStatus(nextStatus);
        setSession(nextSession);
        if (nextSession.authenticated) void refresh();
      })
      .catch((e) => setConnectError(e instanceof ServerApiError ? e.code : '连不上 Bot 服务'));
  }, [refresh]);

  // 打开线程时才拉它的消息。
  useEffect(() => {
    if (!activeId || details[activeId]) return;
    let cancelled = false;
    void serverClient.thread(activeId).then((detail) => {
      if (!cancelled) setDetails((old) => ({ ...old, [activeId]: detail }));
    }).catch(() => toast.error('线程加载失败'));
    return () => { cancelled = true; };
  }, [activeId, details]);

  // 事件流：每个线程独立游标，切换时从 0 回放（服务端按 message.id 去重）。
  const activeLoaded = Boolean(active);
  useEffect(() => {
    // 等详情到手再开事件流，否则详情请求在路上时到达的事件会被丢掉。
    if (!activeId || !activeLoaded || !session?.authenticated) return;
    const controller = new AbortController();
    let stopped = false;
    cursorRef.current = 0;
    const receive = (event: SseEvent, id: number) => {
      cursorRef.current = Math.max(cursorRef.current, id);
      if (!('message' in event)) return;
      patchActive(activeId, (thread) => thread.messages.some((message) => message.id === event.message.id)
        ? { ...thread, messages: thread.messages.map((message) => message.id === event.message.id ? event.message : message) }
        : { ...thread, messages: [...thread.messages, event.message].sort((a, b) => a.seq - b.seq) });
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
  }, [activeId, activeLoaded, session?.authenticated, patchActive]);

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
    try {
      const thread = await serverClient.createThread('新的 Bot 任务');
      setThreads((old) => [thread, ...old]);
      setDetails((old) => ({ ...old, [thread.id]: { ...thread, messages: [] } }));
      setActiveId(thread.id);
    } catch {
      toast.error('新建线程失败');
    }
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

  const send = async () => {
    if (!active || !draft.trim()) return;
    const content = draft.trim();
    const nonce = crypto.randomUUID();
    const pending = appendPending(active.id, 'text', content, nonce);
    setDraft('');
    try {
      settlePending(active.id, pending.id, await serverClient.sendMessage(active.id, content, nonce));
    } catch {
      settlePending(active.id, pending.id, null);
      setDraft(content);
      toast.error('没发出去，内容已放回输入框');
    }
  };

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!active || !file) return;
    setUploadBusy(true);
    const nonce = crypto.randomUUID();
    const pending = appendPending(active.id, 'attachment', JSON.stringify({ originalName: file.name, sizeBytes: file.size, uploading: true }), nonce);
    try {
      const uploaded = await serverClient.uploadFile(file);
      const content = JSON.stringify({ fileId: uploaded.id, originalName: uploaded.originalName, mimeType: uploaded.mimeType, sizeBytes: uploaded.sizeBytes, sha256: uploaded.sha256 });
      settlePending(active.id, pending.id, await serverClient.sendAttachment(active.id, content, nonce));
    } catch {
      settlePending(active.id, pending.id, null);
      toast.error('附件上传失败');
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

  const recent: RecentItem[] = useMemo(() => threads.map((thread) => ({
    id: thread.id,
    label: thread.title || '未命名任务',
    active: thread.id === activeId,
    onClick: () => setActiveId(thread.id),
  })), [threads, activeId]);

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
      title={activeSummary?.title || 'Bot'}
      rail={nav}
      recent={{ label: 'Bot 线程', items: recent }}
      actions={(
        <div className="bot-toolbar">
          <Button isIconOnly variant="tertiary" size="sm" aria-label="新建线程" onPress={() => void create()}>
            <Sym name="edit" />
          </Button>
          <Dropdown>
            <Button isIconOnly variant="tertiary" size="sm" aria-label="更多">
              <Sym name="more_horiz" />
            </Button>
            <Dropdown.Popover placement="bottom end">
              <Dropdown.Menu
                aria-label="Bot 操作"
                disabledKeys={active ? [] : ['stop']}
                onAction={(key) => {
                  if (key === 'stop') void stop();
                  else if (key === 'passkey') void addPasskey();
                  else if (key === 'logout') void logout();
                }}
              >
                <Dropdown.Item id="stop" textValue="停止当前任务"><Sym name="stop" />停止当前任务</Dropdown.Item>
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
      <section className="bot-conversation" aria-label="Bot 对话">
        <div
          ref={scrollRef}
          className="bot-messages"
          aria-live="polite"
          onScroll={(event) => {
            const el = event.currentTarget;
            stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
          }}
        >
          {!threads.length ? (
            <div className="bot-center">
              <Button variant="primary" onPress={() => void create()}>
                <Sym name="edit" />
                新建线程
              </Button>
            </div>
          ) : !active ? (
            <div className="bot-center"><Spinner color="current" /></div>
          ) : (
            <VirtualMessages items={rows} scrollRef={scrollRef} onResize={followEnd} key={active.id}>
              {(row) => (
                <Bubble
                  row={row}
                  approval={approvalByMessage.get(row.message.id)}
                  onReact={react}
                  onResolve={resolveApproval}
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
          disabled={!active}
          onAttach={() => uploadInputRef.current?.click()}
          attachBusy={uploadBusy}
        />
        <input ref={uploadInputRef} className="bot-hidden-file" type="file" aria-label="添加附件" onChange={upload} disabled={!active || uploadBusy} />
      </section>
    </PageShell>
  );
}
