import { useEffect, useState } from 'react';

/** 手机竖屏：窄宽（900px 平板竖屏断点保留给上下堆叠布局） */
const SHORT_PORTRAIT_QUERY = '(max-width: 640px)';

/**
 * 手机横屏：矮 + 横。
 *
 * 必须用**高度**判定：横屏时宽度普遍 > 640px（iPhone 14 是 852×393），按宽度判必漏，
 * 会落到 900px 的平板堆叠档 —— 视频被按 45vh 反推压成一小块、宽屏空间大量浪费。
 * 实测手机横屏 CSS 高度 320~430，平板横屏 ≥ 744，520 是安全分界。
 * `max-width: 1100px` 把「又宽又矮的桌面窗口」（如 1440×500）挡在外面，保留桌面 Tabs 布局。
 */
const SHORT_LANDSCAPE_QUERY =
  '(orientation: landscape) and (max-height: 520px) and (max-width: 1100px)';

/** 一套「手机」判据：竖屏窄宽 **或** 横屏矮高。
 *  横屏时右栏只有 ~320px 宽，面板内部（ChatPanel 头部重排、HandoutPanel 的 docx 等比缩放）
 *  本来就该按手机处理，所以两者并集。 */
const MOBILE_QUERY = `${SHORT_PORTRAIT_QUERY}, ${SHORT_LANDSCAPE_QUERY}`;

/** 通用媒体查询订阅（query 变化时重新订阅） */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    setMatches(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/** 是否手机（竖屏窄宽或横屏矮高），监听窗口变化实时切换 */
export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_QUERY);
}

/** 是否手机横屏：播放页据此切到「左视频 / 右面板」左右分栏 */
export function useIsPhoneLandscape(): boolean {
  return useMediaQuery(SHORT_LANDSCAPE_QUERY);
}

/**
 * 全局移动端副作用（App 顶层挂一次）：
 * visualViewport → --vvh CSS 变量——iOS 键盘弹出时 layout viewport 高度不变，
 * 贴底的 Sender/Tab 栏会被键盘盖住；用 --vvh 把 .page 高度同步为可视高度使其收缩。
 * 横屏时 --vvh 还被用来约束视频宽度（左右分栏下视频不能把控制栏顶出可视区）。
 * Android Chrome 由 viewport 的 interactive-widget=resizes-content 直接缩 layout，
 * visualViewport 同步变化，两者殊途同归不冲突。无 visualViewport 的老浏览器回退 100%。
 * （CSS 侧手机样式走 theme.css 的「≤640px 或 横屏矮高」媒体查询，无需挂 body 类）
 */
export function useMobileGlobals(): void {
  useEffect(() => {
    const vp = window.visualViewport;
    if (!vp) return;
    const sync = () => document.documentElement.style.setProperty('--vvh', `${vp.height}px`);
    sync();
    vp.addEventListener('resize', sync);
    return () => {
      vp.removeEventListener('resize', sync);
      document.documentElement.style.removeProperty('--vvh');
    };
  }, []);
}
