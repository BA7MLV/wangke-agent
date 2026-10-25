import type { VideoRow } from '../store/db';
import { useSettings } from '../store/settings';
import { MD_MIME } from './md';

export const AGENT_INSTRUCTIONS_FILE_ID = 'system:agent-instructions';
export const AGENT_INSTRUCTIONS_ROUTE = `/player/${encodeURIComponent(AGENT_INSTRUCTIONS_FILE_ID)}`;

/** System Markdown uses the ordinary reader/editor, with settings as its only backing store. */
export function getSystemMaterialFile(id: string): Blob | undefined {
  if (id !== AGENT_INSTRUCTIONS_FILE_ID) return;
  return new Blob([useSettings.getState().agentInstructions], { type: MD_MIME });
}

export function getSystemMaterial(id: string): VideoRow | undefined {
  const file = getSystemMaterialFile(id);
  if (!file) return;
  return { id, name: 'AGENTS.md', kind: 'material', materialFormat: 'md', mimeType: MD_MIME,
    size: file.size, duration: 0, createdAt: 0, status: 'transcribed' };
}

export function saveSystemMarkdown(id: string, text: string, expected?: string): boolean {
  if (id !== AGENT_INSTRUCTIONS_FILE_ID) return false;
  const settings = useSettings.getState();
  if (expected !== undefined && settings.agentInstructions !== expected) {
    throw new Error('文件已在其他页面更新，请重新读取后再修改。');
  }
  settings.update({ agentInstructions: text });
  return true;
}
