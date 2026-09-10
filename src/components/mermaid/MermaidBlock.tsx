import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast, useMduiEvent } from '../../ui';
import { copyText } from '../../utils/clipboard';
import { peekMermaid, renderMermaid, toStandaloneSvg } from './mermaidRender';
import './mermaid.css';

/** 播放器快捷键（vidstack 的 keyTarget 默认是 document）——弹层里按这些键要拦下来，否则会误触播放/快进 */
const PLAYER_KEY_RE = /^(?: |Spacebar|k|j|l|m|f|c|i|arrowleft|arrowright|arrowup|arrowdown|home|end|\d)$/i;

type Phase = 'waiting' | 'rendering' | 'ok' | 'error';

/**
 * Mermaid 图表块：替代 ```mermaid 围栏的代码块渲染。
 *
 * 三种状态（对应「绝不吞信息」）：
 * - waiting：围栏还没闭合（流式中）→ 只提示「图表生成中」并给源码预览，不 parse、不抖。
 * - ok：渲染成功 → 展示 SVG + 工具条（复制源码 / 下载 / 大图 / 源码折叠）。
 * - error：语法不合法 → 错误摘要 + 源码 + 重试，用户至少能拿走源码。
 */
export default function MermaidBlock({ code, closed }: { code: string; closed: boolean }) {
  const trimmed = useMemo(() => code.replace(/\s+$/, ''), [code]);
  // 命中缓存则直接进 ok，避免重挂/流式重渲染时的闪烁
  const cached = peekMermaid(trimmed);
  const [phase, setPhase] = useState<Phase>(cached ? 'ok' : closed ? 'rendering' : 'waiting');
  const [svg, setSvg] = useState<string | null>(cached ?? null);
  const [err, setErr] = useState('');
  const [showSource, setShowSource] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);
  // 重试时自增，作为渲染 effect 的触发源
  const [retry, setRetry] = useState(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!closed) {
      setPhase('waiting');
      return;
    }
    const hit = peekMermaid(trimmed);
    if (hit) {
      setSvg(hit);
      setErr('');
      setPhase('ok');
      return;
    }
    setPhase('rendering');
    setErr('');
    renderMermaid(trimmed)
      .then((out) => {
        if (!alive.current) return;
        setSvg(out);
        setPhase('ok');
      })
      .catch((e: unknown) => {
        if (!alive.current) return;
        setErr(e instanceof Error ? e.message : String(e));
        setPhase('error');
      });
  }, [trimmed, closed, retry]);

  const copySource = useCallback(async () => {
    const ok = await copyText(trimmed);
    if (ok) toast.success('已复制 Mermaid 源码');
    else toast.error('复制失败');
  }, [trimmed]);

  const download = useCallback(() => {
    const doc = toStandaloneSvg(svg ?? '');
    const url = URL.createObjectURL(new Blob([doc], { type: 'image/svg+xml;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `diagram-${Date.now()}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  }, [svg]);

  // 受控 dialog 必须接 closed 把 state 同步回 false：mdui 自己处理 Esc / 点遮罩时
  // 只把 open 拿掉，React 不知道 —— 不接的话关掉后再点「查看大图」就再也弹不出来。
  const zoomRef = useMduiEvent('mdui-dialog', 'closed', () => setZoomOpen(false));

  /** 图标按钮 + 提示：mdui-tooltip 的默认插槽就是触发元素（trigger 属性是触发**方式**，不是选择器） */
  const iconBtn = (
    testId: string,
    label: string,
    icon: React.ReactNode,
    onClick: () => void,
    active?: boolean,
  ) => (
    <mdui-tooltip content={label}>
      {/* 「源码开着」的激活态：文档树规则能覆盖 mdui-button-icon 的 :host 颜色，
          图标走 fill:currentColor 跟随，所以一条 color 就够 */}
      <mdui-button-icon
        data-testid={testId}
        aria-label={label}
        className={active ? 'is-on' : undefined}
        onClick={onClick}
      >
        {icon}
      </mdui-button-icon>
    </mdui-tooltip>
  );

  const toolbar = (
    <div className="xmd-mermaid-tools">
      {iconBtn('mermaid-copy', '复制 Mermaid 源码', <mdui-sym-content-copy />, copySource)}
      {svg && (
        <>
          {iconBtn('mermaid-zoom', '查看大图', <mdui-sym-open-in-full />, () => setZoomOpen(true))}
          {iconBtn('mermaid-download', '下载 SVG', <mdui-sym-download />, download)}
        </>
      )}
      {iconBtn(
        'mermaid-source-toggle',
        showSource ? '隐藏源码' : '查看源码',
        <mdui-sym-code />,
        () => setShowSource((v) => !v),
        showSource,
      )}
    </div>
  );

  return (
    <div className="xmd-mermaid" data-testid="mermaid-block" data-phase={phase}>
      <div className="xmd-mermaid-head">
        <span className="xmd-mermaid-tag">Mermaid</span>
        <span className="xmd-mermaid-spacer" />
        {toolbar}
      </div>

      {phase === 'waiting' || phase === 'rendering' ? (
        <div className="xmd-mermaid-placeholder" data-testid="mermaid-pending">
          <span className="xmd-mermaid-dots" />
          <span>{phase === 'waiting' ? '图表生成中…' : '正在渲染图表…'}</span>
        </div>
      ) : phase === 'error' ? (
        <div className="xmd-mermaid-error" data-testid="mermaid-error">
          <div className="xmd-mermaid-error-title">
            <mdui-sym-warning />
            <span>图表渲染失败，已回退为源码</span>
          </div>
          <div className="xmd-mermaid-error-msg">{err}</div>
          <mdui-button data-testid="mermaid-retry" onClick={() => setRetry((v) => v + 1)}>
            <mdui-sym-refresh slot="icon" />
            重试
          </mdui-button>
        </div>
      ) : (
        svg && (
          <div
            className="xmd-mermaid-canvas"
            data-testid="mermaid-canvas"
            /* 安全性由 mermaid 的 securityLevel:'strict' + renderMermaid 里的危险特征检测保证 */
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        )
      )}

      {(showSource || phase === 'error' || phase === 'waiting') && (
        <pre className="xmd-mermaid-source" data-testid="mermaid-source">
          {trimmed}
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
        data-testid="mermaid-zoom-dialog"
      >
        <ZoomPane svg={svg ?? ''} onDownload={download} />
        <mdui-button slot="action" variant="text" onClick={() => setZoomOpen(false)}>
          关闭
        </mdui-button>
      </mdui-dialog>
    </div>
  );
}

/** 大图查看：整宽自适应 + 缩放档位；键盘事件就地拦下，避免冒泡到 vidstack 的 document 监听触发播放器快捷键 */
function ZoomPane({ svg, onDownload }: { svg: string; onDownload: () => void }) {
  const [zoom, setZoom] = useState(1);
  const boxRef = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={boxRef}
      className="xmd-mermaid-zoom"
      onKeyDownCapture={(e) => {
        if (PLAYER_KEY_RE.test(e.key)) e.stopPropagation();
      }}
    >
      <div className="xmd-mermaid-zoom-bar">
        <div className="xmd-mermaid-zoom-tools">
          <mdui-tooltip content="缩小">
            <mdui-button-icon
              data-testid="mermaid-zoom-out"
              aria-label="缩小"
              disabled={zoom <= 0.5}
              onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))}
            >
              <mdui-sym-zoom-out />
            </mdui-button-icon>
          </mdui-tooltip>
          <span className="xmd-mermaid-zoom-label" data-testid="mermaid-zoom-label">
            {Math.round(zoom * 100)}%
          </span>
          <mdui-tooltip content="放大">
            <mdui-button-icon
              data-testid="mermaid-zoom-in"
              aria-label="放大"
              disabled={zoom >= 4}
              onClick={() => setZoom((z) => Math.min(4, +(z + 0.25).toFixed(2)))}
            >
              <mdui-sym-zoom-in />
            </mdui-button-icon>
          </mdui-tooltip>
          <mdui-button data-testid="mermaid-zoom-reset" aria-label="复位" onClick={() => setZoom(1)}>
            复位
          </mdui-button>
          <mdui-button data-testid="mermaid-zoom-download" aria-label="下载 SVG" onClick={onDownload}>
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
