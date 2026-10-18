import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildWidgetDocument, WIDGET_MSG, type WidgetPayload } from '../harness/widgetRuntime';
import { Sym } from '../ui';
import './widget-block.css';

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
 * ## 宿主只做两件事
 *
 * 收高度（决定 iframe 高度）、收 prompt（把用户点击转成新一轮提问）。
 * 两者都会校验 `event.source === iframe.contentWindow` 与 opaque origin
 * `event.origin === "null"`，所以外部页面不能伪造同名消息。
 */

interface Props {
  payload: WidgetPayload;
  /** 深色模式（宿主的主题设置，不是系统偏好） */
  dark: boolean;
  /** widget 请求继续对话时调用（文本就是用户在 widget 里点的那句话） */
  onPrompt?: (text: string) => void;
  /** 独立预览页不再显示「在新窗口展开」，避免从新窗口继续打开新窗口。 */
  allowPopout?: boolean;
}

/**
 * 展开预览只传一个随机 token，真正的 HTML 通过 BroadcastChannel 传递。
 * 因此源码不会进入 URL、浏览器历史或可复制的链接，也不会让新窗口接触宿主 DOM。
 */
export const WIDGET_PREVIEW_MSG = {
  ready: 'widget-preview:ready',
  payload: 'widget-preview:payload',
  prompt: 'widget-preview:prompt',
} as const;

export type WidgetPreviewMessage =
  | { type: typeof WIDGET_PREVIEW_MSG.ready }
  | { type: typeof WIDGET_PREVIEW_MSG.payload; payload: WidgetPayload; dark: boolean }
  | { type: typeof WIDGET_PREVIEW_MSG.prompt; text: string };

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
const MAX_H = 2000;

export default function WidgetBlock({ payload, dark, onPrompt, allowPopout = true }: Props) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const previewTokenRef = useRef<string | null>(null);
  const previewChannelRef = useRef<BroadcastChannel | null>(null);
  if (!previewTokenRef.current) previewTokenRef.current = createPreviewToken();
  const previewToken = previewTokenRef.current;
  const payloadRef = useRef(payload);
  const darkRef = useRef(dark);
  const onPromptRef = useRef(onPrompt);
  payloadRef.current = payload;
  darkRef.current = dark;
  onPromptRef.current = onPrompt;
  const [height, setHeight] = useState(MIN_H);
  const [doc, setDoc] = useState('');
  const [failed, setFailed] = useState('');

  useEffect(() => {
    let cancelled = false;
    setDoc('');
    setFailed('');
    buildWidgetDocument(payload)
      .then((d) => !cancelled && setDoc(d))
      .catch((e) => !cancelled && setFailed(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [payload]);

  // 主题变化后要重新挂载才能拿到新的 srcdoc —— 不透明源下拿不到 document，
  // 所以只能整份换掉。（代价是重跑一次脚本，对图表 widget 是可接受的。）
  useEffect(() => setHeight(MIN_H), [dark]);

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
        } satisfies WidgetPreviewMessage);
      } else if (message.type === WIDGET_PREVIEW_MSG.prompt) {
        const text = typeof message.text === 'string' ? message.text.trim() : '';
        if (text) onPromptRef.current?.(text);
      }
    };
    return () => {
      if (previewChannelRef.current === channel) previewChannelRef.current = null;
      channel.close();
    };
  }, [allowPopout, previewToken]);

  // 预览页打开后，主题切换或 payload 替换也要同步过去；打开前的消息会被忽略，
  // 因为预览页随后一定会发 ready，ready 分支会再发送当前值。
  useEffect(() => {
    if (!allowPopout) return;
    previewChannelRef.current?.postMessage({
      type: WIDGET_PREVIEW_MSG.payload,
      payload,
      dark,
    } satisfies WidgetPreviewMessage);
  }, [allowPopout, dark, payload]);

  const onMessage = useCallback(
    (e: MessageEvent) => {
      // 只认「自己那个 iframe」发来的消息，且只认 opaque origin。
      // 只校验 source 不够：iframe 自己导航到外部页面后 contentWindow
      // 仍然相同，外部页面可能伪造同名消息；opaque sandbox 的 origin 必须是 "null"。
      if (e.origin !== 'null' || !frameRef.current || e.source !== frameRef.current.contentWindow) return;
      const d = e.data as { __wbw?: string; payload?: unknown } | null;
      if (!d || typeof d.__wbw !== 'string') return;

      if (d.__wbw === WIDGET_MSG.height) {
        const h = Number(d.payload);
        if (Number.isFinite(h)) setHeight(Math.min(MAX_H, Math.max(MIN_H, h)));
      } else if (d.__wbw === WIDGET_MSG.prompt) {
        const t = typeof d.payload === 'string' ? d.payload.trim() : '';
        if (t) onPrompt?.(t);
      }
      // ready / theme 之外的一律忽略：widget 不能借消息通道做别的事
    },
    [onPrompt],
  );

  useEffect(() => {
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onMessage]);

  // 主题直接随 srcdoc 首屏注入，不靠消息通道 —— 省一次往返，也少一个能被伪造的面
  // The runtime stylesheet scopes dark colors to html[data-wbw-theme]. Keep
  // the marker on the document root rather than body so it matches that
  // contract (and so a widget's own body markup cannot shadow it).
  const themed = useMemo(
    () => doc.replace('<html lang="zh-CN">', `<html lang="zh-CN" data-wbw-theme="${dark ? 'dark' : 'light'}">`),
    [doc, dark],
  );
  const canPopout = allowPopout && typeof BroadcastChannel !== 'undefined';
  const previewHref = useMemo(() => {
    if (!canPopout) return '#';
    const url = new URL(window.location.href);
    url.search = '';
    url.hash = `/widget-preview?token=${encodeURIComponent(previewToken)}`;
    return url.toString();
  }, [canPopout, previewToken]);

  if (failed) {
    return (
      <div className="widget-block widget-block--error" data-testid="widget-error">
        这个图形没能加载起来：{failed}
      </div>
    );
  }
  if (!themed) {
    return (
      <div className="widget-block widget-block--loading" data-testid="widget-loading">
        正在准备图形…
      </div>
    );
  }

  return (
    <div className="widget-block" data-testid="widget-block" data-h={Math.round(height)}>
      {allowPopout && (
        <div className="widget-block__toolbar">
          {canPopout ? (
            <a
              className="widget-block__open"
              href={previewHref}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="widget-open"
            >
              <Sym name="open_in_full" />
              <span>在新窗口展开</span>
            </a>
          ) : (
            <span className="widget-block__open widget-block__open--disabled">当前浏览器不支持独立预览</span>
          )}
        </div>
      )}
      <iframe
        ref={frameRef}
        className="widget-block__frame"
        title="交互图形"
        /* 只有 allow-scripts。**绝不要**加 allow-same-origin：给了就等于把
           IndexedDB / localStorage / 父页面 DOM 一起交出去。 */
        sandbox="allow-scripts"
        srcDoc={themed}
        style={{ height }}
        data-testid="widget-frame"
      />
    </div>
  );
}
