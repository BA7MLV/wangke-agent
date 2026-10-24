/** 全局用户指令保留 Markdown 原文；旧设置、导入和同步的非法值回落为空。 */
export function normalizeAgentInstructions(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 只补充用户偏好，不替换工具能力、事实依据和输出契约。空值不改变原提示词。 */
export function withAgentInstructions(prompt: string, instructions?: string): string {
  const text = normalizeAgentInstructions(instructions).trim();
  if (!text) return prompt;
  return `${prompt}\n\n## 用户设置的 Agent 默认提示词\n来源：/system/AGENTS.md，与设置页及资料中的同名系统文件共用原文，可 read 读取最新版。以下是用户的长期偏好，适用于本次对话。回答语言、语气、详略和讲解方式优先采用这些偏好；本轮用户的明确要求优先于长期偏好。工具能力边界、事实依据、引用与输出格式契约仍须遵守。\n\n${text}`;
}
