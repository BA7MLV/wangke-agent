import { useCallback, useState } from 'react';
import { toast, useMduiEvent } from '../../ui';
import { copyText } from '../../utils/clipboard';
import { toStandaloneSvg } from './mermaidRender';
import './mermaid.css';

/** 播放器快捷键（vidstack 的 keyTarget 默认是 document）——弹层里按这些键要拦下来，否则会误触播放/快进 */
const PLAYER_KEY_RE = /^(?: |Spacebar|k|j|l|m|f|c|i|arrowleft|arrowright|arrowup|arrowdown|home|end|\d)$/i;

/**
 * 图表块的四态机。两条链路（mermaid / 原生 svg）共用同一组状态，语义也一致：
 * - waiting：围栏还没闭合（流式中）→ 只提示并给源码预览，不解析、不抖。
 * - rendering：内容齐了、正在出图（只有 mermaid 会停在这个态，svg 是同步净化）。
 * - ok：出图成功 → SVG + 工具条（复制源码 / 下载 / 大图 / 源码折叠）。
 * - error：语法或安全校验没过 → 错误摘要 + 源码 + 重试，用户至少能拿走源码。
 */
export type DiagramPhase = 'waiting' | 'rendering' | 'ok' | 'error';

export interface DiagramBlockProps {
  /** data-testid 前缀：`mermaid` / `svg`，决定 `-block` / `-canvas` / `-copy` … 这一整组测试钩子 */
  testId: string;
  /** 左上角标签文字 */
  tag: string;
  phase: DiagramPhase;
  svg?: string | null;
  err?: string;
  /** 围栏里的原始源码（已去掉尾部空白） */
  source: string;
  copyLabel: string;
  copyToast: string;
  waitingText: string;
  renderingText: string;
  errorTitle: string;
  /** 下载文件名前缀，最终形如 `${downloadPrefix}-1712345678901.svg` */
  downloadPrefix: string;
  /**
   * 失败态的重试回调。**不传就不显示重试按钮** —— mermaid 那边重试是有意义的
   * （渲染管线里还有 parse 与队列），而 svg 的净化是纯函数、同样的输入必然同样的结果，
   * 摆一个按不出变化的按钮只会误导用户以为「再点一下就好了」。
   */
  onRetry?: () => void;
}

/**
 * 图表块的**外壳**：头部标签 + 工具条 + 四态正文 + 源码折叠 + 大图弹层。
 *
 * 抽出来的理由：mermaid 与原生 svg 的差别只在「源码怎么变成 SVG」这一步，
 * 而外壳里的坑是共通的 —— `<pre>` 外壳剥离、源码折叠与激活态、下载补 xml 头、
 * 大图弹层的缩放档位、以及**弹层里必须拦下播放器快捷键**（vidstack 监听 document）。
 * 两套各写一遍就是把这些坑各踩一遍。各链路的组件只负责产出 `phase` / `svg` / `err`。
 */
export default function DiagramBlock({
  testId,
  tag,
  phase,
  svg,
  err,
  source,
  copyLabel,
  copyToast,
  waitingText,
  renderingText,
  errorTitle,
  downloadPrefix,
  onRetry,
}: DiagramBlockProps) {
  const [showSource, setShowSource] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);

  const copySource = useCallback(async () => {
    const ok = await copyText(source);
    if (ok) toast.success(copyToast);
    else toast.error('复制失败');
  }, [source, copyToast]);

  const download = useCallback(() => {
    const doc = toStandaloneSvg(svg ?? '');
    const url = URL.createObjectURL(new Blob([doc], { type: 'image/svg+xml;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${downloadPrefix}-${Date.now()}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  }, [svg, downloadPrefix]);

  // 受控 dialog 必须接 closed 把 state 同步回 false：mdui 自己处理 Esc / 点遮罩时
  // 只把 open 拿掉，React 不知道 —— 不接的话关掉后再点「查看大图」就再也弹不出来。
  const zoomRef = useMduiEvent('mdui-dialog', 'closed', () => setZoomOpen(false));

  /** 图标按钮 + 提示：mdui-tooltip 的默认插槽就是触发元素（trigger 属性是触发**方式**，不是选择器） */
  const iconBtn = (suffix: string, label: string, icon: React.ReactNode, onClick: () => void, active?: boolean) => (
    <mdui-tooltip content={label}>
      {/* 「源码开着」的激活态：文档树规则能覆盖 mdui-button-icon 的 :host 颜色，
          图标走 fill:currentColor 跟随，所以一条 color 就够 */}
      <mdui-button-icon
        data-testid={`${testId}-${suffix}`}
        aria-label={label}
        className={active ? 'is-on' : undefined}
        onClick={onClick}
      >
        {icon}
      </mdui-button-icon>
    </mdui-tooltip>
  );

  return (
    <div className="xmd-mermaid" data-testid={`${testId}-block`} data-phase={phase}>
      <div className="xmd-mermaid-head">
        <span className="xmd-mermaid-tag">{tag}</span>
        <span className="xmd-mermaid-spacer" />
        <div className="xmd-mermaid-tools">
          {iconBtn('copy', copyLabel, <mdui-sym-content-copy />, copySource)}
          {svg && (
            <>
              {iconBtn('zoom', '查看大图', <mdui-sym-open-in-full />, () => setZoomOpen(true))}
              {iconBtn('download', '下载 SVG', <mdui-sym-download />, download)}
            </>
          )}
          {iconBtn(
            'source-toggle',
            showSource ? '隐藏源码' : '查看源码',
            <mdui-sym-code />,
            () => setShowSource((v) => !v),
            showSource,
          )}
        </div>
      </div>

      {phase === 'waiting' || phase === 'rendering' ? (
        <div className="xmd-mermaid-placeholder" data-testid={`${testId}-pending`}>
          <span className="xmd-mermaid-dots" />
          <span>{phase === 'waiting' ? waitingText : renderingText}</span>
        </div>
      ) : phase === 'error' ? (
        <div className="xmd-mermaid-error" data-testid={`${testId}-error`}>
          <div className="xmd-mermaid-error-title">
            <mdui-sym-warning />
            <span>{errorTitle}</span>
          </div>
          <div className="xmd-mermaid-error-msg">{err}</div>
          {onRetry && (
            <mdui-button data-testid={`${testId}-retry`} onClick={onRetry}>
              <mdui-sym-refresh slot="icon" />
              重试
            </mdui-button>
          )}
        </div>
      ) : (
        svg && (
          /* 安全性：调用方负责。mermaid 走 securityLevel:'strict' + 危险特征检测；
             原生 svg 走 svgRender.ts 的白名单净化。这里不再二次净化。 */
          <div
            className="xmd-mermaid-canvas"
            data-testid={`${testId}-canvas`}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        )
      )}

      {(showSource || phase === 'error' || phase === 'waiting') && (
        <pre className="xmd-mermaid-source" data-testid={`${testId}-source`}>
          {source}
        </pre>
      )}

      {/* 「查看大图」保持原来 92vw / 上限 1400px 的观感：mdui-dialog 的面板尺寸在 shadow 里
          （.panel{max-width:35rem}），但它暴露了 part="panel"，从文档树用 ::part() 正当改写。 */}
      <mdui-dialog
        ref={zoomRef}
        className="mermaid-zoom-dialog"
        open={zoomOpen}
        headline="查看大图"
        close-on-esc
        close-on-overlay-click
        data-testid={`${testId}-zoom-dialog`}
      >
        <ZoomPane testId={testId} svg={svg ?? ''} onDownload={download} />
        <mdui-button slot="action" variant="text" onClick={() => setZoomOpen(false)}>
          关闭
        </mdui-button>
      </mdui-dialog>
    </div>
  );
}

/** 大图查看：整宽自适应 + 缩放档位；键盘事件就地拦下，避免冒泡到 vidstack 的 document 监听触发播放器快捷键 */
function ZoomPane({ testId, svg, onDownload }: { testId: string; svg: string; onDownload: () => void }) {
  const [zoom, setZoom] = useState(1);

  return (
    <div
      className="xmd-mermaid-zoom"
      onKeyDownCapture={(e) => {
        if (PLAYER_KEY_RE.test(e.key)) e.stopPropagation();
      }}
    >
      <div className="xmd-mermaid-zoom-bar">
        <div className="xmd-mermaid-zoom-tools">
          <mdui-tooltip content="缩小">
            <mdui-button-icon
              data-testid={`${testId}-zoom-out`}
              aria-label="缩小"
              disabled={zoom <= 0.5}
              onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))}
            >
              <mdui-sym-zoom-out />
            </mdui-button-icon>
          </mdui-tooltip>
          <span className="xmd-mermaid-zoom-label" data-testid={`${testId}-zoom-label`}>
            {Math.round(zoom * 100)}%
          </span>
          <mdui-tooltip content="放大">
            <mdui-button-icon
              data-testid={`${testId}-zoom-in`}
              aria-label="放大"
              disabled={zoom >= 4}
              onClick={() => setZoom((z) => Math.min(4, +(z + 0.25).toFixed(2)))}
            >
              <mdui-sym-zoom-in />
            </mdui-button-icon>
          </mdui-tooltip>
          <mdui-button data-testid={`${testId}-zoom-reset`} aria-label="复位" onClick={() => setZoom(1)}>
            复位
          </mdui-button>
          <mdui-button data-testid={`${testId}-zoom-download`} aria-label="下载 SVG" onClick={onDownload}>
            <mdui-sym-download slot="icon" />
            下载 SVG
          </mdui-button>
        </div>
      </div>
      <div className="xmd-mermaid-zoom-scroll">
        <div className="xmd-mermaid-zoom-inner" style={{ width: `${zoom * 100}%` }} dangerouslySetInnerHTML={{ __html: svg }} />
      </div>
    </div>
  );
}
