/**
 * 界面主题（MD3 / Material You 的 light / dark / auto）。
 *
 * mdui 的主题实现非常轻：**只是给 `<html>` 挂一个 `mdui-theme-{light|dark|auto}` 类**，
 * 三套色板全在 mdui.css 里（`auto` 走 `prefers-color-scheme` 媒体查询，纯 CSS，不需要 JS 监听）。
 * 所以这一层只做两件事：
 *
 *   1. 把设置里的主题写上去（`applyTheme`）；
 *   2. 为 **antd** 算出「当前实际是深还是浅」—— antd 的明暗是 JS 算的（`theme.darkAlgorithm`），
 *      不能靠 CSS，所以 `auto` 模式下必须自己订阅系统配色变化（`useResolvedDark`）。
 *      迁移期两套 UI 并存，做不到这一点就会出现「mdui 页面变深了、antd 部分还是浅的」。
 *
 * 等到阶段 5 移除 antd，第 2 件事就可以整个删掉，只留下 `setTheme(theme)`。
 */
import { useEffect, useState } from 'react';
import { getColorFromImage, removeColorScheme, setColorScheme, setTheme } from './mdui';
import type { AppTheme } from '../store/settings';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** 系统当前是否处于深色 */
export function systemPrefersDark(): boolean {
  return window.matchMedia(DARK_QUERY).matches;
}

/** 把主题写到 `<html>`：mdui 会据此切换整套深浅色令牌，并同步 `color-scheme`
 *  （后者让原生滚动条 / 表单控件 / 播放器控件跟着变色）。 */
export function applyTheme(theme: AppTheme): void {
  setTheme(theme);
}

/**
 * 当前**实际生效**的是深色还是浅色（`auto` 时跟随系统，并订阅其变化）。
 *
 * 只有 antd 需要它；用 mdui 的部分靠 CSS 媒体查询自己就对了，不需要 React 参与。
 */
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

/**
 * Material You 的**动态取色**：从一张封面图里提出主色，生成整套 MD3 配色方案。
 *
 * 返回一个 **callback ref**，把它挂到要上色的那个元素上即可：
 * ```tsx
 * const colorRef = useDynamicColor({ sourceUrl: coverUrl, enabled: dynamicColor });
 * return <div className="page" ref={colorRef}>…</div>;
 * ```
 *
 * 为什么不接收 `RefObject`：**目标元素常常比数据晚挂上**。播放页就是先渲染加载态、
 * 数据就绪后才渲染真正的根节点 —— 用 RefObject 的话，effect 可能在元素还不存在时读一次 `.current`，
 * 之后依赖项不再变化、effect 也不会重跑，于是**永远错过**（实测踩到：全程无报错、配色就是不生效）。
 * callback ref 天然在元素挂载/卸载时触发，从根上消除这类竞态。
 *
 * 三处刻意的设计：
 *
 * 1. **只作用在目标元素上**，不写全局。配色随课程变化是「这一门课」的属性，不该影响首页；
 *    而且 mdui 的 `setColorScheme` 生成的是挂在目标元素上的 CSS 变量，元素一卸载就自然失效。
 * 2. **同时生成浅色与深色两套**（mdui 内部用 `Scheme.light` / `Scheme.dark` 各算一遍），
 *    所以动态取色和深色模式不打架、可以叠加。
 * 3. **失败一律静默退回默认配色**。取色依赖封面帧存在、能解码、色彩量化能出结果，
 *    任何一步失败都只是「没用上动态配色」，绝不能影响播放 —— 所以这里把 catch 吃掉是**有意为之**。
 *
 * 封面帧的取用（查库、建 blob URL、回收）留给调用方，这一层只管「给张图 → 上色」。
 */
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
        /* 见上文第 3 点：静默退回默认配色 */
      });

    return () => {
      cancelled = true;
      removeColorScheme(target);
    };
  }, [sourceUrl, enabled, target]);

  // setState 的 setter 身份稳定，可以直接当 callback ref 用
  return setTarget;
}
