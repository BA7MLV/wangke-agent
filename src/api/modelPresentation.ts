import type { ModelMeta } from './modelMeta';

export const MODEL_KIND_LABEL = {
  llm: 'LLM · 文本', vlm: 'VLM · 视觉', audio: '音频', image: '图像生成', video: '视频生成',
  multimodal: '多模态', unknown: '能力未知',
} as const;
export type ModelKind = keyof typeof MODEL_KIND_LABEL;

/** 只依据已声明的模态分类；未知与否定必须区分。生成模型优先按输出分类。 */
export function modelKind(meta: ModelMeta | null): ModelKind {
  const input = meta?.inputModalities;
  const output = meta?.outputModalities;
  if (!input?.length || !output?.length) return 'unknown';
  if (output.includes('video')) return 'video';
  if (output.includes('image')) return 'image';
  if (output.includes('text') && (input.includes('image') || input.includes('video'))) return 'vlm';
  if (input.includes('audio') || output.includes('audio')) return 'audio';
  if (input.length === 1 && input[0] === 'text' && output.length === 1 && output[0] === 'text') return 'llm';
  return 'multimodal';
}

const MODALITY_LABEL: Record<string, string> = { text: '文本', image: '图像', video: '视频', audio: '音频', pdf: 'PDF' };
export const modalityLabel = (values?: string[]) => values?.length ? values.map((v) => MODALITY_LABEL[v] ?? v).join('、') : '未提供';
export const formatModelTokens = (value?: number) => value == null ? '未提供' : new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
export const capabilityLabel = (value?: boolean) => value === undefined ? '未提供' : value ? '支持' : '不支持';
