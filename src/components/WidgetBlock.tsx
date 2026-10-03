import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildWidgetDocument, WIDGET_MSG, type WidgetPayload } from '../harness/widgetRuntime';

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
 * 两者都会校验 `event.source === iframe.contentWindow`，所以别的页面伪造同名消息无效。
 */

interface Props {
  payload: WidgetPayload;
  /** 深色模式（宿主的主题设置，不是系统偏好） */
  dark: boolean;
  /** widget 请求继续对话时调用（文本就是用户在 widget 里点的那句话） */
  onPrompt?: (text: string) => void;
}

const MIN_H = 80;
const MAX_H = 2000;

export default function WidgetBlock({ payload, dark, onPrompt }: Props) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(MIN_H);
  const [doc, setDoc] = useState('');
  const [failed, setFailed] = useState('');

  useEffect(() => {
    let cancelled = false;
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

  const onMessage = useCallback(
    (e: MessageEvent) => {
      // 只认「自己那个 iframe」发来的消息，且只认约定的形状
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return;
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
  const themed = useMemo(() => doc.replace('<body>', `<body data-wbw-theme="${dark ? 'dark' : 'light'}">`), [doc, dark]);

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