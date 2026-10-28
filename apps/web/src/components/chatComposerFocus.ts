/**
 * 「新会话」之后把焦点交给对话输入框。
 *
 * 只在有精确指针（鼠标 / 触控板）时做：手机上程序化聚焦要么被系统忽略，
 * 要么突然弹出键盘盖住半屏，都不是用户点「新会话」时想要的。
 * 跳转与草稿态切换都在同一帧之后才落到 DOM，所以等两帧再找输入框。
 */
export function focusChatComposer(): void {
  if (typeof window === 'undefined' || !window.matchMedia('(pointer: fine)').matches) return;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.querySelector<HTMLTextAreaElement>('.course-chat__input')?.focus();
  }));
}
