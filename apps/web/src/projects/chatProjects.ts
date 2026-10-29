import type { ProjectDetailDto } from '@wangke/contracts';
import type { ResourceDirectory, ResourceFolderColor } from '@wangke/contracts/resources';
import { request } from '../api/serverClient';
import { cloud } from '../cloud/state';
import { flushCloud } from '../cloud/sync';
import { db } from '../store/db';

export interface ChatProject { folderId: number; name: string; color?: ResourceFolderColor }
export const projectDisplayName = (name: string) => name.replace(/^项目[：:]\s*/, '');
export function projectFolderName(name: string) {
  const title = projectDisplayName(name.trim()).trim();
  if (!title || title.length > 97 || /[\\/\u0000-\u001f\u007f]/.test(title)) throw new Error('invalid_project_name');
  return `项目：${title}`;
}
export async function listChatProjects(): Promise<ChatProject[]> {
  if (cloud.enabled) {
    await flushCloud();
    const data = await request<ResourceDirectory>('/resources');
    return data.entries.filter(entry => entry.kind === 'directory' && entry.scope && entry.folderId != null)
      .map(entry => ({ folderId: entry.folderId!, name: entry.name, color: entry.color }));
  }
  return (await db.folders.toArray()).filter(folder => folder.parentId == null && folder.id != null)
    .map(folder => ({ folderId: folder.id!, name: folder.name, color: folder.color }));
}
export async function createChatProject(name: string): Promise<ChatProject> {
  const folderName = projectFolderName(name);
  if (cloud.enabled) {
    const project = await request<ProjectDetailDto & { folderId: number }>('/resources/folders', { method: 'POST', body: JSON.stringify({ name: folderName }) });
    return { folderId: project.folderId, name: project.name };
  }
  const folderId = await db.folders.add({ name: folderName, createdAt: Date.now() });
  return { folderId, name: folderName };
}
