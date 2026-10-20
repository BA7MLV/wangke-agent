import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Modal, TextArea } from '@heroui/react';
import { MODAL_CONTAINER_CLASS } from '../ui';
import type { ChatRow } from '../store/db';
import { persistArtifactEdit } from '../store/artifactEdit';
import { editArtifact, validateArtifact } from '../pipelines/artifactEdit';
import { replaceArtifactFence, type ArtifactKind, type ArtifactLocation } from '../utils/artifactEdit';

interface Revision { kind: ArtifactKind; location: ArtifactLocation; before: string; after: string; widgetRef?: string }
export interface ArtifactActions { edit(): void; undo?: () => void; busy: boolean }
interface Draft { next: string; source: string; content: string; rowId: number }
interface Scope {
  rowId: number; content: string; busy: boolean; setBusy: (busy: boolean) => void;
  history: Revision[]; saved: (row: ChatRow, revision?: Revision) => void;
}
const ArtifactContext = createContext<Scope | null>(null);

/** Scoped to a persisted assistant message; standalone diagrams stay read-only. */
export function ArtifactEditProvider({ rowId, content, disabled, onSaved, children }: {
  rowId?: number; content: string; disabled: boolean; onSaved: (row: ChatRow) => void; children: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<Revision[]>([]);
  return <ArtifactContext.Provider value={rowId == null || disabled ? null : {
    rowId, content, busy, setBusy, history,
    saved: (row, revision) => {
      setHistory((prev) => revision ? [...prev.slice(-9), revision] : prev.slice(0, -1));
      onSaved(row);
    },
  }}>{children}</ArtifactContext.Provider>;
}

export default function ArtifactEditor({ kind, source, location = 'fence', closed = true, libraries, widgetId, widgetRef, children }: {
  kind: ArtifactKind; source: string; location?: ArtifactLocation; closed?: boolean;
  children: ReactNode | ((actions: ArtifactActions | null) => ReactNode);
  libraries?: readonly string[];
  widgetId?: string; widgetRef?: string;
}) {
  const scope = useContext(ArtifactContext);
  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [context, setContext] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const controller = useRef<AbortController | null>(null);
  // Cancel on virtualization, navigation or deletion; late responses must never write.
  useEffect(() => () => controller.current?.abort(), []);

  if (!scope || !closed) return <>{typeof children === 'function' ? children(null) : children}</>;
  const revision = scope.history.at(-1);
  const canUndo = revision?.after.trimEnd() === source.trimEnd() && revision.kind === kind && revision.location === location
    && revision.widgetRef === widgetRef;

  function close() {
    controller.current?.abort();
    setOpen(false);
  }

  async function generate(mode: 'patch' | 'rewrite') {
    if (!scope || scope.busy || !instruction.trim() || controller.current) return;
    const abort = new AbortController();
    controller.current = abort;
    scope.setBusy(true);
    setRunning(true);
    setError('');
    setDraft(null);
    try {
      if (location === 'fence' || (location === 'html' && /^\s*[`~]{3}/.test(scope.content))) {
        replaceArtifactFence(scope.content, kind, source, source);
      }
      const next = await editArtifact({ kind, source, instruction, context, libraries, mode, signal: abort.signal });
      await validateArtifact(kind, next);
      if (!abort.signal.aborted) setDraft({ next, source, content: scope.content, rowId: scope.rowId });
    } catch (e) {
      if (!abort.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    } finally {
      controller.current = null;
      scope.setBusy(false);
      setRunning(false);
    }
  }

  async function save(undo = false) {
    if (!scope || scope.busy || controller.current) return;
    const next = undo && canUndo ? revision.before : draft?.next;
    if (next == null) return;
    scope.setBusy(true);
    setError('');
    try {
      if (!undo && draft && (draft.source !== source || draft.content !== scope.content || draft.rowId !== scope.rowId)) {
        throw new Error('生成补丁后原回答已变化，请重新生成修改');
      }
      const row = await persistArtifactEdit({ rowId: scope.rowId, kind, location, source, next, widgetId, expectedContent: scope.content });
      scope.saved(row, undo ? undefined : { kind, location, before: source, after: next, widgetRef });
      setDraft(null);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      scope.setBusy(false);
    }
  }

  return <div data-testid="editable-artifact">
    {typeof children !== 'function' && <div className="flex items-center justify-end gap-2 py-1">
      <Button size="sm" variant="tertiary" isDisabled={scope.busy} onPress={() => { setError(''); setDraft(null); setOpen(true); }}>
        {kind === 'html' ? '修改此 HTML' : '修改此图'}
      </Button>
      {canUndo && <Button size="sm" variant="tertiary" isDisabled={scope.busy} onPress={() => void save(true)}>撤销上次修改</Button>}
    </div>}
    {!open && error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {typeof children === 'function' ? children({ busy: scope.busy,
      edit: () => { setError(''); setDraft(null); setOpen(true); },
      ...(canUndo ? { undo: () => void save(true) } : {}),
    }) : children}
    {open && <Modal.Root isOpen onOpenChange={(value) => !value && close()}>
      <Modal.Backdrop>
        <Modal.Container placement="center" size="lg" className={MODAL_CONTAINER_CLASS}>
          <Modal.Dialog data-testid="artifact-edit-dialog">
            <Modal.Header><Modal.Heading>{kind === 'html' ? '修改此 HTML' : '修改此图'}</Modal.Heading></Modal.Header>
            <Modal.Body>
              <div className="flex flex-col gap-3">
                <p className="text-sm text-muted">只发送此块源码和下方要求，不发送整段会话。其他正文和图形保持不变。</p>
                <TextArea aria-label="修改要求" placeholder="例如：将红色曲线改成 sin(x)，其余不变" value={instruction} maxLength={4000} disabled={scope.busy}
                  onChange={(event) => { setInstruction(event.target.value); setDraft(null); }} />
                <TextArea aria-label="必要题意或约束（可选）" placeholder="必要题意或约束（可选）；此操作不会自动读取课程或完整回答" value={context} maxLength={4000} disabled={scope.busy}
                  onChange={(event) => { setContext(event.target.value); setDraft(null); }} />
                {running && <p role="status" className="text-sm text-muted">正在修改此块，原内容保持不变…</p>}
                {error && <p role="alert" className="text-sm text-danger">{error}</p>}
                {draft != null && <>
                  <p role="status" className="text-sm">修改已通过结构检查，应用后更新当前内容块。结构检查不保证视觉或交互正确，可应用后撤销。</p>
                  <details><summary>查看修改前后源码</summary>
                    <p className="text-sm text-muted">修改前</p><pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs">{source}</pre>
                    <p className="text-sm text-muted">修改后</p><pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs">{draft.next}</pre>
                  </details>
                </>}
              </div>
            </Modal.Body>
            <Modal.Footer className="flex-wrap">
              <Button variant="tertiary" onPress={close}>{running ? '取消生成' : '取消'}</Button>
              <Button variant="secondary" isDisabled={scope.busy || !instruction.trim()} onPress={() => void generate('rewrite')}>仅重生成此块</Button>
              {draft == null
                ? <Button isDisabled={scope.busy || !instruction.trim()} onPress={() => void generate('patch')}>生成局部修改</Button>
                : <Button isDisabled={scope.busy} onPress={() => void save()}>应用修改</Button>}
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal.Root>}
  </div>;
}
