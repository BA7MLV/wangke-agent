/** Skill 文件（Agent Skills 规范子集）：YAML frontmatter + Markdown 正文 */

export interface SkillFile {
  name: string;
  description: string;
  body: string;
}

/**
 * YAML 块标量指示符：`>`（折叠）或 `|`（字面），后跟可选的显式缩进与 chomping，
 * 两者顺序任意 —— 实际能见到 `>-`、`>2-`、`|-2` 等写法。
 */
const BLOCK_SCALAR_RE = /^[>|][\d+-]*$/;

/**
 * 吃掉块标量的续行，**一律折成单行空格分隔**。
 *
 * 为什么连 `|`（字面标量，本该保留换行）也折掉：`description` 会被
 * `skillMetaBlock()` 拼成 `- 名称：描述` 的**单行清单**喂给路由器，
 * 描述里带换行会把一条技能劈成两行、让路由按行误读。所以这里统一压成空格，
 * 顺带也保证 `serializeSkillMarkdown()` 的往返是稳定的（它写的是单行）。
 */
function readBlockScalar(lines: string[], start: number): { text: string; next: number } {
  const parts: string[] = [];
  let i = start;
  // 首行缩进即基准；没有缩进的续行说明块标量是空的
  let baseIndent: number | null = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') {
      parts.push('');
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (indent === 0) break; // 回到顶层键，说明块结束了
    baseIndent ??= indent;
    if (indent < baseIndent) break;
    parts.push(line.slice(baseIndent));
  }
  // 默认 chomping 是 clip：去掉尾部空行。缩进为 0 的空行不属于块，别把下一个键吃掉
  while (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  // 空行在块内是段落分隔，折成空格后压掉多余空白
  const text = parts
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { text, next: i };
}

/**
 * 解析 .md 文件为 Skill；无 frontmatter 时用文件名作名称。
 *
 * frontmatter 支持 YAML 块标量：`description: >-` 是 Agent Skills 写多行描述的
 * 常规写法（外部 skill 几乎都这么写）。**必须认**，否则逐行正则会把值读成字面量
 * `>-`，真正的描述被静默丢弃 —— 表现是 Level 1 清单里渲染成 `- 名称：>-`，
 * 路由器拿不到任何用途信息，于是永远选不中这个技能。
 */
export function parseSkillMarkdown(filename: string, text: string): SkillFile {
  let name = filename.replace(/\.(md|markdown)$/i, '');
  let description = '';
  let body = text;

  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (fm) {
    body = text.slice(fm[0].length);
    const lines = fm[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(\w[\w-]*)\s*:\s*(.*)$/);
      if (!m) continue;
      const key = m[1];
      const raw = m[2].trim();

      let val: string;
      if (BLOCK_SCALAR_RE.test(raw)) {
        const block = readBlockScalar(lines, i + 1);
        val = block.text;
        i = block.next - 1; // 跳过已消费的续行
      } else {
        val = raw.replace(/^["']|["']$/g, '');
      }

      if (key === 'name' && val) name = val;
      else if (key === 'description') description = val;
    }
  }
  return { name: name.trim(), description: description.trim(), body: body.trim() };
}

/** 序列化为带 frontmatter 的 .md 文本（导出/编辑用） */
export function serializeSkillMarkdown(skill: SkillFile): string {
  return `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n${skill.body}\n`;
}
