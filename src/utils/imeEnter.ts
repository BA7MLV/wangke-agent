import { useMemo, useRef } from 'react';
import type { CompositionEvent, KeyboardEvent } from 'react';

/**
 * 输入法（IME）安全的回车判定。
 *
 * 中文、日文输入法选词时按下的回车是「确认候选词」，不是「发送」。三种浏览器各有各的坑：
 *
 * 1. Chrome / Firefox：选词中的 keydown 带 `isComposing: true`，最省心。
 * 2. 部分 Android 输入法：在 compositionend **之前**就派发 keydown，且不带 isComposing，
 *    只能靠 composition 事件自己记状态兜底。
 * 3. Safari（macOS / iOS）：顺序反过来 —— 先 compositionend，再派发那次回车的 keydown，
 *    此时 isComposing 已是 false，自记的状态也已清掉，于是**确认候选词就把消息发出去了**。
 *    这次 keydown 的 keyCode 固定是 229（「输入法正在处理」），再加一个极短的时间窗兜底。
 *
 * 以前 ChatPanel 和 CourseChat 各写一份前两条，Safari 这条都漏了；这里收成一处。
 */
const SAFARI_COMPOSITION_END_WINDOW_MS = 40;

export interface ImeEnterGuard {
  /** 展开到 textarea / input 上 */
  compositionProps: {
    onCompositionStart: (event: CompositionEvent<HTMLElement>) => void;
    onCompositionEnd: (event: CompositionEvent<HTMLElement>) => void;
  };
  /** 这次 keydown 是否属于输入法（是则不要当成发送） */
  isComposing: (event: KeyboardEvent<HTMLElement>) => boolean;
  /** 普通回车（不含 Shift、不在选词中）—— 即「发送」意图 */
  isSubmitEnter: (event: KeyboardEvent<HTMLElement>) => boolean;
}

export function isImeKeyEvent(event: KeyboardEvent<HTMLElement>, composing: boolean, lastEnd: number): boolean {
  const native = event.nativeEvent;
  if (native.isComposing || composing) return true;
  if (native.keyCode === 229) return true;
  return performance.now() - lastEnd < SAFARI_COMPOSITION_END_WINDOW_MS;
}

export function useImeEnter(): ImeEnterGuard {
  const composing = useRef(false);
  const lastEnd = useRef(-Infinity);
  return useMemo<ImeEnterGuard>(() => {
    const isComposing = (event: KeyboardEvent<HTMLElement>) => isImeKeyEvent(event, composing.current, lastEnd.current);
    return {
      compositionProps: {
        onCompositionStart: () => { composing.current = true; },
        onCompositionEnd: () => { composing.current = false; lastEnd.current = performance.now(); },
      },
      isComposing,
      isSubmitEnter: (event) => event.key === 'Enter' && !event.shiftKey && !event.altKey && !isComposing(event),
    };
  }, []);
}
