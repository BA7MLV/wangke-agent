/**
 * 封面动态取色（原 mdui `getColorFromImage` + `setColorScheme` 的替代实现）。
 *
 * 为什么不继续用 mdui 的函数：那一套把结果写成 `--mdui-color-*` 自定义属性，
 * 组件样式表还得去读这些名字 —— 等于把 mdui 的设计令牌又请回了界面。
 * 这里改成产出**语义化角色**（surface / on-surface / accent / accent-fg），
 * 直接写目标元素上的行内自定义属性，作用域仅限那一个元素。
 */

/** 把 r/g/b（0-255）转成 HSL（h: 0-360，s/l: 0-100） */
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l * 100];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
  else if (max === gn) h = ((bn - rn) / d + 2) * 60;
  else h = ((rn - gn) / d + 4) * 60;
  return [h, s * 100, l * 100];
}

/** 相对亮度（WCAG 定义），用来在深/浅底之间挑可读的前景色 */
function relativeLuminance(r: number, g: number, b: number): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * 从一张已解码的图片里取一个「能当主色用」的颜色。
 *
 * 策略不是简单取平均 —— 封面里大量是深色背景和白色文字，平均值会得到一团灰。
 * 改成**量化取众数**：把像素按 4bit/通道（4096 桶）归一化后投票，
 * 再在候选里挑饱和度与亮度都够格的那个。
 */
export function getColorFromImage(img: HTMLImageElement): Promise<string> {
  const size = 48;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return Promise.reject(new Error('拿不到 2d 上下文'));
  ctx.drawImage(img, 0, 0, size, size);
  const { data } = ctx.getImageData(0, 0, size, size);

  // 量化投票：桶 key 是 4bit/通道，值是累积的 r/g/b 与计数
  const buckets = new Map<number, { r: number; g: number; b: number; n: number }>();
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a < 128) continue;
    // 接近纯黑或纯白的像素大多是背景/文字，不携带色相信息
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (Math.max(r, g, b) < 24 || Math.min(r, g, b) > 232) continue;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const hit = buckets.get(key);
    if (hit) {
      hit.r += r;
      hit.g += g;
      hit.b += b;
      hit.n += 1;
    } else {
      buckets.set(key, { r, g, b, n: 1 });
    }
  }

  if (buckets.size === 0) return Promise.reject(new Error('图片里没有可用的彩色像素'));

  // 打分：出现次数为主，饱和度为辅（灰调的桶即使很多也不适合当主色）
  let best: { r: number; g: number; b: number; score: number } | null = null;
  for (const bucket of buckets.values()) {
    const r = bucket.r / bucket.n;
    const g = bucket.g / bucket.n;
    const b = bucket.b / bucket.n;
    const [, s, l] = rgbToHsl(r, g, b);
    // 亮度太极端（近黑/近白）当主色会看不清，压一压权重
    const lightnessPenalty = l < 12 || l > 92 ? 0.25 : 1;
    const score = bucket.n * (0.35 + s / 100) * lightnessPenalty;
    if (!best || score > best.score) best = { r, g, b, score };
  }
  if (!best) return Promise.reject(new Error('没有挑出主色'));
  return Promise.resolve(toHex(best.r, best.g, best.b));
}

/**
 * 把主色铺成一组语义角色，写到 `target` 的行内自定义属性上。
 *
 * 只写这一个元素，不碰全局 —— 播放页可能同时有多个上色目标（比如课程卡 + 章节条），
 * 而且换课程时必须能干净地撤销。
 */
export function setColorScheme(hex: string, options: { target: HTMLElement }): void {
  const { target } = options;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return;
  const int = parseInt(m[1], 16);
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  const [h, s, l] = rgbToHsl(r, g, b);

  // 主色太淡就压暗，太艳就收一点 —— 保证 accent 上的白字始终够对比度
  const accentL = Math.min(Math.max(l, 32), 62);
  const accent = `oklch(${accentL}% ${Math.min(s, 0.19)} ${h})`;
  const fg = relativeLuminance(r, g, b) > 0.45 ? 'oklch(18% 0.02 0)' : 'oklch(98% 0.005 0)';

  target.style.setProperty('--dyn-surface', `oklch(${Math.min(accentL + 22, 96)}% ${Math.min(s * 0.18, 0.05)} ${h})`);
  target.style.setProperty('--dyn-surface-fg', `oklch(${Math.max(accentL - 18, 12)}% 0.02 ${h})`);
  target.style.setProperty('--dyn-border', `oklch(${accentL}% ${Math.min(s * 0.45, 0.09)} ${h})`);
  target.style.setProperty('--dyn-accent', accent);
  target.style.setProperty('--dyn-accent-fg', fg);
  // 页面边缘（包括 iOS 刘海 / 灵动岛与 Home Indicator 区域）使用同一
  // 个浅色表面，避免内容区与 viewport-fit=cover 的安全区出现色块断层。
  target.style.setProperty('--dyn-edge', `oklch(${Math.min(accentL + 22, 96)}% ${Math.min(s * 0.18, 0.05)} ${h})`);
  target.dataset.dynColor = 'on';
}

/** 撤销 setColorScheme 写上去的全部属性 */
export function removeColorScheme(target: HTMLElement): void {
  for (const prop of ['--dyn-surface', '--dyn-surface-fg', '--dyn-border', '--dyn-accent', '--dyn-accent-fg', '--dyn-edge']) {
    target.style.removeProperty(prop);
  }
  delete target.dataset.dynColor;
}
