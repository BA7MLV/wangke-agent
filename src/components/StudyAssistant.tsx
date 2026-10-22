import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { Button, cn, Disclosure, Tabs } from '@heroui/react';
import { Sym } from '../ui';
import { useAssistantPosition } from './useAssistantPosition';
import { ASSISTANT_RESIZE_EDGES, type AssistantResizeEdge } from './assistantGeometry';
import './study-assistant.css';

export type StudyPanelKey = 'subs' | 'chat' | 'dm' | 'cards';
export const STUDY_PANEL_KEYS: readonly StudyPanelKey[] = ['subs', 'chat', 'dm', 'cards'];
const LABELS: Record<StudyPanelKey, string> = {
  subs: '字幕', chat: '问答', dm: '弹幕', cards: '卡片',
};
const RESIZE_LABELS: Record<AssistantResizeEdge, string> = {
  n: '上边缘', e: '右边缘', s: '下边缘', w: '左边缘',
  nw: '左上角', ne: '右上角', sw: '左下角', se: '右下角',
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
  const { boundsRef, assistantRef, suppressToggle } = useAssistantPosition(open);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<'trigger' | 'panel' | null>(null);
  const changeOpen = (expanded: boolean) => {
    pendingFocus.current = expanded ? 'panel' : 'trigger';
    onOpenChange(expanded);
  };
  useLayoutEffect(() => {
    if (pendingFocus.current === (open ? 'panel' : 'trigger')) {
      (open ? bodyRef : triggerRef).current?.focus({ preventScroll: true });
    }
    pendingFocus.current = null;
  }, [open]);
  return (
    <div ref={boundsRef} className="study-assistant-viewport">
      <Disclosure ref={assistantRef} className="study-assistant" isExpanded={open}
        onExpandedChange={(expanded) => { if (!suppressToggle.current) changeOpen(expanded); }}>
        <Disclosure.Content className={cn('study-assistant__content t-dropdown', open ? 'is-open' : 'is-closing')}
          inert={!open} data-testid="study-assistant-panel">
          <div ref={bodyRef} className="study-assistant__body" tabIndex={-1}>
            <div className="study-assistant__header">
              <div className="study-assistant__drag-handle" data-assistant-drag-handle
                data-testid="study-assistant-drag-handle" title="拖动移动学习助手">
                <Sym name="drag_indicator" />
                <span>学习助手</span>
              </div>
              <Button isIconOnly variant="tertiary" size="sm" data-testid="study-assistant-close"
                aria-label="收起学习助手" onPress={() => changeOpen(false)}>
                <Sym name="keyboard_arrow_down" />
              </Button>
            </div>
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
          </div>
          {ASSISTANT_RESIZE_EDGES.map((edge) => (
            <Button key={edge} isIconOnly variant="tertiary"
              className="study-assistant__resize-edge" data-assistant-resize-handle={edge}
              data-testid={`study-assistant-resize-${edge}`} excludeFromTabOrder={edge.length > 1}
              aria-label={`调整学习助手${RESIZE_LABELS[edge]}`}
              aria-description="拖动调整尺寸，方向键微调，Home 恢复默认" />
          ))}
        </Disclosure.Content>
        <Disclosure.Heading className="study-assistant__heading" hidden={open}>
          <Button ref={triggerRef} slot="trigger" variant="primary" className="study-assistant__trigger"
            data-assistant-drag-handle aria-description="拖动可移动"
            data-testid="study-assistant-toggle" aria-label="打开学习助手">
            <Sym name="neurology" />
          </Button>
        </Disclosure.Heading>
      </Disclosure>
    </div>
  );
}
