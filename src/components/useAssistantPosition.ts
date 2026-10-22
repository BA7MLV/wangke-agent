import { useLayoutEffect, useRef } from 'react';
import {
  ASSISTANT_DEFAULT_SIZE, ASSISTANT_TRIGGER_SIZE, clamp, getAssistantLayout, resizeAssistantLayout,
  type AssistantAnchor, type AssistantLayout, type AssistantResizeEdge, type AssistantSize,
} from './assistantGeometry';

const POSITION_KEY = 'wangke-study-assistant-position';
const SIZE_KEY = 'wangke-study-assistant-size';
interface Position { right: number; bottom: number }

function readSize(): AssistantSize {
  try {
    const value = JSON.parse(localStorage.getItem(SIZE_KEY) ?? 'null');
    if (value && Number.isFinite(value.width) && Number.isFinite(value.height)) {
      return { width: Math.max(320, value.width), height: Math.max(300, value.height) };
    }
  } catch { /* 存储不可用时使用默认尺寸。 */ }
  return { ...ASSISTANT_DEFAULT_SIZE };
}

function readPosition(): Position {
  try {
    const value = JSON.parse(localStorage.getItem(POSITION_KEY) ?? 'null');
    if (value && Number.isFinite(value.right) && Number.isFinite(value.bottom)) {
      return { right: clamp(value.right, 0, 1), bottom: clamp(value.bottom, 0, 1) };
    }
  } catch { /* 存储不可用时仍可拖动。 */ }
  return { right: 0, bottom: 0 };
}

/** 入口独立定位；拖动和缩放只写 DOM，不重渲染问答、字幕或输入草稿。 */
export function useAssistantPosition(open: boolean) {
  const boundsRef = useRef<HTMLDivElement>(null);
  const assistantRef = useRef<HTMLDivElement>(null);
  const suppressToggle = useRef(false);
  const syncRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const viewportElement = boundsRef.current;
    const assistant = assistantRef.current;
    if (!viewportElement || !assistant) return;
    let position = readPosition();
    let size = readSize();
    let anchor: AssistantAnchor = { x: 0, y: 0 };
    let layout: AssistantLayout;
    const readBounds = () => ({ width: viewportElement.clientWidth, height: viewportElement.clientHeight });
    const saveSize = () => {
      try { localStorage.setItem(SIZE_KEY, JSON.stringify(size)); } catch { /* 仅保留本次尺寸。 */ }
    };
    const applyAnchor = (next: AssistantAnchor) => {
      const bounds = readBounds();
      anchor = next;
      assistant.style.right = `${bounds.width - next.x - ASSISTANT_TRIGGER_SIZE}px`;
      assistant.style.bottom = `${bounds.height - next.y - ASSISTANT_TRIGGER_SIZE}px`;
    };
    const applyPanel = (next: AssistantLayout) => {
      layout = next;
      assistant.style.setProperty('--assistant-panel-left', `${next.x - anchor.x}px`);
      assistant.style.setProperty('--assistant-panel-top', `${next.y - anchor.y}px`);
      assistant.style.setProperty('--assistant-width', `${next.width}px`);
      assistant.style.setProperty('--assistant-height', `${next.height}px`);
      assistant.dataset.placement = next.placement;
      const panel = assistant.querySelector<HTMLElement>('.study-assistant__content');
      if (panel) panel.dataset.origin = `${next.resizeY === 'top' ? 'bottom' : 'top'}-${next.resizeX === 'left' ? 'right' : 'left'}`;
    };
    // 展开、旋转、弹出键盘都不改入口的位置偏好，也不覆盖用户保存的尺寸。
    const place = () => {
      const bounds = readBounds();
      applyAnchor({
        x: bounds.width - ASSISTANT_TRIGGER_SIZE - clamp(position.right * bounds.width, 0, bounds.width - ASSISTANT_TRIGGER_SIZE),
        y: bounds.height - ASSISTANT_TRIGGER_SIZE - clamp(position.bottom * bounds.height, 0, bounds.height - ASSISTANT_TRIGGER_SIZE),
      });
      applyPanel(getAssistantLayout(bounds, anchor, size, layout?.placement));
    };
    let gesture: {
      id: number; x: number; y: number; target: Element; moved: boolean; resize: AssistantResizeEdge | null;
      previous: Position; previousSize: AssistantSize; anchor: AssistantAnchor; layout: AssistantLayout;
      minX: number; minY: number; maxX: number; maxY: number;
    } | null = null;
    const down = (event: PointerEvent) => {
      if (gesture || !event.isPrimary || event.button !== 0) return;
      suppressToggle.current = false;
      if (!(event.target instanceof Element)) return;
      const handle = event.target.closest('[data-assistant-drag-handle], [data-assistant-resize-handle]');
      if (!handle) return;
      const expanded = assistant.hasAttribute('data-expanded');
      const target = event.target.closest('button') ?? handle;
      gesture = {
        id: event.pointerId, x: event.clientX, y: event.clientY, target, moved: false,
        resize: handle.getAttribute('data-assistant-resize-handle') as AssistantResizeEdge | null,
        previous: position, previousSize: size, anchor, layout,
        minX: expanded ? Math.min(anchor.x, layout.x) : anchor.x,
        minY: expanded ? Math.min(anchor.y, layout.y) : anchor.y,
        maxX: expanded ? Math.max(anchor.x + ASSISTANT_TRIGGER_SIZE, layout.x + layout.width) : anchor.x + ASSISTANT_TRIGGER_SIZE,
        maxY: expanded ? Math.max(anchor.y + ASSISTANT_TRIGGER_SIZE, layout.y + layout.height) : anchor.y + ASSISTANT_TRIGGER_SIZE,
      };
      // RAC 的 Press 会在 pointerdown 释放隐式捕获；随后捕获，轻点仍能正常触发。
      // 捕获也确保拖到 HTML iframe 上时不会丢失后续移动/抬起事件。
      queueMicrotask(() => {
        if (gesture?.id === event.pointerId && target.isConnected) {
          try { target.setPointerCapture(event.pointerId); } catch { /* 指针已被系统取消。 */ }
        }
      });
    };
    const resizePanel = (original: AssistantLayout, edge: AssistantResizeEdge, dx: number, dy: number) => {
      const next = resizeAssistantLayout(readBounds(), anchor, original, edge, dx, dy);
      size = { width: next.width, height: next.height };
      applyPanel(next);
    };
    const move = (event: PointerEvent) => {
      if (!gesture || gesture.id !== event.pointerId) return;
      const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
      if (!gesture.moved && Math.hypot(dx, dy) < 6) return;
      gesture.moved = true;
      suppressToggle.current = true;
      event.preventDefault();
      if (gesture.resize) {
        assistant.dataset.resizing = 'true';
        resizePanel(gesture.layout, gesture.resize, dx, dy);
        return;
      }
      assistant.dataset.dragging = 'true';
      const bounds = readBounds();
      const moveX = clamp(dx, -gesture.minX, bounds.width - gesture.maxX);
      const moveY = clamp(dy, -gesture.minY, bounds.height - gesture.maxY);
      applyAnchor({ x: gesture.anchor.x + moveX, y: gesture.anchor.y + moveY });
      position = {
        right: (bounds.width - anchor.x - ASSISTANT_TRIGGER_SIZE) / (bounds.width || 1),
        bottom: (bounds.height - anchor.y - ASSISTANT_TRIGGER_SIZE) / (bounds.height || 1),
      };
      if (assistant.hasAttribute('data-expanded')) {
        // 手势期间保持展开方向和相对位置，避免越过中线时浮窗突然翻到另一侧。
        applyPanel({ ...gesture.layout, x: gesture.layout.x + moveX, y: gesture.layout.y + moveY });
      } else {
        applyPanel(getAssistantLayout(bounds, anchor, size));
      }
    };
    const finish = (event: PointerEvent, cancelled: boolean) => {
      if (!gesture || gesture.id !== event.pointerId) return;
      const drag = gesture;
      gesture = null;
      delete assistant.dataset.dragging;
      delete assistant.dataset.resizing;
      if (drag.moved) {
        if (cancelled) {
          position = drag.previous;
          size = drag.previousSize;
          applyAnchor(drag.anchor);
          applyPanel(drag.layout);
        } else {
          if (drag.resize) saveSize();
          else try { localStorage.setItem(POSITION_KEY, JSON.stringify(position)); } catch { /* 仅保留本次位置。 */ }
        }
      }
      if (drag.target.hasPointerCapture(event.pointerId)) drag.target.releasePointerCapture(event.pointerId);
    };
    const up = (event: PointerEvent) => finish(event, false);
    const cancel = (event: PointerEvent) => finish(event, true);
    const keydown = (event: KeyboardEvent) => {
      suppressToggle.current = false;
      if (!(event.target instanceof Element)) return;
      const edge = event.target.closest('[data-assistant-resize-handle]')?.getAttribute('data-assistant-resize-handle') as AssistantResizeEdge | undefined;
      if (!edge) return;
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return;
      event.preventDefault();
      if (event.key === 'Home') {
        size = { ...ASSISTANT_DEFAULT_SIZE };
        place();
      } else {
        const step = event.shiftKey ? 40 : 10;
        resizePanel(layout, edge,
          event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0,
          event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0);
      }
      saveSize();
    };
    const viewport = window.visualViewport;
    const sync = () => {
      // Safari 键盘与双指缩放会同时改变视觉视口的大小和偏移。
      viewportElement.style.top = `${viewport?.offsetTop ?? 0}px`;
      viewportElement.style.left = `${viewport?.offsetLeft ?? 0}px`;
      viewportElement.style.width = `${viewport?.width ?? window.innerWidth}px`;
      viewportElement.style.height = `${viewport?.height ?? window.innerHeight}px`;
      place();
    };
    syncRef.current = sync;
    sync();
    const observer = new ResizeObserver(sync);
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
      syncRef.current = null;
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

  useLayoutEffect(() => { syncRef.current?.(); }, [open]);
  return { boundsRef, assistantRef, suppressToggle };
}
