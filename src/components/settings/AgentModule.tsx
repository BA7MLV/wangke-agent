import { Button, TextArea } from '@heroui/react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { useSettings } from '../../store/settings';
import { Field, SectionCard, confirmDialog } from '../../ui';
import { closeSettings } from '../settingsDialogStore';

/** 类似 AGENTS.md 的长期偏好，与应用的工具/引用契约分开维护。 */
export default function AgentModule() {
  const { t } = useTranslation('settings');
  const inputId = useId();
  const scopeId = useId();
  const instructions = useSettings((s) => s.agentInstructions);
  const update = useSettings((s) => s.update);

  const reset = async () => {
    if (await confirmDialog({
      headline: t('agent.resetTitle'),
      description: t('agent.resetConfirm'),
      confirmText: t('agent.reset'),
      cancelText: t('agent.cancel'),
    })) update({ agentInstructions: '' });
  };

  return (
    <SectionCard title={t('agent.title')} subtitle={t('agent.subtitle')} testId="card-agent-instructions">
      <Field
        label={<label htmlFor={inputId}>{t('agent.label')}</label>}
        hint={t('agent.hint')}
      >
        <TextArea
          id={inputId}
          aria-label={t('agent.label')}
          aria-describedby={scopeId}
          data-testid="agent-instructions"
          className="w-full min-w-0 resize-y font-mono text-sm"
          rows={14}
          value={instructions}
          placeholder={t('agent.placeholder')}
          onChange={(event) => update({ agentInstructions: event.target.value })}
        />
      </Field>
      <div className="flex flex-wrap items-center justify-between gap-3 pt-3">
        <span className="text-xs text-muted" data-testid="agent-instructions-status" role="status">
          {instructions.trim() ? t('agent.saved') : t('agent.default')}
        </span>
        <Button variant="secondary" size="sm" isDisabled={!instructions} onPress={() => void reset()} data-testid="agent-instructions-reset">
          {t('agent.reset')}
        </Button>
      </div>
      <p id={scopeId} className="mt-4 text-xs leading-normal text-muted text-pretty">
        {t('agent.scope')}
      </p>
      <a href="#/library?file=/system/AGENTS.md" onClick={() => closeSettings()} className="mt-3 inline-block text-sm text-accent underline" data-testid="agent-instructions-open-file">{t('agent.openFile')}</a>
    </SectionCard>
  );
}
