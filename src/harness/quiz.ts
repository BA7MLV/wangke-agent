/** 答题卡与普通 Markdown 题库共用的数据结构；无浏览器依赖。 */
import { parseMaterialImageHref } from '../materials/imageRefs.ts';
import { validateWidgetArgs } from './widget.ts';

export type AnswerSource = 'original' | 'verified' | 'ai' | 'missing';
export type QuestionType = 'single' | 'multiple' | 'boolean' | 'fill' | 'ordering' | 'matching' | 'freeform' | 'composite';
export type QuizAnswer = number | boolean | string | QuizAnswer[];
/** Old numeric picks remain readable. Only a student's explicit reference check sets selfGrade. */
export type QuizPick = number | { answer: QuizAnswer; selfGrade?: boolean };

export interface QuizQuestion {
  /** Omitted on legacy four-option single-choice cards. */
  type?: QuestionType;
  /** 原文题型，例如“证明题”“阅读理解”“作图题”。 */
  typeLabel?: string;
  /** 题干 */
  stem: string;
  /** Choice/order items; empty for open responses. Never invent extra options. */
  options: string[];
  answer: QuizAnswer;
  /** 填空的每空可接受答案；只做保守的首尾空白清理，不猜公式等价。 */
  acceptedAnswers?: string[][];
  blanks?: number;
  /** matching: 左列标签在 options，右列标签在 matches，answer 为逐项右列下标。 */
  matches?: string[];
  /** 组合题的独立小题；各自保留答案来源。 */
  parts?: QuizQuestion[];
  /** Optional custom input, using the existing HTML sandbox; no answer keys or write APIs. */
  presentation?: { html: string };
  /** 老题卡不设此字段；从原题整理的题库必须明确答案来源。 */
  answerSource?: AnswerSource;
  source?: { courseId: string; name?: string; page?: number };
  /** 只保存现有材料原图的稳定引用，不保存临时 blob URL 或模型生成图。 */
  images?: string[];
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
  /** Host-only provenance of this practice snapshot; no separate progress store. */
  bank?: { path: string; offset: number; total: number };
}

/** Tool transcripts are not saved: retain the cursor in the existing chat snapshot instead. */
export function quizHistoryContent(row: { content: string; quiz?: { data: QuizData; picks: QuizPick[] } }): string {
  const quiz = row.quiz;
  const bank = quiz?.data.bank;
  if (!quiz || !bank) return row.content;
  const count = quiz.data.questions.length;
  const answered = quiz.data.questions.filter((_, index) => isQuizAnswered(quiz.picks[index])).length;
  const next = bank.offset + count;
  return `${row.content}\n\n[题库练习快照：path=${bank.path}；offset=${bank.offset}；本批 ${count} 题，已作答 ${answered} 题；题库共 ${bank.total} 题。${next < bank.total ? `学生要求继续时调用相同 path、offset=${next}。` : '本批已到题库末尾。'}题库文件是唯一真相源，旧题卡不随文件修改而重算。]`;
}

export type QuizValidation = { ok: true; quiz: QuizData } | { ok: false; error: string };

const TIME_RE = /^\d{1,3}:\d{2}(:\d{2})?$/;

export const questionType = (q: QuizQuestion): QuestionType => q.type ?? 'single';
export const optionLetter = (index: number) => String.fromCharCode(65 + index);
export const isQuizAnswered = (pick: QuizPick | undefined): boolean => pick !== undefined && (typeof pick !== 'number' || pick >= 0);
export const quizPickAnswer = (pick: QuizPick): QuizAnswer => typeof pick === 'number' ? pick : pick.answer;
export function hasVerifiedQuizAnswer(q: QuizQuestion): boolean {
  return q.answerSource !== 'ai' && q.answerSource !== 'missing' && validQuizAnswer(q, q.answer) &&
    (questionType(q) !== 'composite' || !!q.parts?.every(hasVerifiedQuizAnswer));
}
export function canGradeQuizQuestion(q: QuizQuestion): boolean {
  return hasVerifiedQuizAnswer(q) && questionType(q) !== 'freeform' &&
    (questionType(q) !== 'composite' || !!q.parts?.every(canGradeQuizQuestion));
}
const text = (s: string) => s.replace(/\r\n/g, '\n').trim();
const indexIn = (v: unknown, length: number): v is number => Number.isInteger(v) && Number(v) >= 0 && Number(v) < length;
export function validQuizAnswer(q: QuizQuestion, answer: unknown): answer is QuizAnswer {
  switch (questionType(q)) {
    case 'single': return indexIn(answer, q.options.length);
    case 'boolean': return typeof answer === 'boolean';
    case 'multiple': return Array.isArray(answer) && answer.length > 0 && answer.length <= q.options.length &&
      answer.every((a) => indexIn(a, q.options.length)) && new Set(answer).size === answer.length;
    case 'ordering': return Array.isArray(answer) && answer.length === q.options.length &&
      answer.every((a) => indexIn(a, q.options.length)) && new Set(answer).size === answer.length;
    case 'matching': return Array.isArray(answer) && answer.length === q.options.length && answer.every((a) => indexIn(a, q.matches?.length ?? 0));
    case 'fill': return Array.isArray(answer) && answer.length === (q.blanks ?? (Array.isArray(q.answer) ? q.answer.length : q.acceptedAnswers?.length ?? 1)) &&
      answer.length > 0 && answer.length <= 50 && answer.every((a) => typeof a === 'string' && a.trim().length > 0 && a.length <= 16000);
    case 'freeform': return typeof answer === 'string' && answer.trim().length > 0 && answer.length <= 32000;
    case 'composite': return Array.isArray(answer) && answer.length === q.parts?.length && answer.every((a, i) => validQuizAnswer(q.parts![i], a));
  }
}
/** Undefined is pending/reference-only, never an incorrect answer. */
export function gradeQuizAnswer(q: QuizQuestion, answer: QuizAnswer): boolean | undefined {
  if (!canGradeQuizQuestion(q) || !validQuizAnswer(q, answer)) return undefined;
  switch (questionType(q)) {
    case 'multiple': return JSON.stringify([...(answer as number[])].sort((a, b) => a - b)) === JSON.stringify([...(q.answer as number[])].sort((a, b) => a - b));
    case 'fill': return (answer as string[]).every((a, i) => (q.acceptedAnswers?.[i] ?? [(q.answer as string[])[i]]).some((v) => text(v) === text(a)));
    case 'composite': return (answer as QuizAnswer[]).every((a, i) => gradeQuizAnswer(q.parts![i], a) === true);
    default: return JSON.stringify(answer) === JSON.stringify(q.answer);
  }
}
export function quizPickResult(q: QuizQuestion, pick: QuizPick | undefined): boolean | undefined {
  if (!isQuizAnswered(pick)) return;
  const result = gradeQuizAnswer(q, quizPickAnswer(pick!));
  if (result !== undefined) return result;
  if (hasVerifiedQuizAnswer(q) && typeof pick === 'object') return pick.selfGrade;
}
export function formatQuizAnswer(q: QuizQuestion, answer: QuizAnswer): string {
  switch (questionType(q)) {
    case 'single': return optionLetter(Number(answer));
    case 'boolean': return answer ? '正确' : '错误';
    case 'multiple': case 'ordering': return (answer as number[]).map(optionLetter).join(questionType(q) === 'ordering' ? ' → ' : '、');
    case 'matching': return (answer as number[]).map((a, i) => `${optionLetter(i)} → ${q.matches?.[a] ?? '?'}`).join('；');
    case 'fill': return (answer as string[]).map((a, i) => `（${i + 1}）${a}`).join('；');
    case 'composite': return (answer as QuizAnswer[]).map((a, i) => `（${i + 1}）${formatQuizAnswer(q.parts![i], a)}`).join('\n');
    default: return String(answer);
  }
}
/** Open a composite's references only after submission, including partially unverified subquestions. */
export function quizExplanation(q: QuizQuestion): string {
  return [q.explanation, ...(q.parts ?? []).map((part, i) => {
    const reference = part.answerSource === 'missing' ? '答案待补充' : `${part.answerSource === 'ai' ? 'AI 参考答案（待核验）' : '参考答案'}：${formatQuizAnswer(part, part.answer)}`;
    return `### 小题 ${i + 1}\n\n${part.stem}\n\n${reference}\n\n${quizExplanation(part)}`;
  })].join('\n\n');
}
/** Host must reject overwriting a submitted answer; only one explicit self-check may be added. */
export function canUpdateQuizPick(q: QuizQuestion, old: QuizPick | undefined, next: QuizPick): boolean {
  if (!isQuizAnswered(next) || !validQuizAnswer(q, quizPickAnswer(next))) return false;
  if (!isQuizAnswered(old)) return typeof next === 'number' || next.selfGrade === undefined;
  return !canGradeQuizQuestion(q) && hasVerifiedQuizAnswer(q) && typeof old === 'object' && old.selfGrade === undefined &&
    typeof next === 'object' && typeof next.selfGrade === 'boolean' && JSON.stringify(old.answer) === JSON.stringify(next.answer);
}

/** 校验并清洗模型输出的题卡参数；任何字段非法返回错误描述（供模型修正重试） */
export function validateQuiz(raw: unknown, maxQuestions = 5, depth = 0): QuizValidation {
  if (depth > 3) return { ok: false, error: '组合题最多嵌套 3 层' };
  const questions = (raw as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(questions) || questions.length === 0)
    return { ok: false, error: 'questions 必须是非空数组' };
  if (questions.length > maxQuestions) return { ok: false, error: `questions 最多 ${maxQuestions} 题` };

  const out: QuizQuestion[] = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i] as Record<string, unknown> | null;
    const where = `第 ${i + 1} 题`;

    const stem = typeof q?.stem === 'string' ? q.stem.trim() : '';
    if (!stem) return { ok: false, error: `${where}：stem（题干）不能为空` };

    const type = q?.type ?? 'single';
    if (typeof type !== 'string' || !['single', 'multiple', 'boolean', 'fill', 'ordering', 'matching', 'freeform', 'composite'].includes(type))
      return { ok: false, error: `${where}：未知 type；特殊题型用 freeform 或 composite，保留原文题型 typeLabel` };
    const needsOptions = ['single', 'multiple', 'ordering', 'matching'].includes(String(type));
    const options = Array.isArray(q?.options) ? q.options.map((o) => typeof o === 'string' ? o.trim() : '') : [];
    if (needsOptions && (options.length < 2 || options.length > 26 || options.some((o) => !o) || new Set(options).size !== options.length))
      return { ok: false, error: `${where}：options 需要 2~26 个不重复、非空的原文选项` };
    if (!needsOptions && q?.options !== undefined && (!Array.isArray(q.options) || q.options.length))
      return { ok: false, error: `${where}：此题型不需要 options，请省略或传 []` };

    const answerSource = q?.answerSource as AnswerSource | undefined;
    if (answerSource !== undefined && !['original', 'verified', 'ai', 'missing'].includes(answerSource))
      return { ok: false, error: `${where}：answerSource 必须是 original、verified、ai 或 missing` };
    const answer = q?.answer;
    const blanks = q?.blanks;
    if (blanks !== undefined && (type !== 'fill' || !Number.isInteger(blanks) || Number(blanks) < 1 || Number(blanks) > 50))
      return { ok: false, error: `${where}：blanks 仅用于 fill，须为 1~50 整数` };
    let parts: QuizQuestion[] | undefined;
    if (type === 'composite') {
      const result = validateQuiz({ questions: q?.parts }, 50, depth + 1);
      if (!result.ok) return { ok: false, error: `${where} parts：${result.error}` };
      parts = result.quiz.questions;
    } else if (q?.parts !== undefined) return { ok: false, error: `${where}：只有 composite 能包含 parts` };
    let matches: string[] | undefined;
    if (type === 'matching') {
      if (!Array.isArray(q?.matches) || q.matches.length < 2 || q.matches.length > 26 || q.matches.some((m) => typeof m !== 'string' || !m.trim()))
        return { ok: false, error: `${where}：matching 需要 2~26 个非空 matches 右列标签` };
      matches = q.matches.map((m: string) => m.trim());
    }
    let acceptedAnswers: string[][] | undefined;
    if (q?.acceptedAnswers !== undefined) {
      if (type !== 'fill' || !Array.isArray(q.acceptedAnswers) || !q.acceptedAnswers.length || q.acceptedAnswers.length > 50 ||
        q.acceptedAnswers.some((a) => !Array.isArray(a) || !a.length || a.length > 20 || a.some((s) => typeof s !== 'string' || !s.trim() || s.length > 16000)))
        return { ok: false, error: `${where}：acceptedAnswers 只能为填空的每空非空字符串数组` };
      acceptedAnswers = q.acceptedAnswers.map((a: string[]) => a.map(text));
    }
    const shape = { type, options, answer, parts, matches, acceptedAnswers, blanks } as QuizQuestion;
    if (answerSource === 'missing' ? answer !== -1 : !validQuizAnswer(shape, answer))
      return { ok: false, error: `${where}：${answerSource === 'missing' ? 'missing 的 answer 必须是 -1；多空题用 blanks 标明空数' : 'answer 与题型不符（单选下标、多选/排序/配对下标数组、判断布尔值、填空字符串数组、主观题参考文字、组合题逐小题答案数组）'}` };
    if (type === 'composite' && answerSource !== 'missing' && JSON.stringify(answer) !== JSON.stringify(parts!.map((p) => p.answer)))
      return { ok: false, error: `${where}：组合题 answer 必须与 parts 每题答案一致，避免两份答案冲突` };
    if (acceptedAnswers && ((answerSource !== 'missing' && (answer as string[]).some((a, i) => !acceptedAnswers![i]?.some((v) => text(v) === text(a)))) ||
      (Array.isArray(answer) && acceptedAnswers.length !== answer.length)))
      return { ok: false, error: `${where}：acceptedAnswers 必须与空数一致并包含每空标准答案` };
    let presentation: QuizQuestion['presentation'];
    if (q?.presentation !== undefined) {
      const html = (q.presentation as { html?: unknown } | null)?.html;
      const result = validateWidgetArgs({ format: 'html', code: html });
      if (!result.ok) return { ok: false, error: `${where} HTML：${result.error}` };
      presentation = { html: result.args.code };
    }

    const explanation = typeof q?.explanation === 'string' ? q.explanation.trim() : '';
    if (!explanation) return { ok: false, error: `${where}：explanation（解析）不能为空` };

    const rawTime = typeof q?.time === 'string' ? q.time.trim() : '';
    const time = TIME_RE.test(rawTime) ? rawTime : undefined;

    let source: QuizQuestion['source'];
    if (q?.source !== undefined) {
      const s = q.source as QuizQuestion['source'];
      if (!s || typeof s.courseId !== 'string' || !s.courseId.trim() ||
        (s.name !== undefined && typeof s.name !== 'string') ||
        (s.page !== undefined && (!Number.isSafeInteger(s.page) || s.page < 1)))
        return { ok: false, error: `${where}：source 必须包含真实 courseId，page 为正整数` };
      source = { courseId: s.courseId, ...(s.name !== undefined ? { name: s.name } : {}), ...(s.page !== undefined ? { page: s.page } : {}) };
    }
    let images: string[] | undefined;
    if (q?.images !== undefined) {
      if (!Array.isArray(q.images) || q.images.length > 10 || q.images.some((image) =>
        typeof image !== 'string' || !parseMaterialImageHref(image)))
        return { ok: false, error: `${where}：images 只能包含材料图片目录返回的原图引用（最多 10 张）` };
      images = [...new Set(q.images as string[])];
      if (source && images.some((image) => parseMaterialImageHref(image)!.courseId !== source.courseId))
        return { ok: false, error: `${where}：原图必须来自题目的来源材料` };
    }
    out.push({ stem, options, answer: answer as QuizAnswer, explanation, ...(time ? { time } : {}),
      ...(q?.type !== undefined ? { type: type as QuestionType } : {}),
      ...(typeof q?.typeLabel === 'string' ? { typeLabel: q.typeLabel.trim().slice(0, 100) } : {}),
      ...(parts ? { parts } : {}), ...(matches ? { matches } : {}), ...(acceptedAnswers ? { acceptedAnswers } : {}), ...(presentation ? { presentation } : {}),
      ...(blanks !== undefined ? { blanks: Number(blanks) } : {}),
      ...(answerSource ? { answerSource } : {}), ...(source ? { source } : {}), ...(images ? { images } : {}) });
  }
  return { ok: true, quiz: { questions: out } };
}

/** A bank is an ordinary editable material, not a question table or an executable HTML page. */
export function parseQuestionBank(markdown: string): QuizData {
  const openings = markdown.match(/^```quiz[ \t]*\r?$/gm) ?? [];
  const blocks = [...markdown.matchAll(/^```quiz[ \t]*\r?\n([\s\S]*?)^```[ \t]*\r?$/gm)];
  if (!blocks.length || blocks.length !== openings.length) throw new Error('题库需要完整的 ```quiz JSON 数据块；未闭合或缺失，未展示题卡。');
  const questions: QuizQuestion[] = [];
  for (const block of blocks) {
    let raw: unknown;
    try { raw = JSON.parse(block[1]); } catch { throw new Error('题库数据块不是有效 JSON，请先用 edit 修正原文件。'); }
    const result = validateQuiz(raw, 2000);
    if (!result.ok) throw new Error(`题库格式无效：${result.error}`);
    const hasProvenance = (q: QuizQuestion): boolean => !!q.source && !!q.answerSource && (!q.parts || q.parts.every(hasProvenance));
    if (result.quiz.questions.some((q) => !hasProvenance(q)))
      throw new Error('原题题库必须为每题记录 source 和 answerSource；缺失时不能冒充已核验答案。');
    questions.push(...result.quiz.questions);
  }
  return { questions };
}
