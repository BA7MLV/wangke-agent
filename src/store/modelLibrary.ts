import type { ModelRef, ModelSlot, SavedModel, Settings } from './settings';

export const modelKey = (ref: ModelRef) => JSON.stringify([ref.providerId, ref.model]);
const fields = { chat: 'llmModel', vision: 'visionModel', asr: 'asrModel' } as const;

/** 旧用户的显式选择自动成为模型库；绝不把发现缓存自动加入。 */
export function savedModelsOf(settings: Settings): SavedModel[] {
  if (settings.savedModels) return settings.savedModels;
  const models = new Map<string, SavedModel>();
  for (const slot of Object.keys(fields) as ModelSlot[]) {
    for (const ref of [...settings.favorites[slot], settings[fields[slot]]]) {
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
    && settings.providers.some((p) => p.id === m.providerId && p.serves.includes(slot)));
}

export function modelLabel(settings: Settings, ref: ModelRef): string {
  return savedModelsOf(settings).find((m) => modelKey(m) === modelKey(ref))?.name || ref.model;
}

/** 改 ID 时原子迁移当前选择与收藏，避免 UI 改名而请求仍发旧 ID。 */
export function editModelPatch(settings: Settings, original: ModelRef | null, draft: SavedModel): Partial<Settings> {
  const next = { ...draft, model: draft.model.trim(), name: draft.name.trim(), slots: [...new Set(draft.slots)] };
  if (!next.model) throw new Error('请输入模型 ID');
  const provider = settings.providers.find((p) => p.id === next.providerId);
  if (!provider) throw new Error('请选择有效的供应商');
  if (!next.slots.length || next.slots.some((slot) => !provider.serves.includes(slot))) {
    throw new Error('请选择供应商支持的用途');
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
  for (const slot of Object.keys(fields) as ModelSlot[]) {
    const field = fields[slot];
    if (modelKey(settings[field]) === originalKey) {
      if (!next.slots.includes(slot)) throw new Error(`该模型正在使用，请先切换对应的默认模型再取消用途`);
      patch[field] = { providerId: next.providerId, model: next.model };
    }
    patch.favorites![slot] = settings.favorites[slot].flatMap((ref) =>
      modelKey(ref) !== originalKey ? [ref] : next.slots.includes(slot) ? [{ providerId: next.providerId, model: next.model }] : []);
  }
  return patch;
}
