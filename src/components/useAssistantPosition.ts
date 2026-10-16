import { useLayoutEffect, useRef } from 'react';

const POSITION_KEY = 'wangke-study-assistant-position';
interface Position { right: number; bottom: number }

function readPosition(): Position {
  try {
    const value = JSON.parse(localStorage.getItem(POSITION_KEY) ?? 'null');
    if (value && Number.isFinite(value.right) && Number.isFinite(value.bottom)) {
      return { right: Math.max(0, Math.min(1, value.right)), bottom: Math.max(0, Math.min(1, value.bottom)) };
    }
  } catch { /* 存储不可用时仍可拖动。 */ }
  return { right: 0, bottom: 0 };
}

/** 只移动浮层 DOM，不在 pointermove 时重渲染问答和字幕。位置按可视区比例记忆。 */
export function useAssistantPosition() {
  const boundsRef = useRef<HTMLDivElement>(null);
  const assistantRef = useRef<HTMLDivElement>(null);
  const suppressToggle = useRef(false);

  useLayoutEffect(() => {
    const viewportElement = boundsRef.current;
    const assistant = assistantRef.current;
    if (!viewportElement || !assistant) return;
    let position = readPosition();
    let gesture: {
      id: number; x: number; y: number; right: number; bottom: number;
      previous: Position; moved: boolean; target: Element;
    } | null = null;
    // 透明边框是安全区；绝对定位的 containing block 从边框内沿开始。
    const readBounds = () => {
      const rect = viewportElement.getBoundingClientRect();
      const width = viewportElement.clientWidth, height = viewportElement.clientHeight;
      return { width, height, right: rect.left + viewportElement.clientLeft + width, bottom: rect.top + viewportElement.clientTop + height };
    };
    // 展开、旋转、弹出键盘时只约束显示位置，不覆盖用户原来的位置偏好。
    const place = (preferred: Position): Position => {
      const bounds = readBounds();
      assistant.style.setProperty('--assistant-max-width', `${bounds.width}px`);
      const trigger = assistant.querySelector<HTMLElement>('.study-assistant__heading');
      const gap = parseFloat(getComputedStyle(assistant).rowGap) || 0;
      assistant.style.setProperty('--assistant-max-height', `${Math.max(0, bounds.height - (trigger?.offsetHeight ?? 48) - gap)}px`);
      const rect = assistant.getBoundingClientRect();
      const right = Math.max(0, Math.min(preferred.right * bounds.width, bounds.width - rect.width));
      const bottom = Math.max(0, Math.min(preferred.bottom * bounds.height, bounds.height - rect.height));
      assistant.style.right = `${right}px`;
      assistant.style.bottom = `${bottom}px`;
      return { right: right / (bounds.width || 1), bottom: bottom / (bounds.height || 1) };
    };
    const down = (event: PointerEvent) => {
      if (gesture || !event.isPrimary || event.button !== 0) return;
      suppressToggle.current = false;
      if (!(event.target instanceof Element)) return;
      const handle = event.target.closest('[data-assistant-drag-handle]');
      if (!handle) return;
      const bounds = readBounds();
      const rect = assistant.getBoundingClientRect();
      const target = event.target.closest('button') ?? handle;
      gesture = {
        id: event.pointerId, x: event.clientX, y: event.clientY,
        right: bounds.right - rect.right, bottom: bounds.bottom - rect.bottom,
        previous: position, moved: false, target,
      };
      // RAC 的 Press 会在 pointerdown 释放隐式捕获；随后捕获到原按钮，轻点仍能正常触发。
      // 捕获也确保快速拖到 HTML iframe 上时不会丢失后续移动/抬起事件。
      queueMicrotask(() => {
        if (gesture?.id === event.pointerId && target.isConnected) {
          try { target.setPointerCapture(event.pointerId); } catch { /* 指针已被系统取消。 */ }
        }
      });
    };
    const move = (event: PointerEvent) => {
      if (!gesture || gesture.id !== event.pointerId) return;
      const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
      if (!gesture.moved && Math.hypot(dx, dy) < 6) return;
      gesture.moved = true;
      suppressToggle.current = true;
      assistant.dataset.dragging = 'true';
      event.preventDefault();
      const bounds = readBounds();
      position = place({ right: (gesture.right - dx) / (bounds.width || 1), bottom: (gesture.bottom - dy) / (bounds.height || 1) });
    };
    const finish = (event: PointerEvent, cancelled: boolean) => {
      if (!gesture || gesture.id !== event.pointerId) return;
      const drag = gesture;
      gesture = null;
      delete assistant.dataset.dragging;
      if (drag.moved) {
        if (cancelled) {
          position = drag.previous;
          place(position);
        } else {
          try { localStorage.setItem(POSITION_KEY, JSON.stringify(position)); } catch { /* 仅保留本次位置。 */ }
        }
      }
      if (drag.target.hasPointerCapture(event.pointerId)) drag.target.releasePointerCapture(event.pointerId);
    };
    const up = (event: PointerEvent) => finish(event, false);
    const cancel = (event: PointerEvent) => finish(event, true);
    const keydown = () => { suppressToggle.current = false; };
    const viewport = window.visualViewport;
    const sync = () => {
      // Safari 键盘与双指缩放会同时改变视觉视口的大小和偏移。
      viewportElement.style.top = `${viewport?.offsetTop ?? 0}px`;
      viewportElement.style.left = `${viewport?.offsetLeft ?? 0}px`;
      viewportElement.style.width = `${viewport?.width ?? window.innerWidth}px`;
      viewportElement.style.height = `${viewport?.height ?? window.innerHeight}px`;
      place(position);
    };
    sync();
    const observer = new ResizeObserver(() => place(position));
    observer.observe(assistant);
    observer.observe(viewportElement);
    assistant.addEventListener('pointerdown', down, true);
    assistant.addEventListener('keydown', keydown, true);
    assistant.addEventListener('lostpointercapture', cancel);
    window.addEventListener('pointermove', move, { capture: true, passive: false });
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', cancel, true);
    window.addEventListener('resize', sync);
    viewport?.addEventListener('resize', sync);
    viewport?.addEventListener('scroll', sync);
    return () => {
      observer.disconnect();
      assistant.removeEventListener('pointerdown', down, true);
      assistant.removeEventListener('keydown', keydown, true);
      assistant.removeEventListener('lostpointercapture', cancel);
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', cancel, true);
      window.removeEventListener('resize', sync);
      viewport?.removeEventListener('resize', sync);
      viewport?.removeEventListener('scroll', sync);
    };
  }, []);

  return { boundsRef, assistantRef, suppressToggle };
}
