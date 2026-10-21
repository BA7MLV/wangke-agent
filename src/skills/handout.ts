import { loadEnabledSkillMeta } from './store';

const HANDOUT_SKILL = '课程讲义';

/** 显式快捷操作仍走普通 read 技能资源与会话白名单，不另建生成执行体。 */
export async function prepareHandoutPrompt(skillIds?: number[]) {
  const skill = (await loadEnabledSkillMeta()).find((s) => s.name === HANDOUT_SKILL);
  if (!skill) throw new Error('请先在「设置 → 写作技能」中启用「课程讲义」');
  return {
    skillIds: skillIds === undefined || skillIds.includes(skill.id) ? skillIds : [...skillIds, skill.id],
    prompt: `请先 read /skills/${encodeURIComponent(HANDOUT_SKILL)} 加载「${HANDOUT_SKILL}」技能，再根据当前课程或已选资料整理学习讲义。先确认来源和范围，分段读取原文，按章节写清核心概念、方法步骤、原文例题和易错点，并标注出处。用现有 read / edit 将讲义保存为来源课程同目录的 Markdown 资料，以讲义.md 文件为唯一真相源。先 read 课程详情给出的 handout.md 路径，已存在则基于最新原文修改，不覆盖用户笔记；未存在才 create。每章保存后核对文件，并在对话展示正文或摘要及文件链接，方便实时查看；长内容可分章继续，明确已覆盖与尚未读取的范围。没有明确来源时先询问。`,
  };
}

/** 插入可编辑草稿，保留用户已写的要求；重复点击不堆叠同一段提示词。 */
export function handoutDraft(draft: string, prompt: string): string {
  if (draft.includes(prompt)) return draft;
  return draft.trim() ? `${prompt}\n\n补充要求：\n${draft}` : prompt;
}
