import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { prefersReducedMotion } from '../utils/motion';
import { useViewportResize } from '../utils/useMobile';
import type { VirtualMessagesHandle } from './VirtualMessages';

const NEAR_BOTTOM_PX = 24;

interface ScrollMessage { key: string; role: string }
interface ChatScrollOptions {
  sessionKey: unknown;
  revision: string;
  messages: readonly ScrollMessage[];
  virtualRef: RefObject<VirtualMessagesHandle | null>;
  onReachStart: () => void;
  jumpButtonRef?: RefObject<HTMLButtonElement | null>;
}

/** Default to the reply's beginning; only an explicit jump opts into tail-following. */
export function useChatScroll(
  scrollRef: RefObject<HTMLDivElement | null>,
  { sessionKey, revision, messages, virtualRef, onReachStart, jumpButtonRef }: ChatScrollOptions,
) {
  const modeRef = useRef<'start' | 'manual' | 'end'>('start');
  const frameRef = useRef(0);
  const lastTopRef = useRef(0);
  const lastBottomRef = useRef(0);
  const latestRef = useRef({ key: '', index: 0 });
  latestRef.current = { key: messages[messages.length - 1]?.key ?? '', index: messages.length - 1 };
  // A new question starts a fresh reading anchor. Token updates, persistence and
  // a cloud reply changing keys at completion must NOT reset manual reading.
  let turnKey: string | undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === 'user') { turnKey = messages[index].key; break; }
  }
  const reachStartRef = useRef(onReachStart);
  reachStartRef.current = onReachStart;

  const syncButton = useCallback(() => {
    const element = scrollRef.current;
    const button = jumpButtonRef?.current;
    if (element && button) {
      const distance = element.scrollHeight - element.clientHeight - element.scrollTop;
      button.dataset.show = modeRef.current !== 'end' && distance > NEAR_BOTTOM_PX ? 'true' : 'false';
    }
  }, [scrollRef, jumpButtonRef]);

  // Coalesce token, ResizeObserver and viewport updates. Read the height at execution
  // time, after the virtual rows / Markdown have committed their actual layout.
  const pinIfSticking = useCallback(() => {
    if (frameRef.current) return;
    let attempts = 0;
    const position = () => {
      frameRef.current = 0;
      const element = scrollRef.current;
      if (element && element.clientHeight > 0 && modeRef.current !== 'manual') {
        const bottom = Math.max(0, element.scrollHeight - element.clientHeight);
        let target = bottom;
        if (modeRef.current === 'start' && latestRef.current.key) {
          const { key, index } = latestRef.current;
          const article = element.querySelector<HTMLElement>(`[data-chat-message="${CSS.escape(key)}"]`);
          if (!article) {
            // The latest reply may be outside the mounted virtual window.
            // Bring its row in first, then measure the real answer start.
            if (attempts++ < 3) {
              virtualRef.current?.scrollToIndex(index);
              frameRef.current = requestAnimationFrame(position);
            }
            return;
          }
          const answer = article.querySelector<HTMLElement>('[data-chat-answer-start]') ?? article;
          const inset = parseFloat(getComputedStyle(element).paddingTop) || 0;
          const answerTop = element.scrollTop + answer.getBoundingClientRect().top - element.getBoundingClientRect().top - inset;
          // Short replies stay fully visible without manufacturing a blank screen below them.
          target = Math.max(0, Math.min(bottom, answerTop));
        }
        virtualRef.current?.cancelScroll();
        if (Math.abs(target - element.scrollTop) > 1) element.scrollTop = target;
        lastTopRef.current = element.scrollTop;
        lastBottomRef.current = bottom;
      }
      syncButton();
    };
    frameRef.current = requestAnimationFrame(position);
  }, [scrollRef, syncButton, virtualRef]);

  const pauseFollowing = useCallback(() => {
    modeRef.current = 'manual';
    virtualRef.current?.cancelScroll();
    cancelAnimationFrame(frameRef.current);
    frameRef.current = 0;
    syncButton();
  }, [syncButton, virtualRef]);

  const jumpToLatest = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    modeRef.current = 'end';
    virtualRef.current?.cancelScroll();
    lastTopRef.current = element.scrollTop;
    element.scrollTo({ top: element.scrollHeight, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    syncButton();
  }, [scrollRef, syncButton, virtualRef]);

  useLayoutEffect(() => {
    modeRef.current = 'start';
    lastTopRef.current = scrollRef.current?.scrollTop ?? 0;
    lastBottomRef.current = Math.max(0, (scrollRef.current?.scrollHeight ?? 0) - (scrollRef.current?.clientHeight ?? 0));
    syncButton();
    pinIfSticking();
    return () => {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
    };
  }, [sessionKey, turnKey, scrollRef, syncButton, pinIfSticking]);

  useEffect(pinIfSticking, [revision, pinIfSticking]);
  useViewportResize(pinIfSticking);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    let touchY: number | undefined;
    const scrollsInside = (target: EventTarget | null, direction: number) => {
      // Scrolling an expanded reasoning pane / code block must not release the
      // outer timeline until that inner pane actually reaches the requested edge.
      for (let node = target instanceof Element ? target : null; node && node !== element; node = node.parentElement) {
        if (node instanceof HTMLElement && /auto|scroll/.test(getComputedStyle(node).overflowY)
          && (direction < 0 ? node.scrollTop > 0 : node.scrollTop + node.clientHeight < node.scrollHeight - 1)) return true;
      }
      return false;
    };
    const onScroll = () => {
      // Clamp Safari's elastic overscroll before comparing directions.
      const bottom = Math.max(0, element.scrollHeight - element.clientHeight);
      const top = Math.max(0, Math.min(bottom, element.scrollTop));
      const distance = bottom - top;
      // Virtual rows can correct an estimate by moving upward while their total
      // height changes. That is a layout adjustment, not a reader scrolling up.
      const layoutChanged = Math.abs(bottom - lastBottomRef.current) > 1;
      if (modeRef.current === 'end' && !layoutChanged && top < lastTopRef.current - 1 && distance > 1) pauseFollowing();
      lastTopRef.current = top;
      lastBottomRef.current = bottom;
      if (top < 40 && modeRef.current === 'manual') reachStartRef.current();
      syncButton();
    };
    // Either direction hands control to the reader BEFORE a queued frame can
    // restore the answer start. Reaching the bottom manually does not opt in.
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY !== 0 && !event.ctrlKey && !scrollsInside(event.target, event.deltaY)) pauseFollowing();
    };
    const onTouchStart = (event: TouchEvent) => { touchY = event.touches.length === 1 ? event.touches[0].clientY : undefined; };
    const onTouchMove = (event: TouchEvent) => {
      if (touchY == null || event.touches.length !== 1) return;
      const nextY = event.touches[0].clientY;
      const direction = touchY - nextY;
      if (Math.abs(direction) > 1 && !scrollsInside(event.target, direction)) pauseFollowing();
      touchY = nextY;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable="true"]')) return;
      const upward = ['ArrowUp', 'PageUp', 'Home'].includes(event.key) || event.key === ' ' && event.shiftKey;
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)
        && !scrollsInside(event.target, upward ? -1 : 1)) pauseFollowing();
    };
    const onPointerDown = (event: PointerEvent) => {
      // Native scrollbar drags have no wheel/touch event.
      if (event.target !== element || event.pointerType === 'touch') return;
      const bounds = element.getBoundingClientRect();
      const gutter = Math.max(12, element.offsetWidth - element.clientWidth);
      if (event.clientX >= bounds.right - gutter || event.clientX <= bounds.left + gutter) pauseFollowing();
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    element.addEventListener('wheel', onWheel, { passive: true });
    element.addEventListener('touchstart', onTouchStart, { passive: true });
    element.addEventListener('touchmove', onTouchMove, { passive: true });
    element.addEventListener('keydown', onKeyDown);
    element.addEventListener('pointerdown', onPointerDown);
    return () => {
      element.removeEventListener('scroll', onScroll);
      element.removeEventListener('wheel', onWheel);
      element.removeEventListener('touchstart', onTouchStart);
      element.removeEventListener('touchmove', onTouchMove);
      element.removeEventListener('keydown', onKeyDown);
      element.removeEventListener('pointerdown', onPointerDown);
    };
  }, [scrollRef, pauseFollowing, syncButton]);

  return { pinIfSticking, pauseFollowing, jumpToLatest };
}
