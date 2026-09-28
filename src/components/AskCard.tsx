import type { AskUserState } from '../store/db';
import './ask-cards.css';

/**
 * 助手提问卡：题面 + 2~5 个候选方案，点一下即作答。
 *
 * 三种形态由 `ask.picked` 与 `active` 共同决定：
 * - 待答 + 循环还活着：可点，点了立刻把答案喂回 agent 循环；
 * - 已答：锁死并高亮选中项（和 `QuizCard` 的答后形态同款，用户能一眼看到自己选了哪个）；
 * - 待答但循环已结束（刷新页面后从库里读回来的）：**不给能点的按钮**。
 *   一个点了没反应的选项比一句「本次会话已结束」糟糕得多 —— 它会让用户以为应用坏了。
 */
interface Props {
  ask: AskUserState;
  /** 本轮 agent 循环是否还活着（决定卡片可不可交互） */
  active: boolean;
  onPick: (option: string) => void;
  /** 「我自己说」：把输入框交给用户，本轮就以他打的字作为答案 */
  onCustom: () => void;
}

export default function AskCard({ ask, active, onPick, onCustom }: Props) {
  const picked = ask.picked;
  const answered = picked != null;
  const actionable = active && !answered;

  return (
    <div className="ask-card" data-testid="ask-card" data-answered={answered ? 'true' : 'false'}>
      <div className="ask-card__head">
        <mdui-sym-help aria-hidden="true" />
        <span>需要你定一下</span>
      </div>
      <p className="ask-card__question">{ask.question}</p>
      <div className="ask-card__options">
        {ask.options.map((option) => (
          <button
            key={option}
            type="button"
            className="ask-option"
            data-picked={option === picked ? 'true' : undefined}
            disabled={!actionable}
            onClick={() => onPick(option)}
          >
            {option}
            <span className="ask-option__mark" aria-hidden="true">
              {option === picked && <mdui-sym-check />}
            </span>
          </button>
        ))}
      </div>
      {/* 已作答就不给「我自己说」：循环已经带着你的选择往下走了，再摆一个改入口是骗人 */}
      {ask.allowCustom !== false && !answered && (
        <button
          type="button"
          className="ask-card__custom"
          disabled={!active}
          onClick={onCustom}
          data-testid="ask-custom"
        >
          <mdui-sym-edit aria-hidden="true" />
          这些都不对，我自己说
        </button>
      )}
      {!actionable && !answered && (
        <p className="ask-card__dead" data-testid="ask-card-expired">
          本次会话已结束，这张提问卡没法再作答。重新提问一次即可。
        </p>
      )}
    </div>
  );
}
