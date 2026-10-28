import { useCallback, useMemo, useRef, useState } from 'react';
import { Button } from '@heroui/react';
import { useQuestionTimer } from '../study/useQuestionTimer';
import type { Attempt, QuestionSource } from '../study/wrongbook';
import { uuid } from '../utils/uuid';
import type { ComponentProps } from '@ant-design/x-markdown';
import { Markdown as XMarkdown } from './markdown/Markdown';
import { canGradeQuizQuestion, canUpdateQuizPick, formatQuizAnswer, gradeQuizAnswer, hasVerifiedQuizAnswer, isQuizAnswered, optionLetter,
  questionType, quizExplanation, quizPickAnswer, quizPickResult, validQuizAnswer, type QuizAnswer, type QuizData, type QuizPick } from '../harness/quiz';
import QuestionInput, { emptyQuizAnswer } from './QuestionInput';
import { MaterialImage, SourceImage } from './MaterialImage';
import { materialSourceHref } from '../materials/imageRefs';
import { linkifyTimestamps, parseTs } from '../utils/linkify';
import { MarkdownCode, MarkdownPre } from './mermaid/markdown';
import { MarkdownTable } from './MdTable';
import { NumberPop } from './motion';
import { Sym } from '../ui';


/**
 * 解析里的 code / pre 与问答正文**共用**同一对替换组件：```mermaid 围栏由它们接管成图，
 * 普通代码块照旧。不在题卡里另造一套围栏解析 —— 「围栏判定 + `<pre>` 外壳剥离 + 未闭合挂起 +
 * 失败回退源码」这一串坑问答正文已经踩平了（见 components/mermaid/）。
 */
const MD_BLOCK_COMPONENTS = { code: MarkdownCode, pre: MarkdownPre, table: MarkdownTable };

interface Props {
  quiz: QuizData;
  /** Legacy numeric picks or typed answers; -1 = 未作答. */
  picks: QuizPick[];
  onAnswer: (qIdx: number, pick: QuizPick) => void;
  onSeek?: (t: number) => void;
  /**
   * 解析里的 [mm:ss] 是否渲染成可点击跳转（默认是）。
   * 阅读材料没有播放器，必须传 false —— 否则模型万一在解析里写了时间戳，
   * 会变成一个点了没反应的死链（与 ChatPanel 材料模式不跑 linkifyTimestamps 是同一条理由）。
   */
  seekable?: boolean;
  /** Only local course cards opt in; live guest answers never enter the host notebook. */
  notebookSource?: QuestionSource;
  onAttempt?: (qIdx: number, pick: QuizPick, durationSeconds: number) => void;
  onReview?: (text: string) => void;
}

/**
 * 多题型答题卡：旧单选点选即判，其他题型先填草稿再提交；开放题参考核对与自评独立于自动成绩。
 *
 * 选项刻意保留**原生 `<button>`** 而不是换 `Button`：
 * MD3 里这种「一行一个的可选项」在语义上更接近列表项，而按钮组件的形状（full 圆角胶囊）
 * 会让四个选项显得像四个并排的按钮、反而看不出是一组单选。保持原生标签 + MD3 令牌上色，
 * 既拿到设计语言的观感（surface 面层 / outline-variant 描边 / 令牌化的答对答错色），
 * 又不改变既有交互与 a11y。
 *
 * 解析（explanation）走 **XMarkdown + 共用围栏组件**：粗体/列表照常，```mermaid 围栏自动出图。
 * ⚠️ 已知限制：XMarkdown 依赖 DOMPurify，Node 环境（SSR / 单测）没有 window，它会直接不产出内容，
 * 所以「解析渲染」的契约由浏览器 e2e（scripts/e2e-quiz-mermaid.mjs）守着，单测只覆盖数据层。
 */
export default function QuizCard({ quiz, picks, onAnswer, onSeek, seekable = true, notebookSource, onAttempt, onReview }: Props) {
  const { root, finish } = useQuestionTimer(picks);
  const answered = useRef(new Set<number>());
  const [saveErrors, setSaveErrors] = useState<Record<number, string>>({});
  const [collected, setCollected] = useState<Set<number>>(() => new Set());
  const [drafts, setDrafts] = useState<Record<number, QuizAnswer>>({});
  const durations = useRef(new Map<number, number>());
  const pending = useRef(new Map<number, Attempt>());
  const saveAttempt = async (qi: number, attempt: Attempt) => {
    if (!notebookSource) return;
    try {
      const { recordWrongbookAttempt } = await import('../store/wrongbook');
      await recordWrongbookAttempt(quiz.questions[qi], quiz.questions[qi].source ?? notebookSource, attempt);
      pending.current.delete(qi);
      if (!attempt.correct) setCollected((old) => new Set([...old, qi]));
      setSaveErrors((old) => { const next = { ...old }; delete next[qi]; return next; });
    } catch (error) {
      setSaveErrors((old) => ({ ...old, [qi]: `错题记录保存失败：${error instanceof Error ? error.message : '请重试'}` }));
    }
  };
  const answer = (qi: number, pick: QuizPick) => {
    const q = quiz.questions[qi];
    if (!canUpdateQuizPick(q, picks[qi], pick) || answered.current.has(qi)) return;
    answered.current.add(qi);
    const durationSeconds = durations.current.get(qi) ?? finish(qi);
    durations.current.set(qi, durationSeconds);
    onAnswer(qi, pick);
    onAttempt?.(qi, pick, durationSeconds);
    const correct = quizPickResult(q, pick);
    if (notebookSource && correct !== undefined) {
      const attempt: Attempt = { id: uuid(), at: new Date().toISOString(), answer: quizPickAnswer(pick), correct,
        durationSeconds, rating: correct ? 3 : 1, ...(!canGradeQuizQuestion(q) ? { grading: 'self' as const } : {}) };
      pending.current.set(qi, attempt);
      void saveAttempt(qi, attempt);
    }
    // Open responses may subsequently receive one explicit self-check, without re-submitting the answer.
    if (!canGradeQuizQuestion(q) && typeof pick === 'object' && pick.selfGrade === undefined) answered.current.delete(qi);
  };
  const done = quiz.questions.every((_, i) => isQuizAnswered(picks[i]));
  const gradableCount = quiz.questions.filter(canGradeQuizQuestion).length;
  const score = quiz.questions.reduce((s, q, i) => s + (canGradeQuizQuestion(q) && isQuizAnswered(picks[i]) && gradeQuizAnswer(q, quizPickAnswer(picks[i])) === true ? 1 : 0), 0);

  /** 解析里的链接：#seek-秒 跳播放器（与正文同款 .quiz-ts 观感），其余按外链新窗口打开 */
  const ExplanationLink = useCallback(
    ({ href, children }: ComponentProps & { href?: string }) => {
      const h = href ?? '';
      if (h.startsWith('#source-image/')) return <MaterialImage href={h} label={children} linkOnly />;
      if (h.startsWith('#seek-') && onSeek) {
        const secs = Number(h.slice(6));
        return (
          <a
            className="quiz-ts"
            onClick={(e) => {
              e.preventDefault();
              onSeek(secs);
            }}
          >
            {children}
          </a>
        );
      }
      return (
        <a href={h} target="_blank" rel="noreferrer">
          {children}
        </a>
      );
    },
    [onSeek],
  );

  // 合并对象要 memo：XMarkdown 的 components 参与内部 useMemo，每次都换新对象会让它整段重新解析
  const mdComponents = useMemo(
    () => ({ ...MD_BLOCK_COMPONENTS, a: ExplanationLink, img: SourceImage }),
    [ExplanationLink],
  );

  return (
    <div ref={root} data-testid="quiz-card" className="quiz-card">
      {quiz.questions.map((q, qi) => {
        const pick = picks[qi] ?? -1;
        const isDone = isQuizAnswered(pick);
        const gradable = canGradeQuizQuestion(q);
        const verified = hasVerifiedQuizAnswer(q);
        const result = quizPickResult(q, pick);
        const simple = questionType(q) === 'single' && !q.presentation;
        const draft = drafts[qi] ?? (isDone ? quizPickAnswer(pick) : emptyQuizAnswer(q));
        return (
          <div key={qi} className="quiz-q" data-question-index={qi}>
            <div className="quiz-stem">
              {!q.source && quiz.questions.length > 1 ? `${qi + 1}. ` : ''}
              {q.source ? <XMarkdown content={q.stem} components={mdComponents} /> : q.stem}
              {q.time && onSeek && seekable && (
                <a className="quiz-ts quiz-ts--stem" onClick={() => onSeek(parseTs(q.time!))}>
                  [{q.time}]
                </a>
              )}
            </div>
            {q.source && <p className="quiz-source">
              <a href={materialSourceHref(q.source.courseId, q.source.page)}>
                {q.source.name ?? '原题来源'}{q.source.page ? ` · 第 ${q.source.page} 页` : ''}
              </a>
            </p>}
            {q.images?.map((image) => <div className="quiz-image" key={image}><MaterialImage href={image} label="原题画面（含题干或选项图）" /></div>)}
            {q.typeLabel && <p className="quiz-source">{q.typeLabel}</p>}
            {!gradable && <p className="quiz-source" role="note">{verified ? '主观或组合题：提交后对照参考答案自行核对，不计入自动判分。' : `${q.answerSource === 'ai' ? 'AI 参考答案，尚未核验' : '原题尚无可核验答案'}；可以作答，但不计分、不记为错题。`}</p>}
            {simple ? <div className="quiz-options">
              {q.options.map((opt, oi) => {
                const isAnswer = oi === q.answer;
                const isPick = oi === pick;
                // 待核验题只显示中性的选中态，不能暗示对错。
                const state = !isDone
                  ? ''
                  : !gradable
                    ? isPick ? ' quiz-option--selected' : ' quiz-option--muted'
                    : isAnswer
                      ? ' quiz-option--correct'
                      : isPick
                        ? ' quiz-option--wrong'
                        : ' quiz-option--muted';
                return (
                  <button
                    key={oi}
                    type="button"
                    className={`quiz-option${state}`}
                    disabled={isDone}
                    aria-pressed={isPick}
                    onClick={() => answer(qi, oi)}
                  >
                    <b className="quiz-option__letter">{optionLetter(oi)}.</b>
                    {opt}
                    {/* 槽位常驻（未作答时是空的）：判定图标只能在作答那一刻出现，
                        否则行内宽度/行高会同时变化，被点的选项连同下面的选项一起跳一下。
                        详见 cards.css 的 .quiz-option__mark 注释。 */}
                    <span className="quiz-option__mark">
                      {isDone && gradable && isAnswer && <Sym name="check" className="quiz-option__mark--ok" />}
                      {isDone && gradable && !isAnswer && isPick && (
                        <Sym name="close" className="quiz-option__mark--bad" />
                      )}
                    </span>
                  </button>
                );
              })}
            </div> : <>
              <QuestionInput question={q} value={draft} disabled={isDone} onChange={(value) => setDrafts((old) => ({ ...old, [qi]: value }))} />
              {!isDone && <Button size="sm" isDisabled={!validQuizAnswer(q, draft)} onPress={() => answer(qi, { answer: draft })}>提交答案</Button>}
            </>}
            {collected.has(qi) && <p className="mt-2 text-sm text-muted">已记录到 <a className="underline" href="#/player/wrongbook.md">/wrongbook.md</a>。</p>}
            {saveErrors[qi] && (
              <div role="alert" className="mt-2 text-sm text-danger">
                {saveErrors[qi]}
                <Button size="sm" variant="tertiary" onPress={() => {
                  const attempt = pending.current.get(qi);
                  if (attempt) void saveAttempt(qi, attempt);
                }}>重试保存</Button>
              </div>
            )}
            {isDone && (
              <div className="quiz-explain" data-testid="quiz-explain">
                <span className={result === undefined ? 'quiz-result' : result ? 'quiz-result quiz-result--ok' : 'quiz-result quiz-result--bad'}>
                  {!gradable ? (verified ? result === undefined ? '已作答，请对照参考答案核对' : `自评：${result ? '已掌握' : '需复习'}（非自动判分）` : q.answerSource === 'ai' ? `已作答；AI 参考答案：${formatQuizAnswer(q, q.answer)}（待核验）` : '已作答，待补充答案后批改') : result ? '回答正确' : `正确答案：${formatQuizAnswer(q, q.answer)}`}
                </span>
                {!simple && <p className="quiz-response">我的作答：{formatQuizAnswer(q, quizPickAnswer(pick))}</p>}
                {verified && !gradable && <>
                  <XMarkdown content={`参考答案：\n\n${formatQuizAnswer(q, q.answer)}`} components={mdComponents} />
                  {typeof pick === 'object' && pick.selfGrade === undefined && <div className="quiz-self-check" role="group" aria-label="核对参考答案">
                    <Button size="sm" variant="secondary" onPress={() => answer(qi, { answer: pick.answer, selfGrade: true })}>我已核对：答对了</Button>
                    <Button size="sm" variant="secondary" onPress={() => answer(qi, { answer: pick.answer, selfGrade: false })}>我已核对：需复习</Button>
                  </div>}
                </>}
                {!gradable && onReview && <Button size="sm" variant="tertiary" onPress={() => onReview(`请对这道题提供 AI 参考批改：检查我的作答、指出遗漏，给出参考评分和改进建议。明确这是 AI 建议，不是确定判分；不要修改题库答案、成绩或直接写入错题本。若原题信息不足先说明。\n\n${JSON.stringify({
                  stem: q.stem, type: q.type, options: q.options, matches: q.matches, parts: q.parts?.map(({ presentation: _html, ...part }) => part), source: q.source,
                  answerSource: q.answerSource, referenceAnswer: q.answer, explanation: q.explanation, myAnswer: quizPickAnswer(pick),
                })}`)}>请求 AI 参考批改（发送消息）</Button>}
                {/* 解析正文：与问答正文同一条渲染链路（XMarkdown）+ 时间戳链接化。
                    解析常常是「一句话 + 一张图」，所以独占一行而不是接在判定语后面的同行文本。 */}
                <div className="quiz-explain__md" data-testid="quiz-explain-md">
                  <XMarkdown
                    content={seekable ? linkifyTimestamps(quizExplanation(q)) : quizExplanation(q)}
                    components={mdComponents}
                  />
                </div>
              </div>
            )}
          </div>
        );
      })}
      {done && (
        <div className="quiz-score">
          {/* number-pop-in：每答一题分数变一次，逐位重新入场。
               注意 digits 只包数字本身，单位（「答对」/「/」/总数）留在外面。 */}
          {gradableCount > 0 ? <>答对 <NumberPop text={score} />/{gradableCount}</> : '本批已作答'}
          {gradableCount < quiz.questions.length && `；另 ${quiz.questions.length - gradableCount} 题待核验或自评，未计入成绩`}
        </div>
      )}
    </div>
  );
}
