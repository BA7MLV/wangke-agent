/**
 * 模型能力查询：优先用 models.dev 实时元数据（见 modelMeta.ts），
 * 未拉取/未收录时回退到按模型名的启发式推断，可能误判。
 */

import type { ReasoningEffort } from './siliconflow';
import { getModelMeta } from './modelMeta';

const VISION_RE = /([-_/]vl|vision|gpt-4o|gpt-5|gemini|claude|qwen3-vl|internvl|minicpm-v|glm-4v|step-1v|kimi-latest|moonshot-v1-.*-vision)/i;
const THINK_RE = /(r1|qwen3|qwq|glm-z1|glm-5|glm-4\.[56]|hunyuan-t1|thinking|reasoner|deepseek-v3\.2|deepseek-v4|k2-thinking)/i;

export function isVisionModel(id: string): boolean {
  return getModelMeta(id)?.vision ?? VISION_RE.test(id);
}

export function supportsThinking(id: string): boolean {
  return getModelMeta(id)?.reasoning ?? THINK_RE.test(id);
}

const EFFORT_MODELS_RE = /(deepseek-v4|glm-5\.2)/i;
const BUDGET_BY_EFFORT: Record<ReasoningEffort, number> = { low: 2048, high: 8192, max: 32768 };

/** 按模型生成思考参数：effort 模型传 reasoning_effort，其余推理模型传 thinking_budget */
export function thinkingParams(model: string, effort: ReasoningEffort) {
  return EFFORT_MODELS_RE.test(model)
    ? { enable_thinking: true, reasoning_effort: effort }
    : { enable_thinking: true, thinking_budget: BUDGET_BY_EFFORT[effort] };
}

/**
 * 模型单次输出的上限（tokens），即 `max_tokens` 的天花板；元数据缺失时回退到 8192。
 *
 * 与 `contextWindow` 不是一回事：这个只管**输出**那一半，窗口是输入+输出的总容量。
 * 超了它网关直接拒，所以每轮算输出预算时拿它当上限。
 *
 * 实测在架模型（models.dev）：DeepSeek-V4-Pro 384k、Kimi-K3 / GLM-5.2 262k、
 * Qwen3.5-122B 64k，但也有 Qwen2.5-72B 只有 4k —— **所以必须逐模型取，不能取全局最大**。
 */
export function outputLimitOf(id: string): number {
  return getModelMeta(id)?.output ?? 8192;
}

/**
 * 算输出预算时该用的窗口：**取设置值与模型真实窗口里更大的那个**。
 *
 * 为什么不用设置值：`contextWindow` 是给历史裁剪用的**保守估值**（默认 131072），
 * 用户不一定改过，而模型真实窗口可能是 1M（DeepSeek-V4-Pro / Kimi-K3 / GLM-5.2）。
 * 拿估值当上限会让 `max_tokens` 被压到几万，白白浪费模型能力 ——
 * 而 `max_tokens` 是天花板不是预留，给足不花钱。
 *
 * 取 max 而不是无条件信元数据：设置值可能被用户**调大**过（换过窗口更大的服务），
 * 那是显式意图，不能被元数据拉回去。两者都缺时返回 null，交给调用方按未知处理。
 */
export function effectiveContextWindow(id: string, configured?: number | null): number | null {
  const meta = getModelMeta(id)?.context ?? null;
  const conf = configured != null && configured > 0 ? configured : null;
  if (meta == null && conf == null) return null;
  return Math.max(meta ?? 0, conf ?? 0);
}

/** 启发式上下文窗口对照表（tokens），仅作元数据缺失时的兜底，未知 131072 */
const WINDOW_TABLE: [RegExp, number][] = [
  [/deepseek-v4/i, 1000000],
  [/deepseek/i, 131072],
  [/qwen3-vl/i, 262144],
  [/qwen3/i, 131072],
  [/qwen2\.5/i, 131072],
  [/glm/i, 131072],
  [/kimi|moonshot/i, 131072],
  [/gpt-4o|gpt-5/i, 128000],
  [/claude/i, 200000],
  [/gemini/i, 1048576],
];

export function guessContextWindow(id: string): number {
  const meta = getModelMeta(id);
  if (meta) return meta.context;
  for (const [re, win] of WINDOW_TABLE) if (re.test(id)) return win;
  return 131072;
}
