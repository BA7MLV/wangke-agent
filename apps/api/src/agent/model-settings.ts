import type { DatabaseStore } from '../storage/database.js';
import type { CloudConfig } from '@wangke/contracts/cloud';

const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 1_000_000_000;
/** The same account preferences used by the main model picker/editor. No second Bot window. */
export function modelSettings(store: DatabaseStore, owner: string, config?: CloudConfig, ref = config?.llmModel) {
  const preference = (id: string) => {
    const row = store.db.prepare("SELECT value FROM cloud_records WHERE owner_id=? AND table_name='preferences' AND record_key=?").get(owner, JSON.stringify(id)) as { value: string | null } | undefined;
    if (!row?.value) return undefined;
    try { return JSON.parse(row.value)?.value; } catch { return undefined; }
  };
  const models = preference('savedModels');
  const saved = Array.isArray(models) ? models.find(m => m?.providerId === ref?.providerId && m?.model === ref?.model) : undefined;
  const main = ref?.providerId === config?.llmModel.providerId && ref?.model === config?.llmModel.model;
  const configured = main ? preference('contextWindow') : undefined;
  const contextTokens = positive(saved?.contextWindow) ? saved.contextWindow : positive(configured) ? configured : 131072;
  const outputTokens = Math.min(positive(saved?.maxOutputTokens) ? saved.maxOutputTokens : 8192, Math.max(1, contextTokens - 1024));
  return { contextTokens, outputTokens, model: ref?.model ?? '' };
}
