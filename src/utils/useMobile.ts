import { useEffect, useState } from 'react';

/** 手机断点：≤640px（900px 平板竖屏断点保留给上下堆叠布局） */
const MOBILE_QUERY = '(max-width: 640px)';

/** 是否手机窄屏，监听窗口变化实时切换 */
export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() => window.matchMedia(MOBILE_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const onChange = (e: MediaQueryListEvent) => setMobile(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return mobile;
}

/**
 * 全局移动端副作用（App 顶层挂一次）：
 * visualViewport → --vvh CSS 变量——iOS 键盘弹出时 layout viewport 高度不变，
 * 贴底的 Sender/Tab 栏会被键盘盖住；用 --vvh 把 .page 高度同步为可视高度使其收缩。
 * Android Chrome 由 viewport 的 interactive-widget=resizes-content 直接缩 layout，
 * visualViewport 同步变化，两者殊途同归不冲突。无 visualViewport 的老浏览器回退 100%。
 * （CSS 侧的手机样式一律走 @media (max-width: 640px)，无需挂 body 类）
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
