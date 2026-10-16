/**
 * 供应商模型列表（`GET /models`）的本地缓存。
 *
 * ## 为什么需要一个模块级的缓存
 *
 * 这份列表原先只活在 `ModelsModule` 的 `modelOptions` state 里，**设置面板一关就没了**。
 * 用户每次打开设置想选模型，都得重新点一次「拉取模型列表」并等一轮网络往返 ——
 * 而这份列表一天之内几乎不会变。
 *
 * ## 为什么键是 baseUrl 而不是 provider.id
 *
 * `Provider.id` 由 `nextProviderId()` 顺序生成（`p1` / `p2` / …），**删掉一家再加一家
 * 会复用同一个 id**。拿 id 当键的话，上一家的模型列表会被当成新家的缓存命中 ——
 * 用户在新家看到一屏别家的模型，点下去就是 404。`baseUrl` 才是「这份列表从哪来」的身份。
 *
 * ## 为什么不缓存 apiKey
 *
 * apiKey 已经单独存在 settings 里（且明确不进云同步与迁移包）。复制进这份缓存等于凭空
 * 多出一份凭据副本，而这份缓存的唯一用途是「省一次网络往返」，不值得。
 * 代价是同一地址换 key 后列表可能与实际可见的不一致 —— 所以 TTL 只给 24 小时，
 * 过期即静默重拉，用户也可以随时手动强制刷新。
 */

const CACHE_KEY = 'wangke-model-list';

/**
 * 缓存结构版本。**字段含义变了就得 +1**，老缓存整体作废而不是被误读
 * （与 `api/modelMeta.ts` 的 `MODEL_META_CACHE_VERSION` 同一套规矩）。
 */
export const MODEL_LIST_CACHE_VERSION = 1;

/** 超过这个时长就视为过期：打开设置时会静默重拉，但**过期数据照常先用** */
const TTL_MS = 24 * 3600 * 1000;

interface ListEntry {
  ids: string[];
  updatedAt: number;
}

interface ListCache {
  version: number;
  /** 键 = 归一化后的 baseUrl */
  entries: Record<string, ListEntry>;
}

export interface CachedModelList {
  ids: string[];
  updatedAt: number;
  /** true = 已过 TTL。调用方应当后台重拉，但可以先用这份顶着 */
  stale: boolean;
}

/**
 * 归一化端点，作为缓存键。
 *
 * 去尾部斜杠：`https://api.x.com/v1` 与 `https://api.x.com/v1/` 是同一家，
 * 不去的话用户改一次地址（哪怕是补个斜杠）就等于换了供应商，缓存白存。
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
    mem = parsed?.version === MODEL_LIST_CACHE_VERSION && parsed.entries ? parsed : { version: MODEL_LIST_CACHE_VERSION, entries: {} };
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

/** 读一家的缓存；没存过返回 null */
export function readModelList(baseUrl: string): CachedModelList | null {
  const key = keyOf(baseUrl);
  if (!key) return null;
  const entry = load().entries[key];
  if (!entry || !Array.isArray(entry.ids)) return null;
  return { ids: entry.ids, updatedAt: entry.updatedAt, stale: Date.now() - entry.updatedAt > TTL_MS };
}

/** 写一家的缓存。空列表也写 —— 「这家确实一个模型都没有」是一个值得记住的结论 */
export function writeModelList(baseUrl: string, ids: readonly string[]): void {
  const key = keyOf(baseUrl);
  if (!key) return;
  const cache = load();
  save({
    version: MODEL_LIST_CACHE_VERSION,
    entries: { ...cache.entries, [key]: { ids: [...ids], updatedAt: Date.now() } },
  });
}

/** 删掉一家的缓存（供应商被删除时调） */
export function dropModelList(baseUrl: string): void {
  const key = keyOf(baseUrl);
  if (!key) return;
  const cache = load();
  if (!(key in cache.entries)) return;
  const entries = { ...cache.entries };
  delete entries[key];
  save({ version: MODEL_LIST_CACHE_VERSION, entries });
}

/**
 * 只保留这些端点的缓存，其余全部清掉。
 *
 * 为什么不是「删供应商时顺手删」就够了：那条路径管不到**导入迁移包**、
 * 「清空数据」这类批量改配置的动作，而 localStorage 里的条目只增不减迟早堆满
 * （配额满了会静默让整份缓存写不进去，表现是「缓存莫名其妙失效」）。
 * 在设置页挂载时收一次口，比在每个改配置的地方都记得调一次可靠。
 */
export function pruneModelLists(keepBaseUrls: readonly string[]): void {
  const keep = new Set(keepBaseUrls.map(keyOf).filter(Boolean));
  const cache = load();
  const entries = Object.fromEntries(Object.entries(cache.entries).filter(([key]) => keep.has(key)));
  if (Object.keys(entries).length === Object.keys(cache.entries).length) return;
  save({ version: MODEL_LIST_CACHE_VERSION, entries });
}

/** 仅供测试：丢掉内存态，强制下次重新读 localStorage */
export function __resetModelListCacheForTest(): void {
  mem = undefined;
}
