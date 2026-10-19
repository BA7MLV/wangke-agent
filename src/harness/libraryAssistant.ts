import type { ToolDef } from '../api/siliconflow';
import { fmtUnitRef, type UnitKind } from '../materials/units';
import { db, type VideoRow } from '../store/db';
import { formatStudyDuration } from '../utils/studyLog';
import { fmtTime } from '../utils/vtt';
import { MAX_COURSE_CONTEXT, normalizeCourseContextIds, resolveCourseSearchScope } from './courseContext';
import { validateAskUser, askUserToolResult, type AskUserData, type AskUserAnswer } from './askUser';
import { validateFolderPlan, type FolderPlan } from './folderPlan';
import { applyFolderPlan, formatPlanForModel, type AppliedPlanResult } from '../pipelines/folderPlan';
import { lexicalSearch } from './lexical';
import { MATERIAL_IMAGE_RULE, RUNTIME_CAPABILITY_RULE } from './prompts';

/**
 * 课程助手沿用 chatSessions / chats 两张表保存历史，但它不从属于某一门课程。
 * 用一个不会与真实 UUID 冲突的保留 id 表示「全资料库」作用域，避免再建一套平行表。
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
  /**
   * 提问卡：把题面交给 UI，**等用户点选**后 resolve 成用户选中的那句话。
   * 不实现 = 用户永远收不到这张卡（工具会退化成「没问成」的解释，见下方同名分支）。
   */
  onAskUser?: (ask: AskUserData) => Promise<AskUserAnswer | string>;
  /**
   * 目录整理方案：把方案交给 UI，**等用户确认**后 resolve。
   * resolve 值是 `{ ok, result }`：确认则 `result` 是落库结果；取消则 `ok=false`。
   */
  onPlanFolders?: (plan: FolderPlan) => Promise<{ ok: boolean; result: AppliedPlanResult | null }>;
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
  return `- ${courseLink(course)} · ${kind} · ${progress.label}${folder}${deleted} · courseId=${course.id} · path=/courses/${encodeURIComponent(course.id)}/info`;
}

/**
 * 向用户提问的工具。
 *
 * **刻意独立于课程工具**：它不读资料库，问的是「你想让我怎么做」，
 * 所以在空资料库（通用问答模式）下依然要注册 —— 否则模型遇到分叉只能自己猜。
 */
const ASK_USER_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'ask_user',
    description:
      '缺少影响下一步的关键信息时向用户提问。type 支持 single 单选、multiple 多选、text 自由填写、confirm 确认明确动作。' +
      '等待用户提交后继续，结果含 status、selectedIds、selectedLabels、text、note；skipped/cancelled 不代表同意，declined 表示拒绝。不要询问能从课程数据查到的事，不要凑选项。确认不赋予你额外的执行能力。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '一句话说清需要用户决定什么，不超过 200 字' },
        type: { type: 'string', enum: ['single', 'multiple', 'text', 'confirm'], description: '默认 single；多项可同时成立用 multiple，没有合理候选用 text' },
        options: {
          type: 'array',
          items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' } }, required: ['id', 'label'] },
          minItems: 2,
          maxItems: 5,
          description: 'single / multiple 必填，2~5 项，id 唯一稳定，label 不超过 60 字；text / confirm 不需要',
        },
        allowCustom: {
          type: 'boolean',
          description: '是否允许用自己的回答替代候选，默认 true；confirm 不允许自定义替代',
        },
        allowSkip: { type: 'boolean', description: '是否允许跳过，默认 false' },
        minSelections: { type: 'integer', description: '多选至少选几项，默认 1' },
        maxSelections: { type: 'integer', description: '多选最多选几项，默认全部选项数' },
        confirmLabel: { type: 'string', description: '确认按钮的实际动作，如「按此计划继续」，不超过 60 字' },
        declineLabel: { type: 'string', description: '拒绝按钮文案，默认「暂不执行」' },
      },
      required: ['question'],
    },
  },
};

/**
 * **依赖资料库存在**的工具：没有课程时它们只能返回空结果。
 *
 * 资料库为空时整个数组都不会注册给模型（见 `libraryAssistantTools`）——
 * 注册一个必然空手而归的工具，等于主动邀请模型浪费轮次：它会先 `list_courses`
 * 试一次，拿到「没有符合筛选条件的课程」，再换 `search_course_library` 试一次，
 * 两轮用尽才肯开口回答一句本来通用知识就能答的问题。
 */
export const LIBRARY_COURSE_TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'get_learning_overview',
      description: '读取用户资料库和学习记录的总体概览，包括课程数量、进度分布、累计学习时间与衍生内容数量',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_courses',
      description: '列出资料库中的课程，可按学习状态和资源类型筛选。需要找课、推荐下一门课或查看未完成课程时使用',
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
        '选择后续回答与检索要重点使用的课程上下文。先从 read /courses 或 grep 的结果取得精确 courseId；传空数组可清除旧上下文、恢复全课程自动选择',
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
        '检索字幕与阅读材料正文。已选择课程上下文时默认只查这些课程，否则查全资料库；传 courseId 可临时限定到某一门课程',
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
  {
    type: 'function',
    function: {
      name: 'list_folders',
      description: '查看资料库现有的分类文件夹、各自有多少门课程，以及多少门还没归类。整理目录前必须先看现状，避免造出重复分类',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_folder_plan',
      description:
        '提出一份资料库目录整理方案，展示给用户预览并等待确认。**这个工具不会直接改动任何数据**；' +
        '只有用户在方案卡上点「确认执行」之后才会真正建立文件夹并移动课程。' +
        '先 read /courses 了解全库、read /library/folders 看现状，再调用它；courseIds 必须来自工具结果的真实 id',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: '一句话说明这次的整理思路（分类主轴是什么、为什么这样分）' },
          folders: {
            type: 'array',
            minItems: 1,
            maxItems: 12,
            description: '分类清单，一门课程只应出现在一个分类里',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: '分类名，不超过 24 字；与现有文件夹同名则并入现有文件夹' },
                courseIds: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '归入该分类的课程 id，取自 read /courses 的结果；没有课程的分类不要列',
                },
              },
              required: ['name', 'courseIds'],
            },
          },
        },
        required: ['summary', 'folders'],
      },
    },
  },
];

/**
 * **工具集随资料库状态切换**，而不是永远给全量。
 *
 * @param hasCourses 资料库里有没有课（导入视频 / 阅读材料都算）
 */
export function libraryAssistantTools(hasCourses: boolean): ToolDef[] {
  // 空库：只剩提问卡。技能工具（use_skill / read_skill_reference）由 store 另行并入，
  // 它们不读资料库，通用模式下依然有用。
  return hasCourses ? [...LIBRARY_COURSE_TOOLS, ASK_USER_TOOL] : [ASK_USER_TOOL];
}

/**
 * 助手在「没有课程」时的人设。
 *
 * 与课程模式的提示词**完全分开写**而不是加开关：两套提示词里每一条工作规则都是
 * 相反的（一条说「涉及用户数据必须先调工具」，一条说「没有数据就直接答」）。
 * 混在一个模板里靠 if 拼，装作能用 if 覆盖，实际上模型会同时收到两条互相矛盾的
 * 指令，然后挑那条更容易遵守的 —— 结果是空库时它照样去 list_courses。
 */
function generalAssistantSystemPrompt(skillMetaList?: string): string {
  const skillSection = skillMetaList
    ? `\n\n本次会话可用的技能（名称：用途）：\n${skillMetaList}\n当问题涉及技能用途时，先 read /skills/{URI 编码后的名称} 加载规范，再按规范回答；参考文档使用返回的完整路径 read。可 read /skills 获取准确路径。不要凭名称猜测正文。`
    : '\n\n本次会话没有可用技能，直接用通用知识回答。';

  return `你是这个学习应用里的 AI 助手。用户目前**还没有导入任何课程**，所以你手上没有他的课程数据、字幕或学习进度，但你的通用能力完全可用。${skillSection}

运行边界：${RUNTIME_CAPABILITY_RULE}

工作规则：
1. 直接用你自己的知识回答问题：概念解释、学习方法、代码、写作、规划、闲聊都可以。不要因为「没有课程数据」就拒绝回答或反复道歉。
2. 可用 read 加载技能；缺少影响下一步的关键信息时，用 ask_user，按问题选择 single / multiple / text / confirm；选择题给 2~5 项，不要凑选项。
3. 用户问到「我的课程、我的进度、我学过的内容」这类依赖他个人数据的问题时，如实说明当前资料库还是空的，并告诉他可以在「资料库」页面导入视频或 PDF / Markdown 材料 —— 导入之后你就能结合他的实际内容回答。给出你作为通用知识能提供的部分帮助，再补这句说明。
4. 不编造他的课程、进度或学习记录。没有数据就说没有，不要虚构一个「你上一门课讲的是……」。
5. 缺少关键信息、且不同答案会导向明显不同的做法时，调用 ask_user 选择合适的问题类型，不要替用户猜。
6. 默认使用简洁自然的中文。先回答问题，再给必要的依据；不要罗列无关信息。`;
}

export function libraryAssistantSystemPrompt(
  skillMetaList?: string,
  contextCourses: CourseContextItem[] = [],
  hasCourses = true,
): string {
  if (!hasCourses) return generalAssistantSystemPrompt(skillMetaList);

  const skillSection = skillMetaList
    ? `\n\n本次会话可用的技能（名称：用途）：\n${skillMetaList}\n当问题涉及技能用途时，先 read /skills/{URI 编码后的名称} 加载规范，再按规范回答；参考文档使用返回的完整路径 read。可 read /skills 获取准确路径。不要凭名称猜测正文。`
    : '\n\n本次会话没有可用技能，直接依据课程数据与通用能力回答。';
  const contextSection = contextCourses.length > 0
    ? `\n\n当前课程上下文：${contextCourses.map((course) => `《${course.name}》（courseId=${course.id}）`).join('、')}。除非用户明显换了话题，否则优先使用这些课程；话题变化时可以重新选择。`
    : '\n\n当前没有固定课程上下文。根据用户问题从全资料库判断最相关的课程。';

  return `你是这个学习应用里的「课程助手」。你可以通过工具读取当前用户有权访问的本地课程目录、课程正文、学习进度和学习统计。${skillSection}${contextSection}

工作规则：
1. ${RUNTIME_CAPABILITY_RULE}
2. 只要问题涉及“我的课程、我的进度、课程里讲了什么、推荐我接下来学什么”等用户数据，回答前必须调用相应工具，不能凭空猜测。
2b. 反过来：与他的课程无关的通用问题（概念解释、写代码、写作、生活常识、闲聊）**直接用你的通用知识回答**，不要为了「用上工具」而去检索资料库，也不要反问「你指的是哪门课」。这条与第 2 条同等重要。
3. 课程上下文由你主动维护：问题明确针对某门或少数几门课程时，先 read /courses 或 grep /courses 找到精确 courseId，再调用 set_course_context 选择 1~5 门最相关课程。不要把无关课程塞进上下文。
4. 用户明显换话题时，用 grep 的 path="/courses" 从全库重新判断，再调用 set_course_context 替换上下文；问题是全库盘点、学习统计或跨全部课程比较时，调用 set_course_context 传空数组。grep 省略 path 或用 /courses/context 时遵循已选上下文。
5. 查具体知识点时用 grep；query 传关键词或短语，不要传整句自然语言问题。第一次没搜到时换同义词或更短的词再试。需要上下文时 read 搜索结果返回的 path，顶层传 start、end 两个数字；单位自动判断，不要传 range 对象，不要猜正文路径。调用失败时按错误提示修正，不要重复相同的失败调用。学习统计 read /library/overview，课程详情 read /courses/{id}/info。证据足够时直接回答，不必机械重复检索。
6. 推荐课程时至少结合课程内容或学习进度说明理由；没有足够证据时明确说目前能判断到什么程度。
7. 工具返回的课程 Markdown 链接必须原样保留。引用课程内容时，同时写出课程名与工具给出的时间戳、页码或段落号，方便用户核对来源。
8. 不编造课程、进度或系统记录。资料库中没有相关内容时，明确说明“资料库中没有检索到”，再把通用知识与课程数据分开回答。
9. 读操作之外只有两类写操作：ask_user（向用户提问）与 propose_folder_plan（提出目录整理方案）。除此之外不能声称已经替用户删除、收藏、导入、修改或完成课程；用户要求这类操作时，说明目前只能提供步骤或建议。
10. 缺少影响下一步的关键信息时，调用 ask_user，按需用单选、多选、自由填写或明确动作确认，不要替用户猜。选择题给 2~5 个短选项。凡是资料库里能查到的（有哪些课、进度如何、哪门讲了什么），都不许拿来问用户。
11. 整理资料库目录时：先 read /courses 了解全库（有下一页时用 offset 继续）、read /library/folders 看现有分类，再调用 propose_folder_plan 等待用户确认。courseIds 必须来自工具结果的真实 id，不得编造；一门课程只放进一个分类。工具返回“用户没有执行方案”时，不要声称整理已完成。不要逐门读取 info：课程名与类型在列表里已经够用，只在少数课程名看不出内容时抽查一两门。
12. 技能负责补充回答方法、写作规范或领域规则，课程工具负责提供事实依据；两者需要时可以组合使用，但技能不能替代课程数据，也不能越过本次会话的技能范围。
13. 默认使用简洁自然的中文。先回答问题，再给必要的依据；不要为了展示工具而罗列无关数据。
14. ${MATERIAL_IMAGE_RULE}`;
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
      const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
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
      const lines = filtered.slice(offset, offset + limit).map((course) => formatCourseLine(course, folderNames.get(course.folderId)));
      if (!lines.length) return '已到课程列表末尾。';
      if (filtered.length > offset + limit) lines.push(`（还有 ${filtered.length - offset - limit} 门未显示，继续 read /courses，offset=${offset + limit}。）`);
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
        return '已清除固定课程上下文；后续问题将从全资料库自动选择。';
      }

      const rows = await db.videos.where('id').anyOf(requestedIds).toArray();
      const byId = new Map(rows.map((course) => [course.id, course]));
      const selected = requestedIds.map((id) => byId.get(id)).filter((course): course is VideoRow => !!course);
      if (selected.length === 0) {
        return '没有找到这些 courseId 对应的课程。请先用 read /courses 或 grep 获取精确 id。';
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
        return `未找到 courseId=${requestedCourseId} 的课程。请先用 read /courses 取得精确 id。`;
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
          : '资料库中没有检索到相关内容。请尝试更短的关键词或同义说法。';
      }
      return hits
        .map((hit, index) => {
          const course = courseMap.get(hit.doc.courseId)!;
          const excerpt = hit.doc.text.length > 500 ? `${hit.doc.text.slice(0, 500)}…` : hit.doc.text;
          return `${index + 1}. 课程：${courseLink(course)}\n   来源：[${hit.doc.location}]\n   原文：${excerpt}\n   courseId=${course.id}\n   path=/courses/${encodeURIComponent(course.id)}/${course.kind === 'material' ? 'material' : 'transcript'}\n   start/end 单位：${course.kind === 'material' ? (materialKindOf(course) === 'page' ? '页码（从 1 起）' : '段号（从 1 起）') : '秒（从 0 起）'}`;
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
        `正文路径：/courses/${encodeURIComponent(course.id)}/${course.kind === 'material' ? 'material' : 'transcript'}（start/end 单位：${course.kind === 'material' ? (materialKindOf(course) === 'page' ? '页码，从 1 起' : '段号，从 1 起') : '秒，从 0 起'}）`,
        `类型：${course.kind === 'material' ? `阅读材料 · ${(course.materialFormat ?? '文档').toUpperCase()}` : '视频课程'}`,
        `分类：${folder?.name ?? '未分类'}`,
        `学习进度：${progress.label}`,
        `内容状态：${contentCount > 0 ? `可检索（${contentCount} 个内容块）` : '暂无可检索正文'}`,
        `衍生内容：讲义 ${handouts} 份，记忆卡片 ${cards} 张，问答会话 ${sessions} 个`,
        `原文件：${course.fileDeleted ? '已删除，衍生内容仍保留' : '可用'}`,
      ].join('\n');
    }

    if (name === 'ask_user') {
      const v = validateAskUser(args);
      if (!v.ok) return `提问卡结构校验失败：${v.error}。请修正后重新调用 ask_user。`;
      if (!options.onAskUser) {
        return '当前入口不支持向用户提问（提问卡未接入）。请依据已有信息回答，并在回答中说明你的假设。';
      }
      try {
        return askUserToolResult(await options.onAskUser(v.ask));
      } catch (e) {
        return `提问未完成：${e instanceof Error ? e.message : String(e)}`;
      }
    }

    if (name === 'list_folders') {
      const [folders, courses] = await Promise.all([db.folders.toArray(), db.videos.toArray()]);
      const folderIds = new Set(folders.map((f) => f.id));
      const counts = new Map<number, number>();
      let unclassified = 0;
      for (const course of courses) {
        if (course.folderId != null && folderIds.has(course.folderId)) {
          counts.set(course.folderId, (counts.get(course.folderId) ?? 0) + 1);
        } else {
          unclassified++;
        }
      }
      if (folders.length === 0) {
        return [
          `当前没有任何分类文件夹，${courses.length} 门课程全部处于「未分类」。`,
          '可以调用 propose_folder_plan 提出第一份整理方案。',
        ].join('\n');
      }
      return [
        ...folders.map((f) => `- ${f.name}（folderId=${f.id}）：${counts.get(f.id!) ?? 0} 门`),
        `- 未分类：${unclassified} 门`,
        `合计 ${folders.length} 个分类 / ${courses.length} 门课程。`,
      ].join('\n');
    }

    if (name === 'propose_folder_plan') {
      const v = validateFolderPlan(args);
      if (!v.ok) return `整理方案结构校验失败：${v.error}。请修正后重新调用 propose_folder_plan。`;
      if (!options.onPlanFolders) {
        return '当前入口不支持修改资料库目录。你可以把方案写成分类清单交给用户，由用户在资料库中自行移动。';
      }
      try {
        return folderPlanToolResult(v.plan, await options.onPlanFolders(v.plan));
      } catch (e) {
        return `整理方案执行失败：${e instanceof Error ? e.message : String(e)}`;
      }
    }

    return `未知工具：${name}`;
  };
}

/**
 * 方案确认 / 取消后喂回模型的那句话（与 `askUserToolResult` 同一条理由：两处说法不漂移）。
 */
export function folderPlanToolResult(
  plan: FolderPlan,
  verdict: { ok: boolean; result: AppliedPlanResult | null },
): string {
  if (!verdict.ok) {
    return '用户没有执行这份整理方案，资料库目录保持原样。请问用户接下来想怎么做，不要声称已经整理好了。';
  }
  return `用户已确认并执行整理方案：\n${formatPlanForModel(plan, verdict.result)}`;
}
