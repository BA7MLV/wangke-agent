import { useId, useState } from 'react';
import { Button, Checkbox, TextArea } from '@heroui/react';
import type { AskUserState } from '../store/db';
import { askOptions, validateAskAnswer, type AskUserAnswer } from '../harness/askUser';
import { Sym } from '../ui';
import './ask-cards.css';

interface Props {
  ask: AskUserState;
  active: boolean;
  restored?: boolean;
  onPick: (answer: AskUserAnswer) => Promise<void>;
}

export default function AskCard({ ask, active, restored, onPick }: Props) {
  const id = useId();
  const [selected, setSelected] = useState<string[]>([]);
  const [custom, setCustom] = useState(false);
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [showNote, setShowNote] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const answered = ask.picked != null;
  const actionable = active && !answered;
  const type = ask.type ?? 'single';
  const options = askOptions(ask);
  const freeText = type === 'text' || custom;
  const min = ask.minSelections ?? 1;
  const max = ask.maxSelections ?? options.length;

  async function submit(ids = selected, status: AskUserAnswer['status'] = 'answered') {
    if (busy) return;
    setError('');
    try {
      const answer = validateAskAnswer(ask, {
        status, mode: freeText ? type === 'text' ? 'text' : 'custom' : 'selection',
        selectedIds: ids, selectedLabels: [], text, note: showNote && !freeText ? note : '',
      });
      setBusy(true);
      await onPick(answer);
    } catch (e) {
      setError(e instanceof Error ? e.message : '提交失败，请重试');
    } finally {
      setBusy(false);
    }
  }

  const stateLabel = answered
    ? ask.answer?.status === 'skipped' ? '已跳过' : ask.answer?.status === 'declined' ? '暂不执行' : ask.answer?.status === 'cancelled' ? '已取消' : '已回答'
    : type === 'confirm' ? '请确认' : type === 'text' ? '需要你补充' : '请选择';

  return (
    <section className="ask-card" data-testid="ask-card" data-answered={answered ? 'true' : 'false'}
      data-active={actionable ? 'true' : undefined} data-restored={restored && !answered ? 'true' : undefined}
      aria-labelledby={`${id}-question`} aria-busy={busy}>
      <div className="ask-card__head">
        <Sym name={answered ? 'check' : 'help'} aria-hidden="true" />
        <span>{stateLabel}</span>
        {restored && !answered && <span className="ask-card__restored" data-testid="ask-restored"><Sym name="history" aria-hidden="true" />会话已恢复</span>}
      </div>
      <p className="ask-card__question" id={`${id}-question`}>{ask.question}</p>
      {actionable ? (
        <form onSubmit={e => { e.preventDefault(); void submit(); }}>
          <p className="ask-card__hint" role="status">{busy ? '正在提交…' : '等待你的回答'}{!freeText && type === 'multiple' ? ` · 可多选，选择 ${min === max ? min : `${min}–${max}`} 项` : ''}</p>
          {freeText ? (
            <TextArea aria-label="你的回答" value={text} onChange={e => setText(e.target.value)} rows={3} fullWidth disabled={busy} />
          ) : type === 'multiple' ? (
            <fieldset className="ask-card__options" disabled={busy} aria-labelledby={`${id}-question`}>
              {options.map(option => (
                <Checkbox key={option.id} className="ask-option" isSelected={selected.includes(option.id)}
                  isDisabled={busy || (selected.length >= max && !selected.includes(option.id))}
                  onChange={checked => { setSelected(prev => checked ? [...prev, option.id] : prev.filter(v => v !== option.id)); setError(''); }}>
                  <Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control><span className="ask-option__text">{option.label}</span></Checkbox.Content>
                </Checkbox>
              ))}
            </fieldset>
          ) : (
            <div className="ask-card__options" role="group" aria-label="选择一项直接继续">
              {options.map((option, index) => (
                <Button key={option.id} type="button" className="ask-option" variant="outline" isDisabled={busy} onPress={() => void submit([option.id])}>
                  <span className="ask-option__num" aria-hidden="true">{index + 1}</span>
                  <span className="ask-option__text">{option.label}</span>
                  <Sym name="arrow_upward" className="ask-option__mark" aria-hidden="true" />
                </Button>
              ))}
            </div>
          )}
          {showNote && !freeText && <TextArea className="ask-card__note" aria-label="补充说明（选填）" placeholder="补充说明（选填），会和选项一起提交" value={note} onChange={e => setNote(e.target.value)} fullWidth disabled={busy} />}
          {error && <p className="ask-card__error" role="alert">{error}</p>}
          <div className="ask-card__footer">
            {!freeText && <Button type="button" size="sm" variant="ghost" isDisabled={busy} onPress={() => setShowNote(v => !v)}>{showNote ? '收起补充' : '补充说明'}</Button>}
            {type !== 'text' && type !== 'confirm' && ask.allowCustom !== false && (
              <Button type="button" size="sm" variant="ghost" isDisabled={busy} onPress={() => { setCustom(v => !v); setError(''); }} data-testid="ask-custom">{custom ? '返回选项' : '自己回答'}</Button>
            )}
            {ask.allowSkip && <Button type="button" size="sm" variant="ghost" isDisabled={busy} onPress={() => void submit([], 'skipped')}>跳过</Button>}
            {(freeText || type === 'multiple') && <Button type="submit" size="sm" isDisabled={busy || (freeText ? !text.trim() : selected.length < min)}>提交{freeText ? '回答' : '选择'}</Button>}
            {!freeText && type !== 'multiple' && <span>选择一项即可继续</span>}
          </div>
        </form>
      ) : answered ? (
        <p className="ask-card__answer">{ask.picked}</p>
      ) : (
        <p className="ask-card__dead" data-testid="ask-card-expired">本次提问已结束，可在聊天框重新提问。</p>
      )}
    </section>
  );
}
