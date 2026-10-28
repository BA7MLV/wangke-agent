/**
 * 界面主题（light / dark / auto）—— HeroUI 版。
 *
 * HeroUI v3 的深浅色全部由 CSS 变量承担，切换方式是在 `<html>` 上挂 `.dark` 类
 * （变量定义见 @heroui/styles 的 themes/default/variables.css）。所以这一层很薄：
 *
 *   1. `applyTheme(theme)` 把设置里的主题翻译成 `<html>` 上的类名；
 *   2. `auto` 不是纯 CSS 媒体查询，而是 JS 解析一次系统偏好再落类 —— 这样
 *      「系统是深色、用户选浅色」也能正确成立（HeroUI 的 dark: 工具类在
 *      无显式类名时会回落到 prefers-color-scheme，只靠 CSS 表达不了三分状态）；
 *   3. 系统偏好变化时订阅 `change` 事件，实时跟着切。
 *
 * main.tsx 在首帧渲染前同步调用一次 applyTheme，避免深色用户先看到白底。
 */
import { useEffect, useState } from 'react';
import { getColorFromImage, removeColorScheme, setColorScheme } from './dynamicColor';
import { syncBrowserChrome } from './browserChrome';
import type { AccentColor, AppTheme, FontScale } from '../store/settings';

/** HeroUI 的语义色预设：覆盖 accent 令牌后，soft / hover 等令牌会自动跟随。 */
export const ACCENT_COLOR_OPTIONS = [
  { id: 'blue', value: '#2563eb' },
  { id: 'violet', value: '#7c3aed' },
  { id: 'rose', value: '#e11d48' },
  { id: 'orange', value: '#c2410c' },
  { id: 'green', value: '#15803d' },
  { id: 'amber', value: '#a16207' },
] as const satisfies readonly { id: AccentColor; value: string }[];

/**
 * 界面字号档位 → 根字号倍率。
 *
 * `standard` 是 1（即 16px 根字号）—— 这是浏览器与所有主流前端框架的默认值，
 * 也是绝大多数用户「什么都不改」时的观感，所以它就是「适合大多数人」的默认档。
 * 其余三档在原值上下各留一档，覆盖「看着有点小 / 有点大」的大多数诉求；
 * 再往上（>1.25）在窄屏上会把固定列宽撑破，宁可不提供。
 */
export const FONT_SCALE_OPTIONS = [
  { id: 'small', value: 0.875 },
  { id: 'standard', value: 1 },
  { id: 'large', value: 1.125 },
  { id: 'xlarge', value: 1.25 },
] as const satisfies readonly { id: FontScale; value: number }[];

/** 浏览器默认根字号。缩放倍率乘在它上面。 */
const BASE_ROOT_FONT_SIZE = 16;

const STANDARD_FONT_SCALE = FONT_SCALE_OPTIONS.find(({ id }) => id === 'standard')!;

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** 系统当前是否处于深色 */
export function systemPrefersDark(): boolean {
  return window.matchMedia(DARK_QUERY).matches;
}

/** auto 模式下解析出的实际深浅（供需要提前知道结果的场景使用） */
export function useResolvedDark(theme: AppTheme): boolean {
  const [dark, setDark] = useState(() => (theme === 'auto' ? systemPrefersDark() : theme === 'dark'));

  useEffect(() => {
    if (theme !== 'auto') {
      setDark(theme === 'dark');
      return;
    }
    setDark(systemPrefersDark());
    const mq = window.matchMedia(DARK_QUERY);
    const onChange = () => setDark(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme]);

  return dark;
}

/** 把主题写到 `<html>`：HeroUI 据此切换整套深浅色令牌，并同步 `color-scheme`。 */
export function applyTheme(theme: AppTheme): void {
  const root = document.documentElement;
  const dark = theme === 'dark' || (theme === 'auto' && systemPrefersDark());
  root.classList.toggle('dark', dark);
  root.style.colorScheme = dark ? 'dark' : 'light';
  syncBrowserChrome();
}

/** 将选择的 HeroUI 强调色写入根元素，所有 accent 语义令牌随之更新。 */
export function applyAccentColor(accentColor: AccentColor): void {
  const option = ACCENT_COLOR_OPTIONS.find(({ id }) => id === accentColor) ?? ACCENT_COLOR_OPTIONS[0];
  const root = document.documentElement;
  root.style.setProperty('--accent', option.value);
  // 所有预设都足够深，使用白色前景可确保强调按钮的文字对比度。
  root.style.setProperty('--accent-foreground', '#fff');
}

/**
 * 把界面字号档位落到 `<html>` 的基准字号上。
 *
 * 为什么改根字号而不是逐个组件调 `font-size`：
 *   - HeroUI / Tailwind 的字号（`--text-sm` 等）与间距（`--spacing`）全是 `rem`，
 *     根字号一动，整套界面按比例缩放，不需要维护一张「每个元素各放大多少」的表；
 *   - 固定 `px` 的少数尺寸（如 `theme.css` 里防 iOS 聚焦缩放的输入框 16px）故意不跟随 ——
 *     那个 16px 是 Safari 的硬性下限，跟着缩小反而会触发自动放大。
 *
 * 与 `applyTheme` 一样做成命令式函数：首帧前就要调用一次，避免字号「先标准再跳变」。
 */
export function applyFontScale(fontScale: FontScale): void {
  const option = FONT_SCALE_OPTIONS.find(({ id }) => id === fontScale) ?? STANDARD_FONT_SCALE;
  document.documentElement.style.fontSize = `${BASE_ROOT_FONT_SIZE * option.value}px`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 封面**动态取色**：从封面图里提出主色，生成一整套角色色。
// 返回 callback ref，挂到要上色的元素上即可（目标元素常比数据晚挂上）。
// 三处刻意设计：只作用在目标元素上不写全局；取色失败一律静默退回默认配色；撤销时把
// 写上去的自定义属性逐个摘干净，换课程不留残色。
// 实现见 ./dynamicColor —— 原先这里走 mdui 的 setColorScheme，它会把结果写成
// --mdui-color-*，等于把 mdui 令牌又请回界面；现在只产出 --dyn-* 语义角色。
export function useDynamicColor(options: {
  /** 封面图 URL（blob: / data: / http: 都行）；没有就跳过 */
  sourceUrl?: string | null;
  /** 用户开关 + 迁移期状态；false 时保持默认配色 */
  enabled: boolean;
}): (el: HTMLElement | null) => void {
  const { sourceUrl, enabled } = options;
  const [target, setTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!target || !enabled || !sourceUrl) return;
    let cancelled = false;

    const img = new Image();
    img.src = sourceUrl;
    img
      .decode()
      .then(() => getColorFromImage(img))
      .then((hex) => {
        // 取色是异步的，期间可能已经切了课程 / 卸载了页面
        if (cancelled || !hex) return;
        setColorScheme(hex, { target });
        // 浏览器 UI 由 PageShell 的实际边缘色统一同步，不在局部配色 hook 里争写 meta。
      })
      .catch(() => {
        /* 静默退回默认配色：取色失败绝不能影响播放 */
      });

    return () => {
      cancelled = true;
      removeColorScheme(target);
    };
  }, [sourceUrl, enabled, target]);

  // setState 的 setter 身份稳定，可以直接当 callback ref 用
  return setTarget;
}
