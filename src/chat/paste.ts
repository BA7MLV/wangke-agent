export const PASTE_ATTACHMENT_THRESHOLD = 4000;

/** File.size counts UTF-8 bytes, not UTF-16 code units; keep the pasted text intact. */
export function pastedTextAttachment(text: string): File | null {
  const file = new File([text], `粘贴内容-${Date.now()}.txt`, { type: 'text/plain;charset=utf-8' });
  return file.size > PASTE_ATTACHMENT_THRESHOLD ? file : null;
}
