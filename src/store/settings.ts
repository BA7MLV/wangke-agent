import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ReasoningEffort } from '../api/siliconflow';

export type ModelSlot = 'chat' | 'vision' | 'asr';

/** 槽位在设置里的字段名。`chat` 对应的字段叫 `llmModel`（历史命名），映射集中在这里。 */
const SLOT_FIELD = {
  asr: 'asrModel',
  chat: 'llmModel',
  vision: 'visionModel',
} as const satisfies Record<ModelSlot, 'asrModel' | 'llmModel' | 'visionModel'>;

type ModelFieldName = (typeof SLOT_FIELD)[ModelSlot];

/** 槽位的中文名。报错文案与设置页共用，避免同一个槽位在两处叫法不一致。 */
export const SLOT_LABEL: Record<ModelSlot, string> = {
  asr: '语音识别',
  vision: '视觉理解',
  chat: '文本生成',
};

/**
 * 一家模型供应商（连接）。
 *
 * **凭据与模型配置分开的锚点**：`baseUrl` + `apiKey` 属于「连接」，模型 id 属于「槽位」。
 * 供应商层只声明**它实现了哪些端点**（`serves`），不猜模型名 —— 一家纯 ASR 服务里
 * 没有任何带 `asr` 字样的模型名，靠正则猜必然错。
 */
export interface Provider {
  /** 本机唯一短 id；槽位与收藏夹靠它引用，改名等于换一家（所以 UI 不提供改名） */
  id: string;
  /** 显示名 */
  name: string;
  /** OpenAI 兼容根地址，如 `https://api.siliconflow.cn/v1` */
  baseUrl: string;
  /** 凭据。**永不参与同步**（见 `sync/units.ts`），也不参与迁移包导出 */
  apiKey: string;
  /** 这家能填哪些槽位（= 实现了哪些端点）。用户手动声明 */
  serves: ModelSlot[];
  /**
   * models.dev 上的供应商 key（如 `siliconflow-cn`），用于查模型能力数据。留空则拿不到元数据。
   *
   * 为什么必须按它索引而不是按 baseUrl：models.dev 的能力表是**逐供应商**给的，
   * 同一个模型 id 在不同供应商下能力可以不同（实测 `Qwen/Qwen3.6-35B-A3B` 在
   * 硅基流动国际站只支持文本、国内站支持图像+视频；`thinkingmachines/Inkling`
   * 在 deepinfra 是 524288 上下文、官方只有 65536）。把两站拍平成一张表会静默取错值。
   */
  catalogId: string;
}

/** 槽位里的一个模型：模型 id 必须连它属于哪家一起记，否则同名模型无法区分 */
export interface ModelRef {
  providerId: string;
  model: string;
}

/**
 * 一个可发请求的模型目标：端点 + 模型 + 能力数据源合成一体。
 *
 * **为什么把 model 绑进端点里、而不是像以前那样单独传给 API 层**：以前 `chatOnce(settings,
 * { model })` 允许「拿文本模型的连接去打视觉模型」这种组合，多供应商下这会变成真 bug
 * （视觉模型在另一家，请求却发给了文本那家的地址）。绑在一起之后这种错配在类型上就写不出来。
 */
export interface ModelTarget {
  providerId: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  catalogId: string;
}

/** 两个模型引用是否同一个（收藏夹去重、选中态判定） */
export function sameRef(a: ModelRef, b: ModelRef): boolean {
  return a.providerId === b.providerId && a.model === b.model;
}

/**
 * 界面主题。`auto` = 跟随系统（MD3 / Material You 的默认行为）。
 * 取值直接对应 mdui `setTheme()` 的参数，见 `src/ui/theme.ts`。
 */
export type AppTheme = 'auto' | 'light' | 'dark';

export interface Settings {
  /** 模型供应商注册表（凭据在这里，不在顶层） */
  providers: Provider[];
  asrModel: ModelRef;
  llmModel: ModelRef;
  visionModel: ModelRef;
  /** 按用途分组的收藏模型列表（面板下拉的候选） */
  favorites: Record<ModelSlot, ModelRef[]>;
  /** 上下文窗口（tokens），自动探测默认值，可手改 */
  contextWindow: number;
  /** ASR 转写初始并发数（1-12，运行中按 AIMD 自适应：遇 429 减半，稳定后缓慢 +1） */
  asrConcurrency: number;
  /** 思考开关（会话记忆，非按视频） */
  thinkingEnabled: boolean;
  /** 思考深度档位 */
  thinkingEffort: ReasoningEffort;
  /** 播放器字幕字号倍率（0.8/1/1.35/1.7，经 --media-user-font-size 应用） */
  captionScale: number;
  /** 问答 agent 检索轮次上限（达到上限后强制收尾作答；轮次多=材料全但更慢更费 token） */
  agentRounds: number;
  /** 哔哩哔哩导入代理地址（油猴桥不可用时的回退，Cloudflare Worker 常被拒 IP） */
  bilibiliProxy: string;
  /** 用户自己的 B 站 Cookie（可选，含 SESSDATA 时解锁更高清晰度） */
  bilibiliCookie: string;
  /** 思考题弹幕飘屏开关（控制栏可切，持久化） */
  danmakuEnabled: boolean;
  /** 用户自定义的倍速档位（0.25–4，按控制栏「自定义」录入；与内置档位一起去重升序展示） */
  customRates: number[];
  /** 界面主题：跟随系统 / 强制浅色 / 强制深色（MD3 令牌体系下深浅两套色板都已就位） */
  theme: AppTheme;
  /** Material You 动态取色：从课程封面提取主色，让播放页配色随课程变化 */
  dynamicColor: boolean;
  /** 学习时长自动记录（关掉后不再累计，已有记录保留） */
  studyTrackingEnabled: boolean;
  /** 多久没操作就算「人不在」（分钟）。播放视频时不计入空闲判定 */
  studyIdleMinutes: number;
  // ── 阅读材料（docs/plans/2026-09-26-html-faithful-import-design.md）──
  /**
   * HTML 材料是否允许联网加载外部资源（图片 / 样式表 / 字体）。**默认开**。
   *
   * 为什么这里默认开、而 `syncEnabled` 默认关：两者都让数据离开本机，但性质不同 ——
   * 云同步会把**你的**字幕、讲义、问答送上服务器；这里只是阅读一份导入文档时，
   * 按原文档的引用去取它本来就指向的公开资源，不发送任何本机数据。
   *
   * 但「默认开」不等于「静默开」：阅读器顶部会常驻一条「正在联网加载 N 项资源」的提示，
   * 并给一个「本次离线」按钮；README 的免责声明与已知限制里也各有一条。
   * 想完全不出网，把这里关掉即可（关闭后 CSP 会一并收紧，不是只做个样子）。
   */
  htmlRemoteAssets: boolean;
  // ── 云端同步（docs/plans/2026-09-23-cloud-sync-design.md）──
  /**
   * 是否启用云端同步。**默认关闭**。
   *
   * 不是「保守起见」才默认关：这个开关一旦打开，视频之外的数据（字幕、讲义、问答、
   * 卡片、向量、抽帧）就会离开本机，README 首页那句「数据不出本机」与免责声明第 3 条
   * 随之失效。这种事必须由用户显式做，不能替他默认做。
   */
  syncEnabled: boolean;
  /** 同步 Worker 地址，如 `https://wangke-sync.xxx.workers.dev` */
  syncEndpoint: string;
  /**
   * 同步令牌。与供应商 API Key 同级的凭据 —— 泄漏等于全部学习数据泄漏，
   * 因此**永不参与同步**（见 `src/sync/units.ts` 的 NON_SYNC_SETTINGS_KEYS）。
   */
  syncToken: string;
}

/** 预置供应商：老用户升级后无需任何操作即可继续用（凭据由 migrate 从旧字段搬过来） */
export const DEFAULT_PROVIDER_ID = 'sf';

const DEFAULT_SF_BASE_URL = 'https://api.siliconflow.cn/v1';

export const DEFAULT_MODELS = {
  asrModel: 'XingChenAGI/XingChenASR-V3.2-Ultra',
  llmModel: 'deepseek-ai/DeepSeek-V4-Flash',
  // Qwen3.6-35B-A3B：MoE 激活 3B，识图速度远快于稠密 32B，且支持 image/video 输入
  visionModel: 'Qwen/Qwen3.6-35B-A3B',
};

function defaultProvider(apiKey = ''): Provider {
  return {
    id: DEFAULT_PROVIDER_ID,
    name: '硅基流动',
    baseUrl: DEFAULT_SF_BASE_URL,
    apiKey,
    serves: ['chat', 'vision', 'asr'],
    // 国内站：与旧实现取能力数据时的合并顺序一致（cn 覆盖 intl）
    catalogId: 'siliconflow-cn',
  };
}

function defaultModels(): Record<ModelFieldName, ModelRef> {
  return {
    asrModel: { providerId: DEFAULT_PROVIDER_ID, model: DEFAULT_MODELS.asrModel },
    llmModel: { providerId: DEFAULT_PROVIDER_ID, model: DEFAULT_MODELS.llmModel },
    visionModel: { providerId: DEFAULT_PROVIDER_ID, model: DEFAULT_MODELS.visionModel },
  };
}

/**
 * 初始设置。
 *
 * **必须是独立函数，不能在 migrate 里调 `useSettings.getState()`**：
 * zustand 的 persist 在 `create()` 里就**同步**完成首次 hydrate，也就是说 migrate
 * 执行时 `useSettings` 这个变量还没被赋值（还在 TDZ 里）。那时读 `getState()` 会抛，
 * hydrate 中断 —— 表现是「用户明明填了 key，进去却提示没填」，因为 store 悄悄退回到了
 * 初始值，而症状指向的偏偏是默认值里那家预置供应商。
 */
function initialSettings(): Settings {
  return {
    providers: [defaultProvider()],
    ...defaultModels(),
    favorites: { chat: [], vision: [], asr: [] },
    contextWindow: 131072,
    asrConcurrency: 4,
    thinkingEnabled: false,
    thinkingEffort: 'high',
    captionScale: 1,
    agentRounds: 6,
    bilibiliProxy: '',
    bilibiliCookie: '',
    danmakuEnabled: true,
    customRates: [],
    theme: 'auto',
    dynamicColor: true,
    studyTrackingEnabled: true,
    studyIdleMinutes: 5,
    htmlRemoteAssets: true,
    syncEnabled: false,
    syncEndpoint: '',
    syncToken: '',
  };
}

interface SettingsStore extends Settings {
  update: (patch: Partial<Settings>) => void;
}

export const useSettings = create<SettingsStore>()(
  persist(
    (set) => ({
      ...initialSettings(),
      update: (patch) => set(patch),
    }),
    {
      name: 'wangke-settings',
      version: 2,
      migrate: (persisted, version) => migrateSettings(persisted as Record<string, unknown>, version),
    },
  ),
);

// ── 持久化迁移 ───────────────────────────────────────────────────────────────

/**
 * v1 及更早的持久化形状：凭据在顶层 `apiKey` / `baseUrl`，模型是裸 id 字符串。
 *
 * 其余字段与现在同名同型（v1 没改过它们），所以只把四个变了的字段单独声明为旧形状。
 */
type LegacySettings = Omit<Partial<Settings>, 'asrModel' | 'llmModel' | 'visionModel' | 'favorites'> & {
  apiKey?: string;
  baseUrl?: string;
  asrModel?: string;
  llmModel?: string;
  visionModel?: string;
  favorites?: Record<string, string[]>;
};

/**
 * v1 → v2：把「一对全局凭据 + 三个裸模型 id」搬成「供应商注册表 + 带归属的模型引用」。
 *
 * 做法是**整体重建**而不是就地改字段：就地 `delete` 会在 zustand persist 的
 * 「持久化对象浅合并到初始 state」语义下留下残骸，而顶层 `apiKey` 留着就等于
 * 多了一份凭据副本 —— 那正是这次要消灭的东西。
 */
export function migrateSettings(persisted: Record<string, unknown>, version: number): Settings {
  // 已经是 v2 形状（`providers` 是数组）就直接放行。
  //
  // **为什么要有这道闸**：migrate 的语义是「按 version 号重建」，而 version 是持久化对象
  // 里的一个字段 —— 它可能与 state 的实际形状不一致（手改过的 localStorage、跨版本回滚、
  // 测试夹具手写 version）。若无条件按 version < 2 走旧形状重建，就会把一份**已经迁好的**
  // 配置连同凭据一起抹掉，且抹得无声无息（表面上只是「填的 key 不见了」）。
  // 宁可放过一次本该迁移的旧数据（那种情况读到的 providers 不是数组，仍会走下面的旧路径），
  // 也不能凭一个数字字段销毁用户数据。
  if (Array.isArray(persisted.providers)) {
    return { ...initialSettings(), ...(persisted as unknown as Settings) };
  }
  const s = persisted as unknown as LegacySettings;
  // v0 → v1：视觉模型仍是旧默认值（用户未自定义）时，跟随新默认提速
  const visionModel =
    version < 1 && s.visionModel === 'Qwen/Qwen3-VL-32B-Instruct'
      ? DEFAULT_MODELS.visionModel
      : s.visionModel;

  const baseUrl = s.baseUrl?.trim() || DEFAULT_SF_BASE_URL;
  const provider: Provider = { ...defaultProvider(s.apiKey?.trim() ?? ''), baseUrl };

  const favs = {} as Record<ModelSlot, ModelRef[]>;
  for (const slot of Object.keys(SLOT_FIELD) as ModelSlot[]) {
    favs[slot] = (s.favorites?.[slot] ?? [])
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .map((model) => ({ providerId: provider.id, model }));
  }

  // 从默认值起步再逐字段覆盖：新增字段（syncToken 等）自动拿到默认值，
  // 不会因为旧包里没有这个键而变成 undefined。
  const base = initialSettings();
  return {
    providers: [provider],
    asrModel: { providerId: provider.id, model: s.asrModel ?? base.asrModel.model },
    llmModel: { providerId: provider.id, model: s.llmModel ?? base.llmModel.model },
    visionModel: { providerId: provider.id, model: visionModel ?? base.visionModel.model },
    favorites: favs,
    contextWindow: typeof s.contextWindow === 'number' ? s.contextWindow : base.contextWindow,
    asrConcurrency: typeof s.asrConcurrency === 'number' ? s.asrConcurrency : base.asrConcurrency,
    thinkingEnabled: typeof s.thinkingEnabled === 'boolean' ? s.thinkingEnabled : base.thinkingEnabled,
    thinkingEffort: s.thinkingEffort ?? base.thinkingEffort,
    captionScale: typeof s.captionScale === 'number' ? s.captionScale : base.captionScale,
    agentRounds: typeof s.agentRounds === 'number' ? s.agentRounds : base.agentRounds,
    bilibiliProxy: s.bilibiliProxy ?? base.bilibiliProxy,
    bilibiliCookie: s.bilibiliCookie ?? base.bilibiliCookie,
    danmakuEnabled: s.danmakuEnabled ?? base.danmakuEnabled,
    customRates: Array.isArray(s.customRates) ? s.customRates : base.customRates,
    theme: s.theme ?? base.theme,
    dynamicColor: s.dynamicColor ?? base.dynamicColor,
    studyTrackingEnabled: s.studyTrackingEnabled ?? base.studyTrackingEnabled,
    studyIdleMinutes: s.studyIdleMinutes ?? base.studyIdleMinutes,
    htmlRemoteAssets: s.htmlRemoteAssets ?? base.htmlRemoteAssets,
    syncEnabled: s.syncEnabled ?? base.syncEnabled,
    syncEndpoint: s.syncEndpoint ?? base.syncEndpoint,
    syncToken: s.syncToken ?? base.syncToken,
  };
}

// ── 读取 ─────────────────────────────────────────────────────────────────────

export function getSettings(): Settings {
  const s = useSettings.getState();
  return {
    providers: s.providers.map((p) => ({ ...p, serves: [...p.serves] })),
    asrModel: { ...s.asrModel },
    llmModel: { ...s.llmModel },
    visionModel: { ...s.visionModel },
    favorites: {
      chat: s.favorites.chat.map((r) => ({ ...r })),
      vision: s.favorites.vision.map((r) => ({ ...r })),
      asr: s.favorites.asr.map((r) => ({ ...r })),
    },
    contextWindow: s.contextWindow,
    asrConcurrency: s.asrConcurrency,
    thinkingEnabled: s.thinkingEnabled,
    thinkingEffort: s.thinkingEffort,
    captionScale: s.captionScale,
    agentRounds: s.agentRounds,
    bilibiliProxy: s.bilibiliProxy,
    bilibiliCookie: s.bilibiliCookie,
    danmakuEnabled: s.danmakuEnabled,
    customRates: [...s.customRates],
    theme: s.theme,
    dynamicColor: s.dynamicColor,
    studyTrackingEnabled: s.studyTrackingEnabled,
    studyIdleMinutes: s.studyIdleMinutes,
    htmlRemoteAssets: s.htmlRemoteAssets,
    syncEnabled: s.syncEnabled,
    syncEndpoint: s.syncEndpoint,
    syncToken: s.syncToken,
  };
}

/** 按 id 找供应商 */
export function providerOf(s: Settings, providerId: string): Provider | undefined {
  return s.providers.find((p) => p.id === providerId);
}

/** 某个供应商能填哪些槽位（用它筛槽位下拉里的候选供应商） */
export function providersForSlot(s: Settings, slot: ModelSlot): Provider[] {
  return s.providers.filter((p) => p.serves.includes(slot));
}

/**
 * 取出某个槽位当前选中的模型目标（端点 + 模型 + 能力数据源）。
 *
 * **两个失败都在这里抛中文错**，因为它们都是「用户去设置里改一下」就能解决的配置问题，
 * 而流水线里那七处 `if (!settings.apiKey) throw ...` 原本只能报「请填写硅基流动 API Key」——
 * 多供应商后那句话已经指错地方了（没填 key 的是另一家）。
 */
export function targetOfSlot(s: Settings, slot: ModelSlot): ModelTarget {
  const ref = s[SLOT_FIELD[slot]];
  const p = providerOf(s, ref.providerId);
  if (!p) {
    throw new Error(
      `「${SLOT_LABEL[slot]}」模型指向的供应商已被删除，请到「设置 → 模型供应商」重新选择`,
    );
  }
  if (!p.apiKey.trim()) {
    throw new Error(`请先在「设置 → 模型供应商」里填写「${p.name}」的 API Key`);
  }
  return {
    providerId: p.id,
    baseUrl: p.baseUrl.replace(/\/+$/, ''),
    apiKey: p.apiKey.trim(),
    model: ref.model,
    catalogId: p.catalogId,
  };
}

/**
 * 构造目标但不校验凭据 —— 给 UI 用（能力判断、下拉候选不需要 key 存在）。
 * 供应商被删时返回 null，调用方自己决定怎么表现（设置页要提示，能力判断要退回启发式）。
 */
export function targetOrNull(s: Settings, ref: ModelRef): ModelTarget | null {
  const p = providerOf(s, ref.providerId);
  if (!p) return null;
  return {
    providerId: p.id,
    baseUrl: p.baseUrl.replace(/\/+$/, ''),
    apiKey: p.apiKey,
    model: ref.model,
    catalogId: p.catalogId,
  };
}

/** 只查能力数据源的 key（元数据缓存按它索引；没登记就没有元数据） */
export function catalogOf(s: Settings, providerId: string): string {
  return providerOf(s, providerId)?.catalogId ?? '';
}

/**
 * 把导入载荷（迁移包 / 同步载荷）里的供应商表与本机合并。
 *
 * 两种载荷都不带凭据（见 `sync/units.ts` 的 `stripProviderKeys`），所以整表替换会把本机
 * 所有 key 清成空串 —— 表现为「导入一次配置之后整个应用都不能用了」。合并规则：
 * - 载荷里有的供应商：取载荷的非凭据字段 + **本机同 id 的 key**
 * - 载荷里没有的本机供应商：原样留下（导入不是删除）
 * - 载荷里多出来的供应商：key 留空，等用户填
 *
 * 返回新数组、每个对象也是新的：调用方（zustand `update`）不该有机会就地改到本机真身。
 */
export function mergeImportedProviders(
  local: readonly Provider[],
  incoming: readonly ImportedProvider[],
): Provider[] {
  const out: Provider[] = local.map((p) => ({ ...p, serves: [...p.serves] }));
  for (const inc of incoming) {
    const cur = out.find((p) => p.id === inc.id);
    const merged: Provider = {
      id: inc.id,
      name: inc.name || cur?.name || inc.id,
      baseUrl: (inc.baseUrl || cur?.baseUrl || '').replace(/\/+$/, ''),
      // 凭据只从本机取；载荷里带的 apiKey 一律忽略（老包里可能有）
      apiKey: cur?.apiKey ?? '',
      serves: Array.isArray(inc.serves) ? inc.serves.filter(isModelSlot) : (cur?.serves ?? []),
      catalogId: inc.catalogId ?? cur?.catalogId ?? '',
    };
    const i = out.findIndex((p) => p.id === inc.id);
    if (i >= 0) out[i] = merged;
    else out.push(merged);
  }
  return out;
}

/** 导入载荷里的供应商形状。`apiKey` 即便存在也会被忽略，故不在类型里 */
interface ImportedProvider {
  id: string;
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  serves?: string[];
  catalogId?: string;
}

function isModelSlot(v: unknown): v is ModelSlot {
  return v === 'chat' || v === 'vision' || v === 'asr';
}

/** 新建供应商时分配一个不撞的短 id */
export function nextProviderId(s: Settings): string {
  const used = new Set(s.providers.map((p) => p.id));
  for (const short of ['or', 'dm', 'pp', 'kk', 'xf', 'ali', 'gt', 'nb']) {
    if (!used.has(short)) return short;
  }
  for (let i = 2; ; i++) {
    const id = `p${i}`;
    if (!used.has(id)) return id;
  }
}
