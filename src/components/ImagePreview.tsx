import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Modal } from '@heroui/react';
import { MODAL_CONTAINER_CLASS, Sym } from '../ui';
import './image-preview.css';

type PreviewContent =
  | { kind: 'image'; src: string; onError?: () => void }
  // Only SVG already checked by its rendering pipeline may enter this viewer.
  | { kind: 'svg'; svg: string };

interface ImagePreviewProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  content?: PreviewContent;
  /** Stable across thumbnail → original URL changes; changes reset zoom and scroll. */
  contentKey?: string;
  status?: ReactNode;
  footer?: ReactNode;
  onDownload?: () => void;
  downloadLabel?: string;
  navigation?: { index: number; total: number; onChange: (index: number) => void };
  testId?: string;
  testIdPrefix?: string;
}

// Vidstack listens on document. Stop bubbling from the whole dialog, not just
// the canvas, without swallowing Escape, Tab or a button's own keyboard action.
const PLAYER_KEY_RE = /^(?: |Spacebar|k|j|l|m|f|c|i|arrowleft|arrowright|arrowup|arrowdown|home|end|\d)$/i;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;

/** One modal, sizing model and set of controls for raster images and inline SVG. */
export default function ImagePreview(props: ImagePreviewProps) {
  const { isOpen, onOpenChange, contentKey } = props;
  return <Modal.Root isOpen={isOpen} onOpenChange={onOpenChange}>
    <Modal.Backdrop>
      <Modal.Container placement="center" size="lg" className={`${MODAL_CONTAINER_CLASS} image-preview-container`}>
        <PreviewPane key={contentKey} {...props} />
      </Modal.Container>
    </Modal.Backdrop>
  </Modal.Root>;
}

function PreviewPane({ title, content, status, footer, onOpenChange, onDownload, downloadLabel = '下载图片', navigation, testId = 'image-preview-dialog', testIdPrefix = 'image-preview' }: ImagePreviewProps) {
  const [zoom, setZoom] = useState(1);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [intrinsic, setIntrinsic] = useState({ width: 0, height: 0 });
  const scroll = useRef<HTMLDivElement>(null);
  const svgRoot = useRef<HTMLDivElement>(null);
  const svg = content?.kind === 'svg' ? content.svg : undefined;

  useLayoutEffect(() => {
    const el = scroll.current;
    if (!el) return;
    // Also keeps keyboard navigation inside the viewer when changing images.
    el.focus({ preventScroll: true });
    const measure = () => setViewport({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const el = svgRoot.current?.querySelector('svg');
    if (!el) return;
    const box = el.viewBox.baseVal;
    setIntrinsic({ width: box.width || el.width.baseVal.value || 800, height: box.height || el.height.baseVal.value || 600 });
  }, [svg]);

  // 100% always means the entire image fits, including very tall PDF pages and
  // very wide diagrams. Both media use the same pixel box at every zoom level.
  const scale = intrinsic.width > 0 && intrinsic.height > 0
    ? Math.min(viewport.width / intrinsic.width, viewport.height / intrinsic.height) * zoom : 0;
  const width = intrinsic.width * scale;
  const height = intrinsic.height * scale;
  const resize = (next: number) => setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next)));
  const reset = () => {
    setZoom(1);
    if (scroll.current) { scroll.current.scrollLeft = 0; scroll.current.scrollTop = 0; }
  };
  const hasGallery = !!navigation && navigation.total > 1;

  return <div className="image-preview-events"
    onKeyDown={(event) => {
      if (PLAYER_KEY_RE.test(event.key)) event.stopPropagation();
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if (hasGallery && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        event.preventDefault();
        const next = navigation.index + (event.key === 'ArrowLeft' ? -1 : 1);
        if (next >= 0 && next < navigation.total) navigation.onChange(next);
      }
      if (event.target !== scroll.current || !content) return;
      if (event.key === '+' || event.key === '=' || event.key === '-') {
        event.preventDefault(); resize(zoom + (event.key === '-' ? -0.5 : 0.5));
      } else if (event.key === '0') { event.preventDefault(); reset(); }
    }}
    onKeyUp={(event) => { if (PLAYER_KEY_RE.test(event.key)) event.stopPropagation(); }}>
    <Modal.Dialog className="image-preview" data-testid={testId} data-zoom={zoom}>
      <Modal.Header className="image-preview__header">
        <Modal.Heading className="image-preview__title" title={title}>{title}</Modal.Heading>
        {hasGallery && <span className="image-preview__count" aria-live="polite">{navigation.index + 1} / {navigation.total}</span>}
        <Button isIconOnly variant="tertiary" aria-label="关闭图片预览" onPress={() => onOpenChange(false)}><Sym name="close" /></Button>
      </Modal.Header>
      <Modal.Body className="image-preview__body">
        <div ref={scroll} className="image-preview__scroll" tabIndex={0} role="region" aria-label="图片，可缩放并滚动查看">
          {content ? <div className="image-preview__stage" style={{ width, height }}>
            <div className="image-preview__content" style={{ width, height, visibility: scale > 0 ? undefined : 'hidden' }}
              onDoubleClick={() => zoom === 1 ? resize(2) : reset()}>
              {content.kind === 'image' ? <img src={content.src} alt={title} decoding="async" referrerPolicy="no-referrer"
                onLoad={(event) => setIntrinsic({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
                onError={content.onError} />
                : <div ref={svgRoot} className="image-preview__svg" role="img" aria-label={title} dangerouslySetInnerHTML={{ __html: content.svg }} />}
            </div>
          </div> : <div className="image-preview__status">{status}</div>}
        </div>
      </Modal.Body>
      <Modal.Footer className="image-preview__footer">
        {footer && <div className="image-preview__origin">{footer}</div>}
        <div className="image-preview__tools">
          {hasGallery && <Button isIconOnly variant="tertiary" aria-label="上一张图片" isDisabled={navigation.index === 0} onPress={() => navigation.onChange(navigation.index - 1)}><Sym name="chevron_left" /></Button>}
          <Button isIconOnly variant="tertiary" aria-label="缩小图片" data-testid={`${testIdPrefix}-zoom-out`} isDisabled={!content || zoom <= MIN_ZOOM} onPress={() => resize(zoom - 0.5)}><Sym name="zoom_out" /></Button>
          <Button variant="tertiary" aria-label="适应窗口" data-testid={`${testIdPrefix}-zoom-reset`} isDisabled={!content} onPress={reset}>
            <span className="image-preview__zoom" data-testid={`${testIdPrefix}-zoom-label`}>{Math.round(zoom * 100)}%</span>
          </Button>
          <Button isIconOnly variant="tertiary" aria-label="放大图片" data-testid={`${testIdPrefix}-zoom-in`} isDisabled={!content || zoom >= MAX_ZOOM} onPress={() => resize(zoom + 0.5)}><Sym name="zoom_in" /></Button>
          {onDownload && <Button isIconOnly variant="tertiary" aria-label={downloadLabel} data-testid={`${testIdPrefix}-zoom-download`} onPress={onDownload}><Sym name="download" /></Button>}
          {hasGallery && <Button isIconOnly variant="tertiary" aria-label="下一张图片" isDisabled={navigation.index === navigation.total - 1} onPress={() => navigation.onChange(navigation.index + 1)}><Sym name="chevron_right" /></Button>}
        </div>
      </Modal.Footer>
    </Modal.Dialog>
  </div>;
}
