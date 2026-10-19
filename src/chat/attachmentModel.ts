import { chatOnce, textOf, type ChatMessage } from '../api/siliconflow';
import { isVisionModel } from '../api/modelCaps';
import { getSettings, targetOrNull } from '../store/settings';
import { attachmentMessage, type ChatAttachment } from './attachments';

/** Text-only chat models use the configured vision model; never replace images with just filenames. */
export async function attachmentsForModel(attachments: ChatAttachment[], question: string, signal: AbortSignal): Promise<ChatAttachment[]> {
  const settings = getSettings();
  const chat = targetOrNull(settings, settings.llmModel);
  if (chat && isVisionModel(chat.catalogId, chat.model)) return attachments;
  const vision = targetOrNull(settings, settings.visionModel);
  const result: ChatAttachment[] = [];
  for (const file of attachments) {
    signal.throwIfAborted();
    if (!file.dataUrl || file.description) { result.push(file); continue; }
    if (!vision) throw new Error('当前模型不支持图片，请切换多模态模型或在设置中配置视觉模型');
    const response = await chatOnce(vision, {
      messages: [{ role: 'user', content: [
        { type: 'text', text: `请忠实提取图片中的文字、图表和关键细节，供另一位助手回答用户问题。看不清的部分明确说明。用户问题：${question}` },
        { type: 'image_url', image_url: { url: file.dataUrl } },
      ] }],
      max_tokens: 1500,
      signal,
    });
    const description = textOf(response).trim();
    if (!description) throw new Error(`未能识别图片「${file.name}」，请重试`);
    result.push({ ...file, description });
  }
  return result;
}

export function messageForModel(row: { role: 'user' | 'assistant'; content: string; attachments?: ChatAttachment[] }): ChatMessage {
  const settings = getSettings();
  const chat = targetOrNull(settings, settings.llmModel);
  const seesImages = chat && isVisionModel(chat.catalogId, chat.model);
  return attachmentMessage({ ...row, attachments: row.attachments?.map((file) => seesImages ? file : { ...file, dataUrl: undefined }) });
}
