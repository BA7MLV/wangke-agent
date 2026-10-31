import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button, Spinner } from '@heroui/react';
import { useChatAttachments } from '../store/chatAttachments';
import { attachmentSize, type ChatAttachment } from '../chat/attachments';
import { downloadAttachment, readAttachmentBlob } from '../chat/prepareAttachment';
import { Sym, toast } from '../ui';
import { prefersReducedMotion } from '../utils/motion';
import ImagePreview from './ImagePreview';
import ImageGallery from './ImageGallery';
import './chat-attachments.css';

/** The same accessible viewer serves composer thumbnails and persisted messages. */
function ChatImage({ file, images, draft = false }: { file: ChatAttachment; images: ChatAttachment[]; draft?: boolean }) {
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
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
  const navigate = (next: number) => { setIndex(next); setFailed(false); setOriginal(undefined); };
  const stacked = !draft && images.length > 1;
  return <>
    <Button variant="ghost" className={draft ? 'chat-image chat-image--draft' : 'chat-image'} aria-label={stacked ? `查看 ${images.length} 张图片` : `预览图片 ${file.name}`}
      onPress={() => { navigate(Math.max(0, images.findIndex((image) => image.id === file.id))); setOpen(true); }}>
      <img src={file.dataUrl} alt={file.name} loading={draft ? 'eager' : 'lazy'} decoding="async" />
    </Button>
    <ImagePreview isOpen={open} onOpenChange={setOpen} title={current.name} contentKey={current.id}
      content={source && !failed ? { kind: 'image', src: source, onError: () => setFailed(true) } : undefined}
      status={<p role="alert">图片加载失败，请关闭后重试。</p>}
      navigation={{ index, total: images.length, onChange: navigate }}
      onDownload={() => void downloadAttachment(current).catch((error: Error) => toast.error(error.message))}
      testId="chat-image-viewer" />
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
    {images.length > 0 && <ImageGallery count={images.length}><ChatImage file={images[0]} images={images} /></ImageGallery>}
    {files.filter((file) => !file.dataUrl).map((file) => <button type="button" key={file.id} className="chat-attachments__item" aria-label={`下载附件 ${file.name}`}
      onClick={() => void downloadAttachment(file).catch((error: Error) => toast.error(error.message))}>
      {file.dataUrl ? <img className="chat-attachments__thumb" src={file.dataUrl} alt={file.name} loading="lazy" /> : <Sym name="description" />}
      <span className="chat-attachments__info"><span className="truncate" title={file.name}>{file.name}</span><small>{attachmentSize(file.size)}{file.truncated ? ' · 正文已截取' : ''}</small></span>
      <Sym name="download" />
    </button>)}
  </div>;
}
