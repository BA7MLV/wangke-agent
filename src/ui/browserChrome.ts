/**
 * Android / 旧 Safari 读取 theme-color；Safari 26 的染色还会采样根背景和贴边元素。
 * 三者必须来自同一处实色，不能把半透明遮罩色或封面主色直接当成最终边缘色。
 */
let activeEdge: HTMLElement | null = null;

/** 转成不透明 sRGB，避免浏览器 UI 对 oklch / color-mix 的支持与页面 CSS 不一致。 */
function opaqueHex(color: string): string | null {
  if (!color || !CSS.supports('color', color)) return null;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b, alpha] = context.getImageData(0, 0, 1, 1).data;
  if (alpha !== 255) return null;
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

export function syncBrowserChrome(): void {
  const root = document.documentElement;
  const color = activeEdge
    ? getComputedStyle(activeEdge).backgroundColor
    : getComputedStyle(root).getPropertyValue('--background-secondary').trim();
  const hex = opaqueHex(color);
  if (!hex) return;
  // 相同值不重复写入：观察 html.style 时不会形成 MutationObserver 循环。
  if (root.style.getPropertyValue('--browser-chrome-color') !== hex) {
    root.style.setProperty('--browser-chrome-color', hex);
  }
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta && meta.content !== hex) meta.content = hex;
}

/** 只监听主题 / 页面动态配色，不逐帧取色，也不读取滚动中的内容像素。 */
export function observeBrowserChrome(edge: HTMLElement): () => void {
  activeEdge = edge;
  syncBrowserChrome();
  const observer = new MutationObserver(syncBrowserChrome);
  const options = { attributes: true, attributeFilter: ['class', 'style'] };
  observer.observe(document.documentElement, options);
  if (edge.parentElement) observer.observe(edge.parentElement, options);
  return () => {
    observer.disconnect();
    if (activeEdge === edge) {
      activeEdge = null;
      syncBrowserChrome();
    }
  };
}
