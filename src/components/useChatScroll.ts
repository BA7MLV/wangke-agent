import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { prefersReducedMotion } from '../utils/motion';
import { useViewportResize } from '../utils/useMobile';

const NEAR_BOTTOM_PX = 24;

/** Layout-driven following, shared by the main chat and the course side panel. */
export function useChatScroll(
  scrollRef: RefObject<HTMLDivElement | null>,
  sessionKey: unknown,
  revision: string,
  onReachStart: () => void,
  jumpButtonRef?: RefObject<HTMLButtonElement | null>,
) {
  const stickRef = useRef(true);
  const frameRef = useRef(0);
  const lastTopRef = useRef(0);
  const lastBottomRef = useRef(0);
  const reachStartRef = useRef(onReachStart);
  reachStartRef.current = onReachStart;

  const syncButton = useCallback(() => {
    const element = scrollRef.current;
    const button = jumpButtonRef?.current;
    if (element && button) {
      const distance = element.scrollHeight - element.clientHeight - element.scrollTop;
      button.dataset.show = !stickRef.current && distance > NEAR_BOTTOM_PX ? 'true' : 'false';
    }
  }, [scrollRef, jumpButtonRef]);

  // Coalesce token, ResizeObserver and viewport updates. Read the height at execution
  // time, after the virtual rows / Markdown have committed their actual layout.
  const pinIfSticking = useCallback(() => {
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      const element = scrollRef.current;
      if (element && element.clientHeight > 0 && stickRef.current) {
        const bottom = Math.max(0, element.scrollHeight - element.clientHeight);
        if (Math.abs(bottom - element.scrollTop) > 1) element.scrollTop = bottom;
        lastTopRef.current = element.scrollTop;
        lastBottomRef.current = bottom;
      }
      syncButton();
    });
  }, [scrollRef, syncButton]);

  const pauseFollowing = useCallback(() => {
    stickRef.current = false;
    cancelAnimationFrame(frameRef.current);
    frameRef.current = 0;
    syncButton();
  }, [syncButton]);

  const jumpToLatest = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    stickRef.current = true;
    lastTopRef.current = element.scrollTop;
    element.scrollTo({ top: element.scrollHeight, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    syncButton();
  }, [scrollRef, syncButton]);

  useLayoutEffect(() => {
    stickRef.current = true;
    lastTopRef.current = scrollRef.current?.scrollTop ?? 0;
    lastBottomRef.current = Math.max(0, (scrollRef.current?.scrollHeight ?? 0) - (scrollRef.current?.clientHeight ?? 0));
    syncButton();
    pinIfSticking();
    return () => {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
    };
  }, [sessionKey, scrollRef, syncButton, pinIfSticking]);

  useEffect(pinIfSticking, [revision, pinIfSticking]);
  useViewportResize(pinIfSticking);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    let touchY: number | undefined;
    const scrollsInside = (target: EventTarget | null) => {
      // Scrolling an expanded reasoning pane / code block must not release the
      // outer timeline until that inner pane actually reaches its upper edge.
      for (let node = target instanceof Element ? target : null; node && node !== element; node = node.parentElement) {
        if (node instanceof HTMLElement && node.scrollTop > 0 && /auto|scroll/.test(getComputedStyle(node).overflowY)) return true;
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
      if (!layoutChanged && top < lastTopRef.current - 1 && distance > 1) pauseFollowing();
      else if (top > lastTopRef.current + 1 && distance <= NEAR_BOTTOM_PX) stickRef.current = true;
      lastTopRef.current = top;
      lastBottomRef.current = bottom;
      if (top < 40 && !stickRef.current) reachStartRef.current();
      syncButton();
    };
    // Release BEFORE a pending follow frame can undo the user's upward gesture,
    // even when they have only moved a few pixels away from the bottom.
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0 && !event.ctrlKey && !scrollsInside(event.target)) pauseFollowing();
    };
    const onTouchStart = (event: TouchEvent) => { touchY = event.touches.length === 1 ? event.touches[0].clientY : undefined; };
    const onTouchMove = (event: TouchEvent) => {
      if (touchY == null || event.touches.length !== 1) return;
      const nextY = event.touches[0].clientY;
      if (nextY > touchY + 1 && !scrollsInside(event.target)) pauseFollowing();
      touchY = nextY;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || event.key === ' ' && event.shiftKey) pauseFollowing();
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    element.addEventListener('wheel', onWheel, { passive: true });
    element.addEventListener('touchstart', onTouchStart, { passive: true });
    element.addEventListener('touchmove', onTouchMove, { passive: true });
    element.addEventListener('keydown', onKeyDown);
    return () => {
      element.removeEventListener('scroll', onScroll);
      element.removeEventListener('wheel', onWheel);
      element.removeEventListener('touchstart', onTouchStart);
      element.removeEventListener('touchmove', onTouchMove);
      element.removeEventListener('keydown', onKeyDown);
    };
  }, [scrollRef, pauseFollowing, syncButton]);

  return { pinIfSticking, pauseFollowing, jumpToLatest };
}
