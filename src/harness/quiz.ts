/** 答题卡（单选题）数据结构 + 校验。纯模块无运行时依赖，Node 下可直接单测。 */

export interface QuizQuestion {
  /** 题干 */
  stem: string;
  /** 4 个选项（不含 "A." 前缀，由渲染层生成） */
  options: string[];
  /** 正确选项下标 0~3 */
  answer: number;
  /**
   * 解析。渲染层按 Markdown 处理（bold/列表/代码块），并可含：
   * - `[mm:ss]` 时间戳（视频课程，渲染成可点击跳转；材料场景不 linkify）
   * - ` ```mermaid ` 围栏 —— 由 components/mermaid/ 渲染成图（流程/结构/对比/关系类解析）
   */
  explanation: string;
  /** 考点对应的字幕时间戳（mm:ss 或 h:mm:ss），可选 */
  time?: string;
}

export interface QuizData {
  questions: QuizQuestion[];
}

export type QuizValidation = { ok: true; quiz: QuizData } | { ok: false; error: string };

const TIME_RE = /^\d{1,3}:\d{2}(:\d{2})?$/;

/** 校验并清洗模型输出的题卡参数；任何字段非法返回错误描述（供模型修正重试） */
export function validateQuiz(raw: unknown): QuizValidation {
  const questions = (raw as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(questions) || questions.length === 0)
    return { ok: false, error: 'questions 必须是非空数组' };
  if (questions.length > 5) return { ok: false, error: 'questions 最多 5 题' };

  const out: QuizQuestion[] = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i] as Record<string, unknown> | null;
    const where = `第 ${i + 1} 题`;

    const stem = typeof q?.stem === 'string' ? q.stem.trim() : '';
    if (!stem) return { ok: false, error: `${where}：stem（题干）不能为空` };

    if (!Array.isArray(q?.options) || q.options.length !== 4)
      return { ok: false, error: `${where}：options 必须恰好 4 个选项` };
    const options = q.options.map((o) => (typeof o === 'string' ? o.trim() : ''));
    if (options.some((o) => !o)) return { ok: false, error: `${where}：选项不能为空` };
    if (new Set(options).size !== 4) return { ok: false, error: `${where}：选项不能重复` };

    const answer = q?.answer;
    if (typeof answer !== 'number' || !Number.isInteger(answer) || answer < 0 || answer > 3)
      return { ok: false, error: `${where}：answer 必须是 0~3 的整数下标` };

    const explanation = typeof q?.explanation === 'string' ? q.explanation.trim() : '';
    if (!explanation) return { ok: false, error: `${where}：explanation（解析）不能为空` };

    const rawTime = typeof q?.time === 'string' ? q.time.trim() : '';
    const time = TIME_RE.test(rawTime) ? rawTime : undefined;

    out.push({ stem, options, answer, explanation, ...(time ? { time } : {}) });
  }
  return { ok: true, quiz: { questions: out } };
}
