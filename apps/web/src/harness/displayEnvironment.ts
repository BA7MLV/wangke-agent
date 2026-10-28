/** Generation uses the answer column, not the whole desktop/screen width. */
import { RESPONSIVE_CONTENT_RULE } from '@wangke/study-core/display';
export { RESPONSIVE_CONTENT_RULE } from '@wangke/study-core/display';

export function displayEnvironmentPrompt(surface: 'course' | 'panel'): string {
  if (typeof document === 'undefined') return RESPONSIVE_CONTENT_RULE;
  const selector = surface === 'course' ? '.course-chat__messages, .course-chat__composer' : '.chat-list-wrap';
  const host = Array.from(document.querySelectorAll<HTMLElement>(selector)).find(el => el.getBoundingClientRect().width > 0);
  if (!host) return RESPONSIVE_CONTENT_RULE;
  const style = getComputedStyle(host);
  const bounds = host.getBoundingClientRect();
  const width = Math.round(host.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0));
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
  const surfaceHeight = host.matches('.course-chat__composer') ? viewportHeight : bounds.height;
  const height = Math.round(Math.min(surfaceHeight || viewportHeight, viewportHeight) * 0.65);
  if (width <= 0) return RESPONSIVE_CONTENT_RULE;
  return `${RESPONSIVE_CONTENT_RULE}\n当前回答内容区约 ${width}px 宽，主体图示建议高度不超过 ${height}px，宽高比约 ${(width / height).toFixed(2)}:1。这是本轮布局参考，不是固定像素尺寸；${width < 600 ? '当前为窄栏，优先单列、短标签、纵向流程。' : '空间允许时使用并排布局，仍需支持窄屏重排。'}`;
}
