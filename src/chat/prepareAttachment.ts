import { serverClient, ServerApiError } from '../api/serverClient';
import { db } from '../store/db';
import { MAX_ATTACHMENT_TEXT, type ChatAttachment } from './attachments';

const LOCAL_MAX_BYTES = 512 * 1024 * 1024;

async function extract(file: File): Promise<Pick<ChatAttachment, 'text' | 'dataUrl' | 'truncated'>> {
  if (/^image\/(png|jpeg|webp|gif)$/.test(file.type) || /\.(png|jpe?g|webp|gif)$/i.test(file.name)) {
    if (file.size > 10 * 1024 * 1024) throw new Error('图片不能超过 10 MB，请压缩后重试');
    const bitmap = await createImageBitmap(file);
    try {
      const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('无法处理图片，请换一张图片重试');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return { dataUrl: canvas.toDataURL('image/jpeg', 0.85) };
    } finally { bitmap.close(); }
  }
  let text: string;
  if (/\.pdf$/i.test(file.name)) {
    const { openPdf, extractPdfUnits } = await import('../materials/pdf');
    const url = URL.createObjectURL(file);
    try {
      const pdf = await openPdf(url);
      try { text = (await extractPdfUnits(pdf)).map((unit) => unit.text).join('\n\n'); }
      finally { await pdf.destroy(); }
    } finally { URL.revokeObjectURL(url); }
  } else if (/\.docx$/i.test(file.name)) {
    const { readDocxUnits } = await import('../materials/docx');
    text = (await readDocxUnits(file)).map((unit) => unit.text).join('\n\n');
  } else if (/\.(txt|md|markdown|csv|json|html?|log|ya?ml)$/i.test(file.name)) {
    text = await file.text();
    if (/\.html?$/i.test(file.name)) {
      const { extractHtmlUnits } = await import('../materials/html');
      text = extractHtmlUnits(text).map((unit) => unit.text).join('\n\n');
    }
    if (text.includes('\0')) throw new Error('文件不是可读取的文本，请转换为 UTF-8 文本后重试');
  } else throw new Error('支持 PDF、Word（.docx）、文本、Markdown、CSV、JSON 和图片；视频请从课程库导入');
  text = text.trim();
  if (!text) throw new Error('没有提取到正文；扫描版 PDF 请转成图片上传，或先进行 OCR');
  return { text: text.slice(0, MAX_ATTACHMENT_TEXT), truncated: text.length > MAX_ATTACHMENT_TEXT };
}

export async function prepareAttachment(id: string, file: File, onPhase: (phase: string) => void): Promise<ChatAttachment> {
  if (!file.size) throw new Error('文件为空，请选择有内容的文件');
  if (file.size > LOCAL_MAX_BYTES) throw new Error('单个聊天附件不能超过 512 MiB');
  // A static-only deployment explicitly returns 404/HTML. Network/server failures never silently downgrade storage.
  const response = await fetch('/api/v1/files/config', { credentials: 'include' });
  const localOnly = response.status === 404 || (response.ok && !response.headers.get('content-type')?.includes('application/json'));
  if (localOnly) {
    const health = await fetch('/api/v1/health');
    if (health.ok && health.headers.get('content-type')?.includes('application/json')) throw new Error('文件服务版本较旧，请更新 Docker 服务后重试');
    if (health.status >= 500) throw new Error('文件服务暂不可用，请稍后重试');
  }
  if (!localOnly && !response.ok) throw new Error('文件服务暂不可用，请稍后重试');
  if (!localOnly) {
    const config = await response.json() as { maxFileBytes: number };
    if (!Number.isFinite(config.maxFileBytes) || config.maxFileBytes < 1) throw new Error('文件服务配置无效，请更新服务后重试');
    if (file.size > config.maxFileBytes) throw new Error(`文件超过服务端上限（${Math.floor(config.maxFileBytes / 1024 / 1024)} MB）`);
    if (!(await serverClient.session()).authenticated) throw new Error('请先到 Bot 工作空间初始化或登录服务，再重试上传');
  }
  onPhase('解析中');
  const parsed = await extract(file);
  const attachment: ChatAttachment = { id, name: file.name, mimeType: file.type || 'application/octet-stream', size: file.size, ...parsed };
  if (localOnly) {
    onPhase('保存中');
    await db.files.put({ id, blob: file });
  } else {
    onPhase('上传中');
    try { attachment.serverId = (await serverClient.uploadFile(file)).id; }
    catch (error) {
      if (error instanceof ServerApiError && error.status === 401) throw new Error('请先到 Bot 工作空间初始化或登录服务，再重试上传');
      if (error instanceof ServerApiError && error.status === 413) throw new Error('文件超过服务端上传上限');
      throw error;
    }
  }
  return attachment;
}

export async function removeAttachmentFile(file: ChatAttachment): Promise<void> {
  if (file.serverId) await serverClient.deleteFile(file.serverId);
  else await db.files.delete(file.id);
}

export async function readAttachmentBlob(file: ChatAttachment): Promise<Blob> {
  let blob: Blob;
  if (file.serverId) {
    const response = await fetch(`/api/v1/files/${encodeURIComponent(file.serverId)}`, { credentials: 'include' });
    if (!response.ok) throw new Error(response.status === 401 ? '请先登录服务再下载附件' : '附件已删除或暂时无法下载');
    blob = await response.blob();
  } else {
    const saved = await db.files.get(file.id);
    if (!saved) throw new Error('本机附件文件已被清理');
    blob = saved.blob;
  }
  return blob;
}

export async function downloadAttachment(file: ChatAttachment): Promise<void> {
  const url = URL.createObjectURL(await readAttachmentBlob(file));
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
