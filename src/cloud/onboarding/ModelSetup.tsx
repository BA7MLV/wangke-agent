import { useEffect, useMemo, useState } from 'react';
import { Button, Input, Label, Spinner, TextField } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import type { CloudConfig, CloudProvider } from '../../../packages/contracts/src/cloud';
import { cloudRequest } from '../state';
import { applyCloudConfig } from '../sync';
import { Sym } from '../../ui';
import { fitsSlot, findModel, loadCatalog, modelsForSlot, providersForSlot, type Catalog, type CatalogModel, type CatalogProvider, type CatalogSlot } from '../../api/catalog';
import { CUSTOM_PROVIDER, applyChoice, slotRef, type SlotChoice } from './models';

const SLOTS = ['chat', 'vision', 'asr', 'decision'] as const satisfies readonly CatalogSlot[];
/** 列表里最多直接摊开多少个模型；再多就靠搜索。 */
const MODEL_LIMIT = 40;

/**
 * 引导里的「选择模型」。四个槽位一张分组列表，点进去选供应商 → 填 Key → 选模型。
 * 供应商和模型能力来自 models.dev 快照（src/api/catalog），整页可以跳过，之后在设置里改。
 */
export default function ModelSetup({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation('common');
  const [config, setConfig] = useState<CloudConfig>();
  const [catalog, setCatalog] = useState<Catalog>();
  const [editing, setEditing] = useState<CatalogSlot | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    void cloudRequest<CloudConfig>('/config').then(setConfig).catch((e) => setError((e as Error).message));
    void loadCatalog().then(setCatalog).catch((e) => setError((e as Error).message));
  }, []);

  if (!config || !catalog) {
    return <div className="ob-models__loading" role="status">{error ? <p className="ob__error">{error}</p> : <Spinner aria-label={t('onboarding.loading')} />}</div>;
  }

  const finish = async () => {
    if (!dirty) return onDone();
    setBusy(true); setError('');
    try {
      const saved = await cloudRequest<CloudConfig>('/config', { method: 'PUT', body: JSON.stringify(config) });
      applyCloudConfig(saved);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  };

  if (editing) {
    return <SlotPicker key={editing} slot={editing} config={config} catalog={catalog}
      onCancel={() => setEditing(null)}
      onPick={(choice) => { setConfig(applyChoice(config, editing, choice)); setDirty(true); setEditing(null); }}
      onClear={() => { setConfig(applyChoice(config, editing, null)); setDirty(true); setEditing(null); }} />;
  }

  const chat = slotRef(config, 'chat');
  const chatModel = chat.model ? findModel(catalog, providerCatalog(config, chat.providerId), chat.model) : undefined;

  return <div className="ob-models">
    <div className="ob__group ob-models__list">
      {SLOTS.map((slot) => {
        const ref = slotRef(config, slot);
        const provider = config.providers.find((p) => p.id === ref.providerId);
        const meta = ref.model ? findModel(catalog, provider?.catalogId ?? '', ref.model) : undefined;
        const value = ref.model ? (meta?.name ?? ref.model)
          : slot === 'vision' && chatModel && fitsSlot(chatModel, 'vision') ? t('onboarding.models.followChat')
            : t('onboarding.models.none');
        return <button key={slot} type="button" className="ob-row" onClick={() => setEditing(slot)} data-filled={ref.model ? '' : undefined}>
          <span className="ob-row__text">
            <span className="ob-row__title">{t(`onboarding.models.slot.${slot}`)}</span>
            <span className="ob-row__hint">{t(`onboarding.models.hint.${slot}`)}</span>
          </span>
          <span className="ob-row__value">{value}</span>
          <Sym name="chevron_right" className="ob-row__chevron" />
        </button>;
      })}
    </div>
    <p className="ob__error" role="alert">{error}</p>
    <div className="ob__actions">
      <Button className="ob__primary" size="lg" isDisabled={busy} onPress={() => void finish()}>
        {busy ? <><Spinner size="sm" color="current" />{t('onboarding.models.saving')}</> : t('onboarding.models.done')}
      </Button>
      <Button className="ob__skip" variant="ghost" isDisabled={busy} onPress={onDone}>{t('onboarding.models.skip')}</Button>
    </div>
  </div>;
}

function providerCatalog(config: CloudConfig, providerId: string): string {
  return config.providers.find((p) => p.id === providerId)?.catalogId ?? '';
}

function SlotPicker({ slot, config, catalog, onCancel, onPick, onClear }: {
  slot: CatalogSlot; config: CloudConfig; catalog: Catalog;
  onCancel: () => void; onPick: (choice: SlotChoice) => void; onClear: () => void;
}) {
  const { t } = useTranslation('common');
  const current = slotRef(config, slot);
  const currentProvider = config.providers.find((p) => p.id === current.providerId);
  const providers = useMemo(() => providersForSlot(catalog, slot), [catalog, slot]);
  const [providerId, setProviderId] = useState<string>(() => currentProvider
    ? (catalog.providers.some((p) => p.id === currentProvider.catalogId) ? currentProvider.catalogId : CUSTOM_PROVIDER)
    : '');
  const [providerQuery, setProviderQuery] = useState('');
  const [modelQuery, setModelQuery] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(() => (currentProvider && providerId === CUSTOM_PROVIDER ? currentProvider.baseUrl : ''));
  const [modelId, setModelId] = useState(current.model);

  const custom = providerId === CUSTOM_PROVIDER;
  const entry = providers.find((p) => p.id === providerId);
  // 同一家已经在服务器上存过 Key 时，可以不再填。
  const saved: CloudProvider | undefined = custom ? (currentProvider && !catalog.providers.some((p) => p.id === currentProvider.catalogId) ? currentProvider : undefined)
    : config.providers.find((p) => p.catalogId === providerId);
  const keyReady = !!apiKey.trim() || !!saved?.configured || !!saved?.apiKey;
  const models = entry ? modelsForSlot(entry, slot) : [];
  const shownModels = filterModels(models, modelQuery);
  const shownProviders = providerQuery.trim()
    ? providers.filter((p) => `${p.name} ${p.id}`.toLowerCase().includes(providerQuery.trim().toLowerCase()))
    : providers;
  const urlReady = !custom || /^https?:\/\/\S+$/.test(baseUrl.trim());
  const ready = !!providerId && !!modelId.trim() && keyReady && urlReady;

  const choose = (id: string) => {
    setProviderId(id);
    setModelQuery('');
    setApiKey('');
    if (id !== providerId) setModelId('');
  };

  const pick = () => onPick(custom
    ? { kind: 'custom', baseUrl: baseUrl.trim(), apiKey: apiKey.trim() || undefined, model: modelId.trim(), existingId: saved?.id }
    : { kind: 'catalog', provider: entry!, apiKey: apiKey.trim() || undefined, model: modelId.trim() });

  return <div className="ob-picker">
    <div className="ob-picker__bar">
      <Button variant="ghost" size="sm" onPress={onCancel} aria-label={t('onboarding.back')}><Sym name="chevron_left" />{t('onboarding.models.title')}</Button>
      <h2 className="ob-picker__title">{t(`onboarding.models.slot.${slot}`)}</h2>
      {current.model ? <Button variant="ghost" size="sm" className="ob-picker__clear" onPress={onClear}>{t('onboarding.models.clear')}</Button> : <span />}
    </div>

    {!providerId || (!custom && !entry) ? <>
      <div className="ob__group">
        <TextField fullWidth>
          <Label className="sr-only">{t('onboarding.models.searchProvider')}</Label>
          <Input className="ob__input" type="search" placeholder={t('onboarding.models.searchProvider')} value={providerQuery} onChange={(e) => setProviderQuery(e.target.value)} autoComplete="off" />
        </TextField>
      </div>
      <div className="ob__group ob-picker__options" role="listbox" aria-label={t('onboarding.models.provider')}>
        {shownProviders.map((p) => <button key={p.id} type="button" role="option" aria-selected={false} className="ob-row ob-row--compact" onClick={() => choose(p.id)}>
          <span className="ob-row__title">{p.name}</span>
          <span className="ob-row__value">{modelsForSlot(p, slot).length}</span>
          <Sym name="chevron_right" className="ob-row__chevron" />
        </button>)}
        <button type="button" role="option" aria-selected={false} className="ob-row ob-row--compact" onClick={() => choose(CUSTOM_PROVIDER)}>
          <span className="ob-row__title">{t('onboarding.models.custom')}</span>
          <Sym name="chevron_right" className="ob-row__chevron" />
        </button>
      </div>
    </> : <>
      <div className="ob__group">
        <button type="button" className="ob-row ob-row--compact" onClick={() => choose('')}>
          <span className="ob-row__title">{t('onboarding.models.provider')}</span>
          <span className="ob-row__value">{custom ? t('onboarding.models.custom') : entry!.name}</span>
          <Sym name="chevron_right" className="ob-row__chevron" />
        </button>
        {custom && <TextField fullWidth isRequired>
          <Label className="sr-only">{t('onboarding.models.baseUrl')}</Label>
          <Input className="ob__input" type="url" inputMode="url" placeholder="https://…/v1" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} autoComplete="off" spellCheck={false} />
        </TextField>}
        <TextField fullWidth isRequired={!saved}>
          <Label className="sr-only">{t('onboarding.models.apiKey')}</Label>
          <Input className="ob__input" type="password" placeholder={saved?.configured || saved?.apiKey ? t('onboarding.models.apiKeySaved') : t('onboarding.models.apiKey')} value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="new-password" spellCheck={false} />
        </TextField>
        {custom && <TextField fullWidth isRequired>
          <Label className="sr-only">{t('onboarding.models.modelId')}</Label>
          <Input className="ob__input" placeholder={t('onboarding.models.modelId')} value={modelId} onChange={(e) => setModelId(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} />
        </TextField>}
      </div>

      {!custom && <>
        {models.length > 8 && <div className="ob__group">
          <TextField fullWidth>
            <Label className="sr-only">{t('onboarding.models.searchModel')}</Label>
            <Input className="ob__input" type="search" placeholder={t('onboarding.models.searchModel')} value={modelQuery} onChange={(e) => setModelQuery(e.target.value)} autoComplete="off" />
          </TextField>
        </div>}
        <div className="ob__group ob-picker__options" role="listbox" aria-label={t('onboarding.models.model')}>
          {shownModels.map((m) => <button key={m.id} type="button" role="option" aria-selected={m.id === modelId} className="ob-row ob-row--compact" data-selected={m.id === modelId || undefined} onClick={() => setModelId(m.id)}>
            <span className="ob-row__text">
              <span className="ob-row__title">{m.name}</span>
              <Capabilities model={m} />
            </span>
            {m.id === modelId && <Sym name="check" className="ob-row__check" />}
          </button>)}
        </div>
      </>}

      <div className="ob__actions">
        <Button className="ob__primary" size="lg" isDisabled={!ready} onPress={pick}>{t('onboarding.models.use')}</Button>
      </div>
    </>}
  </div>;
}

function filterModels(models: CatalogModel[], query: string): CatalogModel[] {
  const q = query.trim().toLowerCase();
  const list = q ? models.filter((m) => `${m.name} ${m.id}`.toLowerCase().includes(q)) : models;
  return list.slice(0, MODEL_LIMIT);
}

function Capabilities({ model }: { model: CatalogModel }) {
  const { t } = useTranslation('common');
  const input = model.input ?? ['text'];
  const tags = [
    input.includes('image') && t('onboarding.models.cap.vision'),
    input.includes('audio') && t('onboarding.models.cap.audio'),
    model.reasoning && t('onboarding.models.cap.reasoning'),
    model.toolCall && t('onboarding.models.cap.tools'),
    model.context && formatContext(model.context),
  ].filter(Boolean) as string[];
  if (!tags.length) return null;
  return <span className="ob-row__hint">{tags.join(' · ')}</span>;
}

function formatContext(tokens: number): string {
  return tokens >= 1_000_000 ? `${+(tokens / 1_000_000).toFixed(1)}M` : `${Math.round(tokens / 1000)}K`;
}

export type { CatalogProvider };
