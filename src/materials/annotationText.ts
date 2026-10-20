/** 仅在交给模型的摘录中添加 mark；转义原文，避免原文标签与标记混淆。 */
export const markedText = (text: string): string => `<mark>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</mark>`;
