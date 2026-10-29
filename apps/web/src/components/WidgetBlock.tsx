import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button, Dropdown, Label, Modal, TextArea } from '@heroui/react';
import { buildWidgetDocument, WIDGET_MSG, type WidgetPayload } from '../harness/widgetRuntime';
import { normalizeWidgetPrompt, widgetFollowUp, type WidgetState } from '../harness/widgetState';
import { observeWidgetState, openWidgetSession, readWidgetState, saveWidgetState, type WidgetSession } from '../store/widgetState';
import { MODAL_CONTAINER_CLASS, Sym } from '../ui';
import { observeWidgetTheme, readWidgetTheme, type WidgetTheme } from '../harness/widgetTheme';
import type { ArtifactActions } from './ArtifactEditor';
import WidgetStateSummary from './WidgetStateSummary';
import { readWidgetHeight, rememberWidgetHeight, widgetRevision, WIDGET_SCROLL_INTENT } from '../harness/widgetReading';
import './widget-block.css';
import { MAX_WIDGET_DIAGNOSTICS, readWidgetDiagnostic, WIDGET_READY_TIMEOUT_MS, type WidgetDiagnostic } from '../harness/widgetDiagnostics';
import { copyText } from '../utils/clipboard';
import { toast } from '../ui';
import { validateWidgetPayload } from '../harness/widgetProtocol';

/**
 * 沙箱 widget 的宿主壳：一个 `sandbox="allow-scripts"` 的 iframe。
 *
 * ## 权限只有一条
 *
 * **不给** `allow-same-origin`。这样 iframe 处于不透明源，与应用不同源：
 * 里面的脚本读不到父页面的 DOM、IndexedDB、localStorage，也改不了地址栏。
 * 外发数据由 iframe 文档内的 CSP `connect-src 'none'` 断掉（见 widgetRuntime.ts）。
 *
 * 对比 `HtmlReader.tsx` 的阅读视图 —— 那边是 `allow-same-origin` 且不给 `allow-scripts`，
 * 因为它要显示用户导入的材料、只需要样式。两个方向各自成立，**别把两个搞混**。
 *
 * ## 宿主的受限能力
 *
 * 高度、主题、绑定此消息的 JSON 快照，以及必须由用户确认的追问。
 * 消息都校验 `event.source === iframe.contentWindow` 与 opaque origin
 * `event.origin === "null"`，所以外部页面不能伪造同名消息。
 */

interface Props {
  payload: WidgetPayload;
  /** 深色模式（宿主的主题设置，不是系统偏好） */
  dark: boolean;
  /** widget 请求继续对话时调用（文本就是用户在 widget 里点的那句话） */
  onPrompt?: (text: string) => void | Promise<void>;
  /** 只有已持久保存的消息才能写快照。行号由宿主传入，iframe 永远拿不到。 */
  rowId?: number;
  /** Read-only question surfaces have no widget-state DB binding, but still own layout memory. */
  readingKey?: string;
  /** 生成中或入口只读时，不能发起付费追问。 */
  disabled?: boolean;
  /** 独立预览页不再显示「在新窗口展开」，避免从新窗口继续打开新窗口。 */
  allowPopout?: boolean;
  editActions?: ArtifactActions | null;
  /** Ordinary HTML uses the same sandbox/popout boundary, with source actions owned by its renderer. */
  htmlActions?: { sourceOpen: boolean; sourceId: string; toggleSource(): void; copySource(): void };
  /** Popouts inherit the originating surface's locally scoped palette and typography. */
  appearance?: WidgetTheme;
  /** Question-scoped draft only. The student confirms submission in the trusted host UI. */
  answerInput?: { answer: unknown; submitted: boolean; question?: unknown; onDraft: (raw: unknown) => void; onSubmit?: (raw: unknown) => Promise<void> };
}

/**
 * 展开预览只传一个随机 token，真正的 HTML 通过 BroadcastChannel 传递。
 * 因此源码不会进入 URL、浏览器历史或可复制的链接，也不会让新窗口接触宿主 DOM。
 */
export const WIDGET_PREVIEW_MSG = {
  ready: 'widget-preview:ready',
  payload: 'widget-preview:payload',
  prompt: 'widget-preview:prompt',
  result: 'widget-preview:result',
} as const;

export type WidgetPreviewMessage =
  | { type: typeof WIDGET_PREVIEW_MSG.ready }
  | { type: typeof WIDGET_PREVIEW_MSG.payload; payload: WidgetPayload; dark: boolean; appearance?: WidgetTheme; rowId?: number; canPrompt?: boolean; surface?: 'html' }
  | { type: typeof WIDGET_PREVIEW_MSG.prompt; text: string; requestId: number }
  | { type: typeof WIDGET_PREVIEW_MSG.result; requestId: number; error?: string };

const WIDGET_PREVIEW_CHANNEL_PREFIX = 'wangke-widget-preview:';

export function widgetPreviewChannelName(token: string): string {
  return `${WIDGET_PREVIEW_CHANNEL_PREFIX}${token}`;
}

function createPreviewToken(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  // 只作为极旧浏览器的降级；现代浏览器都会走上面的 CSPRNG。
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

const MIN_H = 80;

export default function WidgetBlock(props: Props) {
  const [run, setRun] = useState(0);
  // A new source revision owns a new bridge and pending requests. State/theme updates do not remount it.
  const owner = useRef({ rowId: props.rowId, key: props.rowId });
  let invalid = '';
  try { validateWidgetPayload(props.payload); }
  catch (error) { invalid = error instanceof Error ? error.message : String(error); }
  if (invalid) return <RejectedWidget error={invalid} source={typeof props.payload?.html === 'string' ? props.payload.html : ''}
    retry={() => setRun(value => value + 1)} />;
  const libsKey = JSON.stringify(props.payload.libs ?? []);
  if (props.rowId !== owner.current.rowId) {
    // Persisting this streaming message is a promotion, not a new iframe session.
    if (owner.current.rowId != null) owner.current.key = props.rowId;
    owner.current.rowId = props.rowId;
  }
  const key = JSON.stringify([owner.current.key ?? props.readingKey ?? null, props.payload.id ?? null, props.payload.html, libsKey,
    props.payload.kind, props.payload.schemaVersion, props.payload.revision, props.payload.source]);
  return <WidgetSessionBlock key={`${key}:${run}`} {...props} onRerun={() => setRun((value) => value + 1)} />;
}

/** Corrupt/imported records fail before layout keys, hooks or library loading touch their fields. */
function RejectedWidget({ error, source, retry }: { error: string; source: string; retry(): void }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <div className="md-embedded-ui widget-block" data-testid="widget-block">
    <div className="widget-block--error" data-testid="widget-error" role="alert">
      <p>预览失败：{error}</p>
      <Button size="sm" variant="tertiary" onPress={retry}>重试预览</Button>
      <Button size="sm" variant="tertiary" aria-controls={id} aria-expanded={open} onPress={() => setOpen(value => !value)}>{open ? '收起 HTML 源码' : '查看 HTML 源码'}</Button>
      <Button size="sm" variant="tertiary" onPress={() => void copyText(source).then(ok => ok ? toast.success('HTML 源码已复制') : toast.error('复制失败'))}>复制 HTML</Button>
    </div>
    {open && <pre id={id} aria-label="HTML 源码" className="my-2 max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-default p-3 text-xs" data-testid="widget-source"><code>{source}</code></pre>}
  </div>;
}

function WidgetSessionBlock({ payload, dark, onPrompt, rowId, readingKey, disabled = false, allowPopout = true, editActions, htmlActions, appearance, answerInput, onRerun }: Props & { onRerun(): void }) {
  const [instance] = useState(createPreviewToken);
  const [diagnostics, setDiagnostics] = useState<WidgetDiagnostic[]>([]);
  const diagnosticKeys = useRef(new Set<string>());
  const readyRef = useRef(false);
  const htmlSurface = !!htmlActions;
  const [sourceOpen, setSourceOpen] = useState(false);
  const sourceId = useId();
  const sourceActions = htmlActions ?? {
    sourceOpen, sourceId, toggleSource: () => setSourceOpen(value => !value),
    copySource: () => void copyText(payload.html).then(ok => ok ? toast.success('HTML 源码已复制') : toast.error('复制失败')),
  };
  const hostRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const themeRef = useRef<WidgetTheme | undefined>(appearance);
  const questionId = useId();
  const previewTokenRef = useRef<string | null>(null);
  const previewChannelRef = useRef<BroadcastChannel | null>(null);
  if (!previewTokenRef.current) previewTokenRef.current = createPreviewToken();
  const previewToken = previewTokenRef.current;
  const payloadRef = useRef(payload);
  const darkRef = useRef(dark);
  const onPromptRef = useRef(onPrompt);
  const disabledRef = useRef(disabled);
  payloadRef.current = payload;
  darkRef.current = dark;
  onPromptRef.current = onPrompt;
  disabledRef.current = disabled;
  const answerInputRef = useRef(answerInput);
  answerInputRef.current = answerInput;
  // Short layout hint only, never an authorization/remount key. Exact source
  // identity remains the enclosing component key above.
  const heightKey = useMemo(() => JSON.stringify([rowId ?? readingKey ?? null, payload.id ?? payload.ref ?? null,
    widgetRevision(payload.html), payload.html.length, payload.libs ?? []]), [rowId, readingKey, payload.id, payload.ref, payload.html, payload.libs]);
  const [height, setHeight] = useState(() => readWidgetHeight(heightKey));
  const [ready, setReady] = useState(false);
  const [selection, setSelection] = useState<{ text: string; context: string } | null>(null);
  const answerSubmitting = useRef(false);
  const [doc, setDoc] = useState('');
  const [failed, setFailed] = useState('');
  const [session, setSession] = useState<WidgetSession | null | undefined>(rowId == null ? null : undefined);
  const stateRef = useRef<WidgetState | null>(null);
  const activeRef = useRef(true);
  const [stateMessage, setStateMessage] = useState('');
  const [actionError, setActionError] = useState('');
  const [followUp, setFollowUp] = useState<{ requestId?: number; state: WidgetState | null } | null>(null);
  const followUpRef = useRef(false);
  const sendingRef = useRef(false);
  const [sending, setSending] = useState(false);
  const [question, setQuestion] = useState('');

  const post = useCallback((type: string, value: unknown) => {
    frameRef.current?.contentWindow?.postMessage({ __wbw: type, instance, payload: value }, '*');
  }, [instance]);
  const syncDisplay = useCallback(() => {
    const host = hostRef.current;
    if (!host) return;
    const surface = host.closest('.course-chat__timeline, .chat-list-wrap');
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const surfaceHeight = surface?.getBoundingClientRect().height || viewportHeight;
    post(WIDGET_MSG.display, {
      width: Math.round(host.clientWidth),
      height: Math.max(80, Math.round(Math.min(surfaceHeight, viewportHeight) * 0.65)),
    });
  }, [post]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(syncDisplay);
    observer.observe(host);
    const surface = host.closest('.course-chat__timeline, .chat-list-wrap');
    if (surface) observer.observe(surface);
    window.addEventListener('resize', syncDisplay);
    window.visualViewport?.addEventListener('resize', syncDisplay);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', syncDisplay);
      window.visualViewport?.removeEventListener('resize', syncDisplay);
    };
  }, [syncDisplay, doc]);
  const reply = useCallback((requestId: number | undefined, error?: string) => {
    if (requestId != null && activeRef.current) post(WIDGET_MSG.result, { requestId, ok: !error, error });
  }, [post]);

  useEffect(() => {
    activeRef.current = true;
    if (rowId == null) return () => { activeRef.current = false; };
    let cancelled = false;
    const timer = setTimeout(() => {
      if (!cancelled) { cancelled = true; setFailed('准备运行环境超时，请重新运行'); }
    }, WIDGET_READY_TIMEOUT_MS);
    let subscription: { unsubscribe(): void } | undefined;
    void openWidgetSession(rowId, payload).then(async (binding) => {
      const state = await readWidgetState(binding);
      if (cancelled) return;
      clearTimeout(timer);
      stateRef.current = state;
      setSession(binding);
      subscription = observeWidgetState(binding).subscribe({
        next: (next) => {
          if (cancelled) return;
          stateRef.current = next;
          post(WIDGET_MSG.sync, next);
        },
        error: (error) => { if (!cancelled) setFailed(String(error instanceof Error ? error.message : error)); },
      });
    }).catch((error) => { clearTimeout(timer); if (!cancelled) setFailed(error instanceof Error ? error.message : String(error)); });
    return () => {
      cancelled = true;
      activeRef.current = false;
      clearTimeout(timer);
      subscription?.unsubscribe();
    };
    // Source identity is the enclosing component key; callback and theme changes must not reopen it.
  }, [rowId, payload.html, payload.id, post]);

  const sessionReady = session !== undefined;
  useEffect(() => {
    if (!sessionReady) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      if (!cancelled) { cancelled = true; setFailed('准备运行环境超时，请重新运行'); }
    }, WIDGET_READY_TIMEOUT_MS);
    setDoc('');
    setFailed('');
    if (!appearance && hostRef.current) themeRef.current = readWidgetTheme(hostRef.current, darkRef.current);
    buildWidgetDocument(payload, { instance, dark: darkRef.current, theme: themeRef.current, state: stateRef.current, persistent: session != null,
      answerInput: answerInputRef.current ? { answer: answerInputRef.current.answer, submitted: answerInputRef.current.submitted, question: answerInputRef.current.question } : undefined })
      .then((d) => { clearTimeout(timer); if (!cancelled) setDoc(d); })
      .catch((e) => { clearTimeout(timer); if (!cancelled) setFailed(e instanceof Error ? e.message : String(e)); });
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [sessionReady, payload.html]);

  useEffect(() => {
    if (!doc || ready) return;
    const timer = setTimeout(() => {
      if (!readyRef.current) setFailed('初始化超时，脚本可能未完成或页面已离开运行环境。请重新运行');
    }, WIDGET_READY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [doc, ready]);

  useEffect(() => {
    post(WIDGET_MSG.persistent, session != null);
  }, [session, post]);

  useEffect(() => {
    if (answerInput) post(WIDGET_MSG.answerSync, { answer: answerInput.answer, submitted: answerInput.submitted, question: answerInput.question });
  }, [answerInput, post]);

  // Observe actual computed host tokens, including local course palettes and root font scale.
  // Messages never replace srcdoc: parameter values and local execution survive.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const sync = () => {
      const next = appearance ?? readWidgetTheme(host, dark);
      if (JSON.stringify(next) === JSON.stringify(themeRef.current)) return;
      themeRef.current = next;
      post(WIDGET_MSG.theme, next);
      previewChannelRef.current?.postMessage({ type: WIDGET_PREVIEW_MSG.payload, payload: payloadRef.current,
        dark: darkRef.current, appearance: next, rowId, canPrompt: !!onPromptRef.current && !disabledRef.current,
        ...(htmlSurface ? { surface: 'html' as const } : {}) } satisfies WidgetPreviewMessage);
    };
    sync();
    return appearance ? undefined : observeWidgetTheme(host, sync);
  }, [dark, appearance, post, rowId, doc, htmlSurface]);

  // 新窗口本身只拿到随机 token；它准备好后向这里请求 payload。这样既不把源码放进
  // URL，也不需要给新窗口 opener，展开后的 widget 仍然可以通过同一条桥接继续提问。
  useEffect(() => {
    if (!allowPopout || typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel(widgetPreviewChannelName(previewToken));
    previewChannelRef.current = channel;
    channel.onmessage = (event: MessageEvent<WidgetPreviewMessage>) => {
      const message = event.data;
      if (!message || typeof message.type !== 'string') return;
      if (message.type === WIDGET_PREVIEW_MSG.ready) {
        channel.postMessage({
          type: WIDGET_PREVIEW_MSG.payload,
          payload: payloadRef.current,
          dark: darkRef.current,
          appearance: themeRef.current,
          rowId,
          canPrompt: !!onPromptRef.current && !disabledRef.current,
          ...(htmlSurface ? { surface: 'html' as const } : {}),
        } satisfies WidgetPreviewMessage);
      } else if (message.type === WIDGET_PREVIEW_MSG.prompt) {
        const text = typeof message.text === 'string' ? message.text.trim() : '';
        // The preview's own host already showed the confirmation dialog. Still reject stale sources.
        void (async () => {
          let error: string | undefined;
          try {
            if (!text || disabledRef.current || !session || !onPromptRef.current)
              throw new Error('原会话暂不能追问，请回到聊天页面');
            await readWidgetState(session);
            if (!activeRef.current || disabledRef.current) throw new Error('原会话已关闭或正在生成');
            await onPromptRef.current(text);
          } catch (reason) {
            error = reason instanceof Error ? reason.message : String(reason);
          }
          if (activeRef.current) channel.postMessage({ type: WIDGET_PREVIEW_MSG.result, requestId: message.requestId, error } satisfies WidgetPreviewMessage);
        })();
      }
    };
    return () => {
      if (previewChannelRef.current === channel) previewChannelRef.current = null;
      channel.close();
    };
  }, [allowPopout, previewToken, rowId, session, htmlSurface]);

  // 预览页打开后，主题切换或 payload 替换也要同步过去；打开前的消息会被忽略，
  // 因为预览页随后一定会发 ready，ready 分支会再发送当前值。
  useEffect(() => {
    if (!allowPopout) return;
    previewChannelRef.current?.postMessage({
      type: WIDGET_PREVIEW_MSG.payload,
      payload,
      dark,
      appearance: themeRef.current,
      rowId,
      canPrompt: !!onPrompt && !disabled,
      ...(htmlSurface ? { surface: 'html' as const } : {}),
    } satisfies WidgetPreviewMessage);
  }, [allowPopout, dark, payload, rowId, onPrompt, disabled, htmlSurface]);

  const requestFollowUp = useCallback(async (raw: unknown, requestId?: number) => {
    let acquired = false;
    try {
      if (!onPromptRef.current || disabledRef.current) throw new Error('请等当前回答结束后再追问');
      if (document.visibilityState !== 'visible' || !frameRef.current?.getClientRects().length)
        throw new Error('请在可见的交互讲解中发起追问');
      if (followUpRef.current) throw new Error('请先处理已打开的追问');
      const text = normalizeWidgetPrompt(raw);
      followUpRef.current = true;
      acquired = true;
      const state = session ? await readWidgetState(session) : null;
      if (!activeRef.current) return;
      setQuestion(text);
      setActionError('');
      setFollowUp({ requestId, state });
    } catch (error) {
      if (acquired) followUpRef.current = false;
      const message = error instanceof Error ? error.message : String(error);
      setActionError(message);
      reply(requestId, message);
    }
  }, [session, reply]);

  const onMessage = useCallback(
    (e: MessageEvent) => {
      // 只认「自己那个 iframe」发来的消息，且只认 opaque origin。
      // WindowProxy may survive a navigation and sandboxed pages can remain opaque.
      // Also bind every message to this source revision/run; origin alone is insufficient.
      if (e.origin !== 'null' || !frameRef.current || e.source !== frameRef.current.contentWindow) return;
      const d = e.data as { __wbw?: string; instance?: unknown; payload?: unknown } | null;
      if (!d || typeof d.__wbw !== 'string' || d.instance !== instance) return;

      if (!activeRef.current) return;
      if (d.__wbw === WIDGET_MSG.diagnostic) {
        const diagnostic = readWidgetDiagnostic(d.payload);
        if (!diagnostic || diagnosticKeys.current.size >= MAX_WIDGET_DIAGNOSTICS) return;
        const key = `${diagnostic.kind}:${diagnostic.message}`;
        if (diagnosticKeys.current.has(key)) return;
        diagnosticKeys.current.add(key);
        setDiagnostics((current) => [...current, diagnostic]);
      } else if (d.__wbw === WIDGET_MSG.height) {
        const h = Number(d.payload);
        if (Number.isFinite(h)) setHeight(rememberWidgetHeight(heightKey, h));
      } else if (d.__wbw === WIDGET_MSG.scroll) {
        if (document.visibilityState === 'visible' && frameRef.current.getClientRects().length && (d.payload === -1 || d.payload === 1))
          hostRef.current?.dispatchEvent(new CustomEvent(WIDGET_SCROLL_INTENT, { bubbles: true }));
      } else if (d.__wbw === WIDGET_MSG.selection) {
        const value = d.payload as { text?: unknown; context?: unknown } | null;
        if (!onPromptRef.current || disabledRef.current || document.visibilityState !== 'visible') return;
        setSelection(typeof value?.text === 'string' && value.text.trim().length >= 2
          ? { text: value.text.trim().slice(0, 1600), context: typeof value.context === 'string' ? value.context.slice(0, 1800) : '' } : null);
      } else if (d.__wbw === WIDGET_MSG.prompt) {
        // Old data-wbw-prompt widgets keep working, but no iframe can silently start a model turn.
        const request = d.payload as { requestId?: number; value?: unknown } | null;
        const id = Number.isSafeInteger(request?.requestId) ? request!.requestId : undefined;
        void requestFollowUp(typeof d.payload === 'string' ? d.payload : request?.value, id);
      } else if (d.__wbw === WIDGET_MSG.state) {
        const request = d.payload as { requestId?: number; value?: unknown } | null;
        if (!Number.isSafeInteger(request?.requestId)) return;
        const id = request!.requestId;
        void (async () => {
          try {
            if (!session) throw new Error('请等回答保存完成后再保存参数');
            setStateMessage('正在保存参数…');
            await saveWidgetState(session, request?.value);
            const state = await readWidgetState(session);
            if (!activeRef.current) return;
            stateRef.current = state;
            post(WIDGET_MSG.sync, state);
            setStateMessage('参数已保存在本机');
            setActionError('');
            reply(id);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (activeRef.current) { setStateMessage(''); setActionError(message); }
            reply(id, message);
          }
        })();
      } else if (d.__wbw === WIDGET_MSG.ready) {
        if (d.payload !== 1) return;
        readyRef.current = true;
        setReady(true);
        syncDisplay();
        post(WIDGET_MSG.theme, themeRef.current ?? darkRef.current);
        post(WIDGET_MSG.sync, stateRef.current);
        post(WIDGET_MSG.persistent, session != null);
        if (answerInputRef.current) post(WIDGET_MSG.answerSync, { answer: answerInputRef.current.answer, submitted: answerInputRef.current.submitted, question: answerInputRef.current.question });
      } else if (d.__wbw === WIDGET_MSG.answerDraft || d.__wbw === WIDGET_MSG.answerSubmit) {
        const request = d.payload as { requestId?: number; value?: unknown } | null;
        if (!Number.isSafeInteger(request?.requestId)) return;
        try {
          const input = answerInputRef.current;
          if (!input || input.submitted || disabledRef.current || answerSubmitting.current || document.visibilityState !== 'visible'
            || !frameRef.current.getClientRects().length || document.activeElement !== frameRef.current) throw new Error('此处不能修改题目作答');
          if (d.__wbw === WIDGET_MSG.answerSubmit) {
            if (!input.onSubmit) throw new Error('请在宿主题卡中提交答案');
            // The iframe cannot attest trusted user activation. A native host confirmation
            // is required by onSubmit; only that gesture can finish the original tool.
            const submission = input.onSubmit(request?.value);
            answerSubmitting.current = true;
            void submission.then(() => reply(request!.requestId), error => {
              reply(request!.requestId, error instanceof Error ? error.message : '提交失败');
            }).finally(() => { answerSubmitting.current = false; });
            return;
          }
          input.onDraft(request?.value);
          setActionError('');
          reply(request!.requestId);
        } catch (error) {
          const message = error instanceof Error ? error.message : '作答草稿无效';
          setActionError(message);
          reply(request!.requestId, message);
        }
      }
      // ready / theme 之外的一律忽略：widget 不能借消息通道做别的事
    },
    [session, post, reply, requestFollowUp, syncDisplay, heightKey, instance],
  );

  useEffect(() => {
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onMessage]);

  const canPopout = allowPopout && typeof BroadcastChannel !== 'undefined';
  const previewHref = useMemo(() => {
    if (!canPopout) return '#';
    const url = new URL(window.location.href);
    url.search = '';
    url.hash = `/widget-preview?token=${encodeURIComponent(previewToken)}`;
    return url.toString();
  }, [canPopout, previewToken]);

  const cancelFollowUp = () => {
    if (sendingRef.current || !followUp) return;
    reply(followUp.requestId, '用户取消了追问');
    setFollowUp(null);
    followUpRef.current = false;
  };
  const sendFollowUp = async () => {
    if (!followUp || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    try {
      if (disabledRef.current || !onPromptRef.current) throw new Error('当前暂不能追问');
      if (session) await readWidgetState(session);
      if (!activeRef.current) return;
      if (disabledRef.current || !onPromptRef.current) throw new Error('当前暂不能追问');
      // Send the exact snapshot shown in the dialog, not parameters changed in another window meanwhile.
      await onPromptRef.current(widgetFollowUp(question, followUp.state));
      reply(followUp.requestId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (activeRef.current) setActionError(message);
      reply(followUp.requestId, message);
    } finally {
      sendingRef.current = false;
      if (activeRef.current) {
        setSending(false);
        setFollowUp(null);
        followUpRef.current = false;
      }
    }
  };

  if (!doc && !failed) {
    return (
      <div ref={hostRef} style={{ minHeight: height }} className="md-embedded-ui widget-block widget-block--loading" data-testid="widget-loading" role="status">
        正在准备图形…
      </div>
    );
  }

  return (
    <div ref={hostRef} className="md-embedded-ui widget-block" data-testid="widget-block" data-h={Math.round(height)}>
      {(failed || diagnostics.length > 0) && <div className="widget-block--error" role="alert" data-testid="widget-error">
        <p className="m-0">{failed ? `预览失败：${failed}` : (diagnostics.some((item) => item.kind === 'script' || item.kind === 'promise')
          ? '交互脚本运行出错，部分功能可能不可用。' : '部分资源被限制或未能加载，内容可能不完整。')}</p>
        <details><summary>运行详情</summary><ul>{diagnostics.map((item, index) => <li key={index}>{item.message}</li>)}</ul></details>
        <p className="m-0 text-xs">外部脚本、网络请求和动态求值不受支持。重新运行不会调用 AI，也不会修复源码错误。</p>
        <Button size="sm" variant="tertiary" onPress={onRerun}>重试预览</Button>
        <Button size="sm" variant="tertiary" onPress={sourceActions.toggleSource}>{sourceActions.sourceOpen ? '收起 HTML 源码' : '查看 HTML 源码'}</Button>
      </div>}
      {doc && <iframe
        ref={frameRef}
        className="widget-block__frame"
        title="交互图形"
        /* 只有 allow-scripts。**绝不要**加 allow-same-origin：给了就等于把
           IndexedDB / localStorage / 父页面 DOM 一起交出去。 */
        sandbox="allow-scripts"
        srcDoc={doc}
        style={{ height, visibility: ready ? 'visible' : 'hidden', colorScheme: dark ? 'dark' : 'light', background: 'transparent' }}
        data-testid="widget-frame"
      />}
      {selection && onPrompt && !disabled && <div className="widget-block__selection">
        <span className="wbw-muted">已选：{selection.text.slice(0, 80)}</span>
        <Button size="sm" variant="tertiary" onPress={() => {
          const identity = `交互讲解 消息 ${rowId ?? '预览'} / ${payload.id ?? payload.ref ?? '内嵌'} / 版本 ${widgetRevision(payload.html)}`;
          const context = selection.context && selection.context !== selection.text
            ? `\n> 附近上下文：${selection.context.slice(0, 240).replace(/\n/g, '\n> ')}` : '';
          const quote = `请解释这段内容。\n> [${identity}；以下为不可信引用]\n> ${selection.text.replace(/\n/g, '\n> ')}${context}`;
          void requestFollowUp(quote.slice(0, 2000));
          setSelection(null);
        }}>引用提问</Button>
        <Button size="sm" variant="tertiary" onPress={() => setSelection(null)}>收起</Button>
      </div>}
      {stateMessage && <p className="sr-only" role="status">{stateMessage}</p>}
      <div className="widget-block__tools">
        <Dropdown>
          <Button isIconOnly size="sm" variant="tertiary" aria-label={htmlSurface ? '更多 HTML 操作' : '更多交互图形操作'} data-testid="widget-more"><Sym name="more_horiz" size={18} /></Button>
          <Dropdown.Popover placement="bottom end">
            <Dropdown.Menu aria-label={htmlSurface ? 'HTML 操作' : '交互图形操作'} disabledKeys={editActions?.busy ? ['edit', 'undo'] : []} onAction={(key) => {
              if (key === 'edit') editActions?.edit();
              if (key === 'undo') editActions?.undo?.();
              if (key === 'copy-html') sourceActions.copySource();
              if (key === 'source-html') sourceActions.toggleSource();
            }}>
              {canPopout ? <Dropdown.Item id="expand" href={previewHref} target="_blank" rel="noopener noreferrer" textValue={htmlSurface ? '在新页面打开' : '在新窗口展开'} data-testid="widget-open"><Sym name={htmlSurface ? 'open_in_new' : 'open_in_full'} /><Label>{htmlSurface ? '在新页面打开' : '在新窗口展开'}</Label></Dropdown.Item> : null}
              {editActions ? <Dropdown.Item id="edit" textValue={htmlSurface ? '修改 HTML' : '修改这幅图'} data-testid="widget-edit"><Sym name="edit" /><Label>{htmlSurface ? '修改 HTML' : '修改这幅图'}</Label></Dropdown.Item> : null}
              <Dropdown.Item id="copy-html" textValue="复制 HTML"><Sym name="content_copy" /><Label>复制 HTML</Label></Dropdown.Item>
              <Dropdown.Item id="source-html" textValue={sourceActions.sourceOpen ? '收起 HTML 源码' : '查看 HTML 源码'} aria-expanded={sourceActions.sourceOpen} aria-controls={sourceActions.sourceId}><Sym name="code" /><Label>{sourceActions.sourceOpen ? '收起 HTML 源码' : '查看 HTML 源码'}</Label></Dropdown.Item>
              {editActions?.undo ? <Dropdown.Item id="undo" textValue="撤销上次修改"><Sym name="undo" /><Label>撤销上次修改</Label></Dropdown.Item> : null}
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      </div>
      {!htmlActions && sourceOpen && <pre id={sourceId} aria-label="HTML 源码" className="my-2 max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-default p-3 text-xs" data-testid="widget-source"><code>{payload.html}</code></pre>}
      {actionError && <p className="m-0 text-sm text-danger" role="alert">{actionError}</p>}
      {followUp && <Modal.Root isOpen onOpenChange={(open) => {
        if (!open) cancelFollowUp();
      }}>
        <Modal.Backdrop>
          <Modal.Container placement="center" size="lg" className={MODAL_CONTAINER_CLASS}>
            <Modal.Dialog data-testid="widget-follow-up-dialog">
              <Modal.Header><Modal.Heading className="text-balance">解释当前情况</Modal.Heading></Modal.Header>
              <Modal.Body>
                <div className="flex min-w-0 flex-col gap-4">
                  <p className="m-0 text-pretty text-sm text-muted">可以改写问题，也可以取消。发送后，AI 会结合下方情况继续讲解。</p>
                  <div className="flex flex-col gap-2">
                    <label htmlFor={questionId} className="text-sm font-medium">你想了解什么？</label>
                    <TextArea id={questionId} aria-label="交互讲解追问" value={question} disabled={sending} maxLength={2000} onChange={(event) => setQuestion(event.target.value)} />
                  </div>
                  {followUp.state?.modelContent != null && <section aria-label="当前情况" className="flex min-w-0 flex-col gap-2 text-sm">
                    <h3 className="m-0 text-balance text-sm font-medium">当前情况</h3>
                    <div className="max-h-48 overflow-auto break-words" data-testid="widget-follow-up-state"><WidgetStateSummary value={followUp.state.modelContent} /></div>
                    <details className="text-muted"><summary>查看将发送的参数</summary>
                      <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(followUp.state.modelContent, null, 2)}</pre>
                    </details>
                  </section>}
                  {actionError && <p className="m-0 text-sm text-danger" role="alert">{actionError}</p>}
                </div>
              </Modal.Body>
              <Modal.Footer>
                <Button variant="tertiary" isDisabled={sending} onPress={cancelFollowUp}>取消</Button>
                <Button isDisabled={disabled || sending || !question.trim()} onPress={() => void sendFollowUp()}>{sending ? '正在发送…' : '发送追问'}</Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal.Root>}
    </div>
  );
}
