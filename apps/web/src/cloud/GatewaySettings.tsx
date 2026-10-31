import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Input, Label, Spinner, TextField } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { request, serverClient } from '../api/serverClient';
import { SectionCard, Sym, confirmDialog, toast } from '../ui';
import { SettingRow, SettingSelect, SettingSwitch } from '../components/settings/controls';
import { closeSettingsAndClearHash, openSettings } from '../components/settingsDialogStore';
import { useBotPanel } from '../store/botPanel';
import type { GatewayManifest, GatewayConnectionDiagnostics, GatewayReadiness } from '@wangke/contracts/gateway';

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
  connection?: GatewayConnectionDiagnostics;
  readiness?: GatewayReadiness;
  configuration?: Record<string, { value?: string; configured?: boolean }>;
  bindings: Array<{ id: string; peer: string; threadId: string; revoked: number }>;
}
interface Activity {
  accounts: Account[];
  channels?: GatewayManifest[];
  deliveries: Array<{ id: string; channel: string; accountId: string; status: string; attempts: number; error: string | null }>;
  reminders: Array<{ id: string; text: string; timezone: string; nextAt: number; intervalSeconds: number | null; status: string }>;
  inboxFailures: Array<{ id: number; channel: string; error: string }>;
  projectionFailures: Array<{ eventId: number; channel: string; threadId: string; error: string }>;
}
type View = { kind: 'list' } | { kind: 'add' } | { kind: 'feishu' } | { kind: 'account'; id: string; login?: boolean };

const post = <T,>(path: string, body: unknown = {}, signal?: AbortSignal) => request<T>(`/gateway${path}`, { method: 'POST', body: JSON.stringify(body), signal });
const HEALTH = ['connected', 'connecting', 'reconnecting', 'login_required', 'connection_failed', 'stopped', 'runtime_failed', 'inbound_failed'] as const;
const accountIdentity = (account: Account) => account.configuration?.botId?.value || account.configuration?.appId?.value || account.id;
const readinessState = (account: Account): GatewayReadiness['state'] => account.readiness?.state ?? (!account.enabled ? 'disabled'
  : account.health === 'login_required' ? 'login_required' : account.health !== 'connected' ? 'connection_required'
  : !account.bindings.some(b => !b.revoked) ? 'binding_required' : 'ready');

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
  const [loadFailed, setLoadFailed] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState('');
  const revision = useRef(0);
  const mounted = useRef(false);

  const refresh = useCallback(async () => {
    if (!mounted.current) return;
    const current = ++revision.current;
    try {
      const [value, profiles] = await Promise.all([request<Activity>('/gateway'), serverClient.agents()]);
      if (current === revision.current) { setData(value); setAgents(profiles.agents); setLoadFailed(false); }
    } catch { if (current === revision.current) setLoadFailed(true); }
  }, []);
  useEffect(() => {
    mounted.current = true;
    let alive = true, timer: ReturnType<typeof setTimeout>;
    const tick = async () => { if (document.visibilityState === 'visible') await refresh(); if (alive) timer = setTimeout(tick, 4000); };
    void tick();
    return () => { alive = false; mounted.current = false; revision.current++; clearTimeout(timer); };
  }, [refresh]);

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try { await action(); await refresh(); }
    catch (e) { const code = (e as Error).message; toast.error(code === 'duplicate_channel_account' ? t('duplicateAccount') : code === 'channel_busy' ? t('channelBusy') : code); }
    finally { setBusy(false); }
  };

  const channelName = (channel: string) => (channel === 'ilink' ? t('wechat') : channel === 'feishu' ? t('feishu') : channel);
  const healthLabel = (account: Account) => !account.enabled ? t('health.stopped')
    : (HEALTH as readonly string[]).includes(account.health) ? t(`health.${account.health as typeof HEALTH[number]}`) : t('health.unknown');

  const loadError = <div className="flex items-center justify-between gap-3 py-3 text-sm text-warning" role="alert"><span>{t('loadFailed')}</span><Button size="sm" variant="secondary" onPress={() => void refresh()}>{t('retry')}</Button></div>;
  if (!data) return loadFailed ? loadError : <div className="grid min-h-40 place-items-center text-muted"><Spinner size="sm" color="current" /></div>;
  const enabledAgents = agents.filter(a => a.enabled !== false);
  const newAgentId = enabledAgents.find(a => a.id === selectedAgent)?.id ?? enabledAgents[0]?.id ?? '';

  /* ── 添加：选渠道 ── */
  if (view.kind === 'add') {
    const channels = data.channels ?? [];
    const start = (channel: string) => act(async () => {
      if (channel === 'feishu') { setView({ kind: 'feishu' }); return; }
      const { id } = await post<{ id: string }>('/accounts', { channel, agentId: newAgentId, preset: 'inherit', enabled: true, config: {} });
      await refresh();
      setView({ kind: 'account', id, login: true });
    });
    return (
      <section data-testid="gateway-settings">
        <PushedHeader back={t('back')} title={t('add')} onBack={() => setView({ kind: 'list' })} />
        <p className="mb-3 text-sm text-muted">{t('multiChannelHint')}</p>
        {enabledAgents.length === 0 ? <><p className="py-6 text-center text-sm text-muted">{t('noBot')}</p><Button onPress={() => openSettings('bot')}>{t('configureBot')}</Button></> : (
          <SectionCard title={t('channels')}>
             <SettingSelect label={t('bot')} value={newAgentId} options={enabledAgents.map(a => ({ id: a.id, label: a.name }))} onChange={setSelectedAgent} isDisabled={busy} />
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
    return <FeishuForm agents={enabledAgents} initialAgentId={newAgentId} busy={busy} onBack={() => setView({ kind: 'add' })}
      onSubmit={(fields) => act(async () => {
        const { id } = await post<{ id: string }>('/accounts', { channel: 'feishu', agentId: fields.agentId, preset: 'inherit', enabled: true, config: { appId: fields.appId, appSecret: fields.appSecret } });
        await refresh();
        setView({ kind: 'account', id });
      })} />;
  }

  /* ── 某个渠道 ── */
  if (view.kind === 'account') {
    const account = data.accounts.find((a) => a.id === view.id);
    if (!account) return <section>{loadFailed ? loadError : <p className="py-4 text-muted">{t('removed')}</p>}<Button onPress={() => setView({ kind: 'list' })}>{t('back')}</Button></section>;
    return <>{loadFailed && loadError}<AccountDetail key={account.id} account={account} agents={enabledAgents} busy={busy} startLogin={view.login}
      deliveries={data.deliveries.filter(d => d.accountId === account.id && ['failed', 'uncertain'].includes(d.status))}
      title={channelName(account.channel)} status={healthLabel(account)}
      onRemoved={() => {
        revision.current++;
        setData(value => value && { ...value, accounts: value.accounts.filter(a => a.id !== account.id), deliveries: value.deliveries.filter(d => d.accountId !== account.id) });
        setView({ kind: 'list' });
      }}
      onBack={() => setView({ kind: 'list' })} act={act} refresh={refresh} /></>;
  }

  /* ── 列表 ── */
  const attention = data.deliveries.filter((d) => ['failed', 'uncertain'].includes(d.status));
  const activeReminders = data.reminders.filter((r) => r.status === 'active');
  return (
    <section className="flex min-w-0 flex-col" data-testid="gateway-settings">
      {loadFailed && loadError}
      <p className="mb-3 text-sm text-muted">{t('multiChannelHint')}</p>
      <SectionCard title={t('channels')} actions={<Button size="sm" variant="secondary" onPress={() => setView({ kind: 'add' })} data-testid="gateway-add">{t('add')}</Button>}>
        {data.accounts.length === 0 && <p className="py-3 text-sm text-muted">{t('empty')}</p>}
        {data.accounts.map((account) => (
          <button key={account.id} type="button" data-testid={`gateway-account-${account.channel}`}
            data-account-id={account.id}
            className="flex min-h-12 w-full items-center gap-3 border-b border-border/70 py-2 text-left last:border-b-0"
            onClick={() => setView({ kind: 'account', id: account.id })}>
            <ChannelIcon channel={account.channel} />
            <span className="flex min-w-0 flex-1 flex-col gap-1"><span className="truncate text-sm font-medium">{channelName(account.channel)} · {account.readiness?.botName || t('bot')}</span><span className="truncate font-mono text-xs text-muted">…{accountIdentity(account).slice(-12)}</span></span>
            <span className={`max-w-[40%] text-right text-sm ${readinessState(account) === 'ready' ? 'text-success' : account.enabled ? 'text-warning' : 'text-muted'}`}>{t(`readiness.${readinessState(account)}`)}</span>
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

function FeishuForm({ agents, initialAgentId, busy, onBack, onSubmit }: {
  agents: Array<{ id: string; name: string }>;
  initialAgentId: string;
  busy: boolean;
  onBack: () => void;
  onSubmit: (fields: { appId: string; appSecret: string; agentId: string }) => void;
}) {
  const { t } = useTranslation('gateway');
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [agentId, setAgentId] = useState(initialAgentId);
  const ready = /^cli_\w+$/.test(appId.trim()) && appSecret.trim().length > 0 && agents.some(a => a.id === agentId);
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

function AccountDetail({ account, agents, busy, startLogin, title, status, deliveries, onBack, onRemoved, act, refresh }: {
  account: Account;
  agents: Array<{ id: string; name: string }>;
  busy: boolean;
  startLogin?: boolean;
  title: string;
  status: string;
  deliveries: Activity['deliveries'];
  onBack: () => void;
  onRemoved: () => void;
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
  const state = readinessState(account), readiness = account.readiness;
  const createPair = () => act(async () => setPair(await post<{ command: string; expiresAt: string }>(`/accounts/${account.id}/pair`)));
  const save = (patch: Partial<{ agentId: string; preset: string; enabled: boolean }>, config: Record<string, string> = {}) => act(() => post('/accounts', {
    id: account.id, channel: account.channel, agentId: account.agentId, preset: account.preset, enabled: Boolean(account.enabled), ...patch, config,
  }));
  // 绑上以后收起绑定码：轮询把 bindings 带回来就算完成。
  useEffect(() => { if (active.length) setPair(undefined); }, [active.length]);

  return (
    <section data-testid="gateway-settings">
      <PushedHeader back={t('back')} title={title} onBack={onBack} />

      <SectionCard title={t(`readiness.${state}`)} testId="gateway-readiness">
        <p className="py-2 text-sm text-muted">{t(`readinessHint.${state}`)}</p>
        <ol className="grid grid-cols-2 gap-2 py-2 text-sm" aria-label={t('setupSteps')}>
          {([
            ['connection', readiness?.connected ?? account.health === 'connected'],
            ['binding', active.length > 0],
            ['bot', readiness?.botEnabled ?? true],
            ['model', readiness?.modelConfigured ?? false],
          ] as const).map(([step, done], index) => <li key={step} className="flex min-w-0 items-center gap-2 rounded-xl bg-background-secondary px-3 py-2">
            <span className={done ? 'text-success' : 'text-muted'} aria-hidden="true">{done ? <Sym name="check_circle" /> : index + 1}</span>
            <span>{t(`steps.${step}`)}<span className="sr-only"> · {done ? t('stepDone') : t('stepPending')}</span></span>
          </li>)}
        </ol>
        {state === 'model_required' && <Button variant="primary" onPress={() => openSettings('models')}>{t('configureModel')}</Button>}
        {state === 'bot_required' && <Button variant="primary" onPress={() => openSettings('bot')}>{t('configureBot')}</Button>}
        {Boolean(readiness?.inboxFailures) && <p className="py-2 text-sm text-warning">{t('inboxFailureHint', { count: readiness?.inboxFailures })}</p>}
        {Boolean(readiness?.projectionFailures) && <p className="py-2 text-sm text-warning">{t('projectionFailureHint', { count: readiness?.projectionFailures })}</p>}
         {readiness?.processingStatus && <p className="py-2 text-sm" role="status">{t(`processing.${readiness.processingStatus}`)}</p>}
         {readiness?.latestRun && ['failed', 'waiting_user', 'paused'].includes(readiness.latestRun.status) && <p className="py-2 text-sm text-warning">{t(`runState.${readiness.latestRun.status as 'failed' | 'waiting_user' | 'paused'}`)}{readiness.latestRun.errorCode && <code className="ml-1 break-all">{readiness.latestRun.errorCode}</code>}</p>}
        {readiness?.lastInboundAt != null && <p className="pt-2 text-xs text-muted">{t('lastInbound', { time: new Date(readiness.lastInboundAt).toLocaleString() })}</p>}
      </SectionCard>

      {!login && !active.length && <SectionCard title={t('pairTitle')} testId="gateway-pairing">
        <p className="py-2 text-sm text-muted">{t('pairExplanation')}</p>
        {pair ? <PairCode pair={pair} channel={title} renew={createPair} busy={busy} /> : <Button variant="primary" fullWidth className="min-h-11" isDisabled={busy || !account.enabled || account.health !== 'connected'} data-testid="gateway-pair" onPress={() => void createPair()}>{t('pairTitle')}</Button>}
      </SectionCard>}

      {wechat && login ? (
        <><WeChatLogin accountId={account.id} onDone={() => { setLogin(false); void refresh(); }} /><Button variant="ghost" onPress={() => setLogin(false)}>{t('cancel')}</Button></>
      ) : (
        <SectionCard title={title}>
          <p className="break-all pb-2 font-mono text-xs text-muted">{accountIdentity(account)}</p>
          <SettingRow label={t('transportStatus')}>
            <span className="text-sm text-muted" role="status">{status}</span>
            {wechat && <Button size="sm" variant="secondary" onPress={() => setLogin(true)} data-testid="gateway-relogin">{t('qr.relogin')}</Button>}
          </SettingRow>
          <ConnectionDetails connection={account.connection} />
          {account.enabled === 1 && ['reconnecting', 'connection_failed', 'inbound_failed'].includes(account.health) && (
            <Button size="sm" variant="secondary" onPress={() => void save({})} isDisabled={busy}>{t('reconnect')}</Button>
          )}
          <SettingSwitch label={t('enabled')} isSelected={Boolean(account.enabled)} isDisabled={busy} onChange={(on) => void save({ enabled: on })} />
          {agents.length > 0 ? <SettingSelect label={t('bot')} value={account.agentId} isDisabled={busy}
            options={agents.some(a => a.id === account.agentId) ? agents.map(a => ({ id: a.id, label: a.name })) : [{ id: account.agentId, label: `${readiness?.botName || t('bot')} · ${t('readiness.bot_required')}` }, ...agents.map(a => ({ id: a.id, label: a.name }))]} onChange={(agentId) => void save({ agentId })} />
            : <Button variant="secondary" onPress={() => openSettings('bot')}>{t('configureBot')}</Button>}
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

      {!login && active.length > 0 && (
        <SectionCard title={t('bindings')} testId="gateway-pairing">
          {active.map((binding) => (
            <SettingRow key={binding.id} label={<span className="font-mono text-xs">…{binding.peer.slice(-6)}</span>}>
              <OpenThread threadId={binding.threadId} />
              <Button size="sm" variant="ghost" className="text-danger" isDisabled={busy} onPress={() => void act(async () => {
                if (await confirmDialog({ headline: t('revoke'), description: t('revokeConfirm'), confirmText: t('revoke'), danger: true })) await post(`/accounts/${account.id}/revoke`, { bindingId: binding.id });
              })}>{t('revoke')}</Button>
            </SettingRow>
          ))}
        </SectionCard>
      )}
      {deliveries.length > 0 && <SectionCard title={t('deliveryProblems')}>
        {deliveries.map(d => <div key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
          <span className="min-w-0 break-words">{t(`delivery.${d.status as 'failed' | 'uncertain'}`)}<code className="block text-xs text-muted">{d.error}</code></span>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" isDisabled={busy} onPress={() => void act(async () => {
              if (d.status === 'uncertain' && !await confirmDialog({ headline: t('retry'), description: t('uncertain'), confirmText: t('retry') })) return;
              await post(`/deliveries/${d.id}/retry`, { acknowledgeUncertain: d.status === 'uncertain' });
            })}>{t('retry')}</Button>
            <Button size="sm" variant="ghost" isDisabled={busy} onPress={() => void act(async () => {
              if (await confirmDialog({ headline: t('discard'), description: t('discardConfirm'), confirmText: t('discard') })) await post(`/deliveries/${d.id}/discard`);
            })}>{t('discard')}</Button>
          </div>
        </div>)}
      </SectionCard>}
      <div className="mt-4 flex flex-col gap-2 pb-2">
        <Button variant="ghost" fullWidth className="min-h-11 text-danger" isDisabled={busy} data-testid="gateway-remove" onPress={() => void act(async () => {
          if (!await confirmDialog({ headline: t('remove'), description: t('removeConfirm'), confirmText: t('remove'), danger: true })) return;
          await request(`/gateway/accounts/${account.id}`, { method: 'DELETE' });
          onRemoved(); toast.success(t('removed'));
        })}><Sym name="delete" />{t('remove')}</Button>
        <p className="text-center text-xs text-muted">{t('removeHint')}</p>
      </div>
    </section>
  );
}

function ConnectionDetails({ connection }: { connection?: GatewayConnectionDiagnostics }) {
  const { t } = useTranslation('gateway');
  if (!connection) return null;
  return <div className="flex flex-col gap-1 py-2 text-xs text-muted" data-testid="gateway-connection-details" aria-live="polite">
    {connection.error && <>
      <p className="text-warning">{t(`connectionErrors.${connection.error.code}`)}</p>
      <code className="break-words">{connection.error.code}{connection.error.httpStatus !== undefined ? ` · HTTP ${connection.error.httpStatus}` : ''}{connection.error.platformCode !== undefined ? ` · code ${connection.error.platformCode}` : ''}</code>
      <p>{t('connection.failures', { attempts: connection.consecutiveFailures })}</p>
    </>}
    {connection.retryAt !== undefined && <p>{t('connection.retryAt', { time: new Date(connection.retryAt).toLocaleTimeString() })}</p>}
    {connection.lastSuccessAt !== undefined && <p>{t('connection.lastSuccess', { time: new Date(connection.lastSuccessAt).toLocaleString() })}</p>}
  </div>;
}

function PairCode({ pair, channel, renew, busy }: { pair: { command: string; expiresAt: string }; channel: string; renew: () => Promise<void>; busy: boolean }) {
  const { t } = useTranslation('gateway');
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => { setCopied(false); setNow(Date.now()); }, [pair.command]);
  const minutes = Math.max(0, Math.ceil((Date.parse(pair.expiresAt) - now) / 60_000));
  return (
    <div className="flex flex-col items-center gap-3 py-3 text-center">
      <span className="text-sm text-muted">{t('pairSend', { channel })}</span>
      <code className="select-all rounded-xl bg-background-secondary px-4 py-3 font-mono text-xl tracking-wider" data-testid="gateway-pair-command">{pair.command}</code>
      <Button variant="secondary" className="min-h-11 min-w-32" isDisabled={minutes === 0} onPress={() => {
        if (!navigator.clipboard) { toast.error(t('copyFailed')); return; }
        void navigator.clipboard.writeText(pair.command).then(() => setCopied(true)).catch(() => toast.error(t('copyFailed')));
      }}>
        <Sym name={copied ? 'check' : 'content_copy'} />{copied ? t('copied') : t('copy')}
      </Button>
      <span className="text-xs text-muted">{minutes ? t('pairExpires', { minutes }) : t('pairExpired')}</span>
      <p className="text-sm text-muted">{t('pairWaiting')}</p>
      <Button variant="ghost" size="sm" isDisabled={busy} onPress={() => void renew()}>{t('pairRenew')}</Button>
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
  const [state, setState] = useState<'loading' | 'wait' | 'scaned' | 'confirmed' | 'expired' | 'verify' | 'blocked' | 'already_bound' | 'error'>('loading');
  const [identityChanged, setIdentityChanged] = useState(false);
  const [duplicate, setDuplicate] = useState(false);
  const [verifyCode, setVerifyCode] = useState('');
  const [round, setRound] = useState(0);
  const renewals = useRef(0);
  const verifyRef = useRef('');
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    let doneTimer: ReturnType<typeof setTimeout> | undefined;
    const pause = (ms: number) => new Promise<void>((resolve) => {
      const finish = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', finish); resolve(); };
      const timer = setTimeout(finish, ms);
      controller.signal.addEventListener('abort', finish, { once: true });
      if (controller.signal.aborted) finish();
    });
    void (async () => {
      setState('loading'); setIdentityChanged(false); setDuplicate(false); setVerifyCode(''); verifyRef.current = '';
      let current: { qrcode: string; qrDataUrl: string; redirectHost?: string };
      try { current = await post(`/accounts/${accountId}/login`, { action: 'qr' }, controller.signal); }
      catch { if (alive) setState('error'); return; }
      if (!alive) return;
      setQr(current); setState('wait');
      let failures = 0;
      while (alive) {
        let result: { status: string; redirectHost?: string };
        try {
          const code = verifyRef.current; verifyRef.current = '';
          result = await post(`/accounts/${accountId}/login`, { action: 'poll', qrcode: current.qrcode, ...(current.redirectHost ? { redirectHost: current.redirectHost } : {}), ...(code ? { verifyCode: code } : {}) }, controller.signal);
          failures = 0;
        } catch (error) {
          if (!alive) return;
          if ((error as Error).message === 'channel_identity_changed') { setIdentityChanged(true); setState('error'); return; }
          if ((error as Error).message === 'duplicate_channel_account') { setDuplicate(true); setState('error'); return; }
          if (++failures >= 3) { setState('error'); return; }
          await pause(1000 * 2 ** failures);
          continue;
        }
        if (!alive) return;
        if (result.redirectHost) current = { ...current, redirectHost: result.redirectHost };
        const status = result.status;
        if (status === 'confirmed') { setState('confirmed'); doneTimer = setTimeout(() => alive && doneRef.current(), 900); return; }
        if (status === 'binded_redirect') { setState('already_bound'); return; }
        if (status === 'verify_code_blocked') { setVerifyCode(''); verifyRef.current = ''; setState('blocked'); return; }
        if (status === 'expired') {
          if (renewals.current++ < 3) { setRound((value) => value + 1); return; }
          setState('expired'); return;
        }
        if (status === 'need_verifycode') {
          setVerifyCode(''); setState('verify');
          // Only submit a complete code after an explicit click; never retry a rejected code.
          while (alive && !verifyRef.current) await pause(200);
          continue;
        }
        setState(status.startsWith('scaned') ? 'scaned' : 'wait');
        await pause(300); // Some backends return "wait" immediately rather than holding the poll.
      }
    })();
    return () => { alive = false; controller.abort(); clearTimeout(doneTimer); };
  }, [accountId, round]);

  const label = state === 'blocked' ? t('qr.blocked') : state === 'already_bound' ? t('qr.alreadyBound') : state === 'verify' ? t('qr.verify')
    : state === 'scaned' ? t('qr.scanned') : state === 'confirmed' ? t('qr.confirmed') : state === 'expired' ? t('qr.expired') : t('qr.scan');
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
        <p className="text-base font-medium" role="status" aria-live="polite">{state === 'error' ? duplicate ? t('duplicateAccount') : identityChanged ? t('qr.identityChanged') : t('health.connection_failed') : label}</p>
        {(state === 'error' || state === 'blocked') && <Button variant="secondary" onPress={() => setRound((value) => value + 1)}>{t('qr.refresh')}</Button>}
        {state === 'already_bound' && <Button variant="secondary" onPress={() => doneRef.current()}>{t('back')}</Button>}
        {state === 'verify' && (
          <TextField className="w-48">
            <Label>{t('qr.verify')}</Label>
            <Input inputMode="numeric" autoComplete="one-time-code" maxLength={16} value={verifyCode} onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, ''))} />
          </TextField>
        )}
        {state === 'verify' && <Button variant="primary" isDisabled={!verifyCode} onPress={() => { verifyRef.current = verifyCode; setVerifyCode(''); setState('scaned'); }}>{t('qr.submit')}</Button>}
      </div>
    </SectionCard>
  );
}
