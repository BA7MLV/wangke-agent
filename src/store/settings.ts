import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ReasoningEffort } from '../api/siliconflow';

export type ModelSlot = 'chat' | 'vision' | 'asr';

/**
 * 界面主题。`auto` = 跟随系统（MD3 / Material You 的默认行为）。
 * 取值直接对应 mdui `setTheme()` 的参数，见 `src/ui/theme.ts`。
 */
export type AppTheme = 'auto' | 'light' | 'dark';

export interface Settings {
  apiKey: string;
  baseUrl: string;
  asrModel: string;
  llmModel: string;
  visionModel: string;
  /** 按用途分组的收藏模型列表（面板下拉的候选） */
  favorites: Record<ModelSlot, string[]>;
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
   * 同步令牌。与 `apiKey` 同级的凭据 —— 泄漏等于全部学习数据泄漏，
   * 因此**永不参与同步**（见 `src/sync/units.ts` 的 NON_SYNC_SETTINGS_KEYS）。
   */
  syncToken: string;
}

export const DEFAULT_MODELS = {
  asrModel: 'XingChenAGI/XingChenASR-V3.2-Ultra',
  llmModel: 'deepseek-ai/DeepSeek-V4-Flash',
  // Qwen3.6-35B-A3B：MoE 激活 3B，识图速度远快于稠密 32B，且支持 image/video 输入
  visionModel: 'Qwen/Qwen3.6-35B-A3B',
};

interface SettingsStore extends Settings {
  update: (patch: Partial<Settings>) => void;
}

export const useSettings = create<SettingsStore>()(
  persist(
    (set) => ({
      apiKey: '',
      baseUrl: 'https://api.siliconflow.cn/v1',
      ...DEFAULT_MODELS,
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
      syncEnabled: false,
      syncEndpoint: '',
      syncToken: '',
      update: (patch) => set(patch),
    }),
    {
      name: 'wangke-settings',
      version: 1,
      migrate: (persisted, version) => {
        const s = persisted as Settings;
        // v0 → v1：视觉模型仍是旧默认值（用户未自定义）时，跟随新默认提速
        if (version < 1 && s.visionModel === 'Qwen/Qwen3-VL-32B-Instruct') {
          s.visionModel = DEFAULT_MODELS.visionModel;
        }
        return s;
      },
    },
  ),
);

export function getSettings(): Settings {
  const s = useSettings.getState();
  return {
    apiKey: s.apiKey,
    baseUrl: s.baseUrl.replace(/\/+$/, ''),
    asrModel: s.asrModel,
    llmModel: s.llmModel,
    visionModel: s.visionModel,
    favorites: { ...s.favorites },
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
    syncEnabled: s.syncEnabled,
    syncEndpoint: s.syncEndpoint,
    syncToken: s.syncToken,
  };
}
