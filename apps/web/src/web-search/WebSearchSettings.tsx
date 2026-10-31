import { useEffect, useState } from 'react';
import { Button, Input, Switch } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import type { SearchProvider, SearchProviderKind, WebSearchConfig, WebSearchResult } from '@wangke/contracts/web-search';
import { cloudRequest } from '../cloud/state';
import { SettingSelect } from '../components/settings/controls';
import { registerSettingsLeaveGuard } from '../components/settingsDialogStore';
import { confirmDialog } from '../ui';
import WebSources from './WebSources';
import './web-search.css';
import settingsMessages from '../i18n/locales/zh-CN/settings.json';

const kinds: SearchProviderKind[] = ['tavily', 'brave', 'searxng'];
const names = { tavily: 'Tavily', brave: 'Brave Search', searxng: 'SearXNG' };
export default function WebSearchSettings() {
  const { t } = useTranslation('settings');
  const [config, setConfig] = useState<WebSearchConfig>();
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<WebSearchResult>();
  const [notice, setNotice] = useState('');
  const dirty = Boolean(config && JSON.stringify(config) !== saved);
  const message = (e: unknown) => {
    const code = e instanceof Error ? e.message : '';
    return t(`webSearch.errors.${Object.hasOwn(settingsMessages.webSearch.errors, code) ? code as keyof typeof settingsMessages.webSearch.errors : 'generic'}`);
  };
  useEffect(() => {
    const controller = new AbortController();
    void cloudRequest<WebSearchConfig>('/web-search/config', { signal: controller.signal }).then(value => { setConfig(value); setSaved(JSON.stringify(value)); }).catch(e => { if (!controller.signal.aborted) setError(message(e)); });
    return () => controller.abort();
  }, []);
  useEffect(() => registerSettingsLeaveGuard(async () => !dirty || await confirmDialog({ headline: t('webSearch.discard') })), [dirty, t]);
  const update = (patch: Partial<WebSearchConfig>) => { setConfig(current => current ? { ...current, ...patch } : current); setNotice(''); setResult(undefined); };
  const provider = (id: string, patch: Partial<SearchProvider>) => update({ providers: config!.providers.map(p => p.id === id ? { ...p, ...patch } : p) });
  async function act(work: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('');
    try { await work(); } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  async function reload() {
    const next = await cloudRequest<WebSearchConfig>('/web-search/config'); setConfig(next); setSaved(JSON.stringify(next)); setResult(undefined);
  }
  return <section className="web-settings" data-testid="web-search-settings">
    <div><h3 className="text-base font-semibold">{t('webSearch.title')}</h3><p className="mt-2 text-sm text-muted">{t('webSearch.description')}</p></div>
    {error ? <p role="alert" className="text-danger">{error}</p> : null}
    {notice ? <p role="status" className="text-success">{notice}</p> : null}
    {!config ? <Button isDisabled={busy} variant="secondary" onPress={() => void act(reload)}>{t('webSearch.reload')}</Button> : <>
      <fieldset disabled={busy} className="web-settings border-0 p-0">
        <Switch isSelected={config.enabled} onChange={enabled => update({ enabled })}><Switch.Content><Switch.Control><Switch.Thumb /></Switch.Control><span>{t('webSearch.enabled')}</span></Switch.Content></Switch>
        <Switch isSelected={config.fetchEnabled} onChange={fetchEnabled => update({ fetchEnabled })}><Switch.Content><Switch.Control><Switch.Thumb /></Switch.Control><span>{t('webSearch.fetchEnabled')}</span></Switch.Content></Switch>
        <SettingSelect label={t('webSearch.defaultProvider')} value={config.providerId} onChange={providerId => update({ providerId })} options={config.providers.filter(p => p.enabled).map(p => ({ id: p.id, label: p.name }))} />
        <Switch isSelected={config.fallback} onChange={fallback => update({ fallback })}><Switch.Content><Switch.Control><Switch.Thumb /></Switch.Control><span>{t('webSearch.fallback')}</span></Switch.Content></Switch>
        <p className="text-sm text-muted">{t('webSearch.fallbackHint')}</p>
        {config.providers.map(p => <div key={p.id} className="web-settings__provider">
          <div className="web-settings__row"><strong>{names[p.kind]}</strong><Button size="sm" variant="ghost" onPress={() => update({ providers: config.providers.filter(row => row.id !== p.id), ...(config.providerId === p.id ? { providerId: '', enabled: false } : {}) })}>{t('webSearch.remove')}</Button></div>
          <label className="web-settings__label">{t('webSearch.name')}<Input value={p.name} maxLength={80} onChange={e => provider(p.id, { name: e.target.value })} /></label>
          {p.kind === 'searxng' ? <><label className="web-settings__label">{t('webSearch.serverUrl')}<Input type="url" value={p.baseUrl ?? ''} placeholder="https://search.example.org" onChange={e => provider(p.id, { baseUrl: e.target.value })} /></label><p className="text-sm text-muted">{t('webSearch.searxHint')}</p></> : null}
          <label className="web-settings__label">{t('webSearch.key')}<Input type="password" autoComplete="new-password" value={p.apiKey ?? ''} placeholder={p.configured ? t('webSearch.keySaved') : t('webSearch.keyPlaceholder')} onChange={e => provider(p.id, { apiKey: e.target.value || undefined })} /></label>
          {p.configured ? <Button size="sm" variant="ghost" onPress={() => provider(p.id, { apiKey: '', configured: false, enabled: false })}>{t('webSearch.clearKey')}</Button> : null}
          <Switch isSelected={p.enabled} onChange={enabled => provider(p.id, { enabled })}><Switch.Content><Switch.Control><Switch.Thumb /></Switch.Control><span>{t('webSearch.providerEnabled')}</span></Switch.Content></Switch>
        </div>)}
        <div className="web-settings__row">{kinds.map(kind => <Button key={kind} variant="secondary" isDisabled={config.providers.length >= 12} onPress={() => {
          const id = crypto.randomUUID();
          update({ providers: [...config.providers, { id, kind, name: names[kind], enabled: false, ...(kind === 'searxng' ? { baseUrl: '' } : {}) }] });
        }}>{t('webSearch.add', { name: names[kind] })}</Button>)}</div>
      </fieldset>
      <div className="web-settings__row"><Button isDisabled={busy || !dirty} onPress={() => void act(async () => {
        const next = await cloudRequest<WebSearchConfig>('/web-search/config', { method: 'PUT', body: JSON.stringify(config) });
        setConfig(next); setSaved(JSON.stringify(next)); setNotice(t('webSearch.saved'));
      })}>{busy ? t('webSearch.working') : t('webSearch.save')}</Button><Button variant="ghost" isDisabled={busy} onPress={() => void act(async () => { if (!dirty || await confirmDialog({ headline: t('webSearch.discard') })) await reload(); })}>{t('webSearch.reload')}</Button></div>
      <div className="web-settings__provider"><label className="web-settings__label">{t('webSearch.testQuery')}<Input value={query} maxLength={1000} onChange={e => setQuery(e.target.value)} /></label><p className="text-sm text-muted">{t('webSearch.testHint')}</p><Button variant="secondary" isDisabled={busy || dirty || !config.enabled || !query.trim()} onPress={() => void act(async () => {
        setResult(undefined);
        setResult(await cloudRequest<WebSearchResult>('/web-search/test', { method: 'POST', body: JSON.stringify({ arguments: { query: query.trim(), limit: 4 } }) }));
      })}>{t('webSearch.test')}</Button>{result ? <WebSources result={result} /> : null}</div>
    </>}
  </section>;
}
