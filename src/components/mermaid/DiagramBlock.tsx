import { useCallback, useState } from 'react';
import { Button, Modal, Tooltip, Skeleton, Dropdown, Label } from '@heroui/react';
import { Sym, toast, MODAL_CONTAINER_CLASS } from '../../ui';
import { copyText } from '../../utils/clipboard';
import { toStandaloneSvg } from './mermaidRender';
import type { SvgProgress } from './svgRender';
import type { DiagramShape } from './diagramSchema';
import LiveSvg from './LiveSvg';
import DiagramCanvas from './DiagramCanvas';
import './mermaid.css';

/** 播放器快捷键（vidstack 的 keyTarget 默认是 document）——弹层里按这些键要拦下来，否则会误触播放/快进 */
const PLAYER_KEY_RE = /^(?: |Spacebar|k|j|l|m|f|c|i|arrowleft|arrowright|arrowup|arrowdown|home|end|\d)$/i;

/**
 * 图表块的状态机。三条链路（mermaid / diagram / svg）共用同一组状态，语义也一致：
 * - waiting：围栏还没闭合、且暂时落不了画 → 只提示并给源码预览，不解析、不抖。
 * - drawing：**只有 svg 与 diagram 链路会停在这个态**：半截内容已经能画出个大概了，
 *   边生成边往画布上追加，下面那句「生成中」退成一行小提示（见 LiveSvg / DiagramCanvas）。
 * - rendering：内容齐了、正在出图（只有 mermaid 会停在这个态，另两条是同步计算）。
 * - ok：出图成功 → SVG + 工具条（复制源码 / 下载 / 大图 / 源码折叠）。
 * - error：语法或安全校验没过 → 错误摘要 + 源码 + 重试，用户至少能拿走源码。
 */
export type DiagramPhase = 'waiting' | 'drawing' | 'rendering' | 'ok' | 'error';

/**
 * 流式落画快照（`phase === 'drawing'` 时才有）。两条链路各自的媒介不同：
 * - `svg`：半截 SVG 源码切出的根属性 + 已完整元素（LiveSvg 消费）；
 * - `diagram`：渲染器算出的画布尺寸 + 带 key 的逻辑图元（DiagramCanvas 消费）。
 */
export type DiagramStream =
  | { kind: 'svg'; progress: SvgProgress }
  | { kind: 'diagram'; viewBox: string; shapes: DiagramShape[] };

export interface DiagramBlockProps {
  /** data-testid 前缀：`mermaid` / `diagram` / `svg`，决定 `-block` / `-canvas` / `-copy` … 这一整组测试钩子 */
  testId: string;
  /** 左上角标签文字 */
  tag: string;
  /**
   * 模型在围栏参数里给的标题（```diagram title="抛物线开口方向"），已由 fence.ts 规范化。
   *
   * 为什么不塞进 JSON schema / 不要求模型自己画一行标题文字：
   * - 三条链路（mermaid / diagram / svg）共用这一个位置，模型只记一种写法；
   * - 它是「这张图叫什么」的元信息，不是图里的内容，混进 nodes / curves 会让 schema 多一个层级；
   * - **围栏首行一到就有**，流式期间图还没画完，标题已经在块头上了。
   *
   * 没写则只显示图种标签 —— 老内容（2026-10-16 之前存进 IndexedDB 的问答与题卡）不会变样。
   */
  title?: string | null;
  phase: DiagramPhase;
  svg?: string | null;
  /** 流式落画快照（`phase === 'drawing'` 时才有）。mermaid 链路不传。 */
  stream?: DiagramStream | null;
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
  title,
  phase,
  svg,
  stream,
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
    a.download = `${fileStem(title, downloadPrefix)}-${Date.now()}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  }, [svg, downloadPrefix, title]);

  const downloadJson = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(JSON.parse(source), null, 2) + '\n'], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${fileStem(title, downloadPrefix)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="md-embedded-ui xmd-mermaid" data-testid={`${testId}-block`} data-phase={phase} aria-busy={phase === 'waiting' || phase === 'drawing' || phase === 'rendering'}>
      <div className="xmd-mermaid-head">
        {/* 标题：围栏参数里的那张图的名字。超长会被 fence.ts 截断，所以再挂一个 title 属性 ——
            与原生 SVG/HTML 的 title 一样，悬停看全。 */}
        {title ? (
          <span className="xmd-mermaid-title" title={title} data-testid={`${testId}-title`}>
            {title}
          </span>
        ) : <span className="xmd-mermaid-tag">{tag}</span>}
        <span className="xmd-mermaid-spacer" />
        <div className="xmd-mermaid-tools">
          <Dropdown>
            <Button isIconOnly size="sm" variant="tertiary" aria-label="更多图形操作" data-testid={`${testId}-more`}>
              <Sym name="more_horiz" size={18} />
            </Button>
            <Dropdown.Popover placement="bottom end">
              <Dropdown.Menu aria-label="图形操作" onAction={(key) => {
                if (key === 'copy') void copySource();
                else if (key === 'zoom') setZoomOpen(true);
                else if (key === 'download') download();
                else if (key === 'download-json') downloadJson();
                else if (key === 'source') setShowSource((v) => !v);
              }}>
                <Dropdown.Item id="copy" textValue={copyLabel} data-testid={`${testId}-copy`}><Sym name="content_copy" /><Label>{copyLabel}</Label></Dropdown.Item>
                {svg ? <Dropdown.Item id="zoom" textValue="查看大图" data-testid={`${testId}-zoom`}><Sym name="open_in_full" /><Label>查看大图</Label></Dropdown.Item> : null}
                {svg ? <Dropdown.Item id="download" textValue="下载 SVG" data-testid={`${testId}-download`}><Sym name="download" /><Label>下载 SVG</Label></Dropdown.Item> : null}
                {svg && testId === 'diagram' && phase === 'ok' ? <Dropdown.Item id="download-json" textValue="下载 JSON" data-testid={`${testId}-download-json`}><Sym name="code" /><Label>下载 JSON</Label></Dropdown.Item> : null}
                <Dropdown.Item id="source" textValue={showSource ? '隐藏源码' : '查看源码'} data-testid={`${testId}-source-toggle`}><Sym name="code" /><Label>{showSource ? '隐藏源码' : '查看源码'}</Label></Dropdown.Item>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
        </div>
      </div>

      {phase === 'waiting' || phase === 'rendering' ? (
        <div className="xmd-mermaid-placeholder" data-testid={`${testId}-pending`}>
          <Skeleton className="h-16 w-24 rounded-lg motion-reduce:animate-none" />
          <span role="status">{phase === 'waiting' ? waitingText : renderingText}</span>
        </div>
      ) : (phase === 'drawing' || phase === 'ok') && stream ? (
        <>
          {/* 画布先出，提示退成一行小字：空图也有正确的宽高比（viewBox 一到手就定了），
              所以整块不会随着内容增长来回跳。追加过程见 LiveSvg / DiagramCanvas。 */}
          <div className="xmd-mermaid-canvas" data-testid={`${testId}-canvas`}>
            {stream.kind === 'svg' ? (
              <LiveSvg rootAttrs={stream.progress.rootAttrs} elements={stream.progress.elements} />
            ) : (
              <DiagramCanvas viewBox={stream.viewBox} shapes={stream.shapes} label={title ?? '图表'} />
            )}
          </div>
        </>
      ) : phase === 'error' ? (
        <div className="xmd-mermaid-error" data-testid={`${testId}-error`} role="alert">
<div className="xmd-mermaid-error-title">
          <Sym name="warning" />
          <span>{errorTitle}</span>
        </div>
        <div className="xmd-mermaid-error-msg">{err}</div>
        {onRetry && (
          <Button variant="secondary" data-testid={`${testId}-retry`} onPress={onRetry}>
            <Sym name="refresh" />
            重试
          </Button>
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

      {showSource && (
        <pre className="xmd-mermaid-source" data-testid={`${testId}-source`}>
          {source}
        </pre>
      )}

      {/* 「查看大图」：面板尺寸写在 .mermaid-zoom-dialog 的 Modal.Dialog 上 */}
      <Modal.Root isOpen={zoomOpen} onOpenChange={setZoomOpen}>
        <Modal.Backdrop>
          <Modal.Container placement="center" size="lg" className={MODAL_CONTAINER_CLASS}>
            <Modal.Dialog className="mermaid-zoom-dialog" data-testid={`${testId}-zoom-dialog`}>
              <Modal.Header>
                <Modal.Heading>{title ? `${title} · 查看大图` : '查看大图'}</Modal.Heading>
              </Modal.Header>
              <Modal.Body>
                <ZoomPane testId={testId} svg={svg ?? ''} onDownload={download} />
              </Modal.Body>
              <Modal.Footer>
                <Button variant="tertiary" onPress={() => setZoomOpen(false)}>
                  关闭
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal.Root>
    </div>
  );
}

/**
 * 下载文件名的前缀：有标题就用标题，否则用调用方给的图种前缀。
 *
 * 标题是**模型写的**，可能带 `/`、`:`、`?` 这类路径与系统保留字符（"二次函数 y=x²/开口" 就能写出来），
 * 直接当文件名会拼出意外路径或被系统拒绝，所以统一换成 `_`；再按 30 个字以内收住，
 * 免得一个长标题把文件名顶到系统上限。
 */
function fileStem(title: string | null | undefined, fallback: string): string {
  const s = (title ?? '').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
  return s ? [...s].slice(0, 30).join('') : fallback;
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
          <Tooltip>
              <Button
                isIconOnly
                variant="tertiary"
                data-testid={`${testId}-zoom-out`}
                aria-label="缩小"
                isDisabled={zoom <= 0.5}
                onPress={() => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))}
              >
                <Sym name="zoom-out" />
              </Button>
            <Tooltip.Content>缩小</Tooltip.Content>
          </Tooltip>
          <span className="xmd-mermaid-zoom-label" data-testid={`${testId}-zoom-label`}>
            {Math.round(zoom * 100)}%
          </span>
          <Tooltip>
              <Button
                isIconOnly
                variant="tertiary"
                data-testid={`${testId}-zoom-in`}
                aria-label="放大"
                isDisabled={zoom >= 4}
                onPress={() => setZoom((z) => Math.min(4, +(z + 0.25).toFixed(2)))}
              >
                <Sym name="zoom-in" />
              </Button>
            <Tooltip.Content>放大</Tooltip.Content>
          </Tooltip>
          <Button
            variant="tertiary"
            data-testid={`${testId}-zoom-reset`}
            aria-label="复位"
            onPress={() => setZoom(1)}
          >
            复位
          </Button>
          <Button
            variant="tertiary"
            data-testid={`${testId}-zoom-download`}
            aria-label="下载 SVG"
            onPress={onDownload}
          >
            <Sym name="download" />
            下载 SVG
          </Button>
        </div>
      </div>
      <div className="xmd-mermaid-zoom-scroll">
        <div className="xmd-mermaid-zoom-inner" style={{ width: `${zoom * 100}%` }} dangerouslySetInnerHTML={{ __html: svg }} />
      </div>
    </div>
  );
}
