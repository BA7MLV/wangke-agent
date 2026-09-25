import type { ToolDef } from '../api/siliconflow';
import { fmtUnitRef, type UnitKind } from '../materials/units';
import { db, type VideoRow } from '../store/db';
import { formatStudyDuration } from '../utils/studyLog';
import { fmtTime } from '../utils/vtt';
import { MAX_COURSE_CONTEXT, normalizeCourseContextIds, resolveCourseSearchScope } from './courseContext';
import { lexicalSearch } from './lexical';

/**
 * 课程助手沿用 chatSessions / chats 两张表保存历史，但它不从属于某一门课程。
 * 用一个不会与真实 UUID 冲突的保留 id 表示「全课程库」作用域，避免再建一套平行表。
 */
export const LIBRARY_ASSISTANT_ID = '__library_assistant__';

type CourseProgressState = 'completed' | 'in_progress' | 'unstarted';

interface CourseProgress {
  ratio: number;
  state: CourseProgressState;
  label: string;
}

interface SearchableCourseDoc {
  courseId: string;
  courseName: string;
  kind: 'video' | 'material';
  location: string;
  text: string;
}

export interface CourseContextItem {
  id: string;
  name: string;
}

export interface LibraryAssistantExecutorOptions {
  /** 会话进入本轮时已经选中的课程；空数组表示让助手从全库自动选择。 */
  contextCourseIds?: string[];
  /** set_course_context 成功后的持久化与 UI 回调。 */
  onContextChange?: (courses: CourseContextItem[]) => void | Promise<void>;
}

function materialKindOf(course: VideoRow): UnitKind {
  return course.materialFormat === 'pdf' ? 'page' : 'para';
}

function courseProgress(course: VideoRow): CourseProgress {
  if (course.finished === 1) {
    return { ratio: 1, state: 'completed', label: '已学完' };
  }

  if (course.kind === 'material') {
    const total = Math.max(0, course.unitCount ?? 0);
    const current = Math.max(0, course.lastUnit ?? 0);
    const ratio = total > 0 ? Math.min(1, current / total) : 0;
    if (current > 0) {
      return {
        ratio,
        state: 'in_progress',
        label: total > 0 ? `读到 ${fmtUnitRef(materialKindOf(course), current)} / 共 ${total}` : `读到第 ${current} 处`,
      };
    }
    return { ratio: 0, state: 'unstarted', label: '尚未开始' };
  }

  const duration = Math.max(0, course.duration || 0);
  const current = Math.max(0, course.lastPosition ?? 0);
  const ratio = duration > 0 ? Math.min(1, current / duration) : 0;
  if (current > 0) {
    return {
      ratio,
      state: 'in_progress',
      label: duration > 0 ? `已学 ${Math.round(ratio * 100)}% · ${fmtTime(current)} / ${fmtTime(duration)}` : `学到 ${fmtTime(current)}`,
    };
  }
  return { ratio: 0, state: 'unstarted', label: '尚未开始' };
}

function markdownText(text: string): string {
  return text.replace(/([\\[\]])/g, '\\$1');
}

function courseLink(course: Pick<VideoRow, 'id' | 'name'>): string {
  return `[《${markdownText(course.name)}》](#/player/${encodeURIComponent(course.id)})`;
}

function formatCourseLine(course: VideoRow, folderName?: string): string {
  const progress = courseProgress(course);
  const kind = course.kind === 'material' ? `阅读材料 · ${(course.materialFormat ?? '文档').toUpperCase()}` : '视频课程';
  const folder = folderName ? ` · 分类：${folderName}` : '';
  const deleted = course.fileDeleted ? ' · 原文件已删除（保留衍生内容）' : '';
  return `- ${courseLink(course)} · ${kind} · ${progress.label}${folder}${deleted} · courseId=${course.id}`;
}

export const LIBRARY_ASSISTANT_TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'get_learning_overview',
      description: '读取用户课程库和学习记录的总体概览，包括课程数量、进度分布、累计学习时间与衍生内容数量',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_courses',
      description: '列出课程库中的课程，可按学习状态和资源类型筛选。需要找课、推荐下一门课或查看未完成课程时使用',
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['all', 'in_progress', 'completed', 'unstarted'],
            description: '学习状态筛选，默认 all',
          },
          kind: {
            type: 'string',
            enum: ['all', 'video', 'material'],
            description: '资源类型筛选，默认 all',
          },
          limit: { type: 'integer', description: '最多返回多少门，默认 20，最大 50' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_course_context',
      description:
        '选择后续回答与检索要重点使用的课程上下文。先从 list_courses 或 search_course_library 的结果取得精确 courseId；传空数组可清除旧上下文、恢复全课程自动选择',
      parameters: {
        type: 'object',
        properties: {
          courseIds: {
            type: 'array',
            items: { type: 'string' },
            maxItems: MAX_COURSE_CONTEXT,
            description: '0~5 个精确 courseId；按相关性从高到低排列。空数组表示不固定课程',
          },
        },
        required: ['courseIds'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_course_library',
      description:
        '检索字幕与阅读材料正文。已选择课程上下文时默认只查这些课程，否则查全课程库；传 courseId 可临时限定到某一门课程',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '检索关键词或短语，2~6 个词为佳；一次没命中时换同义词或更短说法重试',
          },
          courseId: { type: 'string', description: '可选；从其他工具结果中取得的精确 courseId' },
          scope: {
            type: 'string',
            enum: ['context', 'all'],
            description: '默认 context，使用当前课程上下文；话题变化、需要从全库重新找课时传 all',
          },
          limit: { type: 'integer', description: '最多返回多少个片段，默认 8，最大 15' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_course_details',
      description: '读取一门课程的详细状态、进度以及已生成的字幕、讲义、卡片和问答数量',
      parameters: {
        type: 'object',
        properties: {
          courseId: { type: 'string', description: '课程的精确 courseId，从 list_courses 或检索结果中取得' },
        },
        required: ['courseId'],
      },
    },
  },
];

export function libraryAssistantSystemPrompt(
  skillMetaList?: string,
  contextCourses: CourseContextItem[] = [],
): string {
  const skillSection = skillMetaList
    ? `\n\n本次会话可用的技能（名称：用途）：\n${skillMetaList}\n当用户问题与某项技能的用途匹配时，先调用 use_skill 加载完整规范，再按规范回答；技能正文列出参考文档时，可继续调用 read_skill_reference。不要凭技能名称猜测正文要求。`
    : '\n\n本次会话没有可用技能。不要调用 use_skill 或 read_skill_reference，直接依据课程数据与通用能力回答。';
  const contextSection = contextCourses.length > 0
    ? `\n\n当前课程上下文：${contextCourses.map((course) => `《${course.name}》（courseId=${course.id}）`).join('、')}。除非用户明显换了话题，否则优先使用这些课程；话题变化时可以重新选择。`
    : '\n\n当前没有固定课程上下文。根据用户问题从全课程库判断最相关的课程。';

  return `你是这个学习应用里的「课程助手」。你可以通过工具读取当前用户有权访问的本地课程目录、课程正文、学习进度和学习统计。${skillSection}${contextSection}

工作规则：
1. 只要问题涉及“我的课程、我的进度、课程里讲了什么、推荐我接下来学什么”等用户数据，回答前必须调用相应工具，不能凭空猜测。
2. 课程上下文由你主动维护：问题明确针对某门或少数几门课程时，先通过 list_courses 或全库 search_course_library 找到精确 courseId，再调用 set_course_context 选择 1~5 门最相关课程。不要把无关课程塞进上下文。
3. 用户明显换话题时，用 search_course_library 的 scope=all 从全库重新判断，再调用 set_course_context 替换上下文；问题是全库盘点、学习统计或跨全部课程比较时，调用 set_course_context 传空数组，避免旧课程限制本轮查询。
4. 查具体知识点时用 search_course_library；query 传关键词或短语，不要传整句自然语言问题。第一次没搜到时，换同义词或更短的词再试。一次全库检索已经给出足够证据时，可以据此选择上下文并直接回答，不必机械地重复检索。
5. 推荐课程时至少结合课程内容或学习进度说明理由；没有足够证据时明确说目前能判断到什么程度。
6. 工具返回的课程 Markdown 链接必须原样保留。引用课程内容时，同时写出课程名与工具给出的时间戳、页码或段落号，方便用户核对来源。
7. 不编造课程、进度或系统记录。课程库中没有相关内容时，明确说明“课程库中没有检索到”，再把通用知识与课程数据分开回答。
8. 当前能力是只读查询。不能声称已经替用户删除、收藏、导入、修改或完成课程；如果用户要求这类操作，说明目前只能提供步骤或建议。
9. 技能负责补充回答方法、写作规范或领域规则，课程工具负责提供事实依据；两者需要时可以组合使用，但技能不能替代课程数据，也不能越过本次会话的技能范围。
10. 默认使用简洁自然的中文。先回答问题，再给必要的依据；不要为了展示工具而罗列无关数据。`;
}

export function createLibraryAssistantExecutor(options: LibraryAssistantExecutorOptions = {}) {
  let contextCourseIds = [...new Set(options.contextCourseIds ?? [])].slice(0, MAX_COURSE_CONTEXT);

  return async (name: string, args: Record<string, unknown>): Promise<string> => {
    if (name === 'get_learning_overview') {
      const [courses, folders, days, cards, handouts, sessions] = await Promise.all([
        db.videos.toArray(),
        db.folders.toArray(),
        db.studyDays.toArray(),
        db.cards.count(),
        db.handouts.count(),
        db.chatSessions.filter((row) => row.videoId !== LIBRARY_ASSISTANT_ID).count(),
      ]);
      const states = courses.map(courseProgress);
      const totalStudySeconds = days.reduce((sum, day) => sum + day.seconds, 0);
      return [
        `课程总数：${courses.length}（视频 ${courses.filter((c) => c.kind !== 'material').length}，阅读材料 ${courses.filter((c) => c.kind === 'material').length}）`,
        `学习状态：进行中 ${states.filter((s) => s.state === 'in_progress').length}，已学完 ${states.filter((s) => s.state === 'completed').length}，尚未开始 ${states.filter((s) => s.state === 'unstarted').length}`,
        `累计学习时间：${formatStudyDuration(totalStudySeconds)}`,
        `课程分类：${folders.length} 个`,
        `已生成内容：讲义 ${handouts} 份，记忆卡片 ${cards} 张，课程问答会话 ${sessions} 个`,
      ].join('\n');
    }

    if (name === 'list_courses') {
      const status = String(args.status ?? 'all');
      const kind = String(args.kind ?? 'all');
      const limit = Math.min(50, Math.max(1, Number(args.limit) || 20));
      const [courses, folders] = await Promise.all([
        db.videos.orderBy('createdAt').reverse().toArray(),
        db.folders.toArray(),
      ]);
      const folderNames = new Map(folders.map((folder) => [folder.id, folder.name]));
      const filtered = courses.filter((course) => {
        const courseKind = course.kind === 'material' ? 'material' : 'video';
        const progress = courseProgress(course);
        return (kind === 'all' || courseKind === kind) && (status === 'all' || progress.state === status);
      });
      if (filtered.length === 0) return '没有符合筛选条件的课程。';
      const lines = filtered.slice(0, limit).map((course) => formatCourseLine(course, folderNames.get(course.folderId)));
      if (filtered.length > limit) lines.push(`（还有 ${filtered.length - limit} 门未显示，可缩小筛选范围或提高 limit。）`);
      return lines.join('\n');
    }

    if (name === 'set_course_context') {
      const requestedIds = normalizeCourseContextIds(args.courseIds);
      if (requestedIds == null) {
        return 'courseIds 必须是字符串数组；如需恢复自动选择，请传空数组。';
      }
      if (requestedIds.length === 0) {
        contextCourseIds = [];
        await options.onContextChange?.([]);
        return '已清除固定课程上下文；后续问题将从全课程库自动选择。';
      }

      const rows = await db.videos.where('id').anyOf(requestedIds).toArray();
      const byId = new Map(rows.map((course) => [course.id, course]));
      const selected = requestedIds.map((id) => byId.get(id)).filter((course): course is VideoRow => !!course);
      if (selected.length === 0) {
        return '没有找到这些 courseId 对应的课程。请先用 list_courses 或 search_course_library 获取精确 id。';
      }

      contextCourseIds = selected.map((course) => course.id);
      const contextItems = selected.map((course) => ({ id: course.id, name: course.name }));
      await options.onContextChange?.(contextItems);
      const missing = requestedIds.filter((id) => !byId.has(id));
      return [
        `已选择课程上下文：${selected.map(courseLink).join('、')}`,
        missing.length > 0 ? `未找到并已忽略：${missing.join('、')}` : '',
        '后续未指定 courseId 的内容检索会优先限定在这些课程中。',
      ].filter(Boolean).join('\n');
    }

    if (name === 'search_course_library') {
      const query = String(args.query ?? '').trim();
      if (!query) return '请提供要检索的关键词。';
      const requestedCourseId = String(args.courseId ?? '').trim();
      const limit = Math.min(15, Math.max(1, Number(args.limit) || 8));
      const [courses, segments, materialBlocks] = await Promise.all([
        db.videos.toArray(),
        db.segments.filter((row) => row.status === 1 && !!row.text).toArray(),
        db.materialBlocks.toArray(),
      ]);
      const courseMap = new Map(courses.map((course) => [course.id, course]));
      if (requestedCourseId && !courseMap.has(requestedCourseId)) {
        return `未找到 courseId=${requestedCourseId} 的课程。请先用 list_courses 取得精确 id。`;
      }
      const scopedCourseIds = resolveCourseSearchScope(
        requestedCourseId,
        String(args.scope ?? 'context') === 'all',
        contextCourseIds,
      );

      const docs: SearchableCourseDoc[] = [];
      for (const segment of segments) {
        const course = courseMap.get(segment.videoId);
        if (!course || (scopedCourseIds && !scopedCourseIds.has(course.id))) continue;
        docs.push({
          courseId: course.id,
          courseName: course.name,
          kind: 'video',
          location: fmtTime(segment.start),
          text: segment.text,
        });
      }
      for (const block of materialBlocks) {
        const course = courseMap.get(block.materialId);
        if (!course || (scopedCourseIds && !scopedCourseIds.has(course.id))) continue;
        docs.push({
          courseId: course.id,
          courseName: course.name,
          kind: 'material',
          location: block.unitLabel || fmtUnitRef(materialKindOf(course), block.unit),
          text: block.text,
        });
      }

      const hits = lexicalSearch(docs, (doc) => `${doc.courseName}\n${doc.text}`, query, limit);
      if (hits.length === 0) {
        return scopedCourseIds
          ? '当前课程上下文中没有检索到相关内容。可以换关键词重试，或重新选择课程上下文。'
          : '课程库中没有检索到相关内容。请尝试更短的关键词或同义说法。';
      }
      return hits
        .map((hit, index) => {
          const course = courseMap.get(hit.doc.courseId)!;
          const excerpt = hit.doc.text.length > 500 ? `${hit.doc.text.slice(0, 500)}…` : hit.doc.text;
          return `${index + 1}. 课程：${courseLink(course)}\n   来源：[${hit.doc.location}]\n   原文：${excerpt}\n   courseId=${course.id}`;
        })
        .join('\n\n');
    }

    if (name === 'get_course_details') {
      const courseId = String(args.courseId ?? '').trim();
      const course = await db.videos.get(courseId);
      if (!course) return `未找到 courseId=${courseId} 的课程。`;
      const [folder, contentCount, handouts, cards, sessions] = await Promise.all([
        course.folderId == null ? undefined : db.folders.get(course.folderId),
        course.kind === 'material'
          ? db.materialBlocks.where('materialId').equals(course.id).count()
          : db.segments.where('videoId').equals(course.id).filter((row) => row.status === 1 && !!row.text).count(),
        db.handouts.where('videoId').equals(course.id).count(),
        db.cards.where('videoId').equals(course.id).count(),
        db.chatSessions.where('videoId').equals(course.id).count(),
      ]);
      const progress = courseProgress(course);
      return [
        `课程：${courseLink(course)}`,
        `courseId=${course.id}`,
        `类型：${course.kind === 'material' ? `阅读材料 · ${(course.materialFormat ?? '文档').toUpperCase()}` : '视频课程'}`,
        `分类：${folder?.name ?? '未分类'}`,
        `学习进度：${progress.label}`,
        `内容状态：${contentCount > 0 ? `可检索（${contentCount} 个内容块）` : '暂无可检索正文'}`,
        `衍生内容：讲义 ${handouts} 份，记忆卡片 ${cards} 张，问答会话 ${sessions} 个`,
        `原文件：${course.fileDeleted ? '已删除，衍生内容仍保留' : '可用'}`,
      ].join('\n');
    }

    return `未知工具：${name}`;
  };
}
