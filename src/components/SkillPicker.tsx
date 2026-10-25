import { useEffect, useId, useState } from 'react';
import { Button, Checkbox, Label, Modal, SearchField, Spinner, Tooltip } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { Sym, MODAL_CONTAINER_CLASS } from '../ui';
import { loadEnabledSkillMeta, type SkillMeta } from '../skills/store';
import { intersectSkillMetaIds } from '../skills/scope';
import { cloud } from '../cloud/state';
import McpScope from '../mcp/McpScope';
import { openSettings } from './settingsDialogStore';
import './skill-picker.css';

interface Props {
  /** undefined = 自动；[] = 不使用；其他集合 = 本次会话可用范围。 */
  value?: number[];
  /** 选满全部启用项时归一化为 undefined，之后新启用的技能也可用。 */
  onChange: (next: number[] | undefined) => void;
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
  mcpValue?: string[];
  onMcpChange?: (ids: string[] | undefined) => Promise<void>;
}

// 简短名称用于选择；用途说明保留在搜索和无障碍描述中。
const BUILTIN_PRESENTATION = [
  { name: '课程讲义', key: 'handout', icon: 'description' },
  { name: '原题题库', key: 'questions', icon: 'quiz' },
  { name: '讲解配图', key: 'diagram', icon: 'account_tree' },
  { name: '交互式讲解', key: 'interactive', icon: 'pointer' },
  { name: '资料整理', key: 'organize', icon: 'folder_open' },
] as const;

/** 技能是可用范围，不是强制调用；勾选即时生效，搜索只过滤展示。 */
export default function SkillPicker({ value, onChange, isOpen, onOpenChange, hideTrigger, mcpValue, onMcpChange }: Props) {
  const { t } = useTranslation('settings');
  const id = useId();
  const [internalOpen, setInternalOpen] = useState(false);
  const open = isOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const [catalog, setCatalog] = useState<{ status: 'loading' | 'ready' | 'error'; skills: SkillMeta[] }>({ status: 'loading', skills: [] });
  const [retry, setRetry] = useState(0);
  const [query, setQuery] = useState('');

  // 每次打开重新读取启停状态；关闭后丢弃未完成的结果，失败不伪装成空列表。
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setCatalog({ status: 'loading', skills: [] });
    setQuery('');
    void loadEnabledSkillMeta().then((skills) => {
      if (!cancelled) setCatalog({ status: 'ready', skills });
    }).catch(() => {
      if (!cancelled) setCatalog({ status: 'error', skills: [] });
    });
    return () => { cancelled = true; };
  }, [open, retry]);

  const { skills, status } = catalog;
  const selected = new Set(intersectSkillMetaIds(skills, value));
  const mode = value === undefined ? 'auto' : value.length === 0 ? 'none' : 'custom';
  const ready = status === 'ready';
  const selectionLabel = mode === 'auto' ? t('skillPicker.auto')
    : mode === 'none' ? t('skillPicker.none') : t('skillPicker.custom');
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const items = skills.map((skill) => {
    const builtin = skill.builtin ? BUILTIN_PRESENTATION.find((item) => item.name === skill.name) : undefined;
    return {
      ...skill,
      title: builtin ? t(`skillPicker.builtins.${builtin.key}.title`) : skill.name,
      summary: builtin ? t(`skillPicker.builtins.${builtin.key}.description`) : skill.description,
      icon: builtin?.icon ?? 'extension',
      order: builtin ? BUILTIN_PRESENTATION.indexOf(builtin) : BUILTIN_PRESENTATION.length,
    };
  }).sort((a, b) => a.order - b.order);
  const visible = items.filter((skill) => [skill.name, skill.title, skill.summary, skill.description, ...(skill.mcpRequired ?? [])]
    .join(' ').toLocaleLowerCase().includes(normalizedQuery));
  const groups = [
    { key: 'builtin', label: t('skillPicker.builtin'), items: visible.filter((skill) => skill.builtin) },
    { key: 'custom', label: t('skillPicker.yours'), items: visible.filter((skill) => !skill.builtin) },
  ];
  const showGroupLabels = skills.some((skill) => skill.builtin) && skills.some((skill) => !skill.builtin);

  const toggle = (skillId: number, checked: boolean) => {
    const next = new Set(selected);
    if (checked) next.add(skillId); else next.delete(skillId);
    // 使用全部候选而非搜索结果，保留隐藏项；空集合绝不能归一化为自动。
    onChange(next.size > 0 && next.size === skills.length ? undefined : skills.map((s) => s.id).filter((key) => next.has(key)));
  };

  const manage = () => {
    setOpen(false);
    openSettings('skills');
  };

  return <>
    {!hideTrigger && <Tooltip>
      <Tooltip.Trigger>
        <Button isIconOnly variant={value === undefined ? 'tertiary' : 'primary'} size="sm"
          aria-label={t('skillPicker.title')} data-testid="skill-picker" data-limited={value === undefined ? undefined : '1'}
          onPress={() => setOpen(true)}>
          <Sym name="extension" />
        </Button>
      </Tooltip.Trigger>
      <Tooltip.Content>{t('skillPicker.trigger', { mode: selectionLabel })}</Tooltip.Content>
    </Tooltip>}

    <Modal.Root isOpen={open} onOpenChange={setOpen}>
      <Modal.Backdrop>
        <Modal.Container placement="center" scroll="inside" size="lg" className={MODAL_CONTAINER_CLASS}>
          <Modal.Dialog className="skill-picker-dialog" data-testid="skill-picker-dialog">
            <Modal.CloseTrigger aria-label={t('skillPicker.close')} />
            <Modal.Header className="skill-picker__header">
              <Modal.Heading className="skill-picker__heading">{onMcpChange && cloud.enabled ? t('mcp.scopeTitle') : t('skillPicker.title')}</Modal.Heading>
              <div className="skill-picker__toolbar">
                <div className="skill-picker__presets">
                  <Button size="sm" variant={mode === 'auto' ? 'secondary' : 'tertiary'} aria-pressed={mode === 'auto'}
                    isDisabled={!ready} data-testid="skill-picker-all" onPress={() => onChange(undefined)}>
                    {t('skillPicker.useAuto')}
                  </Button>
                  <Button size="sm" variant={mode === 'none' ? 'secondary' : 'tertiary'} aria-pressed={mode === 'none'}
                    isDisabled={!ready} data-testid="skill-picker-none" onPress={() => onChange([])}>
                    {t('skillPicker.useNone')}
                  </Button>
                </div>
                {ready && <span className="skill-picker__count" role="status" aria-live="polite" data-testid="skill-picker-status"
                  aria-label={t('skillPicker.countLabel', { count: selected.size, total: skills.length })}>
                  {t('skillPicker.count', { count: selected.size, total: skills.length })}
                </span>}
              </div>
              {ready && mode === 'custom' && selected.size === 0 && skills.length > 0 && <p className="skill-picker__notice" role="status">{t('skillPicker.unavailable')}</p>}
              {ready && skills.length > 0 && <SearchField value={query} onChange={setQuery} aria-label={t('skillPicker.search')}
                data-testid="skill-picker-search">
                <SearchField.Group>
                  <SearchField.SearchIcon />
                  <SearchField.Input placeholder={t('skillPicker.searchPlaceholder')} />
                  <SearchField.ClearButton aria-label={t('skillPicker.clearSearch')} />
                </SearchField.Group>
              </SearchField>}
            </Modal.Header>

            <Modal.Body className="skill-picker__body">
              <div className="skill-picker" aria-busy={status === 'loading'}>
                {status === 'loading' ? <div className="skill-picker__empty" role="status"><Spinner size="sm" /><span>{t('skillPicker.loading')}</span></div>
                  : status === 'error' ? <div className="skill-picker__empty" role="alert">
                    <Sym name="error" /><p>{t('skillPicker.loadError')}</p>
                    <Button size="sm" variant="secondary" onPress={() => setRetry((n) => n + 1)}>{t('skillPicker.retry')}</Button>
                  </div>
                  : skills.length === 0 ? <div className="skill-picker__empty" data-testid="skill-picker-empty">
                    <Sym name="extension" /><strong>{t('skillPicker.empty')}</strong>
                  </div>
                  : visible.length === 0 ? <div className="skill-picker__empty" role="status">
                    <Sym name="search" /><strong>{t('skillPicker.noResults')}</strong>
                    <Button size="sm" variant="secondary" onPress={() => setQuery('')}>{t('skillPicker.clearSearch')}</Button>
                  </div>
                  : groups.filter((group) => group.items.length > 0).map((group) => <section key={group.key} aria-labelledby={`${id}-${group.key}`}>
                    <h3 className={showGroupLabels ? 'skill-picker__group-heading' : 'sr-only'} id={`${id}-${group.key}`}>{group.label}</h3>
                    <div className="skill-picker__list">
                      {group.items.map((skill) => <Checkbox key={skill.id} className="skill-picker__item"
                        isSelected={selected.has(skill.id)} onChange={(checked) => toggle(skill.id, checked)}
                        aria-label={skill.title} aria-describedby={`${id}-desc-${skill.id}`}
                        data-testid="skill-scope-item" data-skill-name={skill.name}>
                        <Checkbox.Content className="skill-picker__content">
                          <span className="skill-picker__icon"><Sym name={skill.icon} /></span>
                          <span className="skill-picker__text" title={skill.summary || undefined}>
                            <Label className="skill-picker__name">{skill.title}</Label>
                            <span className="sr-only" id={`${id}-desc-${skill.id}`}>{skill.summary}</span>
                            {!!skill.mcpRequired?.length && <span className="skill-picker__dependency">{t('skillPicker.requiresMcp', { names: skill.mcpRequired.join(', ') })}</span>}
                          </span>
                          <Checkbox.Control className="skill-picker__control"><Checkbox.Indicator data-testid="skill-scope-check" /></Checkbox.Control>
                        </Checkbox.Content>
                      </Checkbox>)}
                    </div>
                  </section>)}
              </div>
              {open && onMcpChange ? <McpScope value={mcpValue} onChange={onMcpChange} /> : null}
            </Modal.Body>

            <Modal.Footer className="skill-picker__footer">
              <Button variant="tertiary" size="sm" onPress={manage} data-testid="skill-picker-manage"><Sym name="settings" />{t('skillPicker.manage')}</Button>
              <Button variant="primary" data-testid="skill-picker-done" onPress={() => setOpen(false)}>{t('skillPicker.done')}</Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal.Root>
  </>;
}
