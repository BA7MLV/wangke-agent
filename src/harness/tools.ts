import type { ToolDef } from '../api/siliconflow';
import { db } from '../store/db';
import { fmtTime } from '../utils/vtt';
import { formatFrameList } from '../utils/linkify';
import { validateQuiz, type QuizData } from './quiz';
import { searchTranscript } from './search';

/** 问答 Agent 的工具集（JSON schema） */
export const QA_TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'search_transcript',
      description: '在课程字幕中语义检索与问题最相关的片段，返回带时间戳的字幕内容',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索关键词或问题' },
        },
        required: ['query'],
      },
    },
  },
  {
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
  },
  {
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
  },
  {
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
  },
  {
    type: 'function',
    function: {
      name: 'present_quiz',
      description:
        '当用户要求出题、测验或"考考我"时调用，把单选题展示为可作答的交互题卡。调用前必须先用 search_transcript 检索相关字幕，题目必须基于字幕实际讲到的内容。',
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
                  description: '解析：正确项为什么对、干扰项为什么错；引用课程内容时带 [mm:ss] 时间戳',
                },
                time: { type: 'string', description: '考点对应的字幕时间戳，mm:ss 或 h:mm:ss' },
              },
              required: ['stem', 'options', 'answer', 'explanation'],
            },
          },
        },
        required: ['questions'],
      },
    },
  },
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

/** 构造绑定到某个视频的工具执行器；onQuiz：present_quiz 校验通过后的题卡透传回调 */
export function createToolExecutor(videoId: string, onQuiz?: (quiz: QuizData) => void) {
  return async (name: string, args: Record<string, unknown>): Promise<string> => {
    if (name === 'search_transcript') {
      const query = String(args.query ?? '');
      const hits = await searchTranscript(videoId, query);
      if (hits.length === 0) return '未检索到相关字幕内容。';
      return hits.map((h) => `[${fmtTime(h.segment.start)}] ${h.segment.text}`).join('\n');
    }
    if (name === 'get_transcript_range') {
      const start = Number(args.start) || 0;
      const end = Number(args.end) || start + 60;
      const rows = await db.segments
        .where('videoId')
        .equals(videoId)
        .filter((r) => r.status === 1 && !!r.text && r.end >= start && r.start <= end)
        .sortBy('idx');
      if (rows.length === 0) return '该时间范围内没有字幕内容。';
      return rows.map((r) => `[${fmtTime(r.start)}] ${r.text}`).join('\n');
    }
    if (name === 'list_frames') {
      const rows = await db.frames
        .where('videoId')
        .equals(videoId)
        .filter((r) => r.kind === 'slide')
        .sortBy('ts');
      return formatFrameList(rows);
    }
    if (name === 'use_skill') {
      const skillName = String(args.name ?? '');
      const skill = await db.skills.where('name').equals(skillName).first();
      if (!skill || !skill.enabled) return `未找到技能：${skillName}（名称需与技能列表完全一致）`;
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
