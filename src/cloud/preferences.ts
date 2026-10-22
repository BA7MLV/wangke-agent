import { db } from '../store/db';
import { useSettings, type Settings } from '../store/settings';
import { cloud } from './state';

// Account preferences only. Credentials, device relays and legacy sync endpoints
// are deliberately absent from the data protocol.
const keys = ['contextWindow', 'asrConcurrency', 'thinkingEnabled', 'thinkingEffort', 'captionScale',
  'agentRounds', 'danmakuEnabled', 'customRates', 'shortcuts', 'theme', 'accentColor', 'fontScale',
  'dynamicColor', 'studyTrackingEnabled', 'studyIdleMinutes', 'htmlRemoteAssets', 'favorites', 'savedModels'] as const;
let applying = false;
let unsubscribe: (() => void) | undefined;
let writing: Promise<unknown> = Promise.resolve();

export async function loadPreferences() {
  const rows = await db.table('preferences').toArray();
  const values = Object.fromEntries(rows.filter(r => keys.includes(r.id)).map(r => [r.id, r.value]));
  applying = true;
  try { useSettings.setState(values); } finally { applying = false; }
}

export async function startPreferences() {
  unsubscribe?.();
  await loadPreferences();
  if (cloud.worker) return;
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
  const rows = keys.filter(id => !existing.has(id) && saved[id] !== undefined).map(id => ({ id, value: saved[id] }));
  if (rows.length) await db.table('preferences').bulkPut(rows);
}
