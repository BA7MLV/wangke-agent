import { createEmptyCard, fsrs, Rating, type Card, type Grade } from 'ts-fsrs';
import type { QuizAnswer, QuizQuestion } from '../harness/quiz';
import { canGradeQuizQuestion, formatQuizAnswer, gradeQuizAnswer, hasVerifiedQuizAnswer, optionLetter, questionType, validQuizAnswer, validateQuiz } from '../harness/quiz';

export { Rating };
export type ReviewRating = Grade;
export interface QuestionSource { courseId: string; name?: string; page?: number }
export interface Attempt {
  id: string;
  at: string;
  answer: QuizAnswer;
  /** 主观题只有学生明确核对后才可记为错题；与自动判分严格区分。 */
  grading?: 'self';
  correct: boolean;
  durationSeconds: number;
  rating: ReviewRating;
}
type StoredCard = Omit<Card, 'due' | 'last_review'> & { due: string; last_review?: string };
export interface WrongQuestion {
  version: 1;
  id: string;
  question: QuizQuestion;
  source: QuestionSource;
  status: 'reviewing' | 'mastered';
  card: StoredCard;
  attempts: Attempt[];
}

export const EMPTY_WRONGBOOK = '# 错题本\n\n<!-- wrongbook:v2 -->\n\n题目、解析和作答记录可以直接编辑。请保留注释标记，FSRS 用它们安排复习。\n';
const scheduler = fsrs({ enable_fuzz: false });
const blockPattern = () => /^```wrongbook-question\r?\n([\s\S]*?)\r?\n```[ \t]*(?=\r?$)/gm;
const dateValid = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const nonnegative = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Fail closed: a damaged block must never be silently skipped and overwritten. */
function validateEntry(raw: unknown): asserts raw is WrongQuestion {
  if (!object(raw) || raw.version !== 1 || typeof raw.id !== 'string' || !raw.id ||
      !object(raw.question) || !object(raw.source) || typeof raw.source.courseId !== 'string' ||
      !['reviewing', 'mastered'].includes(String(raw.status)) || !object(raw.card) || !Array.isArray(raw.attempts))
    throw new Error('错题档案结构无效，请检查数据块，原文件未被修改。');
  const q = raw.question;
  if (!validateQuiz({ questions: [q] }).ok || !hasVerifiedQuizAnswer(q as unknown as QuizQuestion))
    throw new Error('未核验的参考答案不能写入错题记录。');
  if ((q.time !== undefined && typeof q.time !== 'string') ||
      (raw.source.name !== undefined && typeof raw.source.name !== 'string') ||
      (raw.source.page !== undefined && (!Number.isInteger(raw.source.page) || Number(raw.source.page) < 1)))
    throw new Error('错题的题干、选项、答案或来源无效。');
  const c = raw.card;
  if (!dateValid(c.due) || (c.last_review !== undefined && !dateValid(c.last_review)) ||
      ![0, 1, 2, 3].includes(Number(c.state)) || typeof c.state !== 'number' ||
      !['stability', 'difficulty', 'elapsed_days', 'scheduled_days', 'learning_steps', 'reps', 'lapses'].every((k) => nonnegative(c[k])) ||
      Number(c.difficulty) > 10 ||
      !['learning_steps', 'reps', 'lapses'].every((k) => Number.isInteger(c[k])))
    throw new Error('FSRS 调度数据无效。');
  const ids = new Set<string>();
  let previous = -Infinity;
  for (const a of raw.attempts) {
    if (!object(a) || typeof a.id !== 'string' || !a.id || ids.has(a.id) || !dateValid(a.at) ||
        Date.parse(a.at) < previous || !validQuizAnswer(q as unknown as QuizQuestion, a.answer) ||
        typeof a.correct !== 'boolean' ||
        (canGradeQuizQuestion(q as unknown as QuizQuestion) ? a.grading !== undefined || a.correct !== gradeQuizAnswer(q as unknown as QuizQuestion, a.answer as QuizAnswer) : a.grading !== 'self') || !nonnegative(a.durationSeconds) ||
        ![Rating.Again, Rating.Hard, Rating.Good, Rating.Easy].includes(a.rating as Grade) ||
        (a.correct ? a.rating === Rating.Again : a.rating !== Rating.Again))
      throw new Error('作答记录无效或重复。');
    ids.add(a.id);
    previous = Date.parse(a.at);
  }
}

function parseLegacyWrongbook(markdown: string): WrongQuestion[] {
  if (!markdown.includes('<!-- wrongbook:v1 -->')) throw new Error('不是支持的错题本 Markdown（缺少版本标记）。');
  const entries: WrongQuestion[] = [];
  const ids = new Set<string>();
  const blocks = [...markdown.matchAll(blockPattern())];
  if ((markdown.match(/^```wrongbook-question\b/gm)?.length ?? 0) !== blocks.length)
    throw new Error('错题数据块未闭合。');
  for (const match of blocks) {
    let entry: unknown;
    try { entry = JSON.parse(match[1]); } catch { throw new Error('错题数据块不是有效的 JSON。'); }
    validateEntry(entry);
    if (ids.has(entry.id)) throw new Error(`题目 ID 重复：${entry.id}`);
    ids.add(entry.id);
    entries.push(entry);
  }
  return entries;
}

const markdownBlocks = () => /^<!-- wrongbook:question (.+) -->\r?\n([\s\S]*?)^<!-- \/wrongbook:question -->[ \t]*(?=\r?$)/gm;
const labels = ['重来', '困难', '良好', '简单'];
const letters = Array.from({ length: 26 }, (_, i) => optionLetter(i));
const jsonBlock = (value: unknown) => '```json\n' + JSON.stringify(value, null, 2) + '\n```';
function parseJsonBlock(content: string): unknown {
  const match = /^```json\r?\n([\s\S]*)\r?\n```$/.exec(content.trim());
  if (!match) throw new Error('此题型的数据需保留完整 json 围栏。');
  try { return JSON.parse(match[1]); } catch { throw new Error('题型或作答记录不是有效 JSON。'); }
}
const sectionPattern = (key: string) => new RegExp(`^<!-- wrongbook:${key} -->\\r?\\n([\\s\\S]*?)\\r?\\n<!-- /wrongbook:${key} -->[ \\t]*(?=\\r?$)`, 'gm');
function section(body: string, key: string): string {
  const matches = [...body.matchAll(sectionPattern(key))];
  if (matches.length !== 1 ||
      (body.match(new RegExp(`^<!-- wrongbook:${key} -->`, 'gm'))?.length ?? 0) !== 1 ||
      (body.match(new RegExp(`^<!-- /wrongbook:${key} -->`, 'gm'))?.length ?? 0) !== 1)
    throw new Error(`错题的 ${key} 区域缺失或重复，请保留 Markdown 注释标记。`);
  return matches[0][1];
}
const wrapSection = (key: string, content: string) => `<!-- wrongbook:${key} -->\n${content}\n<!-- /wrongbook:${key} -->`;

function contentOf(entry: WrongQuestion) {
  const rich = questionType(entry.question) !== 'single';
  return {
    stem: entry.question.stem,
    options: rich ? jsonBlock({ options: entry.question.options, matches: entry.question.matches, parts: entry.question.parts, acceptedAnswers: entry.question.acceptedAnswers, blanks: entry.question.blanks }) : entry.question.options.map((o, i) => `- ${letters[i]}. ${o.replace(/\n/g, '\n  ')}`).join('\n'),
    answer: rich ? jsonBlock(entry.question.answer) : formatQuizAnswer(entry.question, entry.question.answer),
    explanation: entry.question.explanation,
    plan: `状态：${entry.status === 'mastered' ? '已掌握' : '复习中'}\n下次复习：${entry.card.due}`,
    attempts: rich ? jsonBlock(entry.attempts) : ['| 时间 | 答案 | 结果 | 用时（秒） | 反馈 |', '| --- | --- | --- | --- | --- |',
      ...entry.attempts.map((a) => `| ${a.at} | ${formatQuizAnswer(entry.question, a.answer)} | ${a.correct ? '正确' : '错误'} | ${a.durationSeconds} | ${labels[a.rating - 1]} |`)].join('\n'),
  };
}
function metadata(entry: WrongQuestion): string {
  const { due: _due, ...card } = entry.card;
  // Escape '<' so names containing '-->' cannot terminate the HTML comment.
  return JSON.stringify({ version: 2, id: entry.id, source: entry.source, card,
    time: entry.question.time, images: entry.question.images, answerSource: entry.question.answerSource, questionSource: entry.question.source,
    type: entry.question.type, typeLabel: entry.question.typeLabel, presentation: entry.question.presentation,
    attemptIds: entry.attempts.map((a) => a.id) }).replace(/</g, '\\u003c').replace(/-->/g, '--\\u003e');
}
function renderQuestion(entry: WrongQuestion): string {
  const c = contentOf(entry);
  for (const text of [c.stem, c.options, c.answer, c.attempts, c.explanation]) {
    if (/<!--\s*\/?wrongbook:/.test(text)) throw new Error('题目正文包含错题本保留的注释标记，请先修改该标记。');
  }
  const source = (entry.source.name ?? entry.source.courseId).replace(/[\r\n]/g, ' ');
  return `<!-- wrongbook:question ${metadata(entry)} -->\n## 错题\n\n### 题目\n\n${wrapSection('stem', c.stem)}\n\n### 选项\n\n${wrapSection('options', c.options)}\n\n### 正确答案\n\n${wrapSection('answer', c.answer)}\n\n### 解析\n\n${wrapSection('explanation', c.explanation)}\n\n### 来源\n\n${source}${entry.source.page ? ` · 第 ${entry.source.page} 页` : ''}\n\n### 复习计划\n\n${wrapSection('plan', c.plan)}\n\n### 作答记录\n\n${wrapSection('attempts', c.attempts)}\n<!-- /wrongbook:question -->`;
}

function parseMarkdownQuestion(json: string, body: string): WrongQuestion {
  body = body.replace(/\r\n/g, '\n');
  let meta: Record<string, unknown>;
  try { meta = JSON.parse(json); } catch { throw new Error('FSRS 注释不是有效的 JSON。'); }
  if (!object(meta) || meta.version !== 2 || !object(meta.card) || !Array.isArray(meta.attemptIds))
    throw new Error('FSRS 注释结构无效。');
  const optionsText = section(body, 'options');
  const rich = meta.type !== undefined && meta.type !== 'single';
  const specs = rich ? parseJsonBlock(optionsText) : undefined;
  if (rich && !object(specs)) throw new Error('题型数据需要 JSON 对象。');
  const starts = rich ? [] : [...optionsText.matchAll(/^- ([A-Z])\. /gm)];
  if (!rich && (starts.length < 2 || starts.length > 26 || starts.some((m, i) => m[1] !== letters[i]))) throw new Error('选项需按 - A.、- B. 顺序排列（2~26 项）。');
  const options = rich ? (specs as Record<string, unknown>).options : starts.map((m, i) => optionsText.slice(m.index! + m[0].length, starts[i + 1]?.index ?? optionsText.length).trimEnd().replace(/\n  /g, '\n'));
  const plan = section(body, 'plan').replace(/\r\n/g, '\n');
  const status = /^状态：(复习中|已掌握)$/m.exec(plan)?.[1];
  const due = /^下次复习：(.+)$/m.exec(plan)?.[1];
  if (!status || !due) throw new Error('复习计划缺少状态或下次复习时间。');
  const rows = rich ? [] : section(body, 'attempts').split(/\r?\n/).filter((line) => line.trim());
  if (!rich && (rows.length < 2 || !/^\|\s*时间\s*\|/.test(rows[0]) || !/^\|[\s:|\-]+\|$/.test(rows[1]) || rows.length - 2 !== meta.attemptIds.length))
    throw new Error('作答记录表格与作答 ID 不一致，请勿删除表头或 FSRS 注释中的 ID。');
  const attempts = rich ? parseJsonBlock(section(body, 'attempts')) : rows.slice(2).map((line, i) => {
    const cells = line.split('|').map((v) => v.trim());
    if (cells.length !== 7 || cells[0] || cells[6] || !['正确', '错误'].includes(cells[3]) || !cells[4])
      throw new Error('作答记录表格格式无效。');
    return { id: (meta.attemptIds as string[])[i], at: cells[1], answer: letters.indexOf(cells[2]), correct: cells[3] === '正确',
      durationSeconds: Number(cells[4]), rating: (labels.indexOf(cells[5]) + 1) as ReviewRating };
  });
  if (rich && (!Array.isArray(attempts) || JSON.stringify(attempts.map((a) => a?.id)) !== JSON.stringify(meta.attemptIds))) throw new Error('作答 ID 与元数据不一致。');
  const entry = { version: 1, id: meta.id, source: meta.source, status: status === '已掌握' ? 'mastered' : 'reviewing',
    question: { ...(object(specs) ? specs : {}), stem: section(body, 'stem'), options,
      answer: rich ? parseJsonBlock(section(body, 'answer')) : letters.indexOf(section(body, 'answer').trim()),
      explanation: section(body, 'explanation'), ...(meta.time !== undefined ? { time: meta.time } : {}),
       ...(meta.images !== undefined ? { images: meta.images } : {}), ...(meta.answerSource !== undefined ? { answerSource: meta.answerSource } : {}),
       ...(meta.questionSource !== undefined ? { source: meta.questionSource } : {}),
       ...(meta.type !== undefined ? { type: meta.type } : {}), ...(meta.typeLabel !== undefined ? { typeLabel: meta.typeLabel } : {}),
       ...(meta.presentation !== undefined ? { presentation: meta.presentation } : {}) },
    card: { ...meta.card, due }, attempts };
  validateEntry(entry);
  return entry;
}

export function parseWrongbook(markdown: string): WrongQuestion[] {
  if (markdown.includes('<!-- wrongbook:v1 -->') && !markdown.includes('<!-- wrongbook:v2 -->')) return parseLegacyWrongbook(markdown);
  if (!markdown.includes('<!-- wrongbook:v2 -->')) throw new Error('不是支持的错题本 Markdown（缺少版本标记）。');
  if (/^```wrongbook-question\b/m.test(markdown)) throw new Error('错题本混有旧版数据块，请先迁移。');
  const blocks = [...markdown.matchAll(markdownBlocks())];
  if ((markdown.match(/^<!-- wrongbook:question\b/gm)?.length ?? 0) !== blocks.length ||
      (markdown.match(/^<!-- \/wrongbook:question -->/gm)?.length ?? 0) !== blocks.length)
    throw new Error('错题的起止注释缺失，原文件未被修改。');
  const entries = blocks.map((m) => parseMarkdownQuestion(m[1], m[2]));
  if (new Set(entries.map((e) => e.id)).size !== entries.length) throw new Error('题目 ID 重复。');
  return entries;
}

/** Convert old JSON blocks in place; unrelated notes and the complete review history survive. */
export function migrateWrongbook(markdown: string): string {
  const entries = parseWrongbook(markdown);
  if (markdown.includes('<!-- wrongbook:v2 -->')) return markdown;
  const byId = new Map(entries.map((e) => [e.id, e]));
  return markdown.replace('<!-- wrongbook:v1 -->', '<!-- wrongbook:v2 -->')
    .replace(blockPattern(), (_block, json: string) => renderQuestion(byId.get((JSON.parse(json) as WrongQuestion).id)!));
}

export function writeQuestion(markdown: string, entry: WrongQuestion): string {
  validateEntry(entry);
  markdown = migrateWrongbook(markdown);
  const existing = parseWrongbook(markdown);
  if (!existing.some((e) => e.id === entry.id)) return markdown.trimEnd() + `\n\n${renderQuestion(entry)}\n`;
  const content = contentOf(entry);
  return markdown.replace(markdownBlocks(), (original, json: string, body: string) => {
    if ((JSON.parse(json) as { id: string }).id !== entry.id) return original;
    // Replace only managed spans: handwritten notes anywhere outside them remain untouched.
    for (const key of Object.keys(content) as (keyof typeof content)[]) {
      if (section(body, key) !== content[key]) body = body.replace(sectionPattern(key), () => wrapSection(key, content[key]));
    }
    return `<!-- wrongbook:question ${metadata(entry)} -->\n${body}<!-- /wrongbook:question -->`;
  });
}

export async function questionId(question: QuizQuestion, source: QuestionSource): Promise<string> {
  // Explanation changes do not create another copy of the same source question.
  const identity: unknown[] = [source.courseId, source.page ?? null, question.stem.trim(), question.options.map((o) => o.trim()), question.answer];
  const partIdentity = (q: QuizQuestion): unknown => [q.stem.trim(), q.options, q.answer, questionType(q), q.matches ?? null, q.parts?.map(partIdentity) ?? null];
  if (questionType(question) !== 'single') identity.push(questionType(question), question.matches ?? null, question.parts?.map(partIdentity) ?? null);
  const key = JSON.stringify(identity);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return 'q-' + Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function applyAttempt(entry: WrongQuestion | undefined, id: string, question: QuizQuestion,
  source: QuestionSource, attempt: Attempt): WrongQuestion | undefined {
  if (!entry && attempt.correct) return undefined; // Only errors enter the notebook.
  if (entry?.attempts.some((a) => a.id === attempt.id)) return entry;
  const now = new Date(attempt.at);
  if (!Number.isFinite(now.getTime()) || (entry?.card.last_review && now < new Date(entry.card.last_review)))
    throw new Error('作答时间早于最近复习，请检查设备时间后重试。');
  const card = entry ? { ...entry.card, due: new Date(entry.card.due),
    last_review: entry.card.last_review ? new Date(entry.card.last_review) : undefined } : createEmptyCard(now);
  const next = scheduler.next(card, now, attempt.rating).card;
  const result: WrongQuestion = {
    version: 1, id, question: entry?.question ?? question, source: entry?.source ?? source,
    status: 'reviewing',
    card: { ...next, due: next.due.toISOString(), last_review: next.last_review?.toISOString() },
    attempts: [...(entry?.attempts ?? []), attempt],
  };
  validateEntry(result);
  return result;
}

export function dueQuestions(entries: WrongQuestion[], now = new Date()): WrongQuestion[] {
  return entries.filter((e) => e.status === 'reviewing' && Date.parse(e.card.due) <= now.getTime())
    .sort((a, b) => Date.parse(a.card.due) - Date.parse(b.card.due));
}
