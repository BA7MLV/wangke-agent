import { useMemo } from 'react';
import type { QuizData } from '../harness/quiz';
import { parseTs } from '../utils/linkify';

const LETTERS = ['A', 'B', 'C', 'D'];
const TS_RE = /\[(\d{1,3}:\d{2}(?::\d{2})?)\]/g;

/** 解析文本：把 [mm:ss] 渲染为可点击跳转，其余原样 */
function ExplanationText({ text, onSeek }: { text: string; onSeek?: (t: number) => void }) {
  const parts = useMemo(() => {
    const out: { str: string; ts?: number }[] = [];
    let last = 0;
    for (const m of text.matchAll(TS_RE)) {
      if (m.index > last) out.push({ str: text.slice(last, m.index) });
      out.push({ str: m[0], ts: parseTs(m[1]) });
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push({ str: text.slice(last) });
    return out;
  }, [text]);
  return (
    <>
      {parts.map((p, i) =>
        p.ts != null && onSeek ? (
          <a key={i} className="quiz-ts" onClick={() => onSeek(p.ts!)}>
            {p.str}
          </a>
        ) : (
          <span key={i}>{p.str}</span>
        ),
      )}
    </>
  );
}

interface Props {
  quiz: QuizData;
  /** 每题已选下标；-1 = 未作答 */
  picks: number[];
  onAnswer: (qIdx: number, optIdx: number) => void;
  onSeek?: (t: number) => void;
}

/**
 * 单选题答题卡：点选即判（本地判分），答后展开解析，全答完显示得分。
 *
 * 选项刻意保留**原生 `<button>`** 而不是换 `mdui-button`：
 * MD3 里这种「一行一个的可选项」在语义上更接近列表项，而 mdui-button 的形状（full 圆角胶囊）
 * 会让四个选项显得像四个并排的按钮、反而看不出是一组单选。保持原生标签 + MD3 令牌上色，
 * 既拿到设计语言的观感（surface 面层 / outline-variant 描边 / 令牌化的答对答错色），
 * 又不改变既有交互与 a11y。
 */
export default function QuizCard({ quiz, picks, onAnswer, onSeek }: Props) {
  const done = quiz.questions.every((_, i) => (picks[i] ?? -1) >= 0);
  const score = quiz.questions.reduce((s, q, i) => s + (picks[i] === q.answer ? 1 : 0), 0);

  return (
    <div data-testid="quiz-card" className="quiz-card">
      {quiz.questions.map((q, qi) => {
        const pick = picks[qi] ?? -1;
        const isDone = pick >= 0;
        return (
          <div key={qi} className="quiz-q">
            <div className="quiz-stem">
              {quiz.questions.length > 1 ? `${qi + 1}. ` : ''}
              {q.stem}
              {q.time && onSeek && (
                <a className="quiz-ts quiz-ts--stem" onClick={() => onSeek(parseTs(q.time!))}>
                  [{q.time}]
                </a>
              )}
            </div>
            <div className="quiz-options">
              {q.options.map((opt, oi) => {
                const isAnswer = oi === q.answer;
                const isPick = oi === pick;
                // 三种状态：答对（绿）/ 错选（红）/ 已答但与此项无关（压暗）
                const state = !isDone
                  ? ''
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
                    onClick={() => onAnswer(qi, oi)}
                  >
                    <b className="quiz-option__letter">{LETTERS[oi]}.</b>
                    {opt}
                    {isDone && isAnswer && <mdui-sym-check className="quiz-option__mark quiz-option__mark--ok" />}
                    {isDone && !isAnswer && isPick && (
                      <mdui-sym-close className="quiz-option__mark quiz-option__mark--bad" />
                    )}
                  </button>
                );
              })}
            </div>
            {isDone && (
              <div className="quiz-explain" data-testid="quiz-explain">
                <span className={pick === q.answer ? 'quiz-result quiz-result--ok' : 'quiz-result quiz-result--bad'}>
                  {pick === q.answer ? '回答正确' : `正确答案：${LETTERS[q.answer]}`}
                </span>
                {' · '}
                <ExplanationText text={q.explanation} onSeek={onSeek} />
              </div>
            )}
          </div>
        );
      })}
      {done && (
        <div className="quiz-score">
          答对 {score}/{quiz.questions.length}
        </div>
      )}
    </div>
  );
}
