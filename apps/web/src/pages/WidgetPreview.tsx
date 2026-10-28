import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { WidgetPayload } from '../harness/widgetRuntime';
import type { WidgetTheme } from '../harness/widgetTheme';
import WidgetBlock, {
  WIDGET_PREVIEW_MSG,
  type WidgetPreviewMessage,
  widgetPreviewChannelName,
} from '../components/WidgetBlock';
import './widget-preview.css';

function isWidgetPayload(value: unknown): value is WidgetPayload {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { html?: unknown; libs?: unknown };
  return (
    typeof candidate.html === 'string' &&
    (candidate.libs == null ||
      (Array.isArray(candidate.libs) && candidate.libs.every((lib) => lib === 'chart.js')))
  );
}

/**
 * `WidgetBlock` 的独立窗口宿主。
 *
 * 这是应用自己的同源页面，但 HTML 只会作为 `srcdoc` 交给 WidgetBlock 内部的
 * `sandbox="allow-scripts"` iframe，不会直接插入应用 DOM；iframe 也没有同源权限。
 */
export default function WidgetPreview() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token')?.trim() ?? '';
  const channelRef = useRef<BroadcastChannel | null>(null);
  const sequence = useRef(0);
  const pending = useRef(new Map<number, { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>());
  const [payload, setPayload] = useState<WidgetPayload | null>(null);
  const [dark, setDark] = useState(false);
  const [appearance, setAppearance] = useState<WidgetTheme>();
  const [rowId, setRowId] = useState<number | undefined>();
  const [canPrompt, setCanPrompt] = useState(false);
  const [htmlSurface, setHtmlSurface] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    document.title = '交互图形';
    setError('');
    setPayload(null);
    if (!token) {
      setError('预览链接无效，请从回答中的图形卡重新打开。');
      return;
    }
    if (typeof BroadcastChannel === 'undefined') {
      setError('当前浏览器不支持独立预览，请回到回答内查看图形。');
      return;
    }

    const channel = new BroadcastChannel(widgetPreviewChannelName(token));
    channelRef.current = channel;
    channel.onmessage = (event: MessageEvent<WidgetPreviewMessage>) => {
      const message = event.data;
      if (message?.type === WIDGET_PREVIEW_MSG.result) {
        const task = pending.current.get(message.requestId);
        if (!task) return;
        pending.current.delete(message.requestId);
        clearTimeout(task.timer);
        if (message.error) task.reject(new Error(message.error)); else task.resolve();
        return;
      }
      if (message?.type !== WIDGET_PREVIEW_MSG.payload || !isWidgetPayload(message.payload)) return;
      setPayload(message.payload);
      setDark(message.dark === true);
      setAppearance(message.appearance);
      setRowId(Number.isSafeInteger(message.rowId) ? message.rowId : undefined);
      setCanPrompt(message.canPrompt === true);
      setHtmlSurface(message.surface === 'html');
      document.title = message.surface === 'html' ? 'HTML 预览' : '交互图形';
    };
    channel.postMessage({ type: WIDGET_PREVIEW_MSG.ready } satisfies WidgetPreviewMessage);
    return () => {
      channel.close();
      channelRef.current = null;
      for (const task of pending.current.values()) {
        clearTimeout(task.timer);
        task.reject(new Error('独立预览已关闭'));
      }
      pending.current.clear();
    };
  }, [token]);

  const sendPrompt = useCallback((text: string) => {
    return new Promise<void>((resolve, reject) => {
      if (!channelRef.current) { reject(new Error('请从原会话重新打开预览')); return; }
      const requestId = ++sequence.current;
      const timer = setTimeout(() => {
        pending.current.delete(requestId);
        reject(new Error('原会话没有响应，请回到聊天页面重试'));
      }, 5000);
      pending.current.set(requestId, { resolve, reject, timer });
      channelRef.current.postMessage({ type: WIDGET_PREVIEW_MSG.prompt, text, requestId } satisfies WidgetPreviewMessage);
    });
  }, []);

  return (
    <main className="page widget-preview-page" data-testid="widget-preview-page">
      <div className="widget-preview-page__inner">
        <header className="widget-preview-page__header">
          <div>
            <h1>{htmlSurface ? 'HTML 预览' : '交互图形'}</h1>
            <p>{htmlSurface ? '独立页面 · 安全预览 HTML 内容' : '独立预览 · 仍可使用图形内的交互控件'}</p>
          </div>
        </header>
        {error ? (
          <div className="widget-preview-page__message" role="alert" data-testid="widget-preview-error">
            {error}
          </div>
        ) : payload ? (
          <div className="widget-preview-page__widget">
            <WidgetBlock payload={payload} dark={dark} appearance={appearance} rowId={rowId} disabled={!canPrompt} allowPopout={false} onPrompt={sendPrompt} />
          </div>
        ) : (
          <div className="widget-preview-page__message" role="status" data-testid="widget-preview-loading">
            正在准备图形…
          </div>
        )}
      </div>
    </main>
  );
}
