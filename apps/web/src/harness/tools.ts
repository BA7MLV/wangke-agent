import type { ToolDef } from '../api/siliconflow';
import { db } from '../store/db';
import { highlightContext } from '../materials/highlightContext';
import { fmtTime } from '../utils/vtt';
import { formatFrameList } from '../utils/linkify';
import { validateQuiz, type QuizData } from './quiz';
import { searchTranscript } from './search';
import {
  formatMaterialHits,
  formatMaterialRange,
  materialRange,
  searchMaterial,
} from './searchMaterial';
import { fmtUnitRef, unitNoun, type UnitKind } from '../materials/units.ts';
import { COURSE_HANDOUT_SKILL, isLegacyHandoutSkill, LEGACY_HANDOUT_TOPICS } from '../skills/catalog';
// 工具层与 md 编辑面的**唯一**耦合点（注册表 + 窄接口，见该文件开头的边界说明）。
// 别在这里 import md-editor 里的别的模块：edits / agentDiff 都是 CodeMirror 侧的，
// 绕过 bridge 就等于把「工具层不认 CodeMirror」这条边界拆了。
//
// ⚠️ 这里**只有 type 导入是静态的**。bridge 静态依赖 @codemirror/view 与
// @codemirror/commands，而本文件在**每一门课**（含视频课）的首屏就加载 —— 普通 import
// 会把 CodeMirror 拉回主 chunk，正好抵消掉 MdReader 把 MdEditor 隔离成 lazy chunk
// 换来的按需加载（理由见 components/MdReader.tsx 顶部）。取值一律走动态 import，见 mdEditorOpen。
import type { MdEditorController } from '../md-editor/bridge';
// 校验必须**走渲染层同一个函数**，否则「预检通过」没有意义 ——
// 两处净化逻辑一旦分叉，工具就成了摆设。
import { sanitizeSvg } from '../components/mermaid/svgRender';
import { renderMermaid } from '../components/mermaid/mermaidRender';
import { renderDiagram } from '../components/mermaid/diagramRender';
import { validateDiagram } from '../components/mermaid/diagramSchema';
import { validateWidgetArgs, widgetAcceptedText, widgetRejectedText, MAX_WIDGET_DOC } from './widget';
import { buildWidgetDocument, type WidgetPayload } from './widgetRuntime';
import { uuid } from '../utils/uuid';

/** 一次范围取数的单元数上限：防止模型一次要 200 页把上下文吃光 */
const MAX_RANGE_UNITS = 20;

// ── 字幕（视频）检索工具 ────────────────────────────────────────────────────

const SEARCH_TRANSCRIPT_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'search_transcript',
    description:
      '在课程字幕中按关键词检索相关片段，返回带时间戳的字幕内容。传**关键词或短语**，不要传整句问题',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            '检索关键词，2~6 个词为佳（例如「贝叶斯定理」「第4条规则」「过拟合 惩罚项」）。不要传自然语言问句——检索是字面匹配，问句里的大量虚词只会引入噪声',
        },
      },
      required: ['query'],
    },
  },
};

const GET_TRANSCRIPT_RANGE_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'get_transcript_range',
    description: '获取指定时间范围内的字幕原文，用于查看某个时间点前后讲了什么',
    parameters: {
      type: 'object',
      properties: {
        start: { type: 'number', description: '开始时间（秒）' },
        end: { type: 'number', description: '结束时间（秒）' },
      },
      required: ['start', 'end'],
    },
  },
};

// ── 阅读材料检索工具 ────────────────────────────────────────────────────────

const SEARCH_MATERIAL_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'search_material',
    description:
      '在阅读材料中按关键词检索相关段落，返回带页码（PDF）或段落号（Word）的原文。传**关键词或短语**，不要传整句问题',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            '检索关键词，2~6 个词为佳（例如「贝叶斯定理」「公式 3.2」「假设检验 显著性」）。不要传自然语言问句——检索是字面匹配',
        },
      },
      required: ['query'],
    },
  },
};

const GET_MATERIAL_RANGE_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'get_material_range',
    description:
      '获取指定范围内的原文，用于查看某处前后内容。范围用页码（PDF）或段落号（Word）表示，闭区间',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'number', description: '起始页/段（1 起）' },
        to: { type: 'number', description: '结束页/段（含）；省略则取 from 之后的 1 个单位' },
      },
      required: ['from'],
    },
  },
};

// ── 两种课程共用的工具 ──────────────────────────────────────────────────────

const USE_SKILL_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'use_skill',
    description: '加载指定技能的完整规范正文。当问题涉及某技能的用途领域时调用（技能列表见系统提示词）',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '技能名称，从系统提示词的技能列表中原样复制' },
      },
      required: ['name'],
    },
  },
};

const READ_SKILL_REFERENCE_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'read_skill_reference',
    description: '读取技能附带的参考文档（路径来自 use_skill 返回的参考文档列表）',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '技能名称' },
        path: { type: 'string', description: '参考文档相对路径，如 references/terms.md' },
      },
      required: ['name', 'path'],
    },
  },
};

const PRESENT_QUIZ_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'present_quiz',
    description:
      '展示各种题型的可作答题卡：单选、多选、判断、填空、排序、配对、主观题和组合题。客观题按已核验答案由宿主批改；主观题提交后参考核对、自评收错，不冒充自动评分。已有题库时传 path（普通 Markdown material 或 /courses/current/questions.md）、offset、limit，读取最新版，不要重写题目或答案。AI 参考答案或缺答案不计分、不收为错题。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '题库 Markdown 路径；与 questions 二选一。' },
        offset: { type: 'integer', minimum: 0, description: '从第几题开始（0 起）' },
        limit: { type: 'integer', minimum: 1, maximum: 5, description: '每批 1~5 题，默认 5' },
        questions: {
          type: 'array',
          description: '1~5 道原题或基于材料的题目；不能把其他题型改成单选',
          items: {
            type: 'object',
            properties: {
              stem: { type: 'string', description: '题干，一句话' },
              type: { type: 'string', enum: ['single', 'multiple', 'boolean', 'fill', 'ordering', 'matching', 'freeform', 'composite'], description: '默认 single；解答/证明/计算/作文/作图/其他特殊题用 freeform；包含独立小题用 composite。' },
              typeLabel: { type: 'string', description: '原文题型名称；保留计算题、证明题等原始类型。' },
              options: {
                type: 'array',
                items: { type: 'string' },
                description: 'single/multiple/ordering/matching 的 2~26 个原文选项，不含字母前缀；其他题型省略或 []，不得凑项',
              },
              answer: { anyOf: [{ type: 'number' }, { type: 'boolean' }, { type: 'string' }, { type: 'array', items: {} }], description: 'single 下标；multiple 无重复下标数组（全选对才对）；boolean 布尔值；fill 每空字符串数组；ordering 排序后的下标数组；matching 每个左项对应的右列下标数组；freeform 参考答案文字；composite 与 parts 每题答案一致的数组；missing 统一 -1。' },
              acceptedAnswers: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: '仅 fill：每空可接受答案数组，只精确核对，不判断公式等价；没有核验过的别名不要添加。缺答案时用 blanks 标明空数。' },
              blanks: { type: 'integer', minimum: 1, maximum: 50, description: '仅 fill：空数，尤其在 missing、answer=-1 时记录作答空数。' },
              matches: { type: 'array', items: { type: 'string' }, description: '仅 matching 的右列标签。' },
              parts: { type: 'array', maxItems: 50, items: { type: 'object', additionalProperties: true }, description: '仅 composite：每个小题使用相同题目字段（stem/type/options/answer/answerSource/source/explanation 等），最多嵌套 3 层；保留共用题干。' },
              presentation: { type: 'object', properties: { html: { type: 'string', description: '可选：复用 show_widget 的 HTML 片段规范，实现拖拽/连线/作图等输入。用户点击时调用 window.__wbw.setAnswerDraft(答案)，只更新草稿；学生还需在宿主题卡点“提交答案”。window.__wbw.answerInput 提供已存作答和 submitted；监听 wbw:answerchange 恢复。不得内嵌答案/解析/判分/错题写入，不可读取材料，原图由题卡 images 显示；始终提供标准作答降级。' } }, required: ['html'] },
              answerSource: { type: 'string', enum: ['original', 'verified', 'ai', 'missing'], description: '原文答案、用户核验答案、AI 参考答案或缺失；missing 时 answer=-1。抽取原题必须提供。' },
              source: { type: 'object', properties: { courseId: { type: 'string' }, name: { type: 'string' }, page: { type: 'integer', minimum: 1 } }, required: ['courseId'] },
              images: { type: 'array', items: { type: 'string' }, description: '材料 images 目录返回的 #source-image/... 稳定引用；不要重画原图，不要传 base64。' },
              explanation: {
                type: 'string',
                description:
                  '解析：正确项为什么对、干扰项为什么错；引用内容时带 [mm:ss] 时间戳（视频课程）或 [第N页]/[第N段]（阅读材料）。支持 Markdown 与 ```diagram JSON 图表围栏：流程/架构/关系用 graph，函数/几何用 plot，柱/折/饼用 chart（kind:bar/line/pie，data:[{label,value}]）。只描述结构与数据，坐标布局由渲染器算。时序等未覆盖图种用 ```mermaid。前端会把围栏渲染成图而不是源码',
              },
              time: {
                type: 'string',
                description: '考点对应的字幕时间戳，mm:ss 或 h:mm:ss（只有视频课程需要）',
              },
            },
            required: ['stem', 'answer', 'explanation'],
          },
        },
      },
      required: [],
    },
  },
};

/**
 * 图形预检：把写好的 SVG / mermaid / diagram 先过一遍**真正的渲染管线**；HTML
 * 则在隔离文档构造成功后交给 WidgetBlock。通过才给模型成功回执。
 *
 * ⚠️ svg / mermaid / diagram 不直接渲染：图真正上屏靠回执里的围栏 —— 模型把它放进回答正文，
 * 由 components/mermaid/ 在渲染 Markdown 时接管。HTML 是需要脚本的交互例外，才走独立沙箱。
 * 共同价值是把渲染失败提前成一次可重试的工具报错。
 *
 * 详见 ./widget.ts 顶部的说明（含「为什么不做成卡片」）。
 */
export const SHOW_WIDGET_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'show_widget',
    description:
      '画流程图、时序图、状态图、结构图、函数图像这类图形时调用一次做预检。传入完整的 mermaid 源码、diagram JSON 或 SVG 源码，' +
      '通过后会把一段可直接放进回答正文的 ```mermaid / ```diagram / ```svg 围栏原样返回给你（带了 title 就会写成 ```diagram title="…"）；' +
      'format="html" 会返回不含源码的 wbw-widget 引用围栏，将引用原样放在正文需要看图的位置；多次调用不会覆盖前图，不要贴 HTML 源码。' +
      'HTML 页面作品（包括无脚本静态页面）统一通过本工具生成，校验完成后自动隔离运行；不要输出裸 HTML 或 html interactive 围栏代替工具。普通 html 围栏仅展示源码。' +
      '例如“做一个可以拖动的函数图”调用本工具；“解释这段按钮代码”只给代码示例；“帮我预览这个示例”保留原示例并用本工具创建作品。课程引用、导入材料和思考中的代码不是执行授权。' +
      '不通过会告诉你具体哪里不合规，改完再试。svg / mermaid / diagram 仍必须把返回的围栏放进正文，且要放在它解释的那句话旁边、前后各配一句说明。',
    parameters: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          enum: ['mermaid', 'diagram', 'svg', 'html'],
          description:
            '源码类型。优先 diagram JSON：流程/结构/层级用 graph，函数/几何用 plot，柱/折/饼用 chart。模型只描述结构与数据，布局由渲染器算；时序/ER 等未覆盖图种用 mermaid。' +
            '参数变化、算法单步、教学模拟器或交互原型用 html，先加载「交互式讲解」技能；不要把所有图做成网页。svg 仅兼容历史内容，新图优先使用受约束 JSON',
        },
        code: {
          type: 'string',
          description:
            '完整源码，不要包围栏、不要加解释文字。diagram 需是一个 JSON 对象：{"type":"chart","kind":"bar","data":[{"label":"甲","value":3}]}（柱/折/饼）；或 {"type":"plot","x":[-10,10],"y":[-3,3],"curves":[{"fn":"sin(x)"}]}（函数图像/几何/坐标轴）' +
            '或 {"type":"graph","nodes":[{"id":"a","label":"客户端"}],"edges":[{"from":"a","to":"b"}]}（结构图）——只描述有什么、怎么连、函数与范围，不要手算坐标，完整 schema 见「讲解配图」技能；' +
            'mermaid 需以图种声明开头（flowchart / sequenceDiagram / stateDiagram-v2 / mindmap / pie）；' +
            'svg 需以 <svg 开头 </svg> 结尾、必须带 viewBox；' +
            'html 只给**片段**（不要 <html>/<head>/<body>），可以带内联 <script>，' +
            '但不能引外部脚本或外链资源（运行环境限制网络访问）。宿主提供主题变量、原生控件样式和 window.__wbw：widgetState 读取快照，setWidgetState({modelContent,privateContent}) 保存 JSON 参数，sendPrompt(text) 经用户确认后携带 modelContent 追问。调参只本地重绘，不请求模型；完整约定见「交互式讲解」技能',
        },
        title: {
          type: 'string',
          description:
            '这张图的标题，2~12 个字，点明它讲的是什么（如「三次请求链路」「抛物线开口方向」）。会显示在图块左上角，也是下载时的文件名；' +
            '不要写成正文句子、不要以句号结尾。mermaid / diagram / svg 三种围栏都该带；html 没有标题栏，不要传',
        },
        libs: {
          type: 'array',
          items: { type: 'string', enum: ['chart.js'] },
          description:
            '仅 html：需要宿主内联的库。画图表时填 ["chart.js"]，之后直接用全局 Chart，不要自己引 CDN。' +
            'mermaid / diagram / svg 不需要这个参数',
        },
      },
      required: ['format', 'code'],
    },
  },
};

/**
 * 可嵌入其他 Agent 的技能工具集。
 *
 * 课程助手没有单课程的字幕/材料上下文，也不展示交互题卡，但仍要复用同一套
 * use_skill / read_skill_reference 契约与白名单执行边界，因此把这两项单独导出。
 */
export const SKILL_TOOLS: ToolDef[] = [USE_SKILL_TOOL, READ_SKILL_REFERENCE_TOOL];

const SHARED_TOOLS: ToolDef[] = [...SKILL_TOOLS, PRESENT_QUIZ_TOOL, SHOW_WIDGET_TOOL];

/** 视频课程的问答工具集 */
export const QA_TOOLS: ToolDef[] = [
  SEARCH_TRANSCRIPT_TOOL,
  GET_TRANSCRIPT_RANGE_TOOL,
  ...SHARED_TOOLS,
];

/**
 * 阅读材料的问答工具集。
 *
 * **不注册 `search_transcript` / `get_transcript_range`**：材料没有字幕，
 * 注册了只会诱发无效工具调用（模型会先试一次，白跑一轮）。这与 `LIST_FRAMES_TOOL`
 * 只在有抽帧时注册是同一个思路 —— 按课程实际具备的能力给工具。
 */
export const MATERIAL_QA_TOOLS: ToolDef[] = [
  SEARCH_MATERIAL_TOOL,
  GET_MATERIAL_RANGE_TOOL,
  ...SHARED_TOOLS,
];

/**
 * 画面引用工具（仅当视频已有讲义抽帧时注册，见 ChatPanel）。
 * 返回幻灯片帧清单（时间戳 + 画面描述），agent 据此在回答里用 [图@mm:ss] 引用。
 */
export const LIST_FRAMES_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'list_frames',
    description: '查看课程的幻灯片画面清单（讲义抽帧得到的时间戳 + 画面内容描述），用于在回答中引用配图',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
};

/**
 * 直接改用户那份 md 正文（**仅当这份材料的编辑面此刻开着**时注册，见 ChatPanel）。
 *
 * 为什么与其它工具不同：前九个工具的产物都在**回答里**（引用的时间戳、题卡、图），
 * 写错了用户最多觉得答得不对；这一个写的是**用户自己的笔记**。所以描述里必须把
 * 「改动会立刻出现在用户眼前」和「old_string 是逐字匹配、不是行号」写在最前面 ——
 * 模型只有知道改的是别人的东西，才会克制；而行号这个说法一旦漏掉，它就会按
 * 「读到的第几行」去猜，那是把用户没让改的地方改掉的形状（edits.ts 顶部的取舍）。
 */
export const EDIT_MARKDOWN_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'edit_markdown',
    description:
      '直接修改用户当前打开的这份 Markdown 材料的正文。改动**立刻出现在用户正在看的那份文档里**（并高亮出来），' +
      '用户可以一键撤销。每条 edit 的 old_string 必须从文档里**原样逐字复制**（标点、空格、换行都算），' +
      '它按精确字符串匹配定位，不是行号：找不到、或找到多处而无法确定改哪一处，都会报错让你重来（报错里会写明命中了几处）。' +
      '只改确实需要改的那几段，不要顺手重写全文。',
    parameters: {
      type: 'object',
      properties: {
        edits: {
          type: 'array',
          description: '要做的改动，一次调用可含多条；同一次调用里各条的替换区间不能重叠',
          items: {
            type: 'object',
            properties: {
              old_string: {
                type: 'string',
                description:
                  '要被替换的原文，从文档里逐字复制（多带几个字保证它在文中唯一）。默认要求唯一命中；确实要改所有出现处时才用 replace_all',
              },
              new_string: {
                type: 'string',
                description: '替换成的新文本。传空字符串 "" 表示删掉 old_string 这一段（可撤销）',
              },
              replace_all: {
                type: 'boolean',
                description: 'old_string 在文中出现多次时是否全部替换；默认 false（要求唯一命中）',
              },
            },
            required: ['old_string', 'new_string'],
          },
        },
      },
      required: ['edits'],
    },
  },
};

/**
 * `edits` 的元素形状。**从控制器的方法签名上取**，而不是从 md-editor/edits 再 import 一次：
 * 那是同一份类型的第二个引用点，两边漂移要等到运行时才发现（见上面 bridge 导入那段）。
 */
type AgentEdit = Parameters<MdEditorController['applyEdits']>[0];

/**
 * 这份材料此刻有没有打开编辑面 —— 也就是「要不要注册 edit_markdown」的判据。
 *
 * ⚠️ bridge 走**动态** import 是一处刻意的取舍，不是写法偏好：本文件在每门课的首屏都加载，
 * 而 bridge 静态依赖 CodeMirror（实测普通 import 会让主 chunk +252 kB / gzip +84 kB），
 * 那正好抵消掉 MdReader 把 MdEditor 隔离成 lazy chunk 的全部理由（理由同上面那段注释）。
 * 代价（第一次用要等一次 import）在这里近乎为零：工具能被注册的前提就是编辑面开着，
 * 而那一刻 bridge 早已随 MdEditor 一起加载完，模块直接从缓存解析。
 * 唯一真会多付一次的形状是「md 材料、用户没点编辑就提问」——那也正是本功能唯一的受益者，
 * 比让所有人在所有首屏都付要划算得多。
 */
export async function mdEditorOpen(materialId: string): Promise<boolean> {
  const { getMdEditor } = await import('../md-editor/bridge');
  return getMdEditor(materialId) !== undefined;
}

export interface ToolExecutorOptions {
  /** Do not deliver a completed preview after its generation has been cancelled. */
  signal?: AbortSignal;
  /**
   * 课程形态：
   * - 不传 = 视频，走字幕检索
   * - `'page'` / `'para'` = 阅读材料，分别对应页码 / 段落号
   */
  kind?: UnitKind;
  /** present_quiz 校验通过后的题卡透传回调 */
  onQuiz?: (quiz: QuizData) => void;
  /**
   * show_widget 的 html 形态校验通过后的图形透传回调。
   *
   * 只有 html 走这里：svg / mermaid 仍然由模型自己把围栏放进正文，
    * 在正文里按讲解顺序定位。html 的载荷旁路保存，回执引用决定正文位置。
   */
  onWidget?: (w: WidgetPayload) => void | Promise<void>;
  /**
   * 会话级技能白名单（问答面板的「技能范围」限定）。
   *
   * ⚠️ **`undefined` 与 `[]` 不同**：`undefined` = 不限制；`[]` = 全部拒绝。
   * 与元数据、资源目录统一使用 loadSessionSkillMeta，包含已合并的历史 ID。
   */
  allowedSkillIds?: number[];
}

/** 构造绑定到某个课程的工具执行器；`kind` 决定走字幕检索还是材料检索 */
export function createToolExecutor(courseId: string, opts: ToolExecutorOptions = {}) {
  const { kind, onQuiz, onWidget, allowedSkillIds } = opts;

  return async (name: string, args: Record<string, unknown>): Promise<string> => {
    if (name === 'search_transcript') {
      const query = String(args.query ?? '');
      const hits = await searchTranscript(courseId, query, Math.min(15, Math.max(1, Number(args.limit) || 6)));
      if (hits.length === 0) return '未检索到相关字幕内容。';
      return hits.map((h) => `[${fmtTime(h.segment.start)}] ${h.segment.text}`).join('\n');
    }
    if (name === 'get_transcript_range') {
      const start = Number(args.start) || 0;
      const end = args.end == null ? start + 60 : Number(args.end);
      const rows = await db.segments
        .where('videoId')
        .equals(courseId)
        .filter((r) => r.status === 1 && !!r.text && r.end >= start && r.start <= end)
        .sortBy('idx');
      if (rows.length === 0) return '该时间范围内没有字幕内容。';
      return rows.map((r) => `[${fmtTime(r.start)}] ${r.text}`).join('\n');
    }
    if (name === 'search_material') {
      if (!kind) return '这份课程没有可检索的阅读材料。';
      const query = String(args.query ?? '');
      const hits = await searchMaterial(courseId, query, Math.min(15, Math.max(1, Number(args.limit) || 6)));
      if (hits.length === 0) return '未检索到相关材料内容。';
      const highlights = await highlightContext(courseId, hits.map((h) => h.block.unit));
      return [formatMaterialHits(hits, kind), highlights].filter(Boolean).join('\n\n');
    }
    if (name === 'get_material_range') {
      if (!kind) return '这份课程没有可检索的阅读材料。';
      const from = Math.max(1, Number(args.from) || 1);
      const rawTo = args.to == null ? from + 1 : Number(args.to) || from + 1;
      const to = Math.min(rawTo, from + MAX_RANGE_UNITS - 1);
      const rows = await materialRange(courseId, from, to);
      if (rows.length === 0) {
        return `第 ${from}~${to} ${unitNoun(kind)}没有内容（可能超出材料范围）。`;
      }
      const highlights = await highlightContext(courseId, rows.map((r) => r.unit));
      const body = [formatMaterialRange(rows, kind), highlights].filter(Boolean).join('\n\n');
      // 被截断时明确告知，否则模型会以为材料就到这里，给出「未提及」的错误结论
      return rawTo > to
        ? `${body}\n\n（注意：一次最多返回 ${MAX_RANGE_UNITS} 个${unitNoun(kind)}，已截断到 ${fmtUnitRef(kind, to)}）`
        : body;
    }
    if (name === 'list_frames') {
      const rows = await db.frames
        .where('videoId')
        .equals(courseId)
        .filter((r) => r.kind === 'slide')
        .sortBy('ts');
      return formatFrameList(rows, courseId);
    }
    if (name === 'use_skill' || name === 'read_skill_reference') {
      const skillName = String(args.name ?? '');
      // 两种读取都在执行时核对白名单，不能只依赖提示词中收窄的技能清单。
      const { loadSessionSkillMeta } = await import('../skills/store');
      const available = await loadSessionSkillMeta(allowedSkillIds);
      const matches = await db.skills.where('name').equals(skillName).toArray();
      const requested = matches.find((s) => s.enabled && available.some((m) => m.id === s.id))
        ?? matches.find((s) => s.enabled && isLegacyHandoutSkill(s))
        ?? matches[0];
      if (!requested || !requested.enabled) return `未找到已启用的技能：${skillName}（名称需与技能列表完全一致）`;
      const merged = isLegacyHandoutSkill(requested);
      const skill = merged
        ? await db.skills.filter((s) => !!s.builtin && s.name === COURSE_HANDOUT_SKILL).first()
        : requested;
      if (!skill || !skill.enabled) return `未找到已启用的技能：${merged ? COURSE_HANDOUT_SKILL : skillName}`;
      // 文案要指向「可选范围」而不是含糊的「不允许」：模型收到「未找到」会换个名字再试，
      // 收到「不在范围内」才知道该收手 —— 否则会白烧好几轮工具调用。
      if (!available.some((s) => s.id === skill.id)) {
        return `技能「${skillName}」不在本次会话的可选技能范围内。请改用系统提示词中列出的技能，或直接依据课程内容回答。`;
      }
      if (name === 'read_skill_reference') {
        let path = String(args.path ?? '');
        if (merged) {
          // 只兼容真实存在的旧参考路径，不把任意拼错的路径当成成功读取。
          const oldRef = await db.skillRefs.where('skillId').equals(requested.id!).filter((r) => r.path === path).first();
          if (!oldRef) return `技能「${skillName}」下未找到参考文档：${path}`;
          path = LEGACY_HANDOUT_TOPICS[skillName];
        }
        const ref = await db.skillRefs.where('skillId').equals(skill.id!).filter((r) => r.path === path).first();
        return ref?.body ?? `技能「${skill.name}」下未找到参考文档：${path}`;
      }
      const refs = await db.skillRefs.where('skillId').equals(skill.id!).toArray();
      const refList =
        refs.length > 0
          ? `\n\n该技能附带的参考文档（用 read 读取以下完整路径）：\n${refs.map((r) => `- /skills/${encodeURIComponent(skill.name)}/references/${r.path.split('/').map(encodeURIComponent).join('/')}`).join('\n')}`
          : '';
      const notice = merged ? `「${skillName}」已并入「${skill.name}」。本次按需读取 ${LEGACY_HANDOUT_TOPICS[skillName]}，遵循下方 Markdown 流程。\n\n` : '';
      return notice + skill.body + refList;
    }
    if (name === 'present_quiz') {
      if (!onQuiz) return '当前入口未接入答题卡，未展示题目。';
      if (args.path !== undefined) return '题库 path 需通过资料资源执行器读取，不能作为内联 questions 展示。';
      const v = validateQuiz(args);
      if (!v.ok) return `题卡结构校验失败：${v.error}。请修正后重新调用 present_quiz。`;
      onQuiz?.(v.quiz);
      return '题卡已展示给学生。请用一句话说明这些题考查的知识点，不要重复题目内容。';
    }
    if (name === 'show_widget') {
      opts.signal?.throwIfAborted();
      const v = validateWidgetArgs(args);
      if (!v.ok) return `预检参数不合法：${v.error}。请修正后重新调用 show_widget。`;
      try {
        // 三条分支都调**渲染层自己的函数**：svg 走净化，mermaid 走 parse，diagram 走
        // schema 校验 + 试渲染。
        // mermaid 那次 render 的结果有缓存（renderMermaid 内），正文里真正渲染时不会再跑一遍。
        if (v.args.format === 'svg') {
          // 回**净化后的**源码，不是原样回传。净化器是「剔除」而不是「全否」：
          // 一段带 <script> 的 SVG 会被剥掉脚本后照常通过。所以原样回传等于让模型
          // 拿到一段「预检说没问题、渲染时却会被悄悄改掉」的代码。给净化后的结果，
          // 回执里的围栏就是**最终会渲染出来的那一份**，模型与用户看到的完全一致。
          return widgetAcceptedText({ format: 'svg', code: sanitizeSvg(v.args.code) });
        }
        if (v.args.format === 'mermaid') {
          // mermaid 只能回源码：renderMermaid 的产物是 SVG 字符串，不是可回填的 mermaid 文本。
          // parse 失败会抛，成功即语法有效，所以这里「回原样」是安全的。
          await renderMermaid(v.args.code);
          return widgetAcceptedText(v.args);
        }
        if (v.args.format === 'diagram') {
          // diagram 回**原样 JSON**：围栏的内容就是 JSON 本身（不像 svg 那样要回净化产物）。
          // 校验 = JSON.parse + schema 锁字段 + 试渲染（布局/表达式错误在这里暴露）。
          // 试渲染是必须的：schema 合法但 fn 是 "sinn(x)" 的图，只有渲染器会喊。
          let doc: unknown;
          try {
            doc = JSON.parse(v.args.code);
          } catch (e) {
            const hint = /^\s*</.test(v.args.code)
              ? '内容以 < 开头，看起来是 SVG 而不是 JSON —— diagram 围栏里只放 JSON 对象'
              : '请检查多余的逗号、缺引号、或把说明文字写进了围栏';
            throw new Error(`diagram 围栏里不是合法的 JSON：${e instanceof Error ? e.message : String(e)}。${hint}`);
          }
          renderDiagram(validateDiagram(doc));
          return widgetAcceptedText(v.args);
        }
        // html：**先确认文档能拼出来**（内联库缺失、源码过大等在这里就暴露），
        // 成功后再交给渲染层上屏。渲染层是唯一能执行它的地方。
        const doc = await buildWidgetDocument({ html: v.args.code, libs: v.args.libs });
        if (doc.length > MAX_WIDGET_DOC)
          throw new Error(`拼好的文档过大（${doc.length} 字，上限 ${MAX_WIDGET_DOC}）。拆成几张图，或去掉不需要的内联库`);
        opts.signal?.throwIfAborted();
        const id = uuid();
        await onWidget?.({ kind: 'html', schemaVersion: 1, revision: 1, source: 'tool', id, ref: id, html: v.args.code, libs: v.args.libs });
        return widgetAcceptedText(v.args, id);
      } catch (e) {
        // 净化 / 解析失败**不回退源码**：这里是工具调用，返回的是给模型看的诊断信息，
        // 模型据此改完重试。真到渲染那步失败才是「静默降级成显示源码」，也正是这里要挡掉的。
        return widgetRejectedText(e);
      }
    }
    if (name === 'edit_markdown') {
      /**
       * courseId 在材料课程里就是 materialId（ChatPanel 对视频与材料传的是同一个 id），
       * 所以直接拿它去问注册表 —— 不另开一个参数，改一处调用点不会漏掉另一处。
       * 动态 import 的理由见文件里 mdEditorOpen 那段（此时编辑面开着，模块必已在缓存里）。
       */
      const { getMdEditor } = await import('../md-editor/bridge');
      const ctl = getMdEditor(courseId);
      /**
       * 编辑面不在 = 这个工具此刻不可用。**必须说清原因与下一步**，且只说一次就够：
       * 模型拿到「请让用户在材料页点编辑」会去转告用户；拿到一句含糊的「不可用」
       * 则多半会换个 old_string 再试，把整轮工具调用烧光（这里一白跑就是一次往返）。
       */
      if (!ctl) {
        return '这份材料现在没有打开编辑面，无法修改正文。请先让用户在材料页点开它的「编辑」，之后重新调用本工具。';
      }
      /**
       * 参数**不**在这里预校验：planAgentEdits 对 edits 的形状（不是数组、字段缺失、
       * 传了数字、old_string 是空串…）都有逐条的诊断，写得比这里能写的更细。
       * 原样透传，别在外面包一层「编辑失败」——那会把「第几条 edit、命中几处、下一步怎么改」全吞掉。
       */
      const r = ctl.applyEdits(args.edits as AgentEdit);
      if (!r.ok) return r.error;
      /**
       * 成功回执要做两件事：说清**改了几处**（changed 是区间数，与用户看到的绿色高亮条数一致，
       * 一条 replace_all 命中 5 处就是 5），以及告诉模型**还欠一句人话** ——
       * 模型常把工具回执当成终点，用户于是只看到文档变了却不知道 agent 做了什么。
       */
      return `已修改 ${r.changed} 处，改动已高亮在用户正在看的那份文档里，用户可以一键撤销。请用一两句话说明你改了什么。`;
    }
    return `未知工具「${name}」。当前运行在浏览器学习应用中，没有通用文件系统或终端能力；不要重试 write/writeFile/fs/shell 等未注册工具。若要展示 SVG，请调用 show_widget(format="svg", code=...)；若要修改 Markdown，请调用已提供的 edit 工具。`;
  };
}
