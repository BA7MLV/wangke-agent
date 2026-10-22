import { useCallback, useEffect, useRef, useState } from 'react';
import type { Provider } from '../store/settings';
import { modelListCacheKey, modelListIdentity, pruneModelLists, readModelList } from '../api/modelListCache';
import { discoverModels } from '../api/modelDiscovery';
import type { DiscoveredModel } from '../api/modelDiscoveryData';

interface DiscoveryState {
  ids?: string[];
  models?: DiscoveredModel[];
  note?: string;
  loading: boolean;
}

/** 仅手动查找时请求接口；本地缓存和发现结果都不自动覆盖已保存的模型。 */
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
      const cached = readModelList(await modelListCacheKey(provider));
      if (!current()) return null;
      setStates((prev) => ({ ...prev, [identity]: { ids, models: cached?.models, note: `${ids.length} 个可用模型（列表不代表调用测试通过）`, loading: false } }));
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
          next[identity] = { ...prev[identity], ids: prev[identity]?.ids ?? cached?.ids, models: prev[identity]?.models ?? cached?.models,
            loading: prev[identity]?.loading ?? false,
            note: prev[identity]?.note ?? (cached ? `${cached.ids.length} 个模型 · ${cached.stale ? '过期缓存' : '缓存'}` : undefined) };
        });
        return next;
      });
    })().catch((error) => {
      if (controller.signal.aborted) return;
      const selected = configured.find((p) => p.id === selectedProviderId);
      if (!selected) return;
      const identity = modelListIdentity(selected);
      setStates((prev) => ({ ...prev, [identity]: { ...prev[identity], loading: false,
        note: `读取模型缓存失败：${error instanceof Error ? error.message : String(error)}` } }));
    });
    return () => controller.abort();
    // 切换详情或连接身份时取消旧请求、恢复本地缓存；缺失或过期也不自动联网。
  }, [providersKey, selectedProviderId]);

  const modelOptions: Record<string, string[]> = {};
  const discoveredModels: Record<string, DiscoveredModel[]> = {};
  const providerNotes: Record<string, string> = {};
  for (const p of providers) {
    const state = states[modelListIdentity(p)];
    if (state?.ids) modelOptions[p.id] = state.ids;
    if (state?.models) discoveredModels[p.id] = state.models;
    if (state?.note) providerNotes[p.id] = state.note;
  }
  const selected = providers.find((p) => p.id === selectedProviderId);
  return { modelOptions, discoveredModels, providerNotes, refresh, checking: selected ? states[modelListIdentity(selected)]?.loading ?? false : false };
}
