/** Web and IM use the same attachment envelope. Old single-file messages remain valid. */
export interface BotAttachment {
  fileId?: string;
  projectId?: string;
  projectPath?: string;
  originalName?: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
}

/** Interactive Web upload budget; independent of the incoming message size. */
export const MAX_BOT_ATTACHMENTS = 8;
// A WeChat chat selection can contain up to 99 photos. Keep the persisted
// envelope intact instead of turning one selection into multiple Bot turns.
export const MAX_BOT_MESSAGE_ATTACHMENTS = 99;

export function parseBotAttachments(content: string): { files: BotAttachment[]; text: string } | null {
  try {
    const value = JSON.parse(content);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const files = value.attachments === undefined ? [value] : value.attachments;
    if (!Array.isArray(files) || !files.length || files.length > MAX_BOT_MESSAGE_ATTACHMENTS) return null;
    if (!files.every(file => file && typeof file === 'object' && !Array.isArray(file) &&
      ['fileId', 'projectId', 'projectPath', 'originalName', 'name', 'mimeType'].every(key => file[key] === undefined || typeof file[key] === 'string') &&
      (file.sizeBytes === undefined || typeof file.sizeBytes === 'number' && Number.isFinite(file.sizeBytes) && file.sizeBytes >= 0) && (
      typeof file.fileId === 'string' && file.fileId.length > 0 ||
      typeof file.projectId === 'string' && typeof file.projectPath === 'string' && file.projectPath.length > 0
    ))) return null;
    return { files, text: typeof value.caption === 'string' ? value.caption : '' };
  } catch { return null; }
}

/** Display-only compatibility: never treat arbitrary prose or links as file URLs. */
export function parseLegacyBotAttachments(content: string): { files: BotAttachment[]; text: string } | null {
  const files: BotAttachment[] = [];
  const text = content.replace(/^Attachment fileId=([a-f0-9-]{36}), name=(.+), mime=([\w.+-]+\/[\w.+-]+)\. Use study_file to read\/understand it\.$/gm,
    (_line, fileId: string, originalName: string, mimeType: string) => { files.push({ fileId, originalName, mimeType }); return ''; }).trim();
  return files.length ? { files, text } : null;
}
