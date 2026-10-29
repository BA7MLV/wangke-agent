import { useEffect, useState } from 'react';
import { Button, Spinner } from '@heroui/react';
import type { BotAttachment } from '@wangke/contracts';
import { serverClient } from '../api/serverClient';
import { attachmentSize } from '../chat/attachments';
import { Sym } from '../ui';
import ImagePreview from './ImagePreview';
import './chat-attachments.css';

export interface BotDraftFile {
  id: string;
  file: File;
  uploaded?: BotAttachment;
  error?: string;
}

const nameOf = (file: BotAttachment) => file.originalName || file.name || '附件';
const isImage = (file: BotAttachment) => /^image\/(png|jpeg|webp|gif)$/.test(file.mimeType ?? '') || /\.(png|jpe?g|webp|gif)$/i.test(nameOf(file));
const urlOf = (file: BotAttachment, projectId?: string) => projectId
  ? file.projectId === projectId && file.projectPath ? serverClient.projectDownloadUrl(projectId, file.projectPath) : undefined
  : file.fileId ? serverClient.fileDownloadUrl(file.fileId) : undefined;

/** Authenticated blob URLs also work for project downloads (application/octet-stream). */
function useAttachmentImage(url?: string, local?: File) {
  const [source, setSource] = useState('');
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl = '';
    setSource(''); setFailed(false);
    const load = async () => {
      let blob: Blob;
      if (local) blob = local;
      else {
        if (!url) throw new Error('file_not_found');
        const response = await fetch(url, { credentials: 'include', signal: controller.signal });
        if (!response.ok) throw new Error('file_not_found');
        blob = await response.blob();
      }
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      setSource(objectUrl);
    };
    void load().catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [url, local, attempt]);
  return { source, failed, attempt, setFailed, retry: () => setAttempt(value => value + 1) };
}

type ImageItem = { name: string; url?: string; local?: File };

function AttachmentImage({ name, url, local, draft = false, images }: ImageItem & { draft?: boolean; images?: ImageItem[] }) {
  const { source, failed, setFailed, retry } = useAttachmentImage(url, local);
  const [open, setOpen] = useState(false);
  const stacked = !!images && images.length > 1;
  return <>
    <Button variant="ghost" className={draft ? 'chat-image chat-image--draft' : 'chat-image'} aria-label={stacked ? `查看 ${images.length} 张图片` : `预览图片 ${name}`}
      onPress={() => { if (failed && !stacked) retry(); else setOpen(true); }}>
      {failed ? <span role="status">图片加载失败，点击重试</span> : source ? <img src={source} alt={name} decoding="async" onError={() => setFailed(true)} /> : <Spinner size="sm" aria-label="图片加载中" />}
      {stacked && <span className="bot-image-stack__count" aria-hidden="true"><Sym name="photo_library" />{images.length}</span>}
    </Button>
    {open && <AttachmentImageViewer images={images ?? [{ name, url, local }]} onClose={() => setOpen(false)} />}
  </>;
}

function AttachmentImageViewer({ images, onClose }: { images: ImageItem[]; onClose: () => void }) {
  const [index, setIndex] = useState(0);
  const selected = Math.min(index, images.length - 1);
  return <AttachmentImagePreview key={selected} image={images[selected]} onClose={onClose}
    navigation={{ index: selected, total: images.length, onChange: setIndex }} />;
}

function AttachmentImagePreview({ image: { name, url, local }, onClose, navigation }: {
  image: ImageItem; onClose: () => void; navigation: { index: number; total: number; onChange: (index: number) => void };
}) {
  const { source, failed, attempt, setFailed, retry } = useAttachmentImage(url, local);
  return <ImagePreview isOpen onOpenChange={open => { if (!open) onClose(); }} title={name} contentKey={`${url}:${attempt}`} testId="bot-image-viewer"
      navigation={navigation}
      content={source && !failed ? { kind: 'image', src: source, onError: () => setFailed(true) } : undefined}
      status={failed ? <Button variant="tertiary" onPress={retry}>图片加载失败，重试</Button> : <Spinner aria-label="图片加载中" />}
      onDownload={source ? () => { const link = document.createElement('a'); link.href = source; link.download = name; link.click(); } : undefined} />
}

export function BotMessageAttachments({ files, projectId }: { files: BotAttachment[]; projectId?: string }) {
  // Only consecutive images belong to an album; keep other attachments in order.
  const groups: BotAttachment[][] = [];
  for (const file of files) {
    const previous = groups.at(-1);
    if (isImage(file) && previous && isImage(previous[0])) previous.push(file);
    else groups.push([file]);
  }
  return <div className="chat-attachments bot-message-attachments" data-testid="bot-message-attachments">
    {groups.map((group, index) => {
      const file = group[0];
      const name = nameOf(file), url = urlOf(file, projectId);
      return isImage(file) ? <div className={`chat-image-gallery${group.length > 1 ? ' bot-image-stack' : ''}`} data-count="1" key={`${file.fileId ?? file.projectPath ?? 'image'}:${index}`}>
        <AttachmentImage name={name} url={url} images={group.map(item => ({ name: nameOf(item), url: urlOf(item, projectId) }))} />
      </div>
        : <div className="imsg-bubble imsg-bubble--file" key={index}>
          <span className="imsg-file__icon" aria-hidden="true"><Sym name="description" /></span>
          {url ? <a className="imsg-file__name" href={url} download>{name}</a> : <span className="imsg-file__name">{name}</span>}
          <span className="imsg-file__size">{file.sizeBytes === undefined ? '' : attachmentSize(file.sizeBytes)}</span>
        </div>;
    })}
  </div>;
}

export function BotAttachmentDraft({ files, sending, onRemove }: { files: BotDraftFile[]; sending: boolean; onRemove: (id: string) => void }) {
  return <div className="chat-attachments" data-testid="chat-attachment-draft" aria-label="待发送附件">
    {files.map(item => isImage({ originalName: item.file.name, mimeType: item.file.type }) ? <div key={item.id} className="chat-image-draft" data-testid="chat-attachment">
      <AttachmentImage name={item.file.name} local={item.file} draft />
      <Button isIconOnly size="sm" variant="secondary" className="chat-image-draft__remove" aria-label={`移除附件 ${item.file.name}`} isDisabled={sending} onPress={() => onRemove(item.id)}><Sym name="close" /></Button>
      {item.error && <span role="alert" className="chat-attachments__error">{item.error}</span>}
    </div> : <div key={item.id} className="chat-attachments__item" data-testid="chat-attachment">
      <Sym name="description" />
      <span className="chat-attachments__info"><span>{item.file.name}</span><small>{attachmentSize(item.file.size)} · {sending ? '正在发送' : '待发送'}</small>{item.error && <span role="alert" className="chat-attachments__error">{item.error}</span>}</span>
      <Button isIconOnly size="sm" variant="tertiary" aria-label={`移除附件 ${item.file.name}`} isDisabled={sending} onPress={() => onRemove(item.id)}><Sym name="close" /></Button>
    </div>)}
  </div>;
}
