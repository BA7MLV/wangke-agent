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
 * 视觉视口尺寸变化时回调（键盘弹收 / 旋转 / 双栏收起都走这里）。
 *
 * 聊天输入区用它把消息流**重新吸底**：键盘弹出会把面板顶矮一截，
 * 停在原 scrollTop 的最新消息会掉出可视区 —— 而那是用户正盯着要看的地方
 * （刚发出去的问题、正在流的回答）。
 */
export function useViewportResize(onResize: () => void): void {
  useEffect(() => {
    const vp = window.visualViewport;
    if (!vp) return;
    vp.addEventListener('resize', onResize);
    return () => vp.removeEventListener('resize', onResize);
  }, [onResize]);
}

/**
 * 全局移动端副作用（App 顶层挂一次），两件事：
 *
 * 1. **visualViewport → `--vvh`**：iOS 键盘弹出时 layout viewport 高度不变，
 *    贴底的输入栏会被键盘盖住；用 `--vvh` 把 `.page` 高度同步为可视高度使其收缩。
 *    横屏时 `--vvh` 还被用来约束视频宽度（左右分栏下视频不能把控制栏顶出可视区）。
 *    Android Chrome 由 viewport 的 `interactive-widget=resizes-content` 直接缩 layout，
 *    visualViewport 同步变化，两者殊途同归不冲突。无 visualViewport 的老浏览器回退 100%。
 *
 * 2. **键盘开关态 → `<html data-keyboard>`**：输入栏贴着键盘上沿时不该再保留
 *    底部安全区（手势条）内边距 —— 那会变成输入卡与键盘之间的一条缝。
 *
 * （CSS 侧手机样式走 theme.css 的「≤640px 或 横屏矮高」媒体查询，无需挂 body 类）
 */
export function useMobileGlobals(): void {
  useEffect(() => {
    const vp = window.visualViewport;
    if (!vp) return;

    // ── 1. 页面高度 = 可视高度 ──
    const syncHeight = () => {
      /**
       * iOS 键盘弹出时视觉视口除了变矮还会**平移**：`offsetTop` 变大，把聚焦的
       * 输入框从键盘后面拨进可视区（这是 Safari 的既定行为，iOS 26 尤其明显）。
       *
       * 旧算法只取 `vp.height`，在这种「既缩又移」的情况下会缩两轮：页面先按
       * 键盘高度塌一截，视觉视口又整体上移一截，输入栏于是悬在键盘上方一条
       * `offsetTop` 高的空档，底下露出 body 底色 —— 表现就是「键盘起来了，
       * 输入框却浮在上面，中间一条大缝」。
       *
       * `height + offsetTop` 恰好是键盘上沿在 layout 视口里的位置：页面长到那里，
       * 输入栏正好贴在键盘上沿，iOS 平移 / 不平移两种行为都成立。
       * 再夹一层 `window.innerHeight` 是兜底 —— iOS 26 收起键盘后 `offsetTop`
       * 迟迟不归位是个已知 bug，夹一刀至少不让页面越过 layout 视口被裁掉底边。
       */
      const height = Math.min(vp.height + vp.offsetTop, window.innerHeight);
      document.documentElement.style.setProperty('--vvh', `${height}px`);
    };
    syncHeight();
    // resize = 高度/缩放变化（键盘弹收、旋转）；scroll = 视口内平移
    // （键盘把聚焦输入框拨上来时 offsetTop 变而 height 不变，只有 scroll 会响）。
    vp.addEventListener('resize', syncHeight);
    vp.addEventListener('scroll', syncHeight);

    // ── 2. 键盘开关态 ──
    /**
     * 用「有没有聚焦输入框」判定，而不是量视口高度差：
     * Android 的 `interactive-widget=resizes-content` 缩的是 layout 视口，
     * 键盘弹出时 `visualViewport.height` 与 `innerHeight` 一起变小，
     * 「高度差」判据在 Android 上永远不成立；而 focus 状态三端一致。
     * 桌面端聚焦输入框也会置位，但桌面没有安全区，对应 CSS 全是等值无观感。
     */
    const root = document.documentElement;
    let blurTimer = 0;
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target || !/^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
      // 焦点在输入框之间转移（或经键盘工具栏）会先 out 后 in，缓一手，
       // 别让 data-keyboard 闪断，把输入卡与键盘之间的缝闪出来。
      window.clearTimeout(blurTimer);
      root.dataset.keyboard = 'open';
    };
    const onFocusOut = () => {
      window.clearTimeout(blurTimer);
      blurTimer = window.setTimeout(() => {
        delete root.dataset.keyboard;
      }, 200);
    };
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);

    return () => {
      vp.removeEventListener('resize', syncHeight);
      vp.removeEventListener('scroll', syncHeight);
      document.documentElement.style.removeProperty('--vvh');
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      window.clearTimeout(blurTimer);
      delete root.dataset.keyboard;
    };
  }, []);
}
