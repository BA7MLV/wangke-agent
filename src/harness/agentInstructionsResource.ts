import { useSettings } from '../store/settings';
import { editMarkdownText, grepMarkdownText, readMarkdownText } from './markdownResource';

/** 保留路径的系统文件：设置即原文，不建立第二份资料副本或双向复制订阅。 */
export function executeAgentInstructionsResource(name: string, args: Record<string, unknown>): string {
  const path = '/system/AGENTS.md';
  const { agentInstructions: text, update } = useSettings.getState();
  const link = '[AGENTS.md](#/library?file=/system/AGENTS.md)';
  if (name === 'read') return `${readMarkdownText(text, path, args)}\n\n系统指令文件：${link}，与「设置 → Agent」共用同一份内容。${text.length === 0 ? '当前为空，使用应用默认行为；用户要求写入指令时，可用 edit(create=true, content=...) 初始化。' : ''}`;
  if (name === 'grep') return grepMarkdownText(text, path, args);
  if (name !== 'edit') return '此文件支持 read、grep、edit。';
  if (args.create === true) {
    if (text.length > 0) return '文件已存在且非空，请先 read，再用 edits 修改；不能覆盖已有指令。';
    if (typeof args.content !== 'string') return '初始化空指令需提供 content。';
    update({ agentInstructions: args.content });
  } else {
    const result = editMarkdownText(text, args);
    if (typeof result === 'string') return result;
    update({ agentInstructions: result.text });
  }
  return `已保存 ${path}，已同步到「设置 → Agent」和资料中的 ${link}。新的默认提示词从下一次发送起生效。`;
}
