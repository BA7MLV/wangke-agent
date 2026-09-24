import type { ToolDef } from '../api/siliconflow';
import { db } from '../store/db';
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
import { isSkillAllowed } from '../skills/scope';

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
      '当用户要求出题、测验或"考考我"时调用，把单选题展示为可作答的交互题卡。调用前必须先用检索工具取到相关内容，题目必须基于材料/字幕实际讲到的内容。',
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description: '1~5 道单选题',
          items: {
            type: 'object',
            properties: {
              stem: { type: 'string', description: '题干，一句话' },
              options: {
                type: 'array',
                items: { type: 'string' },
                description: '恰好 4 个选项，不含 ABCD 前缀；干扰项用常见误解或相近概念',
              },
              answer: { type: 'number', description: '正确选项下标，0~3' },
              explanation: {
                type: 'string',
                description:
                  '解析：正确项为什么对、干扰项为什么错；引用内容时带 [mm:ss] 时间戳（视频课程）或 [第N页]/[第N段]（阅读材料）。支持 Markdown（粗体、列表）与 ```mermaid、```svg 两种图表围栏——流程、结构、对比、关系用 mermaid；函数图像、几何图形这类 mermaid 画不出的用 svg。前端会把围栏渲染成图而不是源码',
              },
              time: {
                type: 'string',
                description: '考点对应的字幕时间戳，mm:ss 或 h:mm:ss（只有视频课程需要）',
              },
            },
            required: ['stem', 'options', 'answer', 'explanation'],
          },
        },
      },
      required: ['questions'],
    },
  },
};

const SHARED_TOOLS: ToolDef[] = [USE_SKILL_TOOL, READ_SKILL_REFERENCE_TOOL, PRESENT_QUIZ_TOOL];

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

export interface ToolExecutorOptions {
  /**
   * 课程形态：
   * - 不传 = 视频，走字幕检索
   * - `'page'` / `'para'` = 阅读材料，分别对应页码 / 段落号
   */
  kind?: UnitKind;
  /** present_quiz 校验通过后的题卡透传回调 */
  onQuiz?: (quiz: QuizData) => void;
  /**
   * 会话级技能白名单（问答面板的「技能范围」限定）。
   *
   * ⚠️ **`undefined` 与 `[]` 不同**：`undefined` = 不限制；`[]` = 全部拒绝。
   * 判定统一走 `skills/scope.ts` 的 `isSkillAllowed`，不要在这里另写一份 ——
   * 两份判定迟早会不一致，而不一致就是漏洞口子。
   */
  allowedSkillIds?: number[];
}

/** 构造绑定到某个课程的工具执行器；`kind` 决定走字幕检索还是材料检索 */
export function createToolExecutor(courseId: string, opts: ToolExecutorOptions = {}) {
  const { kind, onQuiz, allowedSkillIds } = opts;

  /**
   * 技能是否在本次会话的可选范围内。
   *
   * 这是白名单的**唯一执行点**：提示词里收窄清单只是「告诉模型有哪些」，
   * 模型仍可能凭历史消息里的印象去调一个已不在清单里的技能 —— 只在提示词层收窄，
   * 白名单就形同虚设。这里拒绝掉，才算是硬边界。
   */
  const skillAllowed = (id: number | undefined) =>
    allowedSkillIds === undefined || (id != null && allowedSkillIds.includes(id));

  return async (name: string, args: Record<string, unknown>): Promise<string> => {
    if (name === 'search_transcript') {
      const query = String(args.query ?? '');
      const hits = await searchTranscript(courseId, query);
      if (hits.length === 0) return '未检索到相关字幕内容。';
      return hits.map((h) => `[${fmtTime(h.segment.start)}] ${h.segment.text}`).join('\n');
    }
    if (name === 'get_transcript_range') {
      const start = Number(args.start) || 0;
      const end = Number(args.end) || start + 60;
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
      const hits = await searchMaterial(courseId, query);
      if (hits.length === 0) return '未检索到相关材料内容。';
      return formatMaterialHits(hits, kind);
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
      const body = formatMaterialRange(rows, kind);
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
      return formatFrameList(rows);
    }
    if (name === 'use_skill') {
      const skillName = String(args.name ?? '');
      const skill = await db.skills.where('name').equals(skillName).first();
      if (!skill || !skill.enabled) return `未找到技能：${skillName}（名称需与技能列表完全一致）`;
      // 文案要指向「可选范围」而不是含糊的「不允许」：模型收到「未找到」会换个名字再试，
      // 收到「不在范围内」才知道该收手 —— 否则会白烧好几轮工具调用。
      if (!skillAllowed(skill.id)) {
        return `技能「${skillName}」不在本次会话的可选技能范围内。请改用系统提示词中列出的技能，或直接依据课程内容回答。`;
      }
      const refs = await db.skillRefs.where('skillId').equals(skill.id!).toArray();
      const refList =
        refs.length > 0
          ? `\n\n该技能附带的参考文档（用 read_skill_reference 读取）：\n${refs.map((r) => `- ${r.path}`).join('\n')}`
          : '';
      return skill.body + refList;
    }
    if (name === 'read_skill_reference') {
      const skillName = String(args.name ?? '');
      const path = String(args.path ?? '');
      const skill = await db.skills.where('name').equals(skillName).first();
      if (!skill) return `未找到技能：${skillName}`;
      // 边界与 use_skill 保持一致：它是 use_skill 的后续步骤，理论上不会绕过，
      // 但两处判定不一致就是一个可利用的漏洞口子。
      if (!skillAllowed(skill.id)) {
        return `技能「${skillName}」不在本次会话的可选技能范围内，无法读取其参考文档。`;
      }
      const ref = await db.skillRefs
        .where('skillId')
        .equals(skill.id!)
        .filter((r) => r.path === path)
        .first();
      if (!ref) return `技能「${skillName}」下未找到参考文档：${path}`;
      return ref.body;
    }
    if (name === 'present_quiz') {
      const v = validateQuiz(args);
      if (!v.ok) return `题卡结构校验失败：${v.error}。请修正后重新调用 present_quiz。`;
      onQuiz?.(v.quiz);
      return '题卡已展示给学生。请用一句话说明这些题考查的知识点，不要重复题目内容。';
    }
    return `未知工具：${name}`;
  };
}
