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
