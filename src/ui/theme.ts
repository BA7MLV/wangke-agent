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
import type { AppTheme } from '../store/settings';

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
