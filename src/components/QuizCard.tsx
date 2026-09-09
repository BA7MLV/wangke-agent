import { useMemo } from 'react';
import { CheckOutlined, CloseOutlined } from '@ant-design/icons';
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
          <a
            key={i}
            onClick={() => onSeek(p.ts!)}
            style={{ cursor: 'pointer', fontVariantNumeric: 'tabular-nums' }}
          >
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

/** 单选题答题卡：点选即判（本地判分），答后展开解析，全答完显示得分 */
export default function QuizCard({ quiz, picks, onAnswer, onSeek }: Props) {
  const done = quiz.questions.every((_, i) => (picks[i] ?? -1) >= 0);
  const score = quiz.questions.reduce((s, q, i) => s + (picks[i] === q.answer ? 1 : 0), 0);

  return (
    <div
      data-testid="quiz-card"
      style={{ border: '1px solid #f0f0f0', borderRadius: 8, padding: 12, marginTop: 8, background: '#fafafa' }}
    >
      {quiz.questions.map((q, qi) => {
        const pick = picks[qi] ?? -1;
        const isDone = pick >= 0;
        return (
          <div key={qi} style={{ marginBottom: qi < quiz.questions.length - 1 ? 16 : 0 }}>
            <div style={{ fontWeight: 500, marginBottom: 8, lineHeight: 1.6 }}>
              {quiz.questions.length > 1 ? `${qi + 1}. ` : ''}
              {q.stem}
              {q.time && onSeek && (
                <a
                  onClick={() => onSeek(parseTs(q.time!))}
                  style={{
                    cursor: 'pointer',
                    marginLeft: 6,
                    fontSize: 12,
                    fontWeight: 400,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  [{q.time}]
                </a>
              )}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {q.options.map((opt, oi) => {
                const isAnswer = oi === q.answer;
                const isPick = oi === pick;
                let bg = '#fff';
                let border = '#d9d9d9';
                let icon: React.ReactNode = null;
                if (isDone && isAnswer) {
                  bg = '#f6ffed';
                  border = '#52c41a';
                  icon = <CheckOutlined style={{ color: '#52c41a', marginLeft: 6 }} />;
                } else if (isDone && isPick) {
                  bg = '#fff2f0';
                  border = '#ff4d4f';
                  icon = <CloseOutlined style={{ color: '#ff4d4f', marginLeft: 6 }} />;
                }
                return (
                  <button
                    key={oi}
                    type="button"
                    disabled={isDone}
                    onClick={() => onAnswer(qi, oi)}
                    style={{
                      minHeight: 40,
                      textAlign: 'left',
                      padding: '8px 12px',
                      borderRadius: 6,
                      border: `1px solid ${border}`,
                      background: bg,
                      cursor: isDone ? 'default' : 'pointer',
                      opacity: isDone && !isAnswer && !isPick ? 0.55 : 1,
                      fontSize: 14,
                      lineHeight: 1.5,
                    }}
                  >
                    <b style={{ marginRight: 6 }}>{LETTERS[oi]}.</b>
                    {opt}
                    {icon}
                  </button>
                );
              })}
            </div>
            {isDone && (
              <div style={{ marginTop: 6, fontSize: 12, color: '#666', lineHeight: 1.6 }}>
                <span style={{ color: pick === q.answer ? '#52c41a' : '#ff4d4f', fontWeight: 500 }}>
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
        <div
          style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed #e8e8e8', fontSize: 12, color: '#888' }}
        >
          答对 {score}/{quiz.questions.length}
        </div>
      )}
    </div>
  );
}
