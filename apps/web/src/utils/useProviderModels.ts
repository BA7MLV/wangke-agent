import { useCallback, useEffect, useRef, useState } from 'react';
import type { Provider } from '../store/settings';
import { modelListCacheKey, modelListIdentity, pruneModelLists, readModelList, type ModelListConnection } from '../api/modelListCache';
import { discoverModels } from '../api/modelDiscovery';
import type { DiscoveredModel } from '../api/modelDiscoveryData';
import { ApiError } from '../api/siliconflow';

function discoveryFailure(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 401) return '供应商拒绝了当前凭据，请检查 API Key 并保存连接后重试。';
    if (error.status === 403) return '当前凭据没有访问模型列表的权限，请检查账号权限；也可手动添加已获授权的模型。';
    if ([404, 405, 501].includes(error.status)) return '接口未提供模型列表，请确认 API 地址，或手动添加已获授权的模型。';
    if (error.status === 429) return '供应商请求频率或配额受限，请稍后重试。';
  }
  return `${error instanceof Error ? error.message : String(error)}。可重试，或手动添加已获授权的模型。`;
}

interface DiscoveryState {
  ids?: string[];
  models?: DiscoveredModel[];
  note?: string;
  loading: boolean;
}
export type DiscoveryProvider = Provider & ModelListConnection;

/** 进入供应商详情时默认拉取接口列表；缓存和发现结果不自动加入模型库。 */
export function useProviderModels(providers: DiscoveryProvider[], selectedProviderId: string | null) {
  const [states, setStates] = useState<Record<string, DiscoveryState>>({});
  const lifecycle = useRef<AbortController | null>(null);
  const sequences = useRef(new Map<string, number>());
  const providersRef = useRef(providers);
  providersRef.current = providers;
  const providersKey = JSON.stringify(providers.map((p) => [p.id, modelListIdentity(p)]));
  const selected = providers.find((p) => p.id === selectedProviderId);
  const selectedIdentity = selected ? modelListIdentity(selected) : '';

  const refresh = useCallback(async (provider: DiscoveryProvider, signal = lifecycle.current?.signal) => {
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
        note: `拉取失败：${discoveryFailure(error)}` } }));
      throw error;
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    return () => controller.abort();
  }, [selectedProviderId, selectedIdentity]);

  useEffect(() => {
    const controller = new AbortController();
    const configured = providersRef.current.filter((p) => p.baseUrl.trim() && (p.apiKey.trim() || p.credentials === 'include'));
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
      // 缓存读取失败不能中断默认的接口请求。
      console.warn('读取模型缓存失败', error);
    });
    return () => controller.abort();
    // 恢复各连接缓存；其他供应商的修改不应取消当前请求。
  }, [providersKey]);

  // 云端身份只在保存连接后改变；本机输入 Key 时不按每个字符自动请求。
  const savedConnectionIdentity = selected?.credentials === 'include' ? modelListIdentity(selected) : '';
  useEffect(() => {
    const provider = providersRef.current.find((p) => p.id === selectedProviderId);
    if (!provider?.baseUrl.trim() || (!provider.apiKey.trim() && provider.credentials !== 'include')) return;
    void refresh(provider).catch(() => {});
  }, [selectedProviderId, savedConnectionIdentity, refresh]);

  const modelOptions: Record<string, string[]> = {};
  const discoveredModels: Record<string, DiscoveredModel[]> = {};
  const providerNotes: Record<string, string> = {};
  for (const p of providers) {
    const state = states[modelListIdentity(p)];
    if (state?.ids) modelOptions[p.id] = state.ids;
    if (state?.models) discoveredModels[p.id] = state.models;
    if (state?.note) providerNotes[p.id] = state.note;
  }
  return { modelOptions, discoveredModels, providerNotes, refresh, checking: selected ? states[modelListIdentity(selected)]?.loading ?? false : false };
}
