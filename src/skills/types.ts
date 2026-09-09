/** Skill 文件（Agent Skills 规范子集）：YAML frontmatter + Markdown 正文 */

export interface SkillFile {
  name: string;
  description: string;
  body: string;
}

/** 解析 .md 文件为 Skill；无 frontmatter 时用文件名作名称 */
export function parseSkillMarkdown(filename: string, text: string): SkillFile {
  let name = filename.replace(/\.(md|markdown)$/i, '');
  let description = '';
  let body = text;

  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (fm) {
    body = text.slice(fm[0].length);
    for (const line of fm[1].split(/\r?\n/)) {
      const m = line.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
      if (!m) continue;
      const val = m[2].trim().replace(/^["']|["']$/g, '');
      if (m[1] === 'name' && val) name = val;
      else if (m[1] === 'description') description = val;
    }
  }
  return { name: name.trim(), description: description.trim(), body: body.trim() };
}

/** 序列化为带 frontmatter 的 .md 文本（导出/编辑用） */
export function serializeSkillMarkdown(skill: SkillFile): string {
  return `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n${skill.body}\n`;
}
