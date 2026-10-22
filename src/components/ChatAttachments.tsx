import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button, Modal, Spinner } from '@heroui/react';
import { useChatAttachments } from '../store/chatAttachments';
import { attachmentSize, type ChatAttachment } from '../chat/attachments';
import { downloadAttachment, readAttachmentBlob } from '../chat/prepareAttachment';
import { MODAL_CONTAINER_CLASS, Sym, toast } from '../ui';
import { prefersReducedMotion } from '../utils/motion';
import './chat-attachments.css';

/** The same accessible viewer serves composer thumbnails and persisted messages. */
function ChatImage({ file, images, draft = false }: { file: ChatAttachment; images: ChatAttachment[]; draft?: boolean }) {
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [failed, setFailed] = useState(false);
  const current = images[index] || file;
  const [original, setOriginal] = useState<{ id: string; url: string }>();
  // Read the original only while open; revoke its URL on close, navigation or unmount.
  // The stored preview remains usable if the original has since been cleaned up.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let url = '';
    void readAttachmentBlob(current).then((blob) => {
      if (cancelled) return;
      url = URL.createObjectURL(blob);
      setOriginal({ id: current.id, url });
    }).catch(() => {});
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [open, current]);
  const source = open && original?.id === current.id ? original.url : current.dataUrl;
  const navigate = (next: number) => { setIndex(next); setZoom(1); setFailed(false); setOriginal(undefined); };
  return <>
    <Button variant="ghost" className={draft ? 'chat-image chat-image--draft' : 'chat-image'} aria-label={`预览图片 ${file.name}`}
      onPress={() => { navigate(Math.max(0, images.findIndex((image) => image.id === file.id))); setOpen(true); }}>
      <img src={file.dataUrl} alt={file.name} loading={draft ? 'eager' : 'lazy'} decoding="async" />
    </Button>
    <Modal.Root isOpen={open} onOpenChange={setOpen}>
      <Modal.Backdrop><Modal.Container placement="center" size="lg" className={`${MODAL_CONTAINER_CLASS} chat-image-viewer-container`}>
        <Modal.Dialog className="chat-image-viewer" data-testid="chat-image-viewer">
          <Modal.Header className="chat-image-viewer__header">
            <Modal.Heading className="sr-only">图片预览</Modal.Heading>
            <span className="chat-image-viewer__count">{index + 1} / {images.length}</span>
            <Button isIconOnly variant="tertiary" aria-label="关闭图片预览" onPress={() => setOpen(false)}><Sym name="close" /></Button>
          </Modal.Header>
          <Modal.Body className="chat-image-viewer__body">
            <div className="chat-image-viewer__scroll" tabIndex={0} role="region" aria-label="图片，可缩放并滚动查看"
              onKeyDown={(event) => {
                if (event.key === 'ArrowLeft' && index > 0) { event.preventDefault(); navigate(index - 1); }
                if (event.key === 'ArrowRight' && index < images.length - 1) { event.preventDefault(); navigate(index + 1); }
              }}>
              {failed ? <p role="alert">图片加载失败，请关闭后重试。</p> : <img key={current.id} src={source} alt={current.name}
                className={zoom > 1 ? 'chat-image-viewer__image--zoomed' : undefined}
                style={{ width: `${zoom * 100}%` }} onError={() => setFailed(true)}
                onDoubleClick={() => setZoom((value) => value === 1 ? 2 : 1)} />}
            </div>
          </Modal.Body>
          <Modal.Footer className="chat-image-viewer__tools">
            {images.length > 1 && <Button isIconOnly variant="tertiary" aria-label="上一张图片" isDisabled={index === 0} onPress={() => navigate(index - 1)}><Sym name="chevron_left" /></Button>}
            <Button isIconOnly variant="tertiary" aria-label="缩小图片" isDisabled={zoom <= 1} onPress={() => setZoom((value) => Math.max(1, value - 0.5))}><Sym name="zoom_out" /></Button>
            <Button variant="tertiary" onPress={() => setZoom(1)} aria-label="适应窗口">{Math.round(zoom * 100)}%</Button>
            <Button isIconOnly variant="tertiary" aria-label="放大图片" isDisabled={zoom >= 3} onPress={() => setZoom((value) => Math.min(3, value + 0.5))}><Sym name="zoom_in" /></Button>
            <Button isIconOnly variant="tertiary" aria-label="下载图片" onPress={() => void downloadAttachment(current).catch((error: Error) => toast.error(error.message))}><Sym name="download" /></Button>
            {images.length > 1 && <Button isIconOnly variant="tertiary" aria-label="下一张图片" isDisabled={index === images.length - 1} onPress={() => navigate(index + 1)}><Sym name="chevron_right" /></Button>}
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container></Modal.Backdrop>
    </Modal.Root>
  </>;
}

function PendingImage({ file, removing }: { file: File; removing: boolean }) {
  const [preview, setPreview] = useState('');
  useEffect(() => {
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return <div className="chat-image chat-image--draft chat-image-pending" aria-busy="true" aria-label={file.name}>
    {preview && <img src={preview} alt="" />}
    <span className="chat-image-pending__overlay" role="status" aria-label={removing ? '正在移除图片' : '图片加载中'}>
      <span className="chat-image-pending__indicator"><Spinner size="sm" color="current" aria-hidden="true" /></span>
      <span className="sr-only">{removing ? '正在移除图片' : '图片加载中'}</span>
    </span>
  </div>;
}

export function ChatAttachmentDraft() {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content) return;
    // Observe only attachments: typing must not animate the textarea's height.
    const resize = () => {
      const height = content.getBoundingClientRect().height;
      if (height > 0) {
        container.dataset.open = 'true';
        // Commit the collapsed size before starting the first expansion.
        void container.offsetHeight;
      }
      container.style.height = `${height}px`;
      if (height === 0 && (prefersReducedMotion() || container.getBoundingClientRect().height === 0)) {
        container.dataset.open = 'false';
      }
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);
  return <div ref={containerRef} className="chat-attachment-resize t-resize" style={{ height: 0 }}
    onTransitionEnd={(event) => {
      if (event.target === event.currentTarget && event.propertyName === 'height' && contentRef.current?.getBoundingClientRect().height === 0) {
        event.currentTarget.dataset.open = 'false';
      }
    }}>
    <div ref={contentRef}><ChatAttachmentDraftContent /></div>
  </div>;
}

function ChatAttachmentDraftContent() {
  const { items, error, retry, remove } = useChatAttachments();
  const images = items.flatMap((item) => item.value?.dataUrl ? [item.value] : []);
  if (!items.length && !error) return null;
  return <div className="chat-attachments" data-testid="chat-attachment-draft" aria-label="待发送附件">
    {items.map((item) => !item.error && (item.value?.dataUrl || /^image\/(png|jpeg|webp|gif)$/.test(item.file.type) || /\.(png|jpe?g|webp|gif)$/i.test(item.file.name)) ? <div key={item.id} className="chat-image-draft" data-testid="chat-attachment" data-state={item.value ? 'ready' : 'loading'}>
      {item.value?.dataUrl ? <ChatImage file={item.value} images={images} draft /> : <PendingImage file={item.file} removing={item.phase === '移除中'} />}
      <Button isIconOnly size="sm" variant="secondary" className="chat-image-draft__remove" aria-label={`移除附件 ${item.file.name}`} isDisabled={item.phase === '移除中'} onPress={() => void remove(item.id)}><Sym name="close" /></Button>
    </div> : <div key={item.id} className="chat-attachments__item" data-testid="chat-attachment" data-state={item.error ? 'error' : item.value ? 'ready' : 'loading'}>
      {item.value?.dataUrl ? <img className="chat-attachments__thumb" src={item.value.dataUrl} alt={item.file.name} /> : <Sym name="description" />}
      <div className="chat-attachments__info">
        <span className="truncate" title={item.file.name}>{item.file.name}</span>
        <small role="status">{attachmentSize(item.file.size)} · {item.error ? '上传失败' : item.value ? item.value.serverId ? '已保存到服务端' : '已保存到本机' : item.phase}{item.value?.truncated ? ' · 正文已截取' : ''}</small>
        {item.error && <span role="alert" className="chat-attachments__error">{item.error}</span>}
      </div>
      {item.error && <Button size="sm" variant="tertiary" onPress={() => retry(item.id)}>重试</Button>}
      <Button isIconOnly size="sm" variant="tertiary" aria-label={`移除附件 ${item.file.name}`} onPress={() => void remove(item.id)}><Sym name="close" /></Button>
    </div>)}
    {error && <p role="alert" className="chat-attachments__error">{error}</p>}
  </div>;
}

export function ChatMessageAttachments({ files }: { files?: ChatAttachment[] }) {
  if (!files?.length) return null;
  const images = files.filter((file) => file.dataUrl);
  return <div className="chat-attachments" data-testid="chat-message-attachments">
    {images.length > 0 && <div className="chat-image-gallery" data-count={images.length}>{images.map((file) => <ChatImage key={file.id} file={file} images={images} />)}</div>}
    {files.filter((file) => !file.dataUrl).map((file) => <button type="button" key={file.id} className="chat-attachments__item" aria-label={`下载附件 ${file.name}`}
      onClick={() => void downloadAttachment(file).catch((error: Error) => toast.error(error.message))}>
      {file.dataUrl ? <img className="chat-attachments__thumb" src={file.dataUrl} alt={file.name} loading="lazy" /> : <Sym name="description" />}
      <span className="chat-attachments__info"><span className="truncate" title={file.name}>{file.name}</span><small>{attachmentSize(file.size)}{file.truncated ? ' · 正文已截取' : ''}</small></span>
      <Sym name="download" />
    </button>)}
  </div>;
}
