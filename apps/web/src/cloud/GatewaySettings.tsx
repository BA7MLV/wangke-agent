import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Input, Label, Spinner, TextField } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { request, serverClient } from '../api/serverClient';
import { SectionCard, Sym, confirmDialog, toast } from '../ui';
import { SettingRow, SettingSelect, SettingSwitch } from '../components/settings/controls';
import { closeSettingsAndClearHash } from '../components/settingsDialogStore';
import { useBotPanel } from '../store/botPanel';
import type { GatewayManifest } from '@wangke/contracts/gateway';

/*
 * 设置 → 消息渠道（微信 iLink / 飞书）。
 *
 * 结构是 iOS「设置」的导航栈：列表 → 添加 / 某个渠道的详情，在同一块面板里推入与返回，
 * 不在设置弹窗上再叠一层弹窗。
 *
 * 微信的接入只有三步，每一步只有一件事：
 *   1. 选「微信」—— 渠道立即建好并开始拉二维码；
 *   2. 扫码 —— 状态自动刷新（等待扫码 → 在手机上确认 → 已登录），过期自动换码，
 *      不需要再点「检查状态」；
 *   3. 绑定 —— 给出一行 `/pair XXXXXXXX`，拷贝后发给 Bot；绑上以后这一块自动变成「已绑定」。
 * 飞书没有扫码：填 App ID / App Secret，点「连接」，状态行显示长连接是否建立。
 */

interface Account {
  id: string; channel: string; agentId: string; preset: string; enabled: number; health: string;
  manifest?: GatewayManifest;
  configuration?: Record<string, { value?: string; configured?: boolean }>;
  bindings: Array<{ id: string; peer: string; threadId: string; revoked: number }>;
}
interface Activity {
  accounts: Account[];
  channels?: GatewayManifest[];
  deliveries: Array<{ id: string; channel: string; status: string; attempts: number; error: string | null }>;
  reminders: Array<{ id: string; text: string; timezone: string; nextAt: number; intervalSeconds: number | null; status: string }>;
  inboxFailures: Array<{ id: number; channel: string; error: string }>;
  projectionFailures: Array<{ eventId: number; channel: string; threadId: string; error: string }>;
}
type View = { kind: 'list' } | { kind: 'add' } | { kind: 'feishu' } | { kind: 'account'; id: string; login?: boolean };

const post = <T,>(path: string, body: unknown = {}, signal?: AbortSignal) => request<T>(`/gateway${path}`, { method: 'POST', body: JSON.stringify(body), signal });
const HEALTH = ['connected', 'connecting', 'reconnecting', 'login_required', 'connection_failed', 'stopped', 'runtime_failed', 'inbound_failed'] as const;

function ChannelIcon({ channel }: { channel: string }) {
  const wechat = channel === 'ilink';
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-lg text-white" style={{ background: wechat ? '#07c160' : '#3370ff' }} aria-hidden="true">
      <Sym name={wechat ? 'forum' : 'send'} />
    </span>
  );
}

/** 推入页的顶栏：左上角返回，标题居中。 */
function PushedHeader({ back, title, onBack }: { back: string; title: string; onBack: () => void }) {
  return (
    <div className="mb-3 grid grid-cols-[1fr_auto_1fr] items-center">
      <Button variant="ghost" size="sm" className="justify-self-start px-1" onPress={onBack}>
        <Sym name="chevron_left" />{back}
      </Button>
      <h3 className="text-base font-semibold">{title}</h3>
      <span />
    </div>
  );
}

export default function GatewaySettings() {
  const { t } = useTranslation('gateway');
  const [data, setData] = useState<Activity>();
  const [agents, setAgents] = useState<Array<{ id: string; name: string; enabled?: boolean }>>([]);
  const [view, setView] = useState<View>({ kind: 'list' });
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => setData(await request<Activity>('/gateway')), []);
  useEffect(() => {
    let alive = true;
    const tick = () => void request<Activity>('/gateway').then((value) => { if (alive) setData(value); }).catch(() => {});
    tick();
    void serverClient.agents().then((r) => { if (alive) setAgents(r.agents.filter((a) => a.enabled !== false)); }).catch(() => {});
    const timer = setInterval(() => { if (document.visibilityState === 'visible') tick(); }, 4000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try { await action(); await refresh(); }
    catch (e) { toast.error((e as Error).message); }
    finally { setBusy(false); }
  };

  const channelName = (channel: string) => (channel === 'ilink' ? t('wechat') : channel === 'feishu' ? t('feishu') : channel);
  const healthLabel = (account: Account) => !account.enabled ? t('health.stopped')
    : (HEALTH as readonly string[]).includes(account.health) ? t(`health.${account.health as typeof HEALTH[number]}`) : t('health.unknown');

  if (!data) return <div className="grid min-h-40 place-items-center text-muted"><Spinner size="sm" color="current" /></div>;

  /* ── 添加：选渠道 ── */
  if (view.kind === 'add') {
    const channels = data.channels ?? [];
    const start = (channel: string) => act(async () => {
      if (channel === 'feishu') { setView({ kind: 'feishu' }); return; }
      const { id } = await post<{ id: string }>('/accounts', { channel, agentId: agents[0].id, preset: 'inherit', enabled: true, config: {} });
      setView({ kind: 'account', id, login: true });
    });
    return (
      <section data-testid="gateway-settings">
        <PushedHeader back={t('back')} title={t('add')} onBack={() => setView({ kind: 'list' })} />
        {agents.length === 0 ? <p className="py-6 text-center text-sm text-muted">{t('noBot')}</p> : (
          <SectionCard title={t('channels')}>
            {channels.map((channel) => (
              <button key={channel.id} type="button" disabled={busy} data-testid={`gateway-add-${channel.id}`}
                className="flex min-h-12 w-full items-center gap-3 border-b border-border/70 py-2 text-left last:border-b-0 disabled:opacity-60"
                onClick={() => void start(channel.id)}>
                <ChannelIcon channel={channel.id} />
                <span className="flex-1 text-sm font-medium">{channelName(channel.id)}</span>
                {busy ? <Spinner size="sm" color="current" /> : <Sym name="chevron_right" className="text-muted" />}
              </button>
            ))}
          </SectionCard>
        )}
      </section>
    );
  }

  /* ── 添加飞书：两个字段 + 连接 ── */
  if (view.kind === 'feishu') {
    return <FeishuForm agents={agents} busy={busy} onBack={() => setView({ kind: 'add' })}
      onSubmit={(fields) => act(async () => {
        const { id } = await post<{ id: string }>('/accounts', { channel: 'feishu', agentId: fields.agentId, preset: 'inherit', enabled: true, config: { appId: fields.appId, appSecret: fields.appSecret } });
        setView({ kind: 'account', id });
      })} />;
  }

  /* ── 某个渠道 ── */
  if (view.kind === 'account') {
    const account = data.accounts.find((a) => a.id === view.id);
    if (!account) return <div className="grid min-h-40 place-items-center text-muted"><Spinner size="sm" color="current" /></div>;
    return <AccountDetail key={account.id} account={account} agents={agents} busy={busy} startLogin={view.login}
      title={channelName(account.channel)} status={healthLabel(account)}
      onBack={() => setView({ kind: 'list' })} act={act} refresh={refresh} />;
  }

  /* ── 列表 ── */
  const attention = data.deliveries.filter((d) => ['failed', 'uncertain'].includes(d.status));
  const activeReminders = data.reminders.filter((r) => r.status === 'active');
  return (
    <section className="flex min-w-0 flex-col" data-testid="gateway-settings">
      <SectionCard title={t('channels')} actions={<Button size="sm" variant="secondary" onPress={() => setView({ kind: 'add' })} data-testid="gateway-add">{t('add')}</Button>}>
        {data.accounts.length === 0 && <p className="py-3 text-sm text-muted">{t('empty')}</p>}
        {data.accounts.map((account) => (
          <button key={account.id} type="button" data-testid={`gateway-account-${account.channel}`}
            className="flex min-h-12 w-full items-center gap-3 border-b border-border/70 py-2 text-left last:border-b-0"
            onClick={() => setView({ kind: 'account', id: account.id })}>
            <ChannelIcon channel={account.channel} />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{channelName(account.channel)}</span>
            <span className={`text-sm ${account.enabled && account.health === 'connected' ? 'text-muted' : account.enabled ? 'text-warning' : 'text-muted'}`}>{healthLabel(account)}</span>
            <Sym name="chevron_right" className="text-muted" />
          </button>
        ))}
      </SectionCard>

      {(attention.length > 0 || data.inboxFailures.length > 0 || data.projectionFailures.length > 0) && (
        <SectionCard title={t('attention')} testId="gateway-attention">
          {attention.map((d) => (
            <SettingRow key={d.id} label={<span>{channelName(d.channel)} · {t(`delivery.${d.status as 'failed' | 'uncertain'}`)}</span>}>
              <Button size="sm" variant="secondary" isDisabled={busy} onPress={() => void act(async () => {
                if (d.status === 'uncertain' && !await confirmDialog({ headline: t('retry'), description: t('uncertain'), confirmText: t('retry') })) return;
                await post(`/deliveries/${d.id}/retry`, { acknowledgeUncertain: d.status === 'uncertain' });
              })}>{t('retry')}</Button>
              <Button size="sm" variant="ghost" isDisabled={busy} onPress={() => void act(async () => {
                if (await confirmDialog({ headline: t('discard'), description: t('discardConfirm'), confirmText: t('discard') })) await post(`/deliveries/${d.id}/discard`);
              })}>{t('discard')}</Button>
            </SettingRow>
          ))}
          {data.inboxFailures.slice(0, 5).map((f) => <SettingRow key={`in-${f.id}`} label={`${channelName(f.channel)} · ${t('inboundFailure')}`}><span className="text-xs text-muted">{f.error}</span></SettingRow>)}
          {data.projectionFailures.slice(0, 5).map((f) => <SettingRow key={`pf-${f.threadId}-${f.eventId}`} label={`${channelName(f.channel)} · ${t('projectionFailure')}`}><OpenThread threadId={f.threadId} /></SettingRow>)}
        </SectionCard>
      )}

      {activeReminders.length > 0 && (
        <SectionCard title={t('reminders')} testId="gateway-reminders">
          {activeReminders.map((r) => (
            <SettingRow key={r.id} label={<span className="flex flex-col"><span className="truncate">{r.text}</span><span className="text-xs font-normal text-muted">{new Date(r.nextAt).toLocaleString()}</span></span>}>
              <Button size="sm" variant="ghost" isDisabled={busy} onPress={() => void act(() => post(`/reminders/${r.id}/cancel`))}>{t('cancel')}</Button>
            </SettingRow>
          ))}
        </SectionCard>
      )}
    </section>
  );
}

/** 「打开对话」：关掉设置，在主页右侧 Bot 栏里打开那条线程。 */
function OpenThread({ threadId, children }: { threadId: string; children?: ReactNode }) {
  const { t } = useTranslation('gateway');
  const navigate = useNavigate();
  return <Button size="sm" variant="secondary" onPress={() => { closeSettingsAndClearHash(); useBotPanel.getState().openThread(threadId); navigate('/'); }}>{children ?? t('open')}</Button>;
}

function FeishuForm({ agents, busy, onBack, onSubmit }: {
  agents: Array<{ id: string; name: string }>;
  busy: boolean;
  onBack: () => void;
  onSubmit: (fields: { appId: string; appSecret: string; agentId: string }) => void;
}) {
  const { t } = useTranslation('gateway');
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '');
  const ready = /^cli_\w+$/.test(appId.trim()) && appSecret.trim().length > 0 && agentId;
  return (
    <section data-testid="gateway-settings">
      <PushedHeader back={t('add')} title={t('feishu')} onBack={onBack} />
      <SectionCard title={t('feishu')}>
        <div className="flex flex-col gap-3 py-2">
          <TextField fullWidth isRequired>
            <Label>{t('appId')}</Label>
            <Input value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="cli_…" autoComplete="off" autoCapitalize="off" spellCheck={false} />
          </TextField>
          <TextField fullWidth isRequired>
            <Label>{t('appSecret')}</Label>
            <Input type="password" value={appSecret} onChange={(e) => setAppSecret(e.target.value)} autoComplete="new-password" />
          </TextField>
        </div>
        {agents.length > 1 && <SettingSelect label={t('bot')} value={agentId} options={agents.map((a) => ({ id: a.id, label: a.name }))} onChange={setAgentId} />}
      </SectionCard>
      <Button variant="primary" fullWidth className="min-h-11" isDisabled={!ready || busy}
        onPress={() => onSubmit({ appId: appId.trim(), appSecret: appSecret.trim(), agentId })} data-testid="gateway-feishu-connect">
        {busy ? <Spinner size="sm" color="current" /> : t('connect')}
      </Button>
    </section>
  );
}

function AccountDetail({ account, agents, busy, startLogin, title, status, onBack, act, refresh }: {
  account: Account;
  agents: Array<{ id: string; name: string }>;
  busy: boolean;
  startLogin?: boolean;
  title: string;
  status: string;
  onBack: () => void;
  act: (action: () => Promise<unknown>) => Promise<void>;
  refresh: () => Promise<void>;
}) {
  const { t } = useTranslation('gateway');
  const wechat = account.channel === 'ilink';
  const [login, setLogin] = useState(Boolean(startLogin) || (wechat && account.health === 'login_required' && account.enabled === 1));
  const [pair, setPair] = useState<{ command: string; expiresAt: string }>();
  const [appId, setAppId] = useState(account.configuration?.appId?.value ?? '');
  const [appSecret, setAppSecret] = useState('');
  const active = account.bindings.filter((b) => !b.revoked);
  const save = (patch: Partial<{ agentId: string; preset: string; enabled: boolean }>, config: Record<string, string> = {}) => act(() => post('/accounts', {
    id: account.id, channel: account.channel, agentId: account.agentId, preset: account.preset, enabled: Boolean(account.enabled), ...patch, config,
  }));
  // 绑上以后收起绑定码：轮询把 bindings 带回来就算完成。
  useEffect(() => { if (active.length) setPair(undefined); }, [active.length]);

  return (
    <section data-testid="gateway-settings">
      <PushedHeader back={t('back')} title={title} onBack={onBack} />

      {wechat && login ? (
        <WeChatLogin accountId={account.id} onDone={() => { setLogin(false); void refresh(); }} />
      ) : (
        <SectionCard title={title}>
          <SettingRow label={t('status')}>
            <span className="text-sm text-muted" role="status">{status}</span>
            {wechat && <Button size="sm" variant="secondary" onPress={() => setLogin(true)} data-testid="gateway-relogin">{t('qr.relogin')}</Button>}
          </SettingRow>
          <SettingSwitch label={t('enabled')} isSelected={Boolean(account.enabled)} isDisabled={busy} onChange={(on) => void save({ enabled: on })} />
          {agents.length > 1 && <SettingSelect label={t('bot')} value={account.agentId} isDisabled={busy}
            options={agents.map((a) => ({ id: a.id, label: a.name }))} onChange={(agentId) => void save({ agentId })} />}
          <SettingSelect label={t('preset')} value={account.preset} isDisabled={busy}
            options={[{ id: 'inherit', label: t('inherit') }, { id: 'autonomous', label: t('autonomous') }]} onChange={(preset) => void save({ preset })} />
        </SectionCard>
      )}

      {!wechat && (
        <SectionCard title={t('feishu')}>
          <div className="flex flex-col gap-3 py-2">
            <TextField fullWidth>
              <Label>{t('appId')}</Label>
              <Input value={appId} onChange={(e) => setAppId(e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} />
            </TextField>
            <TextField fullWidth>
              <Label>{t('appSecret')}</Label>
              <Input type="password" value={appSecret} onChange={(e) => setAppSecret(e.target.value)}
                placeholder={account.configuration?.appSecret?.configured ? t('secretSaved') : ''} autoComplete="new-password" />
            </TextField>
            {(appSecret || appId !== (account.configuration?.appId?.value ?? '')) && (
              <Button variant="primary" className="min-h-11" isDisabled={busy || !/^cli_\w+$/.test(appId.trim())}
                onPress={() => void save({}, { appId: appId.trim(), ...(appSecret ? { appSecret } : {}) }).then(() => setAppSecret(''))}>{t('saveCredentials')}</Button>
            )}
          </div>
        </SectionCard>
      )}

      {!(wechat && login) && (
        <SectionCard title={active.length ? t('bindings') : t('pairTitle')} testId="gateway-pairing">
          {active.map((binding) => (
            <SettingRow key={binding.id} label={<span className="font-mono text-xs">…{binding.peer.slice(-6)}</span>}>
              <OpenThread threadId={binding.threadId} />
              <Button size="sm" variant="ghost" className="text-danger" isDisabled={busy} onPress={() => void act(async () => {
                if (await confirmDialog({ headline: t('revoke'), description: t('revokeConfirm'), confirmText: t('revoke'), danger: true })) await post(`/accounts/${account.id}/revoke`, { bindingId: binding.id });
              })}>{t('revoke')}</Button>
            </SettingRow>
          ))}
          {!active.length && (pair ? <PairCode pair={pair} channel={title} /> : (
            <div className="py-2">
              <Button variant="primary" fullWidth className="min-h-11" isDisabled={busy || !account.enabled} data-testid="gateway-pair"
                onPress={() => void act(async () => setPair(await post<{ command: string; expiresAt: string }>(`/accounts/${account.id}/pair`)))}>{t('pairTitle')}</Button>
            </div>
          ))}
        </SectionCard>
      )}
    </section>
  );
}

function PairCode({ pair, channel }: { pair: { command: string; expiresAt: string }; channel: string }) {
  const { t } = useTranslation('gateway');
  const [copied, setCopied] = useState(false);
  const minutes = Math.max(1, Math.round((Date.parse(pair.expiresAt) - Date.now()) / 60_000));
  return (
    <div className="flex flex-col items-center gap-3 py-3 text-center">
      <span className="text-sm text-muted">{t('pairSend', { channel })}</span>
      <code className="select-all rounded-xl bg-background-secondary px-4 py-3 font-mono text-xl tracking-wider" data-testid="gateway-pair-command">{pair.command}</code>
      <Button variant="secondary" className="min-h-11 min-w-32" onPress={() => {
        void navigator.clipboard?.writeText(pair.command).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {});
      }}>
        <Sym name={copied ? 'check' : 'content_copy'} />{copied ? t('copied') : t('copy')}
      </Button>
      <span className="text-xs text-muted">{t('pairExpires', { minutes })}</span>
    </div>
  );
}

/**
 * 微信扫码登录：拿码 → 长轮询状态 → 过期自动换码（最多 3 次，再往后等用户点「刷新」）。
 * 卸载即停止（AbortController + alive 标记），离开这一页不会在后台继续轮询。
 */
function WeChatLogin({ accountId, onDone }: { accountId: string; onDone: () => void }) {
  const { t } = useTranslation('gateway');
  const [qr, setQr] = useState<{ qrcode: string; qrDataUrl: string; redirectHost?: string }>();
  const [state, setState] = useState<'loading' | 'wait' | 'scaned' | 'confirmed' | 'expired' | 'verify' | 'error'>('loading');
  const [verifyCode, setVerifyCode] = useState('');
  const [round, setRound] = useState(0);
  const renewals = useRef(0);
  const verifyRef = useRef('');
  verifyRef.current = verifyCode;
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    let doneTimer: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      setState('loading');
      let current: { qrcode: string; qrDataUrl: string; redirectHost?: string };
      try { current = await post(`/accounts/${accountId}/login`, { action: 'qr' }, controller.signal); }
      catch { if (alive) setState('error'); return; }
      if (!alive) return;
      setQr(current); setState('wait');
      while (alive) {
        let result: { status: string; redirectHost?: string };
        try {
          result = await post(`/accounts/${accountId}/login`, { action: 'poll', qrcode: current.qrcode, ...(current.redirectHost ? { redirectHost: current.redirectHost } : {}), ...(verifyRef.current ? { verifyCode: verifyRef.current } : {}) }, controller.signal);
        } catch {
          if (!alive) return;
          await new Promise((resolve) => setTimeout(resolve, 2000));
          continue;
        }
        if (!alive) return;
        if (result.redirectHost) current = { ...current, redirectHost: result.redirectHost };
        const status = result.status;
        if (status === 'confirmed') { setState('confirmed'); doneTimer = setTimeout(() => alive && doneRef.current(), 900); return; }
        if (status === 'expired') {
          if (renewals.current++ < 3) { setRound((value) => value + 1); return; }
          setState('expired'); return;
        }
        if (status.includes('verify')) { setState('verify'); await new Promise((resolve) => setTimeout(resolve, 1500)); continue; }
        setState(status.startsWith('scaned') ? 'scaned' : 'wait');
      }
    })();
    return () => { alive = false; controller.abort(); clearTimeout(doneTimer); };
  }, [accountId, round]);

  const label = state === 'scaned' ? t('qr.scanned') : state === 'confirmed' ? t('qr.confirmed') : state === 'expired' ? t('qr.expired') : t('qr.scan');
  return (
    <SectionCard title={t('wechat')} testId="gateway-wechat-login">
      <div className="flex flex-col items-center gap-4 py-4 text-center">
        <div className="relative grid size-60 place-items-center overflow-hidden rounded-2xl bg-white p-3 shadow-sm">
          {qr && state !== 'loading' ? <img src={qr.qrDataUrl} alt={t('qr.scan')} className={`size-full ${state === 'expired' || state === 'scaned' || state === 'confirmed' ? 'opacity-15 blur-[2px]' : ''}`} /> : <Spinner color="current" />}
          {(state === 'scaned' || state === 'confirmed') && (
            <span className="absolute grid size-14 place-items-center rounded-full bg-success text-2xl text-white" aria-hidden="true"><Sym name="check" /></span>
          )}
          {state === 'expired' && (
            <Button className="absolute" variant="primary" onPress={() => { renewals.current = 0; setRound((value) => value + 1); }}>{t('qr.refresh')}</Button>
          )}
        </div>
        <p className="text-base font-medium" role="status" aria-live="polite">{state === 'error' ? t('health.connection_failed') : label}</p>
        {state === 'error' && <Button variant="secondary" onPress={() => setRound((value) => value + 1)}>{t('qr.refresh')}</Button>}
        {state === 'verify' && (
          <TextField className="w-48">
            <Label>{t('qr.verify')}</Label>
            <Input inputMode="numeric" autoComplete="one-time-code" value={verifyCode} onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, ''))} />
          </TextField>
        )}
      </div>
    </SectionCard>
  );
}
