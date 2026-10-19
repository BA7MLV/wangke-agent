import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import {
  Alert,
  Button,
  Card,
  Chip,
  cn,
  EmptyState as HeroEmptyState,
  Input,
  Label,
  Spinner,
  TextArea,
  TextField,
  Typography,
} from '@heroui/react';
import { PageShell, Sym, type RecentItem } from '../ui';
import { useAppNav } from '../components/appNav';
import { serverClient, ServerApiError, type ApprovalDto, type ThreadDetail, type Session } from '../api/serverClient';
import type { MessageDto, SseEvent } from '@wangke/contracts';
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import './bot-workspace.css';

function approvalLabel(status: ApprovalDto['status']): string {
  if (status === 'approved') return '已批准';
  if (status === 'rejected') return '已拒绝';
  return '等待批准';
}

function MessageBody({
  message,
  approval,
  onReact,
  onResolve,
}: {
  message: MessageDto;
  approval?: ApprovalDto;
  onReact: (messageId: string) => void;
  onResolve: (approvalId: string, approved: boolean) => void;
}) {
  if (message.kind === 'attachment') {
    let value: unknown = message.content;
    try {
      value = JSON.parse(message.content);
    } catch {
      // Plain metadata is still safe to render as text.
    }

    return (
      <Card.Root variant="secondary" className="bot-event-card">
        <Card.Header className="bot-event-card__header">
          <div className="bot-event-card__title">
            <span className="bot-event-card__icon" aria-hidden="true"><Sym name="upload" /></span>
            <Card.Title>附件</Card.Title>
          </div>
          <Chip size="sm" variant="soft">文件</Chip>
        </Card.Header>
        <Card.Content>
          <pre className="bot-code-block">{JSON.stringify(value, null, 2).slice(0, 2000)}</pre>
        </Card.Content>
      </Card.Root>
    );
  }

  if (message.kind === 'progress') {
    return (
      <Alert status="accent" className="bot-progress" role="status">
        <Alert.Indicator><Spinner size="sm" color="current" /></Alert.Indicator>
        <Alert.Content>
          <Alert.Title>处理中</Alert.Title>
          <Alert.Description>{message.content}</Alert.Description>
        </Alert.Content>
      </Alert>
    );
  }

  if (message.kind === 'question' || message.kind === 'approval') {
    const isPending = message.kind === 'approval' && approval?.status === 'pending';
    return (
      <Card.Root variant="secondary" className="bot-event-card">
        <Card.Header className="bot-event-card__header">
          <div className="bot-event-card__title">
            <span className="bot-event-card__icon" aria-hidden="true">
              <Sym name={message.kind === 'question' ? 'help' : 'verified'} />
            </span>
            <Card.Title>{message.kind === 'question' ? '需要你的回答' : '需要批准'}</Card.Title>
          </div>
          {message.kind === 'approval' && approval && (
            <Chip
              size="sm"
              variant="soft"
              color={approval.status === 'rejected' ? 'danger' : approval.status === 'approved' ? 'success' : 'accent'}
            >
              {approvalLabel(approval.status)}
            </Chip>
          )}
        </Card.Header>
        <Card.Content>
          <Typography.Paragraph className="bot-event-card__body">{message.content}</Typography.Paragraph>
          {isPending && approval && (
            <div className="bot-card-actions">
              <Button size="sm" variant="primary" onPress={() => onResolve(approval.id, true)}>
                <Sym name="check" />
                批准
              </Button>
              <Button size="sm" variant="danger" onPress={() => onResolve(approval.id, false)}>
                <Sym name="close" />
                拒绝
              </Button>
            </div>
          )}
        </Card.Content>
      </Card.Root>
    );
  }

  if (message.kind === 'widget') {
    return (
      <Card.Root variant="secondary" className="bot-event-card">
        <Card.Header className="bot-event-card__header">
          <div className="bot-event-card__title">
            <span className="bot-event-card__icon" aria-hidden="true"><Sym name="extension" /></span>
            <Card.Title>结构化卡片</Card.Title>
          </div>
          <Chip size="sm" variant="soft">安全预览</Chip>
        </Card.Header>
        <Card.Content>
          <Typography.Paragraph className="bot-event-card__body">此 Bot 版本不会执行任意 widget 内容。</Typography.Paragraph>
          <pre className="bot-code-block">{message.content.slice(0, 1000)}</pre>
        </Card.Content>
      </Card.Root>
    );
  }

  return (
    <div className="bot-text">
      <span>{message.content}</span>
      <Button
        isIconOnly
        size="sm"
        variant="tertiary"
        className="bot-reaction"
        onPress={() => onReact(message.id)}
        aria-label="给这条消息添加赞"
      >
        <span aria-hidden="true">👍</span>
      </Button>
    </div>
  );
}

function passkeyError(error: unknown, action: '登录' | '注册') {
  if (error instanceof ServerApiError && error.code === 'webauthn_not_configured') return 'Passkey 当前不可用';
  if (error instanceof DOMException && error.name === 'NotAllowedError') return `Passkey ${action}已取消`;
  if (error instanceof Error && error.name === 'NotAllowedError') return `Passkey ${action}已取消`;
  return `Passkey ${action}失败，请稍后重试`;
}

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
      setError(e instanceof ServerApiError ? e.code : '网络请求失败');
    } finally {
      setBusy(false);
    }
  };

  const passkeyLogin = async () => {
    if (!browserSupportsWebAuthn()) {
      setError('当前浏览器不支持 Passkey');
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
      <Card.Root className="bot-access-card">
        <Card.Header className="bot-access-card__header">
          <div className="bot-access-card__eyebrow">
            <Chip size="sm" variant="soft" color="accent">本机服务</Chip>
            <span>安全入口</span>
          </div>
          <Card.Title render={(props) => <h2 {...props} />} className="bot-access-card__title">
            {initialized ? '登录 Bot 工作空间' : '首次初始化 Bot 服务'}
          </Card.Title>
          <Card.Description>
            {initialized
              ? '使用本机服务管理员账号登录，继续管理你的 Bot 线程。'
              : '设置管理员账号后即可开始使用。安全密码至少 12 个字符；安装 secret 仅用于本次初始化。'}
          </Card.Description>
        </Card.Header>
        <Card.Content>
          <form className="bot-access-form" onSubmit={submit}>
            {!initialized && (
              <>
                <TextField fullWidth>
                  <Label>管理员名称</Label>
                  <Input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" />
                </TextField>
                <TextField fullWidth>
                  <Label>安装 secret</Label>
                  <Input type="password" value={secret} onChange={(event) => setSecret(event.target.value)} autoComplete="off" required />
                </TextField>
                <div className="bot-file-field">
                  <Button type="button" variant="secondary" onPress={() => secretFileRef.current?.click()}>
                    <Sym name="upload" />
                    从安装文件读取 secret
                  </Button>
                  <input ref={secretFileRef} className="bot-hidden-file" type="file" accept=".txt,.env" aria-label="从安装文件读取 secret" onChange={readSecret} />
                  {secret && <Chip size="sm" variant="soft" color="success">secret 已读取</Chip>}
                </div>
              </>
            )}

            {initialized && (
              <TextField fullWidth>
                <Label>用户名</Label>
                <Input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" />
              </TextField>
            )}

            <TextField fullWidth>
              <Label>安全密码</Label>
              <Input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete={initialized ? 'current-password' : 'new-password'}
                required
              />
            </TextField>

            {error && (
              <Alert status="danger" role="alert">
                <Alert.Indicator><Sym name="error" /></Alert.Indicator>
                <Alert.Content>
                  <Alert.Title>操作失败</Alert.Title>
                  <Alert.Description>{error}</Alert.Description>
                </Alert.Content>
              </Alert>
            )}

            <div className="bot-access-actions">
              <Button type="submit" variant="primary" fullWidth isDisabled={busy || passkeyBusy}>
                {busy ? <Spinner size="sm" color="current" /> : <Sym name="key" />}
                {busy ? '处理中…' : initialized ? '登录' : '初始化并继续'}
              </Button>
              {initialized && (
                <Button type="button" variant="secondary" fullWidth onPress={() => void passkeyLogin()} isDisabled={busy || passkeyBusy}>
                  {passkeyBusy ? <Spinner size="sm" color="current" /> : <Sym name="verified" />}
                  {passkeyBusy ? '验证中…' : '使用 Passkey 登录'}
                </Button>
              )}
            </div>
          </form>
        </Card.Content>
      </Card.Root>
    </div>
  );
}

export default function BotWorkspace() {
  const nav = useAppNav('bot');
  const [status, setStatus] = useState<{ initialized: boolean } | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [threads, setThreads] = useState<ThreadDetail[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [uploadBusy, setUploadBusy] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [passkeyState, setPasskeyState] = useState('');
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const cursorRef = useRef(0);

  const active = threads.find((thread) => thread.id === activeId) ?? null;

  const refresh = useCallback(async () => {
    const result = await serverClient.threads();
    const details = await Promise.all(result.threads.filter((thread) => thread.mode === 'bot').map((thread) => serverClient.thread(thread.id)));
    setThreads(details);
    setActiveId((id) => id && details.some((thread) => thread.id === id) ? id : details[0]?.id ?? null);
  }, []);

  useEffect(() => {
    void Promise.all([serverClient.bootstrapStatus(), serverClient.session()])
      .then(([nextStatus, nextSession]) => {
        setStatus(nextStatus);
        setSession(nextSession);
        if (nextSession.authenticated) void refresh();
      })
      .catch((e) => setError(e instanceof ServerApiError ? e.code : '无法连接服务'));
  }, [refresh]);

  useEffect(() => {
    if (!activeId || !session?.authenticated) return;
    const controller = new AbortController();
    let stopped = false;
    const receive = (event: SseEvent, id: number) => {
      cursorRef.current = Math.max(cursorRef.current, id);
      if ('message' in event) {
        setThreads((old) => old.map((thread) => thread.id === activeId && !thread.messages.some((message) => message.id === event.message.id)
          ? { ...thread, messages: [...thread.messages, event.message].sort((a, b) => a.seq - b.seq) }
          : thread));
      }
    };
    const run = async () => {
      while (!stopped) {
        try {
          await serverClient.events(activeId, cursorRef.current, receive, controller.signal);
        } catch {
          if (controller.signal.aborted) break;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 500));
      }
    };
    void run();
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [activeId, session?.authenticated]);

  const create = async () => {
    setCreateBusy(true);
    setError('');
    try {
      const thread = await serverClient.createThread('新的 Bot 任务');
      cursorRef.current = 0;
      setThreads((old) => [{ ...thread, messages: [] }, ...old]);
      setActiveId(thread.id);
    } catch {
      setError('新建 Bot 线程失败');
    } finally {
      setCreateBusy(false);
    }
  };

  const send = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!active || !draft.trim()) return;
    const content = draft.trim();
    const nonce = crypto.randomUUID();
    const pending: MessageDto = {
      id: `pending-${nonce}`,
      threadId: active.id,
      clientNonce: nonce,
      seq: Number.MAX_SAFE_INTEGER,
      role: 'user',
      kind: 'text',
      content,
      createdAt: new Date().toISOString(),
      replyTo: null,
    };
    setDraft('');
    setError('');
    setThreads((old) => old.map((thread) => thread.id === active.id ? { ...thread, messages: [...thread.messages, pending] } : thread));
    try {
      const accepted = await serverClient.sendMessage(active.id, content, nonce);
      setThreads((old) => old.map((thread) => thread.id === active.id
        ? { ...thread, messages: thread.messages.map((message) => message.id === pending.id ? accepted : message).sort((a, b) => a.seq - b.seq) }
        : thread));
    } catch {
      setThreads((old) => old.map((thread) => thread.id === active.id
        ? { ...thread, messages: thread.messages.filter((message) => message.id !== pending.id) }
        : thread));
      setError('消息发送失败');
    }
  };

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!active || !file) return;
    setUploadBusy(true);
    setError('');
    const nonce = crypto.randomUUID();
    const pending: MessageDto = {
      id: `pending-${nonce}`,
      threadId: active.id,
      clientNonce: nonce,
      seq: Number.MAX_SAFE_INTEGER,
      role: 'user',
      kind: 'attachment',
      content: JSON.stringify({ originalName: file.name, mimeType: file.type || 'application/octet-stream', sizeBytes: file.size, uploading: true }),
      createdAt: new Date().toISOString(),
      replyTo: null,
    };
    setThreads((old) => old.map((thread) => thread.id === active.id ? { ...thread, messages: [...thread.messages, pending] } : thread));
    try {
      const uploaded = await serverClient.uploadFile(file);
      const content = JSON.stringify({ fileId: uploaded.id, originalName: uploaded.originalName, mimeType: uploaded.mimeType, sizeBytes: uploaded.sizeBytes, sha256: uploaded.sha256 });
      const accepted = await serverClient.sendAttachment(active.id, content, nonce);
      setThreads((old) => old.map((thread) => thread.id === active.id
        ? { ...thread, messages: thread.messages.map((message) => message.id === pending.id ? accepted : message).sort((a, b) => a.seq - b.seq) }
        : thread));
    } catch {
      setThreads((old) => old.map((thread) => thread.id === active.id
        ? { ...thread, messages: thread.messages.filter((message) => message.id !== pending.id) }
        : thread));
      setError('附件上传失败');
    } finally {
      setUploadBusy(false);
    }
  };

  const react = async (messageId: string) => {
    try {
      await serverClient.react(messageId, '👍');
    } catch {
      setError('反应发送失败');
    }
  };

  const resolveApproval = async (approvalId: string, approved: boolean) => {
    try {
      const resolved = await serverClient.resolveApproval(approvalId, approved);
      setThreads((old) => old.map((thread) => ({ ...thread, approvals: thread.approvals?.map((approval) => approval.id === approvalId ? resolved : approval) })));
    } catch {
      setError('审批处理失败');
    }
  };

  const addPasskey = async () => {
    if (!browserSupportsWebAuthn()) {
      setPasskeyState('当前浏览器不支持 Passkey');
      return;
    }
    setPasskeyBusy(true);
    setPasskeyState('');
    try {
      const optionsJSON = await serverClient.passkeyRegisterOptions();
      const response = await startRegistration({ optionsJSON });
      await serverClient.passkeyRegisterVerify(response);
      setPasskeyState('Passkey 已添加');
    } catch (e) {
      setPasskeyState(passkeyError(e, '注册'));
    } finally {
      setPasskeyBusy(false);
    }
  };

  const logout = async () => {
    setLogoutBusy(true);
    setError('');
    try {
      await serverClient.logout();
      setSession({ authenticated: false, user: null });
    } catch {
      setError('退出登录失败');
    } finally {
      setLogoutBusy(false);
    }
  };

  const recent: RecentItem[] = useMemo(() => threads.map((thread) => ({
    id: thread.id,
    label: thread.title || '未命名 Bot 任务',
    active: thread.id === activeId,
    onClick: () => {
      cursorRef.current = 0;
      setActiveId(thread.id);
    },
  })), [threads, activeId]);

  if (!status) {
    return (
      <PageShell title="bot" rail={nav}>
        <HeroEmptyState className="bot-loading">
          <Spinner size="lg" color="accent" />
          <Typography.Heading level={2}>连接本机 Bot 服务</Typography.Heading>
          <Typography.Paragraph size="sm">正在检查服务状态…</Typography.Paragraph>
        </HeroEmptyState>
      </PageShell>
    );
  }

  if (!session?.authenticated) {
    return (
      <PageShell title="bot" rail={nav}>
        <AccessForm
          initialized={status.initialized}
          onDone={() => {
            void Promise.all([serverClient.bootstrapStatus(), serverClient.session()]).then(([nextStatus, nextSession]) => {
              setStatus(nextStatus);
              setSession(nextSession);
              if (nextSession.authenticated) return refresh();
              return undefined;
            });
          }}
        />
      </PageShell>
    );
  }

  return (
    <PageShell
      title={active?.title || 'bot'}
      subtitle="后端持续执行 · 独立沙盒工作区"
      rail={nav}
      recent={{ label: 'Bot 线程', items: recent }}
      actions={(
        <Button variant="tertiary" size="sm" onPress={() => void logout()} isDisabled={logoutBusy}>
          {logoutBusy ? <Spinner size="sm" color="current" /> : <Sym name="key_off" />}
          {logoutBusy ? '退出中…' : '退出登录'}
        </Button>
      )}
      fill
      rootClassName="bot-page"
    >
      <div className="bot-layout">
        <aside className="bot-capabilities" aria-label="Bot 能力与设置">
          <Card.Root variant="secondary" className="bot-sidebar-card">
            <Card.Header className="bot-sidebar-card__header">
              <div className="bot-agent-icon" aria-hidden="true"><Sym name="neurology" /></div>
              <div className="min-w-0">
                <Card.Title>本机 Bot</Card.Title>
                <Card.Description>安全的独立任务空间</Card.Description>
              </div>
              <Chip size="sm" variant="soft" color="success">在线</Chip>
            </Card.Header>
            <Card.Content className="bot-sidebar-card__content">
              <div className="bot-capability">
                <Chip size="sm" variant="soft" color="accent">文本任务</Chip>
                <Typography.Paragraph size="sm">多步执行、定时唤醒，关闭页面后任务继续</Typography.Paragraph>
              </div>
              <div className="bot-capability">
                <Chip size="sm" variant="soft">安全渲染</Chip>
                <Typography.Paragraph size="sm">不会执行 HTML / widget</Typography.Paragraph>
              </div>
              <div className="bot-sidebar-actions">
                {active && <Button variant="secondary" fullWidth onPress={() => {
                  void serverClient.stopThread(active.id).then(() => setPasskeyState('当前线程任务已停止')).catch(() => setError('停止任务失败'));
                }}><Sym name="stop" />停止当前线程任务</Button>}
                <Button variant="primary" fullWidth onPress={() => void create()} isDisabled={createBusy}>
                  {createBusy ? <Spinner size="sm" color="current" /> : <Sym name="add" />}
                  {createBusy ? '创建中…' : '新建 Bot 线程'}
                </Button>
                <Button variant="secondary" fullWidth onPress={() => void addPasskey()} isDisabled={passkeyBusy}>
                  {passkeyBusy ? <Spinner size="sm" color="current" /> : <Sym name="verified" />}
                  {passkeyBusy ? '处理中…' : '添加 Passkey'}
                </Button>
              </div>
              {passkeyState && <p className="bot-status" role="status">{passkeyState}</p>}
            </Card.Content>
          </Card.Root>
        </aside>

        <section className="bot-conversation" aria-label="Bot 对话">
          {error && (
            <Alert status="danger" className="bot-conversation__alert" role="alert">
              <Alert.Indicator><Sym name="error" /></Alert.Indicator>
              <Alert.Content>
                <Alert.Title>操作失败</Alert.Title>
                <Alert.Description>{error}</Alert.Description>
              </Alert.Content>
              <Button variant="tertiary" size="sm" onPress={() => setError('')} aria-label="关闭错误提示">
                <Sym name="close" />
              </Button>
            </Alert>
          )}

          <div className="bot-messages" aria-live="polite">
            {active ? active.messages.map((message) => (
              <article key={message.id} className={cn('bot-message', message.role === 'user' && 'bot-message--user')}>
                <div className="bot-message__meta">
                  <Chip size="sm" variant="soft" color={message.role === 'user' ? 'accent' : 'default'}>
                    {message.role === 'user' ? '你' : 'Bot'}
                  </Chip>
                  <span>{message.kind}</span>
                </div>
                <MessageBody
                  message={message}
                  approval={active.approvals?.find((approval) => approval.messageId === message.id)}
                  onReact={react}
                  onResolve={resolveApproval}
                />
              </article>
            )) : (
              <HeroEmptyState className="bot-empty">
                <div className="bot-empty__icon" aria-hidden="true"><Sym name="chat" /></div>
                <Typography.Heading level={2}>开始一个 Bot 任务</Typography.Heading>
                <Typography.Paragraph size="sm">创建一个线程，描述目标、背景或需要 Bot 处理的文件。</Typography.Paragraph>
                <Button variant="primary" onPress={() => void create()} isDisabled={createBusy}>
                  {createBusy ? <Spinner size="sm" color="current" /> : <Sym name="add" />}
                  新建 Bot 线程
                </Button>
              </HeroEmptyState>
            )}
          </div>

          <form className="bot-composer" onSubmit={send}>
            <TextArea
              aria-label="Bot 任务内容"
              className="bot-composer__input"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="向 Bot 描述任务…"
              rows={2}
              fullWidth
              disabled={!active || uploadBusy}
            />
            <div className="bot-composer__actions">
              <Button type="button" variant="secondary" onPress={() => uploadInputRef.current?.click()} isDisabled={!active || uploadBusy}>
                {uploadBusy ? <Spinner size="sm" color="current" /> : <Sym name="upload" />}
                {uploadBusy ? '上传中…' : '添加附件'}
              </Button>
              <input ref={uploadInputRef} className="bot-hidden-file" type="file" aria-label="添加附件" onChange={upload} disabled={!active || uploadBusy} />
              <Button type="submit" variant="primary" isDisabled={!active || !draft.trim() || uploadBusy}>
                <Sym name="send" />
                发送
              </Button>
            </div>
          </form>
        </section>
      </div>
    </PageShell>
  );
}
