/** 对话只暴露任务入口；旧 IR 规范保留身份，供旧流水线及历史选择兼容。 */
export const COURSE_HANDOUT_SKILL = '课程讲义';

export const LEGACY_HANDOUT_TOPICS: Readonly<Record<string, string>> = {
  公文讲义写作: 'references/writing.md',
  公文版式规格: 'references/writing.md',
  数学讲义写作: 'references/math-writing.md',
  编程讲义写作: 'references/coding-writing.md',
  公考行测讲义: 'references/gongkao-xingce.md',
  公考申论讲义: 'references/gongkao-shenlun.md',
};

export function isLegacyHandoutSkill(skill: { name: string; builtin?: number }): boolean {
  // 用户导入/编辑的同名技能是独立内容，不能按名称隐藏或重定向。
  return !!skill.builtin && Object.hasOwn(LEGACY_HANDOUT_TOPICS, skill.name);
}
