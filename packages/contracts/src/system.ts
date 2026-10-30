/** System documents share the Bot/settings revision, not a second material record. */
export interface SystemDocument {
  path: string;
  name: string;
  content: string;
  revision: number;
  updatedAt: string | null;
  status?: string;
  scope?: string;
  scopeId?: string;
  source?: string;
  summary?: string;
  kind?: string;
  slug?: string;
  version?: string;
  sha256?: string;
  enabled?: boolean;
}

export interface SystemDirectory {
  files: Omit<SystemDocument, 'content'>[];
  directories?: string[];
  nextOffset: number | null;
}

export const AGENTS_PATH = '/system/AGENTS.md';
export const MCP_PATH = '/system/mcp.json';
export const MEMORY_PATH = '/system/memory';
export const SKILLS_PATH = '/system/skills';
export const memoryPath = (id: string) => `${MEMORY_PATH}/${id}.md`;
export const systemSaveArguments = (path: string, content: string, expected: string, revision: number) => ({ tool: 'system_file_save', path, content, expected, revision });
export function memoryId(path: unknown): string | undefined {
  return typeof path === 'string' ? /^\/system\/memory\/([a-f0-9-]{36})\.md$/.exec(path)?.[1] : undefined;
}
/** Flat, portable notebook names; never host paths or hidden files. */
export function memoryName(path: unknown): string | undefined {
  return typeof path === 'string' ? /^\/system\/memory\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,99})\.md$/.exec(path)?.[1] : undefined;
}
export function diaryDate(path: string): string | undefined {
  const name = memoryName(path);
  if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(name)) return;
  const date = new Date(`${name}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === name ? name : undefined;
}
