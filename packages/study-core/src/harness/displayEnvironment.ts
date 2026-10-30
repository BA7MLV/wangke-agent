/** Static layout contract; measuring DOM is an application capability. */
export const RESPONSIVE_CONTENT_RULE =
  '生成内容的布局必须适配回答所在容器，而不是把固定尺寸网页塞进滚动框。HTML 用 width:100%、min-width:0、可换行 Flex/Grid；窄栏将多列重排为单列，禁止固定桌面宽度、min-width 大画布或用 transform:scale 缩小整页文字。' +
  'SVG 必须带 viewBox，保持比例且完整显示。静态 diagram / Mermaid 可先展示完整总览，通过「查看大图」缩放、滚动读细节，不必为塞进一屏删节点或强制拆图；关系过密或主题混杂时再按主题分图。HTML 交互图示优先适配一屏，窄屏重排而非整体缩成小字；说明与长列表走正常文档流。' +
  'HTML 中 svg/img/canvas 等比缩放；Canvas 用 ResizeObserver 按容器尺寸重新布局并按 devicePixelRatio 设置像素缓冲。不要把 iframe 的 100vh 当宿主屏幕高度（iframe 随内容增高，会反馈循环）。' +
  '宿主提供 --wbw-available-height（可用图示高度）、window.__wbw.display（width/height）和 wbw:displaychange 事件；可用这些值为图示设比例、重排标签，文字控件保持可读。尺寸会在旋转屏幕、调整侧栏和窗口时变化，必须持续响应。';

type Surface = 'course' | 'panel';
let describe: (surface: Surface) => string = () => RESPONSIVE_CONTENT_RULE;
export function configureDisplayEnvironment(adapter: (surface: Surface) => string): void { describe = adapter; }
export function displayEnvironmentPrompt(surface: Surface): string { return describe(surface); }
