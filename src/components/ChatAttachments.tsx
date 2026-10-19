import { Button } from '@heroui/react';
import { useChatAttachments } from '../store/chatAttachments';
import { attachmentSize, type ChatAttachment } from '../chat/attachments';
import { downloadAttachment } from '../chat/prepareAttachment';
import { Sym, toast } from '../ui';
import './chat-attachments.css';

export function ChatAttachmentDraft() {
  const { items, error, retry, remove } = useChatAttachments();
  if (!items.length && !error) return null;
  return <div className="chat-attachments" data-testid="chat-attachment-draft" aria-label="待发送附件">
    {items.map((item) => <div key={item.id} className="chat-attachments__item" data-testid="chat-attachment" data-state={item.error ? 'error' : item.value ? 'ready' : 'loading'}>
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
  return <div className="chat-attachments" data-testid="chat-message-attachments">
    {files.map((file) => <button type="button" key={file.id} className="chat-attachments__item" aria-label={`下载附件 ${file.name}`}
      onClick={() => void downloadAttachment(file).catch((error: Error) => toast.error(error.message))}>
      {file.dataUrl ? <img className="chat-attachments__thumb" src={file.dataUrl} alt={file.name} loading="lazy" /> : <Sym name="description" />}
      <span className="chat-attachments__info"><span className="truncate" title={file.name}>{file.name}</span><small>{attachmentSize(file.size)}{file.truncated ? ' · 正文已截取' : ''}</small></span>
      <Sym name="download" />
    </button>)}
  </div>;
}
