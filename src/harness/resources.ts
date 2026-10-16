import type { ToolDef } from '../api/siliconflow';
import { db } from '../store/db';
import type { UnitKind } from '../materials/units';
import { createToolExecutor, EDIT_MARKDOWN_TOOL, QA_TOOLS, type ToolExecutorOptions } from './tools';
import { createLibraryAssistantExecutor, libraryAssistantTools, type LibraryAssistantExecutorOptions } from './libraryAssistant';

/** Virtual resources backed by IndexedDB; paths never access the host filesystem. */
export const coursePath = (id: string) => `/courses/${encodeURIComponent(id)}`;
export const skillPath = (name: string) => `/skills/${encodeURIComponent(name)}`;

export const READ_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'read',
    description: '读取虚拟资源或列目录。/skills 列可用技能，/skills/{编码后的名称} 加载技能，参考文档路径来自返回结果。/courses 列课程（支持 offset/limit 和 status/kind 筛选）；/courses/{id}/info 详情；/courses/{id}/transcript 字幕；/courses/{id}/material 材料；/courses/{id}/frames 画面。/library/overview 学习统计，/library/folders 分类。单课程问答可用 /courses/current 指代当前课程。正文按 range 读取，字幕每次最多 600 秒，材料最多 20 页/段；返回原始定位用于引用。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        range: { type: 'object', properties: {
          unit: { type: 'string', enum: ['seconds', 'pages', 'paragraphs'] },
          start: { type: 'number' }, end: { type: 'number' },
        }, required: ['unit', 'start', 'end'] },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
        status: { type: 'string', enum: ['all', 'in_progress', 'completed', 'unstarted'] },
        kind: { type: 'string', enum: ['all', 'video', 'material'] },
      },
      required: ['path'],
    },
  },
};

export const GREP_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'grep',
    description: '按关键词或短语搜索正文（不是正则表达式）。path 为 /courses（全库）、/courses/context（当前选中的课程）、/courses/{id} 或具体 transcript/material 路径。单课程问答用 /courses/current。省略 path 时搜索当前课程上下文。返回可交给 read 的路径与原始定位。没命中时换同义词或更短的关键词。',
    parameters: { type: 'object', properties: {
      query: { type: 'string' }, path: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 15 },
    }, required: ['query'] },
  },
};

export const EDIT_TOOL: ToolDef = {
  ...EDIT_MARKDOWN_TOOL,
  function: {
    ...EDIT_MARKDOWN_TOOL.function,
    name: 'edit',
    description: '精确替换当前打开编辑面的 Markdown 材料正文。path 必须是当前课程的 material 路径。改动立即显示，可撤销。old_string 必须逐字复制原文；默认要求唯一命中，多处替换需 replace_all。',
    parameters: {
      ...EDIT_MARKDOWN_TOOL.function.parameters,
      properties: {
        ...(EDIT_MARKDOWN_TOOL.function.parameters.properties as Record<string, unknown>),
        path: { type: 'string' },
      },
      required: ['path', 'edits'],
    },
  },
};

export function courseResourceTools(editable = false): ToolDef[] {
  return [GREP_TOOL, READ_TOOL, ...QA_TOOLS.filter((t) => ['present_quiz', 'show_widget'].includes(t.function.name)), ...(editable ? [EDIT_TOOL] : [])];
}

export function libraryResourceTools(hasCourses: boolean): ToolDef[] {
  return [READ_TOOL, ...(hasCourses ? [GREP_TOOL] : []), ...libraryAssistantTools(hasCourses).filter((t) =>
    ['ask_user', 'set_course_context', 'propose_folder_plan'].includes(t.function.name))];
}

type RootResource = 'courses' | 'skills' | 'overview' | 'folders' | 'context';
type Resource = { [K in RootResource]: { type: K } }[RootResource]
  | { type: 'course'; id: string; leaf?: string }
  | { type: 'skill'; name: string; reference?: string };

export function parseResource(path: unknown): Resource | undefined {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('?') || path.includes('#')) return;
  const parts = path.split('/').slice(1);
  try {
    const p = parts.map(decodeURIComponent);
    if (p.some((s) => !s || s === '.' || s === '..')) return;
    if (p.length === 1 && p[0] === 'courses') return { type: 'courses' };
    if (p.length === 1 && p[0] === 'skills') return { type: 'skills' };
    if (p.length === 2 && p[0] === 'library' && p[1] === 'overview') return { type: 'overview' };
    if (p.length === 2 && p[0] === 'library' && p[1] === 'folders') return { type: 'folders' };
    if (p.length === 2 && p[0] === 'courses' && p[1] === 'context') return { type: 'context' };
    if (p[0] === 'courses' && p.length >= 2 && p.length <= 3 && (!p[2] || ['info', 'transcript', 'material', 'frames'].includes(p[2]))) {
      return { type: 'course', id: p[1], leaf: p[2] };
    }
    if (p[0] === 'skills' && p.length === 2) return { type: 'skill', name: p[1] };
    if (p[0] === 'skills' && p.length >= 4 && p[2] === 'references') return { type: 'skill', name: p[1], reference: p.slice(3).join('/') };
  } catch { /* Invalid URI escapes are invalid resource paths. */ }
}

function contentRange(value: unknown, kind?: UnitKind): { start: number; end: number; clipped: boolean } | string {
  const unit = kind ? (kind === 'page' ? 'pages' : 'paragraphs') : 'seconds';
  const minimum = kind ? 1 : 0;
  if (value == null) return { start: minimum, end: kind ? 2 : 60, clipped: false };
  if (typeof value !== 'object' || Array.isArray(value)) return 'range 必须包含 unit、start、end。';
  const r = value as Record<string, unknown>;
  if (r.unit !== unit) return `此资源的 range.unit 必须是 ${unit}。`;
  if (typeof r.start !== 'number' || typeof r.end !== 'number' || !Number.isFinite(r.start) || !Number.isFinite(r.end)
    || r.start < minimum || r.end < r.start || (kind && (!Number.isInteger(r.start) || !Number.isInteger(r.end)))) return 'range 范围无效。';
  const end = Math.min(r.end, r.start + (kind ? 19 : 600));
  return { start: r.start, end, clipped: end < r.end };
}

interface ResourceExecutorOptions extends ToolExecutorOptions {
  courseId?: string;
  editable?: boolean;
  hasFrames?: boolean;
  library?: LibraryAssistantExecutorOptions;
}

export function createResourceExecutor(options: ResourceExecutorOptions = {}) {
  const local = options.courseId !== undefined;
  const executeLocal = createToolExecutor(options.courseId ?? '', options);
  const executeLibrary = createLibraryAssistantExecutor(options.library);
  return async (name: string, args: Record<string, unknown>): Promise<string> => {
    if (!['read', 'grep', 'edit'].includes(name)) {
      if (local && ['present_quiz', 'show_widget'].includes(name)) return executeLocal(name, args);
      if (!local && ['ask_user', 'set_course_context', 'propose_folder_plan'].includes(name)) return executeLibrary(name, args);
      return `未知工具：${name}`;
    }
    if (name === 'grep' && (typeof args.query !== 'string' || !args.query.trim())) return '请提供要检索的关键词。';
    for (const key of ['offset', 'limit'] as const) {
      const value = args[key];
      if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (key === 'offset' ? 0 : 1))) return `${key} 必须是${key === 'offset' ? '非负' : '正'}整数。`;
    }
    const path = args.path ?? (name === 'grep' ? (local ? '/courses/current' : '/courses/context') : undefined);
    const resource = parseResource(path);
    if (!resource) return '无效资源路径。请使用工具描述中的路径，或复制上次 read/grep 返回的路径。';
    if (resource.type === 'skills' || resource.type === 'skill') {
      if (name !== 'read') return '技能资源只支持 read。';
      if (resource.type === 'skills') {
        const skills = await db.skills.filter((s) => !!s.enabled && (options.allowedSkillIds === undefined || (s.id != null && options.allowedSkillIds.includes(s.id)))).toArray();
        return skills.map((s) => `${skillPath(s.name)} — ${s.name}`).join('\n') || '本次会话没有可用技能。';
      }
      return executeLocal(resource.reference === undefined ? 'use_skill' : 'read_skill_reference', { name: resource.name, path: resource.reference });
    }
    if (name === 'grep' && (resource.type === 'courses' || resource.type === 'context')) {
      if (local) return '单课程问答只能搜索 /courses/current 或当前课程的真实路径。';
      return executeLibrary('search_course_library', { query: args.query, limit: args.limit, scope: resource.type === 'courses' ? 'all' : 'context' });
    }
    if (resource.type !== 'course') {
      if (local || name !== 'read') return '当前入口不支持此资源操作。';
      const tool = { courses: 'list_courses', overview: 'get_learning_overview', folders: 'list_folders', context: '' }[resource.type];
      return tool ? executeLibrary(tool, args) : '请 read /courses 列课程，或 grep /courses/context 搜索当前课程上下文。';
    }
    const id = resource.id === 'current' && local ? options.courseId! : resource.id;
    if (local && id !== options.courseId) return '单课程问答只能访问当前课程。';
    const course = await db.videos.get(id);
    if (!course) return '课程不存在，请 read /courses 获取真实路径。';
    const kind = local ? options.kind : course.kind === 'material' ? (course.materialFormat === 'pdf' ? 'page' : 'para') : undefined;
    const leaf = resource.leaf ?? (name === 'grep' ? (kind ? 'material' : 'transcript') : 'info');
    const canonical = `${coursePath(id)}/${leaf}`;
    const execute = local ? executeLocal : createToolExecutor(id, { kind });
    if ((leaf === 'material' && !kind) || (leaf === 'transcript' && kind)) return '此课程没有该类型的正文资源。';
    if (name === 'edit') {
      if (!local || !options.editable || course.materialFormat !== 'md' || leaf !== 'material') return '仅支持修改当前已开放编辑的 Markdown 材料。';
      return execute('edit_markdown', args);
    }
    if (name === 'grep') {
      if (!['material', 'transcript'].includes(leaf)) return 'grep 只支持课程正文。';
      const result = await execute(kind ? 'search_material' : 'search_transcript', args);
      return `path=${canonical}\n定位单位：${kind === 'page' ? 'pages' : kind ? 'paragraphs' : 'seconds'}\n${result}`;
    }
    if (leaf === 'info') return executeLibrary('get_course_details', { courseId: id });
    if (leaf === 'frames') {
      if (kind || (local && !options.hasFrames)) return '此课程没有可用画面。';
      return `path=${canonical}\n${await execute('list_frames', {})}`;
    }
    const range = contentRange(args.range, kind);
    if (typeof range === 'string') return range;
    const result = await execute(kind ? 'get_material_range' : 'get_transcript_range', kind ? { from: range.start, to: range.end } : { start: range.start, end: range.end });
    return `path=${canonical}\n${result}${range.clipped ? `\n（本次范围已截断至 ${range.end}，可继续分段 read。）` : ''}`;
  };
}
