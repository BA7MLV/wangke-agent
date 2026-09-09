import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ReasoningEffort } from '../api/siliconflow';

export type ModelSlot = 'chat' | 'vision' | 'asr' | 'embed';

export interface Settings {
  apiKey: string;
  baseUrl: string;
  asrModel: string;
  llmModel: string;
  embedModel: string;
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
  /** 哔哩哔哩导入代理地址（Cloudflare Worker），用于绕过 CORS/防盗链 */
  bilibiliProxy: string;
  /** 用户自己的 B 站 Cookie（可选，含 SESSDATA 时解锁更高清晰度） */
  bilibiliCookie: string;
  /** 思考题弹幕飘屏开关（控制栏可切，持久化） */
  danmakuEnabled: boolean;
}

export const DEFAULT_MODELS = {
  asrModel: 'XingChenAGI/XingChenASR-V3.2-Ultra',
  llmModel: 'deepseek-ai/DeepSeek-V4-Flash',
  embedModel: 'Qwen/Qwen3-VL-Embedding-8B',
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
      favorites: { chat: [], vision: [], asr: [], embed: [] },
      contextWindow: 131072,
      asrConcurrency: 4,
      thinkingEnabled: false,
      thinkingEffort: 'high',
      captionScale: 1,
      agentRounds: 6,
      bilibiliProxy: '',
      bilibiliCookie: '',
      danmakuEnabled: true,
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
    embedModel: s.embedModel,
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
  };
}
