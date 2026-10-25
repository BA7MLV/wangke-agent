import { useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { request, serverClient } from '../api/serverClient';
import { confirmDialog } from '../ui';

interface Account { id: string; channel: string; agentId: string; preset: string; enabled: number; health: string; bindings: Array<{ id: string; peer: string; threadId: string; revoked: number }> }
interface Activity { accounts: Account[]; deliveries: Array<{ id: string; channel: string; status: string; attempts: number; error: string | null }>; reminders: Array<{ id: string; text: string; timezone: string; nextAt: number; intervalSeconds: number | null; status: string }>; inboxFailures: Array<{ id: number; channel: string; error: string }>; projectionFailures: Array<{ eventId: number; channel: string; threadId: string; error: string }> }
const blank = { id: '', channel: 'feishu', agentId: '', preset: 'autonomous', enabled: false };
export default function GatewaySettings() {
  const { t } = useTranslation('gateway');
  const [data, setData] = useState<Activity>();
  const [agents, setAgents] = useState<Array<{ id: string; name: string }>>([]);
  const [form, setForm] = useState(blank);
  const [appId, setAppId] = useState(''); const [appSecret, setAppSecret] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [login, setLogin] = useState<{ account: string; qrcode: string; qrDataUrl: string; status: string; redirectHost?: string }>();
  const [verifyCode, setVerifyCode] = useState('');
  const refresh = async () => setData(await request<Activity>('/gateway'));
  useEffect(() => {
    const controller = new AbortController(); let disposed = false, timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try { const value = await request<Activity>('/gateway', { signal: controller.signal }); if (!disposed) setData(value); }
      catch (e) { if (!disposed) setError((e as Error).message); }
      if (!disposed) timer = setTimeout(() => void poll(), 4000);
    }
    void poll(); void serverClient.agents().then(r => { if (!disposed) setAgents(r.agents); }).catch(e => { if (!disposed) setError(e.message); });
    return () => { disposed = true; controller.abort(); clearTimeout(timer); };
  }, []);
  async function act(fn: () => Promise<unknown>) { setBusy(true); setError(''); try { await fn(); await refresh(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  const post = <T,>(path: string, body: unknown = {}) => request<T>(`/gateway${path}`, { method: 'POST', body: JSON.stringify(body) });
  async function save(a = form) {
    const config: Record<string, string> = {}; if (appId) config.appId = appId; if (appSecret) config.appSecret = appSecret;
    await post('/accounts', { ...a, id: a.id || undefined, config }); setAppId(''); setAppSecret(''); setNotice(t('saved')); setForm(blank);
  }
  return <section aria-label={t('title')} className="flex min-w-0 flex-col gap-4" data-testid="gateway-settings">
    <h3 className="text-lg font-semibold">{t('title')}</h3><p className="text-sm text-muted">{t('intro')}</p>
    <p className="text-sm text-muted">{t('secretHint')}</p><p className="text-sm text-muted">{t('permissions')}</p>
    <fieldset className="flex min-w-0 flex-col gap-3 rounded-xl border border-border p-4">
      <legend>{form.id ? t('edit') : t('new')}</legend>
      <label>{t('channel')}<select className="input w-full" disabled={!!form.id} value={form.channel} onChange={e => setForm({ ...form, channel: e.target.value })}><option value="feishu">飞书 / Feishu</option><option value="ilink">微信 / WeChat iLink</option></select></label>
      <label>{t('agent')}<select className="input w-full" value={form.agentId} onChange={e => setForm({ ...form, agentId: e.target.value })}><option value="">—</option>{agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
      <label>{t('preset')}<select className="input w-full" value={form.preset} onChange={e => setForm({ ...form, preset: e.target.value })}><option value="inherit">{t('inherit')}</option><option value="autonomous">{t('autonomous')}</option></select></label>
      {form.channel === 'feishu' ? <><label>{t('appId')}<input className="input w-full" value={appId} onChange={e => setAppId(e.target.value)} autoComplete="off" /></label><label>{t('appSecret')}<input className="input w-full" type="password" value={appSecret} onChange={e => setAppSecret(e.target.value)} autoComplete="new-password" /></label></> : null}
      <label className="flex items-center gap-2"><input type="checkbox" checked={form.enabled} onChange={e => setForm({ ...form, enabled: e.target.checked })} />{t('enabled')}</label>
      <Button isDisabled={busy || !form.agentId} onPress={() => void act(() => save())}>{t('save')}</Button>
    </fieldset>
    {data?.accounts.map(a => <div key={a.id} className="flex min-w-0 flex-col gap-3 rounded-xl border border-border p-4">
      <strong>{a.channel} · {a.health} · {a.enabled ? t('enabled') : t('disabled')}</strong>
      <div className="flex flex-wrap gap-2"><Button variant="secondary" isDisabled={busy} onPress={() => { setForm({ id: a.id, channel: a.channel, agentId: a.agentId, preset: a.preset, enabled: !!a.enabled }); setAppId(''); setAppSecret(''); }}>{t('edit')}</Button>
        <Button variant="secondary" isDisabled={busy} onPress={() => void act(async () => { await post('/accounts', { ...a, enabled: !a.enabled, config: {} }); })}>{a.enabled ? t('disabled') : t('enabled')}</Button>
        <Button variant="secondary" isDisabled={busy} onPress={() => void act(async () => { const r = await post<{ command: string; expiresAt: string }>(`/accounts/${a.id}/pair`); setNotice(`${r.command}\n${r.expiresAt}`); })}>{t('pair')}</Button>
        {a.channel === 'ilink' ? <Button variant="secondary" isDisabled={busy} onPress={() => void act(async () => { const r = await post<{ qrcode: string; qrDataUrl: string; status: string }>(`/accounts/${a.id}/login`, { action: 'qr' }); setLogin({ ...r, account: a.id }); setVerifyCode(''); })}>{t('qr')}</Button> : null}
      </div>
      {a.bindings.map(b => <div key={b.id} className="flex flex-wrap items-center gap-2"><span className="break-all text-sm">{b.peer} · {b.revoked ? t('disabled') : t('bindings')}</span><a href={`#/bot?thread=${encodeURIComponent(b.threadId)}`}>{t('takeover')}</a>{!b.revoked ? <Button variant="secondary" isDisabled={busy} onPress={() => void act(async () => { if (await confirmDialog({ headline: t('revoke'), description: t('revokeConfirm'), confirmText: t('revoke'), danger: true })) await post(`/accounts/${a.id}/revoke`, { bindingId: b.id }); })}>{t('revoke')}</Button> : null}</div>)}
    </div>)}
    {login ? <div className="flex flex-col items-start gap-3"><img width={300} height={300} className="max-w-full" src={login.qrDataUrl} alt={t('qr')} /><p role="status">{t('loginState')}: {login.status}</p><label>{t('verify')}<input className="input w-full" inputMode="numeric" autoComplete="one-time-code" value={verifyCode} onChange={e => setVerifyCode(e.target.value)} placeholder={t('verifyHint')} /></label><Button isDisabled={busy || ['confirmed','expired','verify_code_blocked'].includes(login.status)} onPress={() => void act(async () => { const r = await post<{ status: string; redirectHost?: string }>(`/accounts/${login.account}/login`, { action: 'poll', qrcode: login.qrcode, verifyCode, redirectHost: login.redirectHost }); setLogin({ ...login, ...r }); setVerifyCode(''); })}>{t('poll')}</Button></div> : null}
    <p className="text-sm text-muted">{t('threadHint')}</p><p className="text-sm text-muted">{t('limits')}</p>
    <h4>{t('deliveries')}</h4>
    {data?.deliveries.length === 0 ? <p>{t('empty')}</p> : null}
    {data?.deliveries.map(d => <div key={d.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-default p-2"><span className="break-all text-sm">{d.channel} · {d.status} · {d.attempts} · {d.error}</span>{['failed','uncertain'].includes(d.status) ? <Button variant="secondary" isDisabled={busy} onPress={() => void act(async () => { if (d.status !== 'uncertain' || await confirmDialog({ headline: t('retry'), description: t('uncertain'), confirmText: t('retry') })) await post(`/deliveries/${d.id}/retry`, { acknowledgeUncertain: d.status === 'uncertain' }); })}>{t('retry')}</Button> : null}{['pending','failed','uncertain'].includes(d.status) ? <Button variant="secondary" isDisabled={busy} onPress={() => void act(async () => { if (await confirmDialog({ headline: t('discard'), description: t('discardConfirm'), confirmText: t('discard') })) await post(`/deliveries/${d.id}/discard`); })}>{t('discard')}</Button> : null}</div>)}
    <h4>{t('reminders')}</h4>{data?.reminders.length === 0 ? <p>{t('empty')}</p> : null}
    {data?.reminders.map(r => <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-default p-2"><span className="min-w-0 break-words text-sm">{r.text} · {new Date(r.nextAt).toLocaleString()} · {r.timezone} · {r.intervalSeconds ? `${r.intervalSeconds}s` : '1×'} · {r.status}</span>{r.status === 'active' ? <Button variant="secondary" isDisabled={busy} onPress={() => void act(() => post(`/reminders/${r.id}/cancel`))}>{t('cancel')}</Button> : null}</div>)}
    {data?.inboxFailures.length ? <details><summary>{t('inboundFailures')}</summary>{data.inboxFailures.map(f => <p key={f.id}>{f.channel} · {f.id} · {f.error}</p>)}</details> : null}
    {data?.projectionFailures.length ? <details><summary>{t('projectionFailures')}</summary>{data.projectionFailures.map(f => <p key={`${f.threadId}:${f.eventId}`}>{f.channel} · {f.eventId} · {f.error} · <a href={`#/bot?thread=${encodeURIComponent(f.threadId)}`}>{t('takeover')}</a></p>)}</details> : null}
    {notice ? <pre role="status" className="whitespace-pre-wrap break-all text-sm">{notice}</pre> : null}{error ? <p role="alert" className="text-danger">{error}</p> : null}
  </section>;
}
