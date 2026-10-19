import { useCallback, useEffect, useRef, useState } from 'react';
import type { Provider } from '../store/settings';
import { modelListCacheKey, modelListIdentity, pruneModelLists, readModelList } from '../api/modelListCache';
import { discoverModels } from '../api/modelDiscovery';

interface DiscoveryState {
  ids?: string[];
  note?: string;
  loading: boolean;
}

/** 候选列表只是发现结果，不自动覆盖用户保存的模型配置。 */
export function useProviderModels(providers: Provider[], selectedProviderId: string | null) {
  const [states, setStates] = useState<Record<string, DiscoveryState>>({});
  const lifecycle = useRef<AbortController | null>(null);
  const sequences = useRef(new Map<string, number>());
  const providersRef = useRef(providers);
  providersRef.current = providers;
  const providersKey = JSON.stringify(providers.map((p) => [p.id, modelListIdentity(p)]));

  const refresh = useCallback(async (provider: Provider, signal = lifecycle.current?.signal) => {
    if (!signal || signal.aborted) return null;
    const identity = modelListIdentity(provider);
    const sequence = (sequences.current.get(identity) ?? 0) + 1;
    sequences.current.set(identity, sequence);
    const current = () => !signal.aborted && sequences.current.get(identity) === sequence
      && providersRef.current.some((p) => p.id === provider.id && modelListIdentity(p) === identity);
    setStates((prev) => ({ ...prev, [identity]: { ...prev[identity], loading: true } }));
    try {
      const ids = await discoverModels(provider, signal);
      if (!current()) return null;
      setStates((prev) => ({ ...prev, [identity]: { ids, note: `${ids.length} 个可用模型（列表不代表调用测试通过）`, loading: false } }));
      return ids;
    } catch (error) {
      if (signal.aborted && sequences.current.get(identity) === sequence) {
        setStates((prev) => ({ ...prev, [identity]: { ...prev[identity], loading: false } }));
      }
      if (!current()) return null;
      setStates((prev) => ({ ...prev, [identity]: { ...prev[identity], loading: false,
        note: `拉取失败：${error instanceof Error ? error.message : String(error)}。如接口不支持列出模型，可手动添加。` } }));
      throw error;
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    const configured = providersRef.current.filter((p) => p.baseUrl.trim() && p.apiKey.trim());
    void (async () => {
      const keys = await Promise.all(configured.map(modelListCacheKey));
      if (controller.signal.aborted) return;
      pruneModelLists(keys);
      setStates((prev) => {
        if (controller.signal.aborted) return prev;
        const next: Record<string, DiscoveryState> = {};
        configured.forEach((p, index) => {
          const identity = modelListIdentity(p);
          const cached = readModelList(keys[index]);
          next[identity] = { ...prev[identity], ids: prev[identity]?.ids ?? cached?.ids,
            loading: prev[identity]?.loading ?? false,
            note: prev[identity]?.note ?? (cached ? `${cached.ids.length} 个模型 · ${cached.stale ? '过期缓存' : '缓存'}` : undefined) };
        });
        return next;
      });
      const index = configured.findIndex((p) => p.id === selectedProviderId);
      if (index >= 0) {
        const cached = readModelList(keys[index]);
        if (!cached || cached.stale) await refresh(configured[index], controller.signal);
      }
    })().catch((error) => {
      if (controller.signal.aborted) return;
      const selected = configured.find((p) => p.id === selectedProviderId);
      if (!selected) return;
      const identity = modelListIdentity(selected);
      setStates((prev) => ({ ...prev, [identity]: { ...prev[identity], loading: false,
        note: prev[identity]?.note?.startsWith('拉取失败') ? prev[identity].note
          : `拉取失败：${error instanceof Error ? error.message : String(error)}` } }));
    });
    return () => controller.abort();
    // 只在连接身份或当前详情变化时重新发现，不因其他设置变化而请求。
  }, [providersKey, selectedProviderId, refresh]);

  const modelOptions: Record<string, string[]> = {};
  const providerNotes: Record<string, string> = {};
  for (const p of providers) {
    const state = states[modelListIdentity(p)];
    if (state?.ids) modelOptions[p.id] = state.ids;
    if (state?.note) providerNotes[p.id] = state.note;
  }
  const selected = providers.find((p) => p.id === selectedProviderId);
  return { modelOptions, providerNotes, refresh, checking: selected ? states[modelListIdentity(selected)]?.loading ?? false : false };
}
