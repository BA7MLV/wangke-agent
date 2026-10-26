import { useEffect, useId, useRef, useState } from 'react';
import { Button, Checkbox, Modal, TextArea } from '@heroui/react';
import type { AskUserState } from '../store/db';
import { askAnswerText, askOptions, normalizeAskDraft, validateAskAnswer, type AskUserAnswer } from '../harness/askUser';
import { MODAL_CONTAINER_CLASS, Sym, useResolvedDark } from '../ui';
import { useSettings } from '../store/settings';
import WidgetBlock from './WidgetBlock';
import './ask-cards.css';

interface Props {
  ask: AskUserState;
  active: boolean;
  restored?: boolean;
  messageKey?: string;
  onPick: (answer: AskUserAnswer) => Promise<void>;
}

export default function AskCard({ ask, active, restored, messageKey, onPick }: Props) {
  const id = useId();
  const dark = useResolvedDark(useSettings(s => s.theme));
  const [selected, setSelected] = useState<string[]>([]);
  const [custom, setCustom] = useState(false);
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [showNote, setShowNote] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState<AskUserAnswer | null>(null);
  const receipt = useRef<{ resolve: () => void; reject: (error: Error) => void } | null>(null);
  const submitting = useRef(false);
  const answered = ask.picked != null;
  const actionable = active && !answered;
  const type = ask.type ?? 'single';
  const options = askOptions(ask);
  const freeText = type === 'text' || custom;
  const min = ask.minSelections ?? 1;
  const max = ask.maxSelections ?? options.length;
  const draft: AskUserAnswer = ask.answer ?? { status: 'answered', mode: freeText ? type === 'text' ? 'text' : 'custom' : 'selection',
    selectedIds: selected, selectedLabels: [], text, note: showNote && !freeText ? note : '' };

  useEffect(() => {
    if (!actionable) {
      receipt.current?.reject(new Error('本次提问已结束'));
      receipt.current = null;
      setConfirmation(null);
    }
  }, [actionable]);
  useEffect(() => () => {
    receipt.current?.reject(new Error('提问页面已关闭'));
    receipt.current = null;
  }, []);
  useEffect(() => {
    if (!confirmation) return;
    // Expire before the sandbox request timeout: a stale dialog cannot submit later.
    const timer = window.setTimeout(() => {
      if (submitting.current) return;
      receipt.current?.reject(new Error('确认已超时，请重新选择并提交'));
      receipt.current = null; setConfirmation(null);
    }, 280_000);
    return () => window.clearTimeout(timer);
  }, [confirmation]);

  function applyDraft(raw: unknown) {
    if (!actionable || submitting.current || receipt.current) throw new Error('当前不能修改作答');
    const answer = normalizeAskDraft(ask, raw);
    if (answer.status === 'cancelled' || answer.status === 'skipped') throw new Error('请在原生题卡中跳过或取消');
    setSelected(answer.selectedIds); setText(answer.text); setNote(answer.note);
    setCustom(answer.mode === 'custom'); setShowNote(!!answer.note); setError('');
    return answer;
  }

  function requestSubmit(raw: unknown): Promise<void> {
    const answer = validateAskAnswer(ask, raw as AskUserAnswer);
    applyDraft(answer);
    return new Promise((resolve, reject) => {
      receipt.current = { resolve, reject };
      setConfirmation(answer);
    });
  }

  function cancelVisual() {
    if (submitting.current) return;
    receipt.current?.reject(new Error('用户取消了提交，可继续修改'));
    receipt.current = null;
    setConfirmation(null);
  }

  async function confirmVisual() {
    if (!actionable || !confirmation || submitting.current || !receipt.current) return;
    const pending = receipt.current;
    receipt.current = null;
    submitting.current = true; setBusy(true);
    try {
      await onPick(validateAskAnswer(ask, confirmation));
      pending.resolve();
    } catch (reason) {
      const error = reason instanceof Error ? reason : new Error('提交失败');
      setError(error.message); pending.reject(error);
    } finally {
      if (receipt.current === pending) receipt.current = null;
      submitting.current = false; setBusy(false); setConfirmation(null);
    }
  }

  async function submit(ids = selected, status: AskUserAnswer['status'] = 'answered') {
    if (submitting.current || receipt.current) return;
    setError('');
    try {
      const answer = validateAskAnswer(ask, {
        status, mode: freeText ? type === 'text' ? 'text' : 'custom' : 'selection',
        selectedIds: ids, selectedLabels: [], text, note: showNote && !freeText ? note : '',
      });
      submitting.current = true; setBusy(true);
      await onPick(answer);
    } catch (e) {
      setError(e instanceof Error ? e.message : '提交失败，请重试');
    } finally {
      submitting.current = false; setBusy(false);
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
      {ask.presentation && (actionable || answered) && <>
        <WidgetBlock payload={{ html: ask.presentation.html }} dark={dark} readingKey={messageKey}
          allowPopout={false} disabled={!actionable || busy} answerInput={{ answer: draft, submitted: !actionable,
            question: { question: ask.question, type, options, allowCustom: ask.allowCustom, minSelections: min, maxSelections: max },
            onDraft: applyDraft, onSubmit: requestSubmit }} />
        {actionable && <p className="ask-card__hint">图形无法使用时，请直接使用下方标准作答。未提交草稿刷新后不保留。</p>}
      </>}
      {confirmation && actionable && <Modal.Root isOpen onOpenChange={open => { if (!open) cancelVisual(); }}>
        <Modal.Backdrop><Modal.Container placement="center" size="sm" className={MODAL_CONTAINER_CLASS}>
          <Modal.Dialog data-testid="ask-visual-confirm">
            <Modal.Header><Modal.Heading>确认提交回答</Modal.Heading></Modal.Header>
            <Modal.Body><p>{ask.question}</p><p className="whitespace-pre-wrap">{askAnswerText(confirmation)}</p></Modal.Body>
            <Modal.Footer><Button variant="tertiary" isDisabled={busy} onPress={cancelVisual}>继续修改</Button>
              <Button isDisabled={busy} onPress={() => void confirmVisual()}>确认回答</Button></Modal.Footer>
          </Modal.Dialog>
        </Modal.Container></Modal.Backdrop>
      </Modal.Root>}
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
