import { editMarkdownText, grepMarkdownText, readMarkdownText } from './markdownResource';
import { readSystemDocument, saveSystemMarkdown, systemMaterialId } from '../materials/systemFiles';
import { memoryName } from '@wangke/contracts/system';
import { ServerApiError } from '../api/serverClient';

export function executeAgentInstructionsResource(name: string, args: Record<string, unknown>) {
  return executeSystemDocumentResource(name, '/system/AGENTS.md', args);
}

/** Reads and editor saves use the same server document as Bot memory/settings. */
export async function executeSystemDocumentResource(name: string, path: string, args: Record<string, unknown>): Promise<string> {
  let document;
  try { document = await readSystemDocument(path); }
  catch (error) {
    if (name !== 'edit' || args.create !== true || !memoryName(path) || !(error instanceof ServerApiError) || error.status !== 404) throw error;
    if (typeof args.content !== 'string') return '创建笔记需提供 content。';
    await saveSystemMarkdown(systemMaterialId(path)!, args.content, '', true);
    return `已创建笔记 ${path}，与资料和 Bot 共用同一份实体文件。`;
  }
  const text = document.content;
  const agent = path === '/system/AGENTS.md';
  const link = `[${document.name}](#/library?file=${path})`;
  const detail = agent ? '与「设置 → Agent」共用同一份内容。' : `与 Bot 共用同一份记忆；scope=${document.scope}:${document.scopeId ?? ''}，revision=${document.revision}，status=${document.status}，source=${document.source}。`;
  if (name === 'read') return `${readMarkdownText(text, path, args)}\n\n系统${agent ? '指令' : '记忆'}文件：${link}，${detail}${text.length === 0 ? '当前为空，使用应用默认行为；用户要求写入指令时，可用 edit(create=true, content=...) 初始化。' : ''}`;
  if (name === 'grep') return grepMarkdownText(text, path, args);
  if (name !== 'edit') return '此文件支持 read、grep、edit。';
  if (args.create === true) {
    if (text.length > 0) return '文件已存在且非空，请先 read，再用 edits 修改；不能覆盖已有指令。';
    if (typeof args.content !== 'string') return '初始化空指令需提供 content。';
    await saveSystemMarkdown(systemMaterialId(path)!, args.content, text);
  } else {
    const result = editMarkdownText(text, args);
    if (typeof result === 'string') return result;
    await saveSystemMarkdown(systemMaterialId(path)!, result.text, text);
  }
  return `已保存 ${path}，已同步到${agent ? '「设置 → Agent」' : 'Bot 记忆'}和资料中的 ${link}。${agent ? '新的默认提示词从下一次发送起生效。' : '作用域、来源和版本由服务端保留。'}`;
}
