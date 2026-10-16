import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { AskUserState } from '../store/db';
import { Sym } from '../ui';
import './ask-cards.css';

/**
 * 助手提问卡：题面 + 2~5 个候选方案，点一下即作答。
 *
 * 四种形态由 `ask.picked`、`active` 与 `restored` 共同决定：
 * - 待答 + 循环还活着：可点，点了立刻把答案喂回 agent 循环；
 * - 待答但**从断点恢复**（刷新后重新武装）：照样可点，且顶部明说「会话已恢复」——
 *   用户得知道这张卡为什么突然又能点了（见 docs/plans/2026-10-16-ask-user-resume-design.md）；
 * - 已答：锁死并高亮选中项（和 `QuizCard` 的答后形态同款，用户能一眼看到自己选了哪个）；
 * - 待答但循环真的结束了（中断 / 旧数据没有检查点）：**不给能点的按钮**，
 *   一个点了没反应的选项比一句「本次会话已结束」糟糕得多。
 *
 * 作答有两条路，都在本卡内（不再把视线甩到下面的输入框）：
 * 1. 点候选方案，或按 `1`~`5` 的数字键；
 * 2. 「这些都不对，我自己说」→ 卡内展开一个输入框，回车提交。
 * 输入框里打字时数字键不当作快选（那时用户在自己说话）。
 */
interface Props {
  ask: AskUserState;
  /** 这张卡此刻能不能作答（循环活着 or 已恢复） */
  active: boolean;
  /** 从库里的挂起点恢复（刷新后）—— 决定显不显示「会话已恢复」 */
  restored?: boolean;
  onPick: (option: string) => void;
}

export default function AskCard({ ask, active, restored, onPick }: Props) {
  const picked = ask.picked;
  const answered = picked != null;
  const actionable = active && !answered;
  const [customOpen, setCustomOpen] = useState(false);
  const [customText, setCustomText] = useState('');
  const customRef = useRef<HTMLInputElement | null>(null);

  // 展开「我自己说」就把焦点交给输入框：用户点那颗按钮的意图就是马上打字
  useEffect(() => {
    if (customOpen) customRef.current?.focus();
  }, [customOpen]);

  const submitCustom = () => {
    const value = customText.trim();
    if (!value || !actionable) return;
    onPick(value);
  };

  /** 数字键快选：`1`~`5` 对应选项下标。卡片任意位置都能按，输入框除外 */
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!actionable) return;
    const tag = (event.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const index = Number(event.key) - 1;
    if (Number.isInteger(index) && index >= 0 && index < ask.options.length) {
      event.preventDefault();
      onPick(ask.options[index]);
    }
  };

  return (
    <div
      className="ask-card"
      data-testid="ask-card"
      data-answered={answered ? 'true' : 'false'}
      data-restored={restored && !answered ? 'true' : undefined}
      onKeyDown={onKeyDown}
    >
      <div className="ask-card__head">
        <Sym name="help" aria-hidden="true" />
        <span>需要你定一下</span>
        {restored && !answered && (
          <span className="ask-card__restored" data-testid="ask-restored">
            <Sym name="history" aria-hidden="true" />
            会话已恢复
          </span>
        )}
      </div>
      <p className="ask-card__question">{ask.question}</p>
      <div className="ask-card__options" role="radiogroup" aria-label="候选方案">
        {ask.options.map((option, index) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={option === picked}
            className="ask-option"
            data-picked={option === picked ? 'true' : undefined}
            disabled={!actionable}
            onClick={() => onPick(option)}
          >
            <span className="ask-option__num" aria-hidden="true">
              {index + 1}
            </span>
            <span className="ask-option__text">{option}</span>
            <span className="ask-option__mark" aria-hidden="true">
              {option === picked && <Sym name="check" />}
            </span>
          </button>
        ))}
      </div>
      {/* 已作答就不给「我自己说」：循环已经带着你的选择往下走了，再摆一个改入口是骗人 */}
      {ask.allowCustom !== false &&
        !answered &&
        (customOpen ? (
          <div className="ask-card__custom-input">
            <input
              ref={customRef}
              type="text"
              className="ask-card__input"
              placeholder="说说你的想法…"
              value={customText}
              disabled={!active}
              data-testid="ask-custom-input"
              onChange={(event) => setCustomText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  submitCustom();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  setCustomOpen(false);
                }
              }}
            />
            <button
              type="button"
              className="ask-card__custom-send"
              aria-label="用这句话作答"
              disabled={!active || !customText.trim()}
              onClick={submitCustom}
              data-testid="ask-custom-send"
            >
              <Sym name="send" />
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="ask-card__custom"
            disabled={!active}
            onClick={() => setCustomOpen(true)}
            data-testid="ask-custom"
          >
            <Sym name="edit" aria-hidden="true" />
            这些都不对，我自己说
          </button>
        ))}
      {!actionable && !answered && (
        <p className="ask-card__dead" data-testid="ask-card-expired">
          本次会话已结束，这张提问卡没法再作答。重新提问一次即可。
        </p>
      )}
    </div>
  );
}
