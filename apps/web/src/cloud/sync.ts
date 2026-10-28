import { create } from 'zustand';
import { db, useCloudDatabase } from '../store/db';
import { markCloudApply, type OutboxRow } from './cache';
import { cloud, cloudRequest } from './state';
import { CLOUD_TABLES, type CloudRecord, type CloudConfig } from '@wangke/contracts/cloud';
import { useSettings } from '../store/settings';
import { flushPreferences, loadPreferences, startPreferences } from './preferences';
import { apiUrl } from '../api/base';

export const useCloudSync = create<{ pending: number; error: string; syncedAt: number }>()(() => ({ pending: 0, error: '', syncedAt: 0 }));
let timer: ReturnType<typeof setInterval> | undefined;
let flight: Promise<void> | undefined;
const fileCache = new Map<string, Blob>();
let configSignature = '';
let configCheckedAt = 0;

export function applyCloudConfig(config: CloudConfig) {
  configSignature = JSON.stringify(config);
  configCheckedAt = Date.now();
  cloud.maxSteps = config.policy.maxSteps;
  useSettings.setState({
    providers: config.providers.map(p => ({ ...p, baseUrl: apiUrl(`/api/v1/cloud/models/${encodeURIComponent(p.id)}`), apiKey: p.configured ? 'server-managed' : 'server-local' })),
    llmModel: config.llmModel, visionModel: config.visionModel, asrModel: config.asrModel,
    ...decisionPatch(config),
    syncEnabled: false,
  });
}

/**
 * 决策模型只认服务器配置：旧本机安装留下的决策凭据不能绕过服务器。
 * 选了决策模型也不会自动打开技能路由 / 上下文压缩，仍需用户在设置里单独开启。
 */
function decisionPatch(config: CloudConfig) {
  const ref = config.decisionModel;
  const state = useSettings.getState();
  if (!ref?.model || !config.providers.some(p => p.id === ref.providerId)) {
    return { jev: { skillRouting: false, contextCompression: false }, decisionModel: { providerId: '', model: '' } };
  }
  const saved = state.savedModels ?? [];
  const known = saved.some(m => m.providerId === ref.providerId && m.model === ref.model && m.slots.includes('decision'));
  return {
    decisionModel: { providerId: ref.providerId, model: ref.model },
    ...(known ? {} : { savedModels: [...saved, { ...ref, name: '', slots: ['decision' as const], modelType: 'decision', toolCalling: false, decisionProtocol: 'typesafe-systemone' as const }] }),
  };
}

async function uploadBlob(blob: Blob): Promise<{ $file: string; type: string }> {
  const hash = await blobHash(blob);
  const cached = await db.table('_cloudBlobs').get(hash);
  if (cached) return { $file: cached.id, type: blob.type };
  const response = await fetch(apiUrl('/api/v1/files'), { method: 'POST', credentials: 'include', headers: {
    'content-type': 'application/octet-stream', 'x-file-name': 'cache-blob', 'x-file-mime': blob.type || 'application/octet-stream',
  }, body: blob });
  if (!response.ok) throw new Error(`文件同步失败（${response.status}）`);
  const file = await response.json();
  await db.table('_cloudBlobs').put({ hash, id: file.id });
  return { $file: file.id, type: blob.type };
}
async function blobHash(blob: Blob) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), b => b.toString(16).padStart(2, '0')).join('');
}
async function encode(value: any): Promise<any> {
  if (value instanceof Blob) return uploadBlob(value);
  if (Array.isArray(value)) return Promise.all(value.map(encode));
  if (value && typeof value === 'object') return Object.fromEntries(await Promise.all(Object.entries(value).filter(([,v]) => v !== undefined).map(async ([k,v]) => [k, await encode(v)])));
  return value;
}
async function decode(value: any): Promise<any> {
  if (value && typeof value.$file === 'string') {
    const cached = fileCache.get(value.$file);
    if (cached) return cached;
    const response = await fetch(apiUrl(`/api/v1/files/${encodeURIComponent(value.$file)}`), { credentials: 'include' });
    if (!response.ok) throw new Error(`无法同步文件（${response.status}）`);
    const blob = new Blob([await response.blob()], { type: value.type });
    await db.table('_cloudBlobs').put({ hash: await blobHash(blob), id: value.$file });
    // Bounded cache; IndexedDB remains the durable cache after decoding.
    if (fileCache.size >= 50) fileCache.delete(fileCache.keys().next().value!);
    fileCache.set(value.$file, blob);
    return blob;
  }
  if (Array.isArray(value)) return Promise.all(value.map(decode));
  if (value && typeof value === 'object') return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([k,v]) => [k, await decode(v)])));
  return value;
}

async function syncCycle() {
  if (!cloud.worker && Date.now() - configCheckedAt > 15000) {
    const config = await cloudRequest<CloudConfig>('/config');
    configCheckedAt = Date.now();
    if (JSON.stringify(config) !== configSignature) applyCloudConfig(config);
  }
  let changed = false;
  const outbox = db.table<OutboxRow>('_cloudOutbox');
  // One original transaction per POST; acknowledged operations are removed only after commit.
  for (;;) {
    const first = await outbox.orderBy('sequence').first();
    if (!first) break;
    const rows = await outbox.where('transaction').equals(first.transaction).toArray();
    useCloudSync.setState({ pending: await outbox.count() });
    const mutations = [];
    for (const row of rows) mutations.push({ id: row.id, table: row.table, key: row.key, permissionId: row.permissionId,
      baseRevision: (await db.table('_cloudMeta').get(`revision:${row.table}:${JSON.stringify(row.key)}`))?.value,
      before: await encode(row.before), after: await encode(row.after) });
    const result = await cloudRequest<{ versions: Array<{ table: string; key: string | number; revision: number }> }>('/records', { method: 'POST', body: JSON.stringify({ mutations }) });
    await db.transaction('rw', outbox, db.table('_cloudMeta'), async () => {
      await outbox.bulkDelete(rows.map(r => r.sequence!));
      await db.table('_cloudMeta').bulkPut(result.versions.map(r => ({ id: `revision:${r.table}:${JSON.stringify(r.key)}`, value: r.revision })));
    });
  }
  let cursor = (await db.table('_cloudMeta').get('cursor'))?.value ?? 0;
  for (;;) {
    const page = await cloudRequest<{ records: CloudRecord[]; cursor: number; more: boolean }>(`/records?after=${cursor}`);
    if (page.records.length) changed = true;
    const decoded: CloudRecord[] = [];
    for (const record of page.records) decoded.push({ ...record, value: await decode(record.value) });
    let applied = false;
    await db.transaction('rw', db.tables, async () => {
      markCloudApply();
      // A UI write during network I/O must be pushed before applying its remote echo.
      if (await outbox.count()) return;
      for (const record of decoded) {
        if (!Object.hasOwn(CLOUD_TABLES, record.table)) throw new Error('服务器返回了未知数据表');
        const table = db.table(record.table);
        if (record.value === null) await table.delete(record.key);
        else await table.put(record.value);
        await db.table('_cloudMeta').put({ id: `revision:${record.table}:${JSON.stringify(record.key)}`, value: record.revision });
      }
      await db.table('_cloudMeta').put({ id: 'cursor', value: page.cursor });
      applied = true;
    });
    if (!applied) return;
    cursor = page.cursor;
    if (!page.more) break;
  }
  useCloudSync.setState({ pending: await outbox.count(), error: '', syncedAt: Date.now() });
  if (changed) window.dispatchEvent(new Event('cloud-data-changed'));
  if (changed) await loadPreferences();
}

export function flushCloud(): Promise<void> {
  if (!cloud.enabled) return Promise.resolve();
  if (flight) return flight.then(async () => {
    if (await db.table('_cloudOutbox').count()) await flushCloud();
  });
  if (!flight) flight = (async () => {
    const drain = async () => { await flushPreferences(); do { await syncCycle(); } while (await db.table('_cloudOutbox').count()); };
    if (navigator.locks) await navigator.locks.request(`cloud-sync:${cloud.userId}`, drain);
    else await drain();
  })().catch(error => {
    const detail = (error as { detail?: { table?: string; key?: unknown } }).detail;
    useCloudSync.setState({ error: (error as Error).message === 'sync_conflict'
      ? `同步冲突：${detail?.table}/${String(detail?.key)}。本机修改已保留，请在云端管理中处理。`
      : (error as Error).message });
    throw error;
  }).finally(() => { flight = undefined; });
  return flight;
}

export async function resolveCloudConflict() {
  if (navigator.locks) return navigator.locks.request(`cloud-sync:${cloud.userId}`, resolveConflictLocked);
  return resolveConflictLocked();
}
async function resolveConflictLocked() {
  const rows = await db.table<OutboxRow>('_cloudOutbox').orderBy('sequence').toArray();
  if (!rows.length) return;
  const encoded = [];
  for (const row of rows) encoded.push({ ...row, before: await encode(row.before), after: await encode(row.after) });
  const url = URL.createObjectURL(new Blob([JSON.stringify(encoded, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = `wangke-conflict-${Date.now()}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  const records: CloudRecord[] = [];
  for (const row of rows) {
    const result = await cloudRequest<{ value: Record<string, unknown> | null }>(`/record?table=${encodeURIComponent(row.table)}&key=${encodeURIComponent(JSON.stringify(row.key))}`);
    records.push({ table: row.table, key: row.key, value: await decode(result.value), revision: 0 });
  }
  await db.transaction('rw', db.tables, async () => {
    if (await db.table('_cloudOutbox').count() !== rows.length) throw new Error('下载期间有新的修改，请停止编辑后重试处理冲突');
    markCloudApply();
    for (const record of records) {
      if (record.value) await db.table(record.table).put(record.value);
      else await db.table(record.table).delete(record.key);
    }
    await db.table('_cloudOutbox').bulkDelete(rows.map(r => r.sequence!));
  });
  await syncCycle();
}

export async function startCloud(owner: string, worker = false) {
  cloud.enabled = true; cloud.userId = owner; cloud.worker = worker;
  useCloudDatabase(owner);
  await db.open();
  useSettings.persist.setOptions({ name: `wangke-cloud-settings-${owner}` });
  // 登录前的语言不随模型配置重置；有账号语言偏好时，后续 loadPreferences 再覆盖。
  const uiLanguage = useSettings.getState().uiLanguage;
  useSettings.setState({ ...useSettings.getInitialState(), uiLanguage });
  const config = await cloudRequest<CloudConfig>('/config');
  applyCloudConfig(config);
  try { await flushCloud(); }
  catch (error) {
    // Existing local edits must remain reachable through conflict recovery after reload.
    if (worker || !(await db.table('_cloudOutbox').count())) throw error;
  }
  await startPreferences();
  clearInterval(timer);
  timer = setInterval(() => void flushCloud().catch(() => {}), worker ? 250 : 1500);
}

export function stopCloud() {
  clearInterval(timer); fileCache.clear();
  // Re-enter through the auth gate on a fresh JS realm: no parked conversations or model
  // settings from a previous identity remain visible after logout/session expiry.
  window.location.reload();
}

/** Discard this browser's cloud cache after a server-side account reset. */
export async function clearCloudLocalData() {
  clearInterval(timer);
  fileCache.clear();
  flight = undefined;
  configSignature = '';
  configCheckedAt = 0;
  const owner = cloud.userId;
  cloud.enabled = false;
  cloud.userId = '';
  cloud.worker = false;
  cloud.taskId = '';
  cloud.workerToken = '';
  cloud.permissionId = undefined;
  useSettings.persist.setOptions({ name: 'wangke-settings' });
  if (owner) localStorage.removeItem(`wangke-cloud-settings-${owner}`);
  useSettings.setState(useSettings.getInitialState());
  await useSettings.persist.clearStorage();
  await db.delete();
}
