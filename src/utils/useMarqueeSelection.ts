import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';

/** Desktop blank-space selection; item drags and touch scrolling remain native. */
export function useMarqueeSelection(selection: Set<string>, onChange: (keys: Set<string>) => void) {
  const [box, setBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  const suppressClick = useRef(false);
  useEffect(() => () => cleanup.current?.(), []);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'mouse' || event.button !== 0 ||
      (event.target as HTMLElement).closest('.finder-item, button, input, a, [role="button"]')) return;
    const canvas = event.currentTarget;
    const bounds = canvas.getBoundingClientRect();
    // Do not intercept the native scrollbars.
    if (event.clientX >= bounds.left + canvas.clientWidth || event.clientY >= bounds.top + canvas.clientHeight) return;
    cleanup.current?.();
    suppressClick.current = false;
    const original = new Set(selection);
    const base = event.ctrlKey || event.metaKey || event.shiftKey ? original : new Set<string>();
    const startX = event.clientX;
    const startY = event.clientY;
    const originX = startX - bounds.left + canvas.scrollLeft;
    const originY = startY - bounds.top + canvas.scrollTop;
    let x = startX;
    let y = startY;
    let active = false;
    let lastSelection = original;
    let frame = 0;
    const previousUserSelect = canvas.style.userSelect;

    const update = () => {
      const rect = canvas.getBoundingClientRect();
      const endX = Math.max(0, Math.min(canvas.scrollWidth, x - rect.left + canvas.scrollLeft));
      const endY = Math.max(0, Math.min(canvas.scrollHeight, y - rect.top + canvas.scrollTop));
      const left = Math.min(originX, endX);
      const top = Math.min(originY, endY);
      const right = Math.max(originX, endX);
      const bottom = Math.max(originY, endY);
      const next = new Set(base);
      for (const item of canvas.querySelectorAll<HTMLElement>('.finder-item')) {
        const itemRect = item.getBoundingClientRect();
        const itemLeft = itemRect.left - rect.left + canvas.scrollLeft;
        const itemTop = itemRect.top - rect.top + canvas.scrollTop;
        if (itemLeft < right && itemLeft + itemRect.width > left && itemTop < bottom && itemTop + itemRect.height > top) {
          const key = item.dataset.selectionKey ?? (item.dataset.videoId ? `file:${item.dataset.videoId}` : `folder:${item.dataset.groupKey}`);
          next.add(key);
        }
      }
      if (next.size !== lastSelection.size || [...next].some((key) => !lastSelection.has(key))) {
        onChange(next);
        lastSelection = next;
      }
      setBox({ left, top, width: right - left, height: bottom - top });
    };
    const tick = () => {
      const rect = canvas.getBoundingClientRect();
      const velocity = (position: number, min: number, max: number) => position < min + 32
        ? -Math.min(18, (min + 32 - position) / 3)
        : position > max - 32 ? Math.min(18, (position - max + 32) / 3) : 0;
      canvas.scrollBy(velocity(x, rect.left, rect.right), velocity(y, rect.top, rect.bottom));
      update();
      frame = requestAnimationFrame(tick);
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== event.pointerId) return;
      x = e.clientX;
      y = e.clientY;
      if (!active && Math.hypot(x - startX, y - startY) < 5) return;
      e.preventDefault();
      if (!active) {
        active = true;
        suppressClick.current = true;
        canvas.style.userSelect = 'none';
        window.getSelection()?.removeAllRanges();
        frame = requestAnimationFrame(tick);
      }
    };
    const finish = (cancel = false) => {
      if (active) {
        if (cancel) onChange(original);
        else update();
      }
      cleanup.current?.();
      setBox(null);
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== event.pointerId) return;
      x = e.clientX;
      y = e.clientY;
      finish();
    };
    const cancel = () => finish(true);
    const keydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', keydown);
    cleanup.current = () => {
      cancelAnimationFrame(frame);
      canvas.style.userSelect = previousUserSelect;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', keydown);
      cleanup.current = null;
    };
  };

  return { box, onPointerDown, onClickCapture: (event: ReactMouseEvent) => {
    if (suppressClick.current) {
      event.preventDefault();
      event.stopPropagation();
      suppressClick.current = false;
    }
  } };
}
