import type { ToolDef } from '../api/siliconflow';
import { db } from '../store/db';
import { readHighlightCatalog } from '../materials/highlightContext';
import { handoutFileOf } from '../materials/handoutFile';
import { questionBankFileOf } from '../materials/questionBankFile';
import { AGENT_INSTRUCTIONS_FILE_ID } from '../materials/systemFiles';
import { parseQuestionBank } from './quiz';
import type { UnitKind } from '../materials/units';
import { createToolExecutor, EDIT_MARKDOWN_TOOL, QA_TOOLS, SHOW_WIDGET_TOOL, type ToolExecutorOptions } from './tools';
import { createLibraryAssistantExecutor, libraryAssistantTools, type LibraryAssistantExecutorOptions } from './libraryAssistant';

/** Virtual resources backed by IndexedDB; paths never access the host filesystem. */
export const coursePath = (id: string) => `/courses/${encodeURIComponent(id)}`;
export const skillPath = (name: string) => `/skills/${encodeURIComponent(name)}`;

export const READ_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'read',
    description: '读取检索结果中的 path；需要上下文时传 start、end 两个数字，不要构造 range 对象。单位自动判断：视频为秒（从 0 起），PDF 为页，其他材料为段（从 1 起）。省略范围则读取开头；每次最多 600 秒或 20 页/段。例：{"path":"/courses/current/transcript","start":0,"end":60}。也可列目录：/courses 列课程（offset/limit 分页，status/kind 筛选），/skills 列技能；/courses/{id}/info 课程详情，/library/overview 学习统计，/library/folders 分类。正文路径用检索或详情返回的路径，不要猜测；/courses/{id}/images 列原图（支持 start/end、offset/limit），/courses/{id}/highlights 列用户文字高亮摘录（offset/limit 分页，每次最多 5 条），/courses/{id}/frames 列视频画面。/courses/{id}/handout.md 读取讲义文件原文（offset/limit 按行），它是讲义最新版的唯一真相源。单课程可用 /courses/current。技能及参考文档使用 /skills 返回的路径。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '复制检索或目录返回的资源路径。/courses/{id}/questions.md 是原题题库 Markdown，单课程可用 current，支持 read/grep/edit。/system 列系统目录，全局 Agent 指令为 /system/AGENTS.md。' },
        raw: { type: 'boolean', description: 'Markdown 原文（含注释），按行读取；offset 从 0 起。根目录 /wrongbook.md 等文件默认读原文。' },
        crop: { type: 'string', enum: ['questions'], description: '仅 PDF images：自动按题号/文字坐标裁题，start/end 一次 1~3 页；返回可直接写入题库 images 的稳定区域引用。不支持可靠定位时回退页面图。' },
        regions: { type: 'array', maxItems: 10, description: '仅 crop=questions：按实际画面修正区域；不是像素。原点是旋转后页面左上角，坐标/宽高为 0~1000 千分比整数。', items: { type: 'object', properties: {
          page: { type: 'integer', minimum: 1 }, x: { type: 'integer', minimum: 0, maximum: 999 }, y: { type: 'integer', minimum: 0, maximum: 999 },
          width: { type: 'integer', minimum: 1, maximum: 1000 }, height: { type: 'integer', minimum: 1, maximum: 1000 },
        }, required: ['page', 'x', 'y', 'width', 'height'] } },
        start: { type: 'number', description: '起始秒数、页码或段号；与 end 一起传。' },
        end: { type: 'number', description: '结束秒数、页码或段号（含）；与 start 一起传。' },
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
    description: '搜索正文，所有资料统一支持 mode：literal 为不区分大小写的完整子串匹配，regex 为正则匹配（flags 默认 i），ranked 为关键词相关性排序（默认，不保证完整短语匹配）。Markdown 原文件可用 raw=true，根目录 .md 路径默认原文逐行搜索。返回命中附近原文、定位、截断提示及可直接调用的 read 上下文参数；回答依赖前因后果或摘要被截断时，先 read 核验，不要仅凭命中片段推断。匹配不跨内容块。',
    parameters: { type: 'object', properties: {
      query: { type: 'string' }, path: { type: 'string' },
      mode: { type: 'string', enum: ['literal', 'regex', 'ranked'], description: '默认 ranked；regex=true 是 mode=regex 的兼容别名。' },
      raw: { type: 'boolean' }, regex: { type: 'boolean' }, flags: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 15 },
    }, required: ['query'] },
  },
};

export const EDIT_TOOL: ToolDef = {
  ...EDIT_MARKDOWN_TOOL,
  function: {
    ...EDIT_MARKDOWN_TOOL.function,
    name: 'edit',
    description: '修改普通 Markdown 文件。path 可为 /wrongbook.md 等根目录文件、/courses/{id}/material 或 /courses/{id}/handout.md（单课程可用 current）。先 read(raw=true) 读原文，再以 edits 中 old_string/new_string 替换；new_string 为空即删除，匹配相邻正文可插入。默认精确唯一匹配；regex=true 支持正则，flags 支持 i/m/s/u，replace_all=true 替换多处。正则 new_string 按字面文本插入，不展开捕获组。无需打开编辑面。create=true、content 可创建不存在的根目录 .md 文件或讲义文件，不覆盖已有文件；讲义按来源课程自动放入同一资料文件夹，以该 Markdown 文件为准。',
    parameters: {
      ...EDIT_MARKDOWN_TOOL.function.parameters,
      properties: {
        ...(EDIT_MARKDOWN_TOOL.function.parameters.properties as Record<string, unknown>),
        path: { type: 'string', description: 'Markdown 路径；/courses/{id}/questions.md（单课程可用 current）创建为与来源资料同目录的普通题库文件。/system/AGENTS.md 是全局默认提示词，仅在用户明确要求修改长期偏好时编辑。' },
        create: { type: 'boolean', description: '创建文件；/system/AGENTS.md 始终存在，此选项仅允许用 content 初始化空指令，不覆盖已有内容。' }, content: { type: 'string' },
        edits: { type: 'array', items: { type: 'object', properties: {
          old_string: { type: 'string' }, new_string: { type: 'string' },
          regex: { type: 'boolean' }, flags: { type: 'string' }, replace_all: { type: 'boolean' },
        }, required: ['old_string', 'new_string'] } },
      },
      required: ['path'],
    },
  },
};

export function courseResourceTools(_editable = false): ToolDef[] {
  return [GREP_TOOL, READ_TOOL, EDIT_TOOL, ...QA_TOOLS.filter((t) => ['present_quiz', 'show_widget'].includes(t.function.name))];
}

export function libraryResourceTools(hasCourses: boolean): ToolDef[] {
  return [READ_TOOL, EDIT_TOOL, GREP_TOOL, SHOW_WIDGET_TOOL, ...libraryAssistantTools(hasCourses).filter((t) =>
    ['ask_user', 'set_course_context', 'propose_folder_plan'].includes(t.function.name))];
}

type RootResource = 'courses' | 'skills' | 'overview' | 'folders' | 'context';
type Resource = { [K in RootResource]: { type: K } }[RootResource]
  | { type: 'course'; id: string; leaf?: string }
  | { type: 'markdown'; id: string }
  | { type: 'system'; leaf?: 'AGENTS.md' }
  | { type: 'skill'; name: string; reference?: string };

export function parseResource(path: unknown): Resource | undefined {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('?') || path.includes('#')) return;
  const parts = path.split('/').slice(1);
  try {
    const p = parts.map(decodeURIComponent);
    if (p.some((s) => !s || s === '.' || s === '..')) return;
    if (p.length === 1 && p[0] === 'system') return { type: 'system' };
    if (p.length === 2 && p[0] === 'system' && p[1] === 'AGENTS.md') return { type: 'system', leaf: 'AGENTS.md' };
    if (p.length === 1 && /^[^/\\]+\.md$/.test(p[0])) return { type: 'markdown', id: p[0] };
    if (p.length === 1 && p[0] === 'courses') return { type: 'courses' };
    if (p.length === 1 && p[0] === 'skills') return { type: 'skills' };
    if (p.length === 2 && p[0] === 'library' && p[1] === 'overview') return { type: 'overview' };
    if (p.length === 2 && p[0] === 'library' && p[1] === 'folders') return { type: 'folders' };
    if (p.length === 2 && p[0] === 'courses' && p[1] === 'context') return { type: 'context' };
    if (p[0] === 'courses' && p.length >= 2 && p.length <= 3 && (!p[2] || ['info', 'transcript', 'material', 'frames', 'images', 'highlights', 'handout.md', 'questions.md'].includes(p[2]))) {
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

/** Expose only flat arguments to models; accept legacy range for saved conversations. */
function readRange(args: Record<string, unknown>, kind?: UnitKind) {
  if (args.start !== undefined || args.end !== undefined) {
    if (args.start === undefined || args.end === undefined) return '请同时提供 start 和 end 两个数字，例如 start=1、end=5；不需要 range 或 unit。';
    return contentRange({ unit: kind ? (kind === 'page' ? 'pages' : 'paragraphs') : 'seconds', start: args.start, end: args.end }, kind);
  }
  if (args.range != null && (typeof args.range !== 'object' || Array.isArray(args.range))) {
    return '请改用顶层 start 和 end 两个数字，例如 start=1、end=5；不需要 range 或 unit。';
  }
  return contentRange(args.range, kind);
}

interface ResourceExecutorOptions extends ToolExecutorOptions {
  courseId?: string;
  editable?: boolean;
  hasFrames?: boolean;
  library?: LibraryAssistantExecutorOptions;
}

export function createResourceExecutor(options: ResourceExecutorOptions = {}) {
  const local = options.courseId !== undefined;
  let quizPresented = false;
  const presentQuiz: ToolExecutorOptions['onQuiz'] = options.onQuiz ? (quiz) => {
    options.onQuiz!(quiz);
    quizPresented = true;
  } : undefined;
  const executeLocal = createToolExecutor(options.courseId ?? '', { ...options, onQuiz: presentQuiz });
  const executeLibrary = createLibraryAssistantExecutor(options.library);
  return async (name: string, args: Record<string, unknown>): Promise<string> => {
    if (name === 'present_quiz' && quizPresented) return '本轮已展示题卡。请等待学生作答；下一批由学生在新一轮要求继续，不要覆盖当前题卡。';
    if (local && name === 'present_quiz' && args.path !== undefined) {
      if (args.questions !== undefined) return 'path 与 questions 二选一；已有题库请只传 path，由宿主读取最新版。';
      const resource = parseResource(args.path);
      let fileId: string | undefined;
      if (resource?.type === 'course') {
        const id = resource.id === 'current' ? options.courseId! : resource.id;
        if (id !== options.courseId) return '单课程问答只能访问当前课程。';
        const course = await db.videos.get(id);
        if (!course) return '来源课程不存在。';
        if (resource.leaf === 'questions.md') fileId = questionBankFileOf(course).id;
        else if (resource.leaf === 'material' && course.materialFormat === 'md') fileId = id;
      } else if (resource?.type === 'markdown') {
        fileId = resource.id;
      }
      if (!fileId) return '请提供题库的 Markdown material 路径或 /courses/current/questions.md。';
      const offset = args.offset ?? 0, limit = args.limit ?? 5;
      if (!Number.isSafeInteger(offset) || Number(offset) < 0 || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 5)
        return 'offset 必须是非负整数，limit 必须是 1~5 的整数。';
      try {
        const { getMaterialFile } = await import('../store/fileStore');
        const row = await db.videos.get(fileId);
        if (!row || row.kind !== 'material' || row.materialFormat !== 'md') return '题库文件不存在，请先提取原题并保存为 Markdown。';
        const file = await getMaterialFile(fileId);
        if (!file) return '题库原文件不存在，请重新导入。';
        const bank = parseQuestionBank(await file.text());
        const questions = bank.questions.slice(Number(offset), Number(offset) + Number(limit));
        if (!questions.length) return `题库共 ${bank.questions.length} 题，此 offset 已到末尾；重做请用 offset=0。`;
        if (!options.onQuiz) return '当前入口未接入答题卡，未展示题目。';
        presentQuiz!({ questions, bank: { path: String(args.path), offset: Number(offset), total: bank.questions.length } });
        const next = Number(offset) + questions.length;
        return `已从题库最新版展示第 ${Number(offset) + 1}~${next} 题（共 ${bank.questions.length} 题）。不要重复题目或提前透露答案。${next < bank.questions.length ? `学生要求继续时使用相同 path、offset=${next}；不要立即调用覆盖当前题卡。` : '已是最后一批。'}`;
      } catch (error) { return error instanceof Error ? error.message : '读取题库失败，未展示题卡。'; }
    }
    if (!['read', 'grep', 'edit'].includes(name)) {
      // show_widget is independent of a course. It still uses the shared
      // executor so validation, rendering probes and the onWidget callback
      // are identical in course and library chat.
      if (name === 'show_widget') return executeLocal(name, args);
      if (local && name === 'present_quiz') return executeLocal(name, args);
      if (!local && ['ask_user', 'set_course_context', 'propose_folder_plan'].includes(name)) return executeLibrary(name, args);
      return `未知工具「${name}」。这里只能使用本轮工具列表中的工具；不能访问 /tmp、宿主文件系统或 writeFile。需要展示 SVG 时请使用 show_widget(format="svg", code=...)。`;
    }
    if (name === 'grep' && (typeof args.query !== 'string' || !args.query.trim())) return '请提供要检索的关键词。';
    for (const key of ['offset', 'limit'] as const) {
      const value = args[key];
      if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (key === 'offset' ? 0 : 1))) return `${key} 必须是${key === 'offset' ? '非负' : '正'}整数。`;
    }
    const path = args.path ?? (name === 'grep' ? (local ? '/courses/current' : '/courses/context') : undefined);
    const resource = parseResource(path);
    if (!resource) return '无效资源路径。请使用工具描述中的路径，或复制上次 read/grep 返回的路径。';
    if (resource.type === 'system') {
      if (!resource.leaf) {
        if (name !== 'read') return '系统目录只支持 read 列出文件；请对 /system/AGENTS.md 使用 read、grep、edit。';
        return `path=/system\n${Number(args.offset ?? 0) === 0 ? '/system/AGENTS.md — 全局 Agent 指令，与「设置 → Agent」共用原文。' : '目录已到末尾。'}`;
      }
      try {
        const { executeAgentInstructionsResource } = await import('./agentInstructionsResource');
        return executeAgentInstructionsResource(name, args);
      } catch (error) { return error instanceof Error ? error.message : '系统文件操作失败。'; }
    }
    if (resource.type === 'markdown') {
      try {
        if (resource.id === 'AGENTS.md') {
          const { executeAgentInstructionsResource } = await import('./agentInstructionsResource');
          return executeAgentInstructionsResource(name, args);
        }
        const { executeMarkdownResource } = await import('./markdownResource');
        return await executeMarkdownResource(name, resource.id, String(path), args);
      } catch (error) { return error instanceof Error ? error.message : 'Markdown 操作失败。'; }
    }
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
      return executeLibrary('search_course_library', { ...args, scope: resource.type === 'courses' ? 'all' : 'context' });
    }
    if (resource.type !== 'course') {
      if (local || name !== 'read') return '当前入口不支持此资源操作。';
      const tool = { courses: 'list_courses', overview: 'get_learning_overview', folders: 'list_folders', context: '' }[resource.type];
      return tool ? executeLibrary(tool, args) : '请 read /courses 列课程，或 grep /courses/context 搜索当前课程上下文。';
    }
    const id = resource.id === 'current' && local ? options.courseId! : resource.id;
    if (local && id !== options.courseId) return '单课程问答只能访问当前课程。';
    if (id === AGENT_INSTRUCTIONS_FILE_ID) {
      if (resource.leaf && !['info', 'material'].includes(resource.leaf)) return '系统 Markdown 正文位于 /system/AGENTS.md，请对该路径使用 read、grep、edit。';
      const { executeAgentInstructionsResource } = await import('./agentInstructionsResource');
      return executeAgentInstructionsResource(name, args);
    }
    const course = await db.videos.get(id);
    if (!course) return '课程不存在，请 read /courses 获取真实路径。';
    const kind = options.kind ?? (course.kind === 'material' ? ((course.materialFormat ?? 'pdf') === 'pdf' ? 'page' : 'para') : undefined);
    const leaf = resource.leaf ?? (name === 'grep' ? (kind ? 'material' : 'transcript') : 'info');
    const canonical = `${coursePath(id)}/${leaf}`;
    if (leaf === 'handout.md' || leaf === 'questions.md') {
      const isBank = leaf === 'questions.md';
      const handout = isBank ? questionBankFileOf(course) : handoutFileOf(course);
      const label = isBank ? '题库' : '讲义';
      const { executeMarkdownResource } = await import('./markdownResource');
      try {
        const result = await executeMarkdownResource(name, handout.id, canonical, args, handout);
        const row = await db.videos.get(handout.id);
        const link = row && `${label}文件：[${row.name.replace(/([\\[\]])/g, '\\$1')}](#/player/${encodeURIComponent(row.id)})`;
        return `${result}${link ? `\n${link}\n此 Markdown 是${label}唯一真相源；聊天正文是历史快照，续写或修改前重新 read 此路径。${isBank ? '\n做题：在题库资料的问答中 present_quiz(path="/courses/current/material")；在来源资料中 present_quiz(path="/courses/current/questions.md")。' : ''}` : ''}`;
      } catch (error) { return error instanceof Error ? error.message : `${label}文件操作失败。`; }
    }
    const execute = local ? executeLocal : createToolExecutor(id, { kind });
    if ((leaf === 'material' && !kind) || (leaf === 'transcript' && kind)) return `此课程没有该类型的正文资源。请 read ${coursePath(id)}/${kind ? 'material' : 'transcript'}。`;
    if (name === 'edit') {
      if (course.materialFormat !== 'md' || leaf !== 'material') return '仅支持修改 Markdown 材料。';
      if (local && options.editable && Array.isArray(args.edits) && !args.edits.some((e) => e?.regex === true)) return execute('edit_markdown', args);
      const { executeMarkdownResource } = await import('./markdownResource');
      try { return await executeMarkdownResource(name, id, canonical, args); }
      catch (error) { return error instanceof Error ? error.message : 'Markdown 操作失败。'; }
    }
    if (leaf === 'material' && course.materialFormat === 'md' && args.raw === true) {
      const { executeMarkdownResource } = await import('./markdownResource');
      try { return await executeMarkdownResource(name, id, canonical, args); }
      catch (error) { return error instanceof Error ? error.message : 'Markdown 操作失败。'; }
    }
    if (name === 'grep') {
      if (!['material', 'transcript'].includes(leaf)) return 'grep 只支持课程正文。';
      return executeLibrary('search_course_library', { ...args, courseId: id });
    }
    if (leaf === 'info') return executeLibrary('get_course_details', { courseId: id });
    if (leaf === 'highlights') {
      if (!kind) return '此课程不是阅读材料，没有文字高亮。';
      return `path=${canonical}\n${await readHighlightCatalog(id, Number(args.offset), Number(args.limit))}`;
    }
    if (leaf === 'images') {
      if (course.kind !== 'material') return '此课程不是阅读材料。视频画面请 read 对应的 frames 资源。';
      const range = args.range === undefined && args.start === undefined && args.end === undefined ? undefined : readRange(args, kind);
      if (typeof range === 'string') return range;
      if (args.crop !== undefined || args.regions !== undefined) {
        if (args.crop !== 'questions') return '裁题请使用 crop="questions"。';
        try {
          const { readPdfQuestionCrops } = await import('../materials/images');
          return await readPdfQuestionCrops(course, range, args.regions);
        } catch (error) { return error instanceof Error ? error.message : 'PDF 裁题失败，请使用页面图或重试。'; }
      }
      const { readMaterialImageCatalog } = await import('../materials/images');
      const result = await readMaterialImageCatalog(course, args.offset as number | undefined, args.limit as number | undefined, range);
      return `${result}${range?.clipped ? `\n（本次范围已截断至 ${range.end}，可继续分段 read。）` : ''}`;
    }
    if (leaf === 'frames') {
      if (kind || (local && !options.hasFrames)) return '此课程没有可用画面。';
      return `path=${canonical}\n${await execute('list_frames', {})}`;
    }
    const range = readRange(args, kind);
    if (typeof range === 'string') return range;
    const result = await execute(kind ? 'get_material_range' : 'get_transcript_range', kind ? { from: range.start, to: range.end } : { start: range.start, end: range.end });
    return `path=${canonical}\n${result}${range.clipped ? `\n（本次范围已截断至 ${range.end}，可继续分段 read。）` : ''}`;
  };
}
