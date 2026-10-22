/**
 * 供应商模型列表（`GET /models`）的本地缓存。
 *
 * ## 为什么需要一个模块级的缓存
 *
 * 手动「查找模型」后保存结果，重新打开设置可直接复用本地数据。
 * 缓存缺失或过期时也不自动请求；只有用户再次点击查找才联网更新。
 *
 * 业务调用方使用 modelListCacheKey 生成地址 + 协议 + 凭据的 SHA-256 指纹，
 * 不持久化原始凭据。同一端点下不同账户/协议的模型权限不能混用。
 */

import { parseDiscoveredModel, type DiscoveredModel } from './modelDiscoveryData';

const CACHE_KEY = 'wangke-model-list';

/**
 * 缓存结构版本。**字段含义变了就得 +1**，老缓存整体作废而不是被误读
 * （与 `api/modelMeta.ts` 的 `MODEL_META_CACHE_VERSION` 同一套规矩）。
 */
export const MODEL_LIST_CACHE_VERSION = 2;

export interface ModelListConnection {
  baseUrl: string;
  apiKey: string;
  protocol?: 'openai-chat' | 'openai-responses' | 'anthropic-messages';
}

/** 仅内存使用；不要将此值写入日志或持久化。 */
export function modelListIdentity(connection: ModelListConnection): string {
  return JSON.stringify([keyOf(connection.baseUrl), connection.protocol ?? 'openai-chat', connection.apiKey.trim()]);
}

export async function modelListCacheKey(connection: ModelListConnection): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(modelListIdentity(connection)));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 超过这个时长标记为过期；仍可复用，等待用户手动查找更新。 */
const TTL_MS = 24 * 3600 * 1000;

interface ListEntry {
  ids: string[];
  models?: DiscoveredModel[];
  updatedAt: number;
}

interface ListCache {
  version: number;
  /** 业务层传入连接指纹；不存储原始凭据 */
  entries: Record<string, ListEntry>;
}

export interface CachedModelList {
  ids: string[];
  models: DiscoveredModel[];
  updatedAt: number;
  /** true = 已过 TTL。提示过期，等待用户手动更新。 */
  stale: boolean;
}

/**
 * 地址和底层缓存键共用的归一化。业务请求必须先用 modelListCacheKey 生成连接指纹，
 * 不可直接拿 baseUrl 作为缓存键，否则同地址下的账户权限会混用。
 */
function keyOf(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

let mem: ListCache | null | undefined; // undefined = 尚未读 localStorage

function load(): ListCache {
  if (mem !== undefined && mem !== null) return mem;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    const parsed = raw ? (JSON.parse(raw) as ListCache) : null;
    // 版本对不上就当没有：宁可重拉一次，也不能拿旧结构猜字段
    mem = parsed?.version === MODEL_LIST_CACHE_VERSION && parsed.entries && typeof parsed.entries === 'object' && !Array.isArray(parsed.entries) ? parsed : { version: MODEL_LIST_CACHE_VERSION, entries: {} };
  } catch {
    mem = { version: MODEL_LIST_CACHE_VERSION, entries: {} };
  }
  return mem;
}

function save(cache: ListCache): void {
  mem = cache;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // 配额满等场景：内存缓存仍生效，本次会话可用
  }
}

/** 读连接指纹对应的缓存；没存过返回 null */
export function readModelList(cacheKey: string): CachedModelList | null {
  const key = keyOf(cacheKey);
  if (!key) return null;
  const entry = load().entries[key];
  if (!entry || !Array.isArray(entry.ids) || !entry.ids.every((id) => typeof id === 'string' && id.trim().length > 0)
    || !Number.isFinite(entry.updatedAt) || entry.updatedAt <= 0 || entry.updatedAt > Date.now()) return null;
  const models = Array.isArray(entry.models) ? entry.models.map(parseDiscoveredModel).filter((m): m is DiscoveredModel => m !== null)
    : entry.ids.map((id) => ({ id }));
  return { ids: [...entry.ids], models, updatedAt: entry.updatedAt, stale: Date.now() - entry.updatedAt >= TTL_MS };
}

/** 写一家的缓存。空列表也写 —— 「这家确实一个模型都没有」是一个值得记住的结论 */
export function writeModelList(cacheKey: string, ids: readonly string[], models?: DiscoveredModel[]): void {
  const key = keyOf(cacheKey);
  if (!key) return;
  const cache = load();
  save({
    version: MODEL_LIST_CACHE_VERSION,
    entries: { ...cache.entries, [key]: { ids: [...ids], models, updatedAt: Date.now() } },
  });
}

/** 删掉一家的缓存（供应商被删除时调） */
export function dropModelList(cacheKey: string): void {
  const key = keyOf(cacheKey);
  if (!key) return;
  const cache = load();
  if (!(key in cache.entries)) return;
  const entries = { ...cache.entries };
  delete entries[key];
  save({ version: MODEL_LIST_CACHE_VERSION, entries });
}

/**
 * 只保留当前配置的连接指纹，其余全部清掉。
 *
 * 为什么不是「删供应商时顺手删」就够了：那条路径管不到**导入迁移包**、
 * 「清空数据」这类批量改配置的动作，而 localStorage 里的条目只增不减迟早堆满
 * （配额满了会静默让整份缓存写不进去，表现是「缓存莫名其妙失效」）。
 * 在设置页挂载时收一次口，比在每个改配置的地方都记得调一次可靠。
 */
export function pruneModelLists(keepKeys: readonly string[]): void {
  const keep = new Set(keepKeys.map(keyOf).filter(Boolean));
  const cache = load();
  const entries = Object.fromEntries(Object.entries(cache.entries).filter(([key]) => keep.has(key)));
  if (Object.keys(entries).length === Object.keys(cache.entries).length) return;
  save({ version: MODEL_LIST_CACHE_VERSION, entries });
}

/** 仅供测试：丢掉内存态，强制下次重新读 localStorage */
export function __resetModelListCacheForTest(): void {
  mem = undefined;
}
