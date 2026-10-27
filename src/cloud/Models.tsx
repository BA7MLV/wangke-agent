import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { Button } from '@heroui/react';
import type { CloudConfig } from '../../packages/contracts/src/cloud';
import ModelsModule from '../components/settings/ModelsModule';
import { ModelSettingsContext } from '../components/settings/modelSettingsContext';
import { useSettings } from '../store/settings';
import { LoadingButton } from '../ui';
import { cloudRequest } from './state';
import { applyCloudConfig, flushCloud } from './sync';
import { cloudDiscoveryProviders, cloudEditorProviders, cloudModelConfig, cloudModelPreferences, createCloudModelDraft } from './modelSettings';

function CloudModelEditor({ initial, standalone }: { initial: CloudConfig; standalone: boolean }) {
  const [config, setConfig] = useState(initial);
  const [store] = useState(() => createCloudModelDraft(initial, useSettings.getState()));
  const settings = useStore(store);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  // A saved key can change without ever being sent back to the browser. Fresh editor/save
  // identities prevent discovery results from a previous credential being reused.
  const [discoveryRevision, setDiscoveryRevision] = useState(() => crypto.randomUUID());
  useEffect(() => store.subscribe(() => { setMessage(''); setError(''); }), [store]);
  async function save() {
    setBusy(true); setError(''); setMessage('');
    try {
      const draft = store.getState();
      // Account controls have their own editor; preserve its latest policy/passkey-related settings.
      const latest = await cloudRequest<CloudConfig>('/config');
      const saved = await cloudRequest<CloudConfig>('/config', { method: 'PUT', body: JSON.stringify(cloudModelConfig(draft, latest)) });
      setConfig(saved);
      setDiscoveryRevision(crypto.randomUUID());
      store.setState({ providers: cloudEditorProviders(saved) });
      applyCloudConfig(saved);
      useSettings.getState().update(cloudModelPreferences(draft));
      await flushCloud();
      setMessage('模型设置已保存到服务器');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <div className="flex min-w-0 flex-col gap-5">
    <p className="text-sm text-muted">Provider 与模型能力直接从 models.dev 获取。模型密钥加密保存在服务器；编辑完成后保存生效。</p>
    <ModelSettingsContext.Provider value={store}>
      <fieldset disabled={busy} className="m-0 flex min-w-0 flex-col gap-5 border-0 p-0">
        <ModelsModule serverManaged standalone={standalone} discoveryProviders={cloudDiscoveryProviders(settings, config, discoveryRevision)} />
      </fieldset>
    </ModelSettingsContext.Provider>
    <div className="flex flex-wrap items-center gap-3">
      <LoadingButton loading={busy} onPress={() => void save()} data-testid="cloud-models-save">保存模型设置</LoadingButton>
      {message && <p role="status" className="text-sm text-success">{message}</p>}
    </div>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
  </div>;
}

export default function CloudModels({ standalone = false }: { standalone?: boolean } = {}) {
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
  return <CloudModelEditor initial={config} standalone={standalone} />;
}
