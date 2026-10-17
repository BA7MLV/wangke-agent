import type { AskUserState } from '../store/db';
import { Sym } from '../ui';
import './ask-cards.css';

interface Props {
  ask: AskUserState;
  /** 只有输入区的待答问题可操作；消息流中的卡片仅展示记录。 */
  active: boolean;
  restored?: boolean;
  onPick: (option: string) => void;
  onCustom?: () => void;
}

export default function AskCard({ ask, active, restored, onPick, onCustom }: Props) {
  const answered = ask.picked != null;
  const actionable = active && !answered;

  return (
    <section
      className="ask-card"
      data-testid="ask-card"
      data-answered={answered ? 'true' : 'false'}
      data-active={actionable ? 'true' : undefined}
      data-restored={restored && !answered ? 'true' : undefined}
      aria-label={actionable ? '等待你的回答' : '确认记录'}
    >
      <div className="ask-card__head">
        <Sym name={answered ? 'check' : 'help'} aria-hidden="true" />
        <span>{answered ? '已确认' : '向你确认'}</span>
        {restored && !answered && (
          <span className="ask-card__restored" data-testid="ask-restored">
            <Sym name="history" aria-hidden="true" />会话已恢复
          </span>
        )}
      </div>
      <p className="ask-card__question">{ask.question}</p>
      {actionable ? (
        <>
          <div className="ask-card__options" role="group" aria-label="选择一项直接继续">
            {ask.options.map((option, index) => (
              <button key={option} type="button" className="ask-option" onClick={() => onPick(option)}>
                <span className="ask-option__num" aria-hidden="true">{index + 1}</span>
                <span className="ask-option__text">{option}</span>
                <Sym name="arrow_upward" className="ask-option__mark" aria-hidden="true" />
              </button>
            ))}
          </div>
          <div className="ask-card__footer">
            <span>选择一项即可继续{ask.allowCustom !== false ? '，也可以在下方补充' : ''}</span>
            {ask.allowCustom !== false && (
              <button type="button" className="ask-card__custom" onClick={onCustom} data-testid="ask-custom">
                <Sym name="edit" aria-hidden="true" />自己回答
              </button>
            )}
          </div>
        </>
      ) : answered ? (
        <p className="ask-card__answer">{ask.picked}</p>
      ) : (
        <p className="ask-card__dead" data-testid="ask-card-expired">本次确认已结束，可在聊天框重新提问。</p>
      )}
    </section>
  );
}
