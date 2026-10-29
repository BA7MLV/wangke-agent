import { createContext, lazy, Suspense, useContext, useId, useRef, useState, type ReactNode } from 'react';
import { Button, TextArea } from '@heroui/react';
import type { ChatRow } from '../store/db';
import { persistArtifactEdit, type ArtifactTarget } from '../store/artifactEdit';
import { artifactDraftKey, cancelArtifactDraft, clearArtifactDraft, EMPTY_ARTIFACT_DRAFT, generateArtifactDraft, updateArtifactDraft, useArtifactDrafts } from '../store/artifactDrafts';
import type { ArtifactKind, ArtifactLocation } from '../utils/artifactEdit';
import type { WidgetLib } from '../harness/widgetRuntime';
import { useSettings } from '../store/settings';
import { useResolvedDark } from '../ui/theme';

const ArtifactPreview = lazy(() => import('./ArtifactPreview'));
interface Revision { kind: ArtifactKind; location: ArtifactLocation; before: string; after: string; widgetRef?: string; widgetIndex?: number }
export interface ArtifactActions { edit(): void; repair?: (instruction: string) => void; undo?: () => void; busy: boolean }
interface Scope {
  rowId: number; disabled: boolean; history: Revision[];
  saved: (row: ChatRow, revision: Revision, undo: boolean) => void;
}
const ArtifactContext = createContext<Scope | null>(null);

export function useArtifactRowId(): number | undefined {
  const scope = useContext(ArtifactContext);
  return scope && scope.rowId >= 0 ? scope.rowId : undefined;
}

/** Only applying touches the message. Network requests never lock other figures or the conversation. */
export function ArtifactEditProvider({ rowId, disabled, onSaved, children }: {
  rowId?: number; content: string; disabled: boolean; onSaved: (row: ChatRow) => void; children: ReactNode;
}) {
  const [history, setHistory] = useState<Revision[]>([]);
  return <ArtifactContext.Provider value={{
    rowId: rowId ?? -1, disabled: disabled || rowId == null, history,
    saved: (row, revision, undo) => {
      setHistory((prev) => undo ? prev.filter((item) => item !== revision) : [...prev.slice(-9), revision]);
      onSaved(row);
    },
  }}>{children}</ArtifactContext.Provider>;
}

interface EditorProps {
  kind: ArtifactKind; source: string; location?: ArtifactLocation; closed?: boolean;
  children: ReactNode | ((actions: ArtifactActions | null) => ReactNode);
  libraries?: readonly WidgetLib[]; widgetId?: string; widgetRef?: string; widgetIndex?: number;
  htmlContentType?: 'example' | 'interactive';
}

export default function ArtifactEditor({ closed = true, ...props }: EditorProps) {
  const scope = useContext(ArtifactContext);
  if (!scope || !closed) return <>{typeof props.children === 'function' ? props.children(null) : props.children}</>;
  return <EditableArtifact {...props} scope={scope} />;
}

function EditableArtifact({ kind, source, location = 'fence', libraries, widgetId, widgetRef, widgetIndex, children, scope, htmlContentType }: EditorProps & { scope: Scope }) {
  const target: ArtifactTarget = { rowId: scope.rowId, kind, location, source, widgetId };
  const key = artifactDraftKey(target);
  const draft = useArtifactDrafts((state) => state.drafts[key] ?? EMPTY_ARTIFACT_DRAFT);
  const theme = useSettings((state) => state.theme);
  const dark = useResolvedDark(theme);
  const headingId = useId();
  const inputId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const statusButtonRef = useRef<HTMLButtonElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const running = draft.status === 'generating';
  const applying = draft.status === 'applying';
  const busy = running || applying;
  const revision = [...scope.history].reverse().find((item) => item.after.trimEnd() === source.trimEnd() && item.kind === kind
    && item.location === location && item.widgetRef === widgetRef && item.widgetIndex === widgetIndex);
  const edit = () => {
    updateArtifactDraft(key, { open: true });
    // Focus only on an explicit user action, never when a virtualized message remounts.
    requestAnimationFrame(() => (draft.next || running ? panelRef.current : inputRef.current)?.focus());
  };
  const repair = (instruction: string) => {
    if (busy || scope.disabled) return;
    // Opening a repair never sends a request or discards a user's existing draft.
    if (!draft.next) updateArtifactDraft(key, draft.instruction.trim()
      ? { context: [draft.context, instruction].filter(Boolean).join('\n').slice(0, 4000) }
      : { instruction: instruction.slice(0, 4000) });
    edit();
  };
  const collapse = () => {
    updateArtifactDraft(key, { open: false });
    requestAnimationFrame(() => (statusButtonRef.current ?? editButtonRef.current)?.focus());
  };

  async function save(undo = false) {
    if (scope.disabled || busy || useArtifactDrafts.getState().drafts[key]?.status === 'applying') return;
    const next = undo ? revision?.before : draft.next;
    if (next == null) return;
    updateArtifactDraft(key, { status: 'applying', error: '', notice: '' });
    try {
      const row = await persistArtifactEdit({ ...target, next });
      scope.saved(row, undo && revision ? revision : { kind, location, before: source, after: next, widgetRef, widgetIndex }, undo);
      clearArtifactDraft(key);
    } catch (error) {
      updateArtifactDraft(key, { status: draft.next ? 'ready' : 'idle', error: error instanceof Error ? error.message : String(error) });
    }
  }

  const form = <div className="flex min-w-0 flex-col gap-3">
    <label htmlFor={inputId} className="text-sm font-medium">想怎么改？</label>
    <TextArea ref={inputRef} id={inputId} aria-label="修改要求" rows={3} className="w-full resize-y"
      placeholder={kind === 'html' ? '例如：用对比图突出变化，减少文字，保留现有交互' : '例如：突出两条曲线的差异，补充坐标与关键点'}
      value={draft.instruction} maxLength={4000} disabled={busy}
      onChange={(event) => updateArtifactDraft(key, { instruction: event.target.value })} />
    <details className="text-sm text-muted">
      <summary className="cursor-pointer">补充题意与约束（可选）</summary>
      <TextArea aria-label="必要题意或约束（可选）" rows={2} className="mt-2 w-full resize-y" placeholder="只补充这次修改必须知道的条件"
        value={draft.context} maxLength={4000} disabled={busy} onChange={(event) => updateArtifactDraft(key, { context: event.target.value })} />
      <p className="mb-0 text-pretty text-xs">仅发送此块源码和你填写的内容，不读取整段会话或课程。</p>
    </details>
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" isDisabled={scope.disabled || busy || !draft.instruction.trim()}
        onPress={() => void generateArtifactDraft(target, 'patch', libraries)}>{draft.next ? '重新生成修改' : '生成局部修改'}</Button>
      <details className="text-sm text-muted">
        <summary className="cursor-pointer">更多选项</summary>
        <div className="flex flex-col items-start gap-2 py-2">
          <p className="m-0 max-w-sm text-pretty text-xs">局部修改失败，或需要大幅调整时使用。会另发一次模型请求，仍只修改此块。</p>
          <Button size="sm" variant="secondary" isDisabled={scope.disabled || busy || !draft.instruction.trim()}
            onPress={() => void generateArtifactDraft(target, 'rewrite', libraries)}>仅重生成此块</Button>
        </div>
      </details>
    </div>
  </div>;

  return <div data-testid="editable-artifact" className="md-embedded-ui min-w-0">
    {typeof children !== 'function' && !scope.disabled && <div className="flex flex-wrap items-center justify-end gap-2 py-1">
      <Button ref={editButtonRef} size="sm" variant="tertiary" isDisabled={scope.disabled || applying} onPress={edit}>{kind === 'html' ? '修改此 HTML' : '修改此图'}</Button>
      {revision && <Button size="sm" variant="tertiary" isDisabled={scope.disabled || busy} onPress={() => void save(true)}>撤销上次修改</Button>}
    </div>}
    {typeof children === 'function' ? children(scope.disabled ? null : { busy, edit, repair,
      ...(revision && !running ? { undo: () => void save(true) } : {}),
    }) : children}
    {!draft.open && (running || draft.next || draft.error || draft.notice) && <div className="my-2 flex flex-wrap items-center gap-2 rounded-xl border border-border p-3" data-testid="artifact-edit-status">
      <p className="m-0 flex-1 text-pretty text-sm" role={draft.error ? 'alert' : 'status'}>{draft.error || (running ? '正在生成修改 · 可继续其他操作' : draft.next ? '修改已就绪，等待你预览并应用' : draft.notice)}</p>
      <Button ref={statusButtonRef} size="sm" variant="tertiary" onPress={edit}>{running ? '查看进度' : draft.next ? '查看修改' : '继续修改'}</Button>
      {running && <Button size="sm" variant="tertiary" onPress={() => cancelArtifactDraft(key)}>停止生成</Button>}
    </div>}
    {draft.open && <section ref={panelRef} tabIndex={-1} aria-labelledby={headingId} data-testid="artifact-edit-panel" className="my-3 flex min-w-0 flex-col gap-4 rounded-3xl border border-border bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id={headingId} className="m-0 text-balance text-sm font-medium">{kind === 'html' ? '调整这块内容' : '调整这幅图'}</h3>
          <p className="mb-0 mt-1 text-pretty text-xs text-muted">先看效果，再决定是否替换。其他正文和图形不变。</p>
        </div>
        <Button size="sm" variant="tertiary" isDisabled={applying} onPress={collapse}>收起</Button>
      </div>
      {running ? <div className="flex flex-wrap items-center gap-3 rounded-xl bg-default p-3">
        <div className="min-w-0 flex-1" role="status">
          <p className="m-0 text-pretty text-sm font-medium">正在生成修改…</p>
          <p className="mb-0 mt-1 text-pretty text-xs text-muted">可以收起后继续阅读、操作其他图形或发送消息。原内容不会改变。</p>
        </div>
        <Button size="sm" variant="secondary" onPress={() => cancelArtifactDraft(key)}>停止生成</Button>
      </div> : draft.next ? null : form}
      {draft.error && <p role="alert" className="m-0 break-words text-pretty text-sm text-danger">{draft.error}</p>}
      {draft.notice && <p role="status" className="m-0 text-pretty text-sm text-muted">{draft.notice}</p>}
      {draft.next && <>
        <div data-testid="artifact-edit-preview" className="min-w-0">
          <p role="status" className="mb-2 mt-0 text-pretty text-sm font-medium">{running ? '上次预览' : '修改后'} <span className="font-normal text-muted">· 尚未应用，原内容在上方</span></p>
          <Suspense fallback={<p role="status" className="text-sm text-muted">正在准备预览…</p>}>
            <ArtifactPreview kind={kind} source={draft.next} location={location} libraries={libraries} dark={dark} htmlContentType={htmlContentType} />
          </Suspense>
        </div>
        <p className="m-0 text-pretty text-xs text-muted">请检查视觉与交互效果。预览操作不会保存到原图，应用后仍可撤销。</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" isDisabled={scope.disabled || busy} onPress={() => void save()}>{applying ? '正在应用…' : '应用修改'}</Button>
          <Button size="sm" variant="tertiary" isDisabled={applying} onPress={collapse}>稍后再看</Button>
        </div>
        {!running && <details className="text-sm"><summary className="cursor-pointer text-muted">调整要求与重新生成</summary><div className="pt-3">{form}</div></details>}
        <details className="min-w-0 text-sm text-muted"><summary className="cursor-pointer">查看修改前后源码</summary>
          <p className="text-xs">修改前</p><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs">{source}</pre>
          <p className="text-xs">修改后</p><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs">{draft.next}</pre>
        </details>
      </>}
      {scope.disabled && <p className="m-0 text-pretty text-xs text-muted">当前回答处理完成后可继续生成或应用修改，已生成的预览会保留。</p>}
    </section>}
  </div>;
}
