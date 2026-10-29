import { createContext, useContext, type ReactNode } from 'react';
import type { WidgetPayload } from '../harness/widgetRuntime';
import { layoutWidgets, messageWidgets, type WidgetCollection } from '../harness/widgetLayout';
import ArtifactEditor from './ArtifactEditor';
import WidgetBlock from './WidgetBlock';

interface Scope { widgets: WidgetPayload[]; dark: boolean; rowId?: number; disabled?: boolean; onPrompt?: (text: string) => void | Promise<void> }
const WidgetContext = createContext<Scope | null>(null);

function Visual({ payload, scope }: { payload: WidgetPayload; scope: Scope }) {
  if (typeof payload.html !== 'string') return <p role="alert">预览失败：作品源码缺失或格式无效</p>;
  return <ArtifactEditor kind="html" location="widget" source={payload.html} libraries={payload.libs} widgetId={payload.id} widgetRef={payload.ref} widgetIndex={scope.widgets.indexOf(payload)}>
    {(actions) => <WidgetBlock payload={payload} dark={scope.dark} rowId={scope.rowId} disabled={scope.disabled} onPrompt={scope.onPrompt} editActions={actions} />}
  </ArtifactEditor>;
}

/** Renders references at their Markdown position; old/missing references retain a safe end-of-answer fallback. */
export default function WidgetMessage({ message, content, dark, rowId, disabled, onPrompt, children }: {
  message: WidgetCollection; content: string; dark: boolean; rowId?: number; disabled?: boolean;
  onPrompt?: (text: string) => void | Promise<void>; children: (markdown: string) => ReactNode;
}) {
  const widgets = messageWidgets(message);
  const scope = { widgets, dark, rowId, disabled, onPrompt };
  const { markdown, unplaced } = layoutWidgets(content, widgets);
  return <WidgetContext.Provider value={scope}>
    {children(markdown)}
    {unplaced.map((payload, index) => <Visual key={payload.ref ?? payload.id ?? index} payload={payload} scope={scope} />)}
  </WidgetContext.Provider>;
}

export function InlineWidget({ reference, closed }: { reference: string; closed: boolean }) {
  const scope = useContext(WidgetContext);
  if (!closed || !reference.trim()) return null;
  const payload = scope?.widgets.find((widget) => widget.ref === reference.trim());
  if (!scope || !payload) return <p className="text-sm text-muted" role="status">这幅图暂不可用，请回到原回答查看。</p>;
  return <Visual payload={payload} scope={scope} />;
}
