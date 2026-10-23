import { db } from '../store/db';
import { useSettings, type Settings } from '../store/settings';
import { cloud } from './state';
import { normalizeUiLanguage } from '../i18n/locale';

// Account preferences only. Credentials, device relays and legacy sync endpoints
// are deliberately absent from the data protocol.
const keys = ['contextWindow', 'asrConcurrency', 'thinkingEnabled', 'thinkingEffort', 'captionScale',
  'agentRounds', 'danmakuEnabled', 'customRates', 'shortcuts', 'theme', 'uiLanguage', 'accentColor', 'fontScale',
  'dynamicColor', 'studyTrackingEnabled', 'studyIdleMinutes', 'htmlRemoteAssets', 'favorites', 'savedModels'] as const;
let applying = false;
let unsubscribe: (() => void) | undefined;
let writing: Promise<unknown> = Promise.resolve();

export async function loadPreferences() {
  const rows = await db.table('preferences').toArray();
  const values = Object.fromEntries(rows.filter(r => keys.includes(r.id)).map(r => [r.id, r.value]));
  // 云偏好直接 setState，不经过 Settings.update 的输入校验。
  if (Object.hasOwn(values, 'uiLanguage')) values.uiLanguage = normalizeUiLanguage(values.uiLanguage);
  applying = true;
  try { useSettings.setState(values); } finally { applying = false; }
}

export async function startPreferences() {
  unsubscribe?.();
  await loadPreferences();
  if (cloud.worker) return;
  // 首次登录/旧账号尚无该字段时，把登录前的选择作为账号偏好；不是设备解析出的 locale。
  const preferences = db.table('preferences');
  if (!await preferences.get('uiLanguage')) await preferences.put({ id: 'uiLanguage', value: useSettings.getState().uiLanguage });
  unsubscribe = useSettings.subscribe((next, previous) => {
    if (applying) return;
    const changes = keys.filter(key => JSON.stringify(next[key]) !== JSON.stringify(previous[key]));
    if (!changes.length) return;
    const rows = changes.map(id => ({ id, value: next[id as keyof Settings] ?? null }));
    writing = writing.catch(() => {}).then(() => db.table('preferences').bulkPut(rows)).catch(error => {
      window.dispatchEvent(new CustomEvent('cloud-preferences-error', { detail: (error as Error).message }));
    });
  });
}

export async function flushPreferences() { await writing; }

export async function migratePreferences() {
  const saved = JSON.parse(localStorage.getItem('wangke-settings') ?? 'null')?.state;
  if (!saved || typeof saved !== 'object') return;
  const existing = new Set(await db.table('preferences').toCollection().primaryKeys());
  const rows = keys.filter(id => !existing.has(id) && saved[id] !== undefined)
    .map(id => ({ id, value: id === 'uiLanguage' ? normalizeUiLanguage(saved[id]) : saved[id] }));
  if (rows.length) await db.table('preferences').bulkPut(rows);
}
