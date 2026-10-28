import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { Button } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import type { CloudConfig } from '@wangke/contracts/cloud';
import ModelsModule from '../components/settings/ModelsModule';
import { ModelSettingsContext } from '../components/settings/modelSettingsContext';
import { useSettings, type Provider } from '../store/settings';
import { LoadingButton, confirmDialog } from '../ui';
import { cloudRequest } from './state';
import { applyCloudConfig, flushCloud } from './sync';
import { cloudDiscoveryProviders, cloudEditorProviders, cloudModelConfig, cloudModelPreferences, cloudModelUpdate, cloudModelsDirty, cloudProviderDirty, createCloudModelDraft, modelSettingsError } from './modelSettings';
import { modelReferenceIssues } from '@wangke/contracts/model-settings';
import { registerSettingsLeaveGuard } from '../components/settingsDialogStore';

function CloudModelEditor({ initial, standalone, onDone }: { initial: CloudConfig; standalone: boolean; onDone?: () => void }) {
  const { t } = useTranslation('common');
  const [config, setConfig] = useState(initial);
  const [store] = useState(() => createCloudModelDraft(initial, useSettings.getState()));
  const settings = useStore(store);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [conflict, setConflict] = useState(false);
  const [focusIssue, setFocusIssue] = useState(0);
  const [editorGeneration, setEditorGeneration] = useState(0);
  const [editingConnection, setEditingConnection] = useState(false);
  const [savedPreferences, setSavedPreferences] = useState(() => JSON.stringify(cloudModelPreferences(store.getState())));
  const operation = useRef(false);
  const baseline = useRef(config);
  baseline.current = config;
  const issues = modelReferenceIssues(settings);
  const dirty = editingConnection || cloudModelsDirty(settings, config) || JSON.stringify(cloudModelPreferences(settings)) !== savedPreferences;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    if (standalone) return;
    return registerSettingsLeaveGuard(async () => {
      if (operation.current) return false;
      if (!dirtyRef.current) return true;
      return confirmDialog({ headline: '放弃未保存的模型设置？', description: '离开会丢弃本页未保存的编辑。已保存到服务器的连接不受影响。', confirmText: '放弃修改', danger: true });
    });
  }, [standalone]);
  // A saved key can change without ever being sent back to the browser. Fresh editor/save
  // identities prevent discovery results from a previous credential being reused.
  const [discoveryRevision, setDiscoveryRevision] = useState(() => crypto.randomUUID());
  useEffect(() => store.subscribe(() => { setMessage(''); setError(''); }), [store]);
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty]);

  function savedConfig(saved: CloudConfig) {
    baseline.current = saved;
    setConfig(saved);
    setDiscoveryRevision(crypto.randomUUID());
    applyCloudConfig(saved);
  }
  function showError(error: unknown) {
    setError(modelSettingsError(error));
    if (error instanceof Error && error.message === 'model_settings_conflict') setConflict(true);
  }
  async function saveProvider(provider: Provider) {
    if (operation.current) throw new Error('另一个保存操作正在进行，请稍后重试');
    operation.current = true; setBusy(true); setError(''); setMessage('');
    try {
      const payload = cloudModelConfig({ ...store.getState(), providers: [provider] }, baseline.current).providers[0];
      const saved = await cloudRequest<CloudConfig>(`/providers/${encodeURIComponent(provider.id)}`, {
        method: 'PUT', body: JSON.stringify({ provider: payload, modelRevision: baseline.current.modelRevision }),
      });
      savedConfig(saved);
      // Only the saved connection changes; other connections, defaults and capabilities stay as edited.
      const savedProvider = cloudEditorProviders(saved).find((p) => p.id === provider.id)!;
      const current = store.getState();
      store.setState({ providers: current.providers.some((p) => p.id === provider.id)
        ? current.providers.map((p) => p.id === provider.id ? savedProvider : p) : [...current.providers, savedProvider] });
      setMessage('连接已保存到服务器');
    } catch (error) { showError(error); throw new Error(modelSettingsError(error)); }
    finally { operation.current = false; setBusy(false); }
  }
  async function save(complete = false) {
    if (operation.current) return;
    if (editingConnection) { setError('当前新连接尚未保存，请先保存连接或取消编辑，再保存模型设置。'); return; }
    if (modelReferenceIssues(store.getState()).length) {
      setError('请先修复下方默认模型配置，或清除失效选择后稍后配置。');
      setFocusIssue((value) => value + 1);
      return;
    }
    operation.current = true;
    setBusy(true); setError(''); setMessage('');
    try {
      const draft = store.getState();
      const saved = await cloudRequest<CloudConfig>('/model-settings', { method: 'PUT', body: JSON.stringify(cloudModelUpdate(draft, baseline.current)) });
      savedConfig(saved);
      store.setState({ providers: cloudEditorProviders(saved), llmModel: saved.llmModel, visionModel: saved.visionModel,
        asrModel: saved.asrModel, decisionModel: saved.decisionModel ?? { providerId: '', model: '' } });
      useSettings.getState().update(cloudModelPreferences(draft));
      try { await flushCloud(); }
      catch {
        setMessage('连接与默认模型已保存到服务器');
        setError('模型库偏好同步失败，重试保存可继续同步。');
        return;
      }
      setSavedPreferences(JSON.stringify(cloudModelPreferences(draft)));
      setMessage('模型设置已保存到服务器'); setConflict(false);
      if (complete) onDone?.();
    } catch (e) { showError(e); }
    finally { operation.current = false; setBusy(false); }
  }
  async function reload() {
    if (operation.current) return;
    if (!await confirmDialog({ headline: '重新载入服务器设置？', description: '本页未保存的连接和默认模型编辑将被服务器当前设置替换。', confirmText: '重新载入' })) return;
    operation.current = true; setBusy(true);
    try {
      const saved = await cloudRequest<CloudConfig>('/config');
      const draft = createCloudModelDraft(saved, useSettings.getState()).getState();
      store.setState({ ...draft, update: store.getState().update });
      setSavedPreferences(JSON.stringify(cloudModelPreferences(draft)));
      savedConfig(saved); setConflict(false); setError(''); setMessage('已载入服务器设置');
      setEditorGeneration((value) => value + 1);
    } catch (error) { showError(error); }
    finally { operation.current = false; setBusy(false); }
  }
  return <div className="flex min-w-0 flex-col gap-5">
    <p className="text-sm text-muted">保存供应商连接后默认从 /models 接口获取模型，选择添加后设置默认用途；models.dev 仅补充缺失的模型参数。连接单独保存，默认模型与模型库编辑完成后保存，密钥加密保存在服务器。</p>
    {issues.length > 0 && <div className="rounded-xl bg-danger/10 p-3" role="status">
      <p className="text-sm text-danger">有 {issues.length} 项默认模型配置需要修复。你仍可独立保存连接并获取模型列表。</p>
      <Button variant="tertiary" size="sm" onPress={() => setFocusIssue((value) => value + 1)}>定位并修复</Button>
    </div>}
    <ModelSettingsContext.Provider value={store}>
      <fieldset disabled={busy} className="m-0 flex min-w-0 flex-col gap-5 border-0 p-0">
        <ModelsModule key={editorGeneration} serverManaged standalone={standalone} discoveryProviders={cloudDiscoveryProviders(settings, config, discoveryRevision)} providerNeedsSave={(provider) => cloudProviderDirty(provider, config)} onSaveProvider={saveProvider} onDraftChange={setEditingConnection} issues={issues} focusIssue={focusIssue} />
      </fieldset>
    </ModelSettingsContext.Provider>
    <div className="flex flex-wrap items-center gap-3">
      <LoadingButton loading={busy} onPress={() => void save()} data-testid="cloud-models-save">保存模型设置</LoadingButton>
      <span className="text-xs text-muted" data-testid="cloud-models-dirty">{dirty ? '有未保存修改' : '连接与默认模型已保存'}</span>
      {message && <p role="status" className="text-sm text-success">{message}</p>}
    </div>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {conflict && <Button variant="secondary" isDisabled={busy} className="self-start" onPress={() => void reload()}>重新载入服务器设置</Button>}
    {onDone && <div className="ob__actions">
      <LoadingButton className="ob__primary" size="lg" loading={busy} onPress={() => void save(true)} data-testid="onboarding-models-done">
        {busy ? t('onboarding.models.saving') : t('onboarding.models.done')}
      </LoadingButton>
      <Button className="ob__skip" variant="ghost" isDisabled={busy} onPress={onDone}>{t('onboarding.models.skip')}</Button>
    </div>}
  </div>;
}

export default function CloudModels({ standalone = false, onDone }: { standalone?: boolean; onDone?: () => void } = {}) {
  const [config, setConfig] = useState<CloudConfig>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setError('');
    void cloudRequest<CloudConfig>('/config').then((value) => { if (!cancelled) setConfig(value); })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [attempt]);
  if (!config) return error
    ? <div><p role="alert" className="text-danger">{error}</p><Button variant="secondary" onPress={() => setAttempt((n) => n + 1)}>重试</Button></div>
    : <p role="status">正在读取模型设置…</p>;
  return <CloudModelEditor initial={config} standalone={standalone} onDone={onDone} />;
}
