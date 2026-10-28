import type { ModelRef, ModelSlot, SavedModel, Settings } from './settings';
import { getModelMeta, type ModelOverrides } from '../api/modelMeta';
import { providerCatalogId } from './providerPresets';

export const modelKey = (ref: ModelRef) => JSON.stringify([ref.providerId, ref.model]);
const fields = { chat: 'llmModel', vision: 'visionModel', asr: 'asrModel', decision: 'decisionModel' } as const;

/** 旧用户的显式选择自动成为模型库；绝不把发现缓存自动加入。 */
export function savedModelsOf(settings: Settings): SavedModel[] {
  if (settings.savedModels) return settings.savedModels;
  const models = new Map<string, SavedModel>();
  for (const slot of Object.keys(fields) as ModelSlot[]) {
    for (const ref of [...(settings.favorites[slot] ?? []), settings[fields[slot]] ?? { providerId: '', model: '' }]) {
      if (!ref.model || !settings.providers.some((p) => p.id === ref.providerId)) continue;
      const key = modelKey(ref);
      const entry = models.get(key) ?? { ...ref, name: '', slots: [] };
      if (!entry.slots.includes(slot)) entry.slots.push(slot);
      models.set(key, entry);
    }
  }
  return [...models.values()];
}

export function modelsForSlot(settings: Settings, slot: ModelSlot): SavedModel[] {
  return savedModelsOf(settings).filter((m) => m.slots.includes(slot)
    && settings.providers.some((p) => p.id === m.providerId));
}

/** 只按模型声明的输入/输出预选用途，不按供应商或模型名称猜测；用户可在模型上调整。 */
export function suggestedModelSlots(catalogId: string, model: string, overrides?: ModelOverrides): ModelSlot[] {
  const meta = getModelMeta(catalogId, model, overrides);
  if (meta?.type === 'decision') return ['decision'];
  if (meta?.type && meta.type !== 'language') return [];
  const input = meta?.inputModalities ?? ['text'];
  const output = meta?.outputModalities ?? ['text'];
  if (!output.includes('text')) return [];
  const slots: ModelSlot[] = [];
  if (input.includes('text')) slots.push('chat');
  if (input.includes('image')) slots.push('vision');
  if (input.includes('audio')) slots.push('asr');
  return slots;
}

export function modelLabel(settings: Settings, ref: ModelRef): string {
  return savedModelsOf(settings).find((m) => modelKey(m) === modelKey(ref))?.name || ref.model;
}

/** 改 ID 时原子迁移当前选择与收藏，避免 UI 改名而请求仍发旧 ID。 */
export function editModelPatch(settings: Settings, original: ModelRef | null, draft: SavedModel): Partial<Settings> {
  const next = { ...draft, model: draft.model.trim(), name: draft.name.trim(), slots: [...new Set(draft.slots)] };
  if (!next.model) throw new Error('请输入模型 ID');
  if (next.model.length > 200) throw new Error('模型 ID 不能超过 200 个字符');
  const provider = settings.providers.find((p) => p.id === next.providerId);
  if (!provider) throw new Error('请选择有效的供应商');
  if (next.slots.includes('decision')) {
    next.modelType = 'decision';
    next.toolCalling = false;
    if (next.slots.length !== 1) throw new Error('决策接口不能与聊天、图片理解或语音识别用途混用');
    if (next.decisionProtocol !== 'typesafe-systemone') throw new Error('请确认决策接口协议');
    if (next.decisionBaseUrl?.trim()) {
      const url = new URL(next.decisionBaseUrl.trim());
      if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
        throw new Error('决策 API 地址必须使用 HTTPS（本机调试除外），且不能包含凭据或查询参数');
      }
      next.decisionBaseUrl = url.href.replace(/\/+$/, '');
    }
  } else if (getModelMeta(providerCatalogId(provider), next.model, next)?.type === 'decision') {
    throw new Error('决策模型不能用于生成任务');
  }
  for (const field of ['contextWindow', 'maxOutputTokens'] as const) {
    if (next[field] !== undefined && (!Number.isSafeInteger(next[field]) || next[field]! < (field === 'maxOutputTokens' && next.slots.includes('decision') ? 0 : 1))) {
      throw new Error('上下文窗口和最大输出令牌数必须为正整数；留空表示跟随 models.dev');
    }
  }
  if (next.reasoningEffort !== undefined) {
    const lanes = next.reasoningEffort.split(',').map((v) => v.trim()).filter(Boolean);
    if (lanes.some((v) => !['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(v))) {
      throw new Error('推理等级仅支持 minimal、low、medium、high、xhigh、max，用英文逗号分隔');
    }
    next.reasoningEffort = [...new Set(lanes)].join(', ');
  }
  if (!next.slots.length || next.slots.some((slot) => !Object.hasOwn(fields, slot))) {
    throw new Error('请至少选择一个模型用途');
  }
  const list = savedModelsOf(settings);
  const originalKey = original ? modelKey(original) : null;
  if (list.some((m) => modelKey(m) === modelKey(next) && modelKey(m) !== originalKey)) {
    throw new Error('这家供应商的模型已添加，请编辑已有条目');
  }
  const patch: Partial<Settings> = {
    savedModels: [...list.filter((m) => modelKey(m) !== originalKey), next],
    favorites: { ...settings.favorites },
  };
  if (originalKey === modelKey(settings.llmModel) && next.contextWindow !== undefined) patch.contextWindow = next.contextWindow;
  for (const slot of Object.keys(fields) as ModelSlot[]) {
    const field = fields[slot];
    if (modelKey(settings[field]) === originalKey) {
      if (!next.slots.includes(slot)) throw new Error(`该模型正在使用，请先切换对应的默认模型再取消用途`);
      patch[field] = { providerId: next.providerId, model: next.model };
    }
    patch.favorites![slot] = (settings.favorites[slot] ?? []).flatMap((ref) =>
      modelKey(ref) !== originalKey ? [ref] : next.slots.includes(slot) ? [{ providerId: next.providerId, model: next.model }] : []);
  }
  return patch;
}
