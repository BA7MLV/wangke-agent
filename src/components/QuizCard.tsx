import { useCallback, useMemo } from 'react';
import { XMarkdown, type ComponentProps } from '@ant-design/x-markdown';
import type { QuizData } from '../harness/quiz';
import { linkifyTimestamps, parseTs } from '../utils/linkify';
import { MarkdownCode, MarkdownPre } from './mermaid/markdown';

const LETTERS = ['A', 'B', 'C', 'D'];

/**
 * 解析里的 code / pre 与问答正文**共用**同一对替换组件：```mermaid 围栏由它们接管成图，
 * 普通代码块照旧。不在题卡里另造一套围栏解析 —— 「围栏判定 + `<pre>` 外壳剥离 + 未闭合挂起 +
 * 失败回退源码」这一串坑问答正文已经踩平了（见 components/mermaid/）。
 */
const MD_BLOCK_COMPONENTS = { code: MarkdownCode, pre: MarkdownPre };

interface Props {
  quiz: QuizData;
  /** 每题已选下标；-1 = 未作答 */
  picks: number[];
  onAnswer: (qIdx: number, optIdx: number) => void;
  onSeek?: (t: number) => void;
  /**
   * 解析里的 [mm:ss] 是否渲染成可点击跳转（默认是）。
   * 阅读材料没有播放器，必须传 false —— 否则模型万一在解析里写了时间戳，
   * 会变成一个点了没反应的死链（与 ChatPanel 材料模式不跑 linkifyTimestamps 是同一条理由）。
   */
  seekable?: boolean;
}

/**
 * 单选题答题卡：点选即判（本地判分），答后展开解析，全答完显示得分。
 *
 * 选项刻意保留**原生 `<button>`** 而不是换 `mdui-button`：
 * MD3 里这种「一行一个的可选项」在语义上更接近列表项，而 mdui-button 的形状（full 圆角胶囊）
 * 会让四个选项显得像四个并排的按钮、反而看不出是一组单选。保持原生标签 + MD3 令牌上色，
 * 既拿到设计语言的观感（surface 面层 / outline-variant 描边 / 令牌化的答对答错色），
 * 又不改变既有交互与 a11y。
 *
 * 解析（explanation）走 **XMarkdown + 共用围栏组件**：粗体/列表照常，```mermaid 围栏自动出图。
 * ⚠️ 已知限制：XMarkdown 依赖 DOMPurify，Node 环境（SSR / 单测）没有 window，它会直接不产出内容，
 * 所以「解析渲染」的契约由浏览器 e2e（scripts/e2e-quiz-mermaid.mjs）守着，单测只覆盖数据层。
 */
export default function QuizCard({ quiz, picks, onAnswer, onSeek, seekable = true }: Props) {
  const done = quiz.questions.every((_, i) => (picks[i] ?? -1) >= 0);
  const score = quiz.questions.reduce((s, q, i) => s + (picks[i] === q.answer ? 1 : 0), 0);

  /** 解析里的链接：#seek-秒 跳播放器（与正文同款 .quiz-ts 观感），其余按外链新窗口打开 */
  const ExplanationLink = useCallback(
    ({ href, children }: ComponentProps & { href?: string }) => {
      const h = href ?? '';
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
    () => ({ ...MD_BLOCK_COMPONENTS, a: ExplanationLink }),
    [ExplanationLink],
  );

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
              {q.time && onSeek && seekable && (
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
                    {/* 槽位常驻（未作答时是空的）：判定图标只能在作答那一刻出现，
                        否则行内宽度/行高会同时变化，被点的选项连同下面的选项一起跳一下。
                        详见 cards.css 的 .quiz-option__mark 注释。 */}
                    <span className="quiz-option__mark">
                      {isDone && isAnswer && <mdui-sym-check className="quiz-option__mark--ok" />}
                      {isDone && !isAnswer && isPick && (
                        <mdui-sym-close className="quiz-option__mark--bad" />
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
            {isDone && (
              <div className="quiz-explain" data-testid="quiz-explain">
                <span className={pick === q.answer ? 'quiz-result quiz-result--ok' : 'quiz-result quiz-result--bad'}>
                  {pick === q.answer ? '回答正确' : `正确答案：${LETTERS[q.answer]}`}
                </span>
                {/* 解析正文：与问答正文同一条渲染链路（XMarkdown）+ 时间戳链接化。
                    解析常常是「一句话 + 一张图」，所以独占一行而不是接在判定语后面的同行文本。 */}
                <div className="quiz-explain__md" data-testid="quiz-explain-md">
                  <XMarkdown
                    content={seekable ? linkifyTimestamps(q.explanation) : q.explanation}
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
          答对 {score}/{quiz.questions.length}
        </div>
      )}
    </div>
  );
}
