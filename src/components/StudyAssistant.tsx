import type { ReactNode } from 'react';
import { Button, Disclosure, Tabs } from '@heroui/react';
import { Sym } from '../ui';
import { useAssistantPosition } from './useAssistantPosition';
import './study-assistant.css';

export type StudyPanelKey = 'subs' | 'handout' | 'chat' | 'dm' | 'cards';
export const STUDY_PANEL_KEYS: readonly StudyPanelKey[] = ['subs', 'handout', 'chat', 'dm', 'cards'];
const LABELS: Record<StudyPanelKey, string> = {
  subs: '字幕', handout: '讲义', chat: '问答', dm: '弹幕', cards: '卡片',
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeTab: StudyPanelKey;
  onTabChange: (key: StudyPanelKey) => void;
  panelKeys: readonly StudyPanelKey[];
  panels: Partial<Record<StudyPanelKey, ReactNode>>;
}

/** 非模态的学习工具箱：收起只隐藏，字幕订阅、生成任务和输入草稿继续保留。 */
export default function StudyAssistant({ open, onOpenChange, activeTab, onTabChange, panelKeys, panels }: Props) {
  const { boundsRef, assistantRef, suppressToggle } = useAssistantPosition();
  return (
    <div ref={boundsRef} className="study-assistant-viewport">
      <Disclosure ref={assistantRef} className="study-assistant" isExpanded={open}
        onExpandedChange={(expanded) => { if (!suppressToggle.current) onOpenChange(expanded); }}>
        <Disclosure.Content className="study-assistant__content" hidden={!open} data-testid="study-assistant-panel">
          <Tabs className="panel-tabs" variant="secondary" align="start" selectedKey={activeTab}
            onSelectionChange={(key) => {
              if (panelKeys.includes(key as StudyPanelKey)) onTabChange(key as StudyPanelKey);
            }} data-testid="panel-tabs">
            <Tabs.ListContainer>
              <Tabs.List aria-label="学习面板">
                {panelKeys.map((key) => (
                  <Tabs.Tab key={key} id={key} data-testid={`panel-tab-${key}`}>{LABELS[key]}</Tabs.Tab>
                ))}
              </Tabs.List>
            </Tabs.ListContainer>
            {panelKeys.map((key) => (
              <Tabs.Panel key={key} id={key} shouldForceMount hidden={activeTab !== key} data-testid={`panel-slot-${key}`}>
                {panels[key]}
              </Tabs.Panel>
            ))}
          </Tabs>
        </Disclosure.Content>
        <Disclosure.Heading className="study-assistant__heading" data-assistant-drag-handle title="点击展开或收起，拖动可移动">
          <Button slot="trigger" variant="primary" className="study-assistant__trigger"
            data-testid="study-assistant-toggle" aria-label={open ? '收起学习助手' : '打开学习助手'}>
            <Sym name={open ? 'keyboard_arrow_down' : 'neurology'} />
          </Button>
        </Disclosure.Heading>
      </Disclosure>
    </div>
  );
}
