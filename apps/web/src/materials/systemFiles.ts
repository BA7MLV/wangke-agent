import type { VideoRow } from '../store/db';
import { useSettings } from '../store/settings';
import { MD_MIME } from './md';
import { create } from 'zustand';
import { cloud, cloudRequest, requestToolPermission } from '../cloud/state';
import { request, ServerApiError } from '../api/serverClient';
import { AGENTS_PATH, MEMORY_PATH, memoryName, memoryPath, systemSaveArguments, type SystemDocument, type SystemDirectory } from '@wangke/contracts/system';

export const AGENT_INSTRUCTIONS_FILE_ID = 'system:agent-instructions';
export const AGENT_INSTRUCTIONS_ROUTE = `/player/${encodeURIComponent(AGENT_INSTRUCTIONS_FILE_ID)}`;
export const useSystemDocuments = create<{ documents: Record<string, SystemDocument> }>()(() => ({ documents: {} }));
export function systemMaterialPath(id: string): string | undefined {
  if (id === AGENT_INSTRUCTIONS_FILE_ID) return AGENTS_PATH;
  const path = memoryPath(id.replace(/^system:memory:/, ''));
  return id.startsWith('system:memory:') && memoryName(path) ? path : undefined;
}
export function systemMaterialId(path: string): string | undefined {
  return path === AGENTS_PATH ? AGENT_INSTRUCTIONS_FILE_ID : memoryName(path) ? `system:memory:${memoryName(path)}` : undefined;
}
export const systemMaterialRoute = (path: string) => `/player/${encodeURIComponent(systemMaterialId(path)!)}`;

const systemRequest = <T>(path: string, init: RequestInit = {}) => request<T>(path, {
  ...init, headers: { ...(cloud.workerToken ? { authorization: `Bearer ${cloud.workerToken}` } : {}), ...init.headers },
});

function remember(document: SystemDocument) {
  const previous = useSystemDocuments.getState().documents[document.path];
  if (previous && (previous.revision > document.revision || previous.revision === document.revision && previous.status === 'stale' && document.status === 'active')) return previous;
  if (previous && JSON.stringify(previous) === JSON.stringify(document)) return previous;
  useSystemDocuments.setState(state => ({ documents: { ...state.documents, [document.path]: document } }));
  return document;
}

export async function readSystemDocument(path: string): Promise<SystemDocument> {
  if (!cloud.enabled && path === AGENTS_PATH) return { path, name: 'AGENTS.md', content: useSettings.getState().agentInstructions, revision: 0, updatedAt: null };
  if (path === AGENTS_PATH) await (await import('../cloud/sync')).flushCloud();
  return remember(await systemRequest<SystemDocument>(`/system/file?path=${encodeURIComponent(path)}`));
}

export async function listSystemMemory(offset = 0, query = ''): Promise<SystemDirectory> {
  if (!cloud.enabled) return { files: [], nextOffset: null };
  return systemRequest<SystemDirectory>(`/system/files?path=${encodeURIComponent(MEMORY_PATH)}&offset=${offset}&query=${encodeURIComponent(query)}`);
}

export async function loadSystemMaterialFile(id: string): Promise<Blob | undefined> {
  const path = systemMaterialPath(id);
  if (!path) return;
  const document = await readSystemDocument(path);
  return new Blob([document.content], { type: MD_MIME });
}

/** Synchronous cache for reader refreshes; cloud loads/saves always reach the server. */
export function getSystemMaterialFile(id: string): Blob | undefined {
  const path = systemMaterialPath(id);
  if (!path) return;
  const content = id === AGENT_INSTRUCTIONS_FILE_ID ? useSettings.getState().agentInstructions : useSystemDocuments.getState().documents[path]?.content;
  return content === undefined ? undefined : new Blob([content], { type: MD_MIME });
}

export function getSystemMaterial(id: string): VideoRow | undefined {
  const path = systemMaterialPath(id);
  if (!path) return;
  const file = getSystemMaterialFile(id);
  return { id, name: path.split('/').pop()!, kind: 'material', materialFormat: 'md', mimeType: MD_MIME,
    size: file?.size ?? 0, duration: 0, createdAt: 0, status: 'transcribed' };
}

export async function saveSystemMarkdown(id: string, text: string, expected?: string, create = false): Promise<boolean> {
  const path = systemMaterialPath(id);
  if (!path) return false;
  if (cloud.enabled) {
    const { flushCloud } = await import('../cloud/sync');
    await flushCloud();
    let current: SystemDocument;
    try { current = await readSystemDocument(path); }
    catch (error) {
      if (!create || !(error instanceof ServerApiError) || error.status !== 404 || !memoryName(path)) throw error;
      current = { path, name: `${memoryName(path)}.md`, content: '', revision: 0, updatedAt: null };
    }
    if (create && current.revision !== 0) throw new Error('文件已存在，请先读取，再按原文修改。');
    if (expected !== undefined && current.content !== expected) throw new Error('文件已在其他页面更新，请重新读取后再修改。');
    let saved: SystemDocument;
    const args = systemSaveArguments(path, text, current.content, current.revision);
    const permissionId = await requestToolPermission('write', args);
    try {
      saved = remember(await systemRequest<SystemDocument>('/system/file', { method: 'POST', body: JSON.stringify({ ...args, permissionId }) }));
    } catch (e) {
      if (e instanceof ServerApiError && e.status === 409) throw new Error('文件已在其他页面更新，请重新读取后再修改。');
      if (e instanceof ServerApiError && e.code === 'memory_source_changed') throw new Error('记忆的来源已变化，请在 Bot 记忆管理中核实后更新。');
      throw e;
    } finally {
      if (permissionId) await cloudRequest(`/tasks/${cloud.taskId}/authorize/finish`, { method: 'POST', body: JSON.stringify({ permissionId }) });
    }
    await flushCloud();
    if (path === AGENTS_PATH) {
      const { applySystemAgentInstructions } = await import('../cloud/preferences');
      await applySystemAgentInstructions(saved.content);
    }
    window.dispatchEvent(new Event('system-files-changed'));
    return true;
  }
  if (id !== AGENT_INSTRUCTIONS_FILE_ID) throw new Error('请登录后读取或编辑 Bot 记忆。');
  const settings = useSettings.getState();
  if (expected !== undefined && settings.agentInstructions !== expected) {
    throw new Error('文件已在其他页面更新，请重新读取后再修改。');
  }
  settings.update({ agentInstructions: text });
  return true;
}
