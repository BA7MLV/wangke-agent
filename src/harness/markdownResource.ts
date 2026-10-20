import { db } from '../store/db';
import { getMaterialFile } from '../store/fileStore';
import { planAgentEdits, type AgentEdit, type EditChange } from '../md-editor/edits';
import { saveMarkdownMaterial } from '../materials/markdownFile';

export function markdownRegex(pattern: unknown, flags: unknown = 'm'): RegExp {
  if (typeof pattern !== 'string' || !pattern || pattern.length > 1000) throw new Error('正则需为 1–1000 字符。');
  if (typeof flags !== 'string' || !/^[imsu]*$/.test(flags)) throw new Error('flags 只支持 i、m、s、u。');
  return new RegExp(pattern, flags);
}

/** read/grep/edit share the original Markdown, including comments and line breaks. */
export async function executeMarkdownResource(name: string, id: string, path: string, args: Record<string, unknown>) {
  if (path === `/${id}` && !await db.videos.get(id)) {
    const candidates = await db.videos.filter((r) => r.kind === 'material' && r.materialFormat === 'md' &&
      (r.name === id || `${r.name}.md` === id)).toArray();
    if (candidates.length > 1) return '存在多个同名文件，请通过 /courses 列表取得唯一的 material 路径。';
    if (candidates[0]) id = candidates[0].id;
  }
  const course = await db.videos.get(id);
  if (course && (course.kind !== 'material' || course.materialFormat !== 'md')) return '该路径不是 Markdown 文件。';
  const file = await getMaterialFile(id);
  const text = file ? await file.text() : '';
  if (!file && name !== 'edit') return `文件不存在：${path}。可用 edit 的 create=true、content 创建普通 Markdown 文件。`;
  const lines = text.split('\n');
  if (name === 'read') {
    const start = Number(args.offset ?? 0);
    const count = Math.min(Number(args.limit ?? 50), 200);
    return `path=${path}\n总行数：${lines.length}\n` + lines.slice(start, start + count).map((s, i) => `${start + i + 1}: ${s}`).join('\n');
  }
  if (name === 'grep') {
    const regex = args.regex === true ? markdownRegex(args.query, args.flags) : undefined;
    const query = String(args.query);
    const hits = lines.flatMap((s, i) => (regex ? regex.test(s) : s.toLowerCase().includes(query.toLowerCase())) ? [`${i + 1}: ${s}`] : []);
    return `path=${path}\n${hits.slice(0, Math.min(Number(args.limit ?? 15), 50)).join('\n') || '没有匹配。'}`;
  }
  if (args.create === true) {
    if (file || course) return '文件已存在，请先 read，再用 edits 修改。';
    if (typeof args.content !== 'string') return '创建文件需提供 content。';
    await saveMarkdownMaterial(id, args.content, '', path.slice(1));
    return `已创建 ${path}`;
  }
  if (!file) return '文件不存在，请先用 create=true、content 创建。';
  if (!Array.isArray(args.edits) || !args.edits.length) return '请提供非空 edits。';
  const changes: EditChange[] = [];
  for (const value of args.edits) {
    if (!value || typeof value !== 'object') throw new Error('edit 必须是对象。');
    const edit = value as Record<string, unknown>;
    if (edit.regex !== true) {
      const plan = planAgentEdits(text, [edit as unknown as AgentEdit]);
      if (!plan.ok) return plan.error;
      changes.push(...plan.changes);
      continue;
    }
    const re = markdownRegex(edit.old_string, edit.flags);
    const matches = [...text.matchAll(new RegExp(re.source, re.flags + 'g'))];
    if (matches.some((m) => !m[0])) throw new Error('不支持零宽正则替换；请匹配相邻正文来插入内容。');
    if (!matches.length || (!edit.replace_all && matches.length !== 1)) throw new Error(`正则命中 ${matches.length} 处；请缩小范围或设置 replace_all。`);
    if (typeof edit.new_string !== 'string') throw new Error('new_string 必须是字符串。删除时传空字符串。');
    changes.push(...matches.map((m) => ({ from: m.index!, to: m.index! + m[0].length, insert: edit.new_string as string })));
  }
  changes.sort((a, b) => a.from - b.from);
  if (changes.some((c, i) => i > 0 && c.from < changes[i - 1].to)) return '修改范围重叠，请拆分或缩小匹配范围。';
  let updated = text;
  for (const change of [...changes].reverse()) updated = updated.slice(0, change.from) + change.insert + updated.slice(change.to);
  await saveMarkdownMaterial(id, updated, text);
  return `已修改 ${path}（${changes.length} 处），已按普通 Markdown 重新解析。`;
}
