import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './sticky-header.css';

interface Overlay { target: HTMLElement; style: CSSProperties; height: number }

/** Native sticky owns the bounds. Only its stuck toolbar escapes the chat's
 * clipping/size-container contexts, so the progressive blur cannot cover it. */
export default function StickyHeader({ children, className, enabled = true }: {
  children: ReactNode; className: string; enabled?: boolean;
}) {
  const markerRef = useRef<HTMLSpanElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [overlay, setOverlay] = useState<Overlay | null>(null);

  useLayoutEffect(() => {
    const slot = slotRef.current;
    const scroll = slot?.closest<HTMLElement>('.course-chat__messages');
    const target = slot?.closest<HTMLElement>('.page-shell__surface');
    if (!enabled || !slot || !scroll || !target) { setOverlay(null); return; }
    let frame = 0;
    const measure = () => {
      frame = 0;
      const rect = slot.getBoundingClientRect();
      const marker = markerRef.current?.getBoundingClientRect();
      const viewport = scroll.getBoundingClientRect();
      const barBottom = target.querySelector('[data-testid="top-app-bar"]')?.getBoundingClientRect().bottom ?? viewport.top;
      if (!marker || rect.top <= marker.top + 1 || rect.bottom <= barBottom || rect.top >= viewport.bottom) {
        setOverlay(previous => previous === null ? previous : null);
        return;
      }
      const computed = getComputedStyle(slot);
      const height = overlayRef.current?.getBoundingClientRect().height ?? rect.height;
      const style: CSSProperties = {
        top: rect.top, left: rect.left, width: rect.width,
        backgroundColor: computed.backgroundColor, color: computed.color,
        fontSize: computed.fontSize, lineHeight: computed.lineHeight,
        // A containing block pushes native sticky out at its end. Do not let
        // that last sliver cover the navigation controls above the reading area.
        clipPath: `inset(${Math.max(0, barBottom - rect.top)}px 0 0)`,
      };
      // Portals retain React context, but not CSS inheritance from the message.
      for (const token of ['--muted', '--foreground', '--radius-chip', '--reasoning-expand-duration',
        '--reasoning-expand-ease', '--reasoning-sticky-bg']) {
        const value = computed.getPropertyValue(token);
        if (value) (style as Record<string, unknown>)[token] = value;
      }
      setOverlay(previous => previous && previous.target === target && previous.height === height
        && JSON.stringify(previous.style) === JSON.stringify(style) ? previous : { target, style, height });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    measure();
    const observer = new ResizeObserver(schedule);
    observer.observe(slot);
    observer.observe(scroll);
    observer.observe(target);
    if (slot.parentElement) observer.observe(slot.parentElement);
    const messageWindow = slot.closest('[data-chat-positioned]');
    if (messageWindow) observer.observe(messageWindow);
    const appearance = new MutationObserver(schedule);
    for (let ancestor = slot.parentElement; ancestor; ancestor = ancestor.parentElement) {
      appearance.observe(ancestor, { attributes: true, attributeFilter: ['class', 'style'] });
    }
    scroll.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      appearance.disconnect();
      scroll.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [enabled]);

  useLayoutEffect(() => {
    const node = overlayRef.current;
    if (!node) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const height = node.getBoundingClientRect().height;
        setOverlay(previous => previous && previous.height !== height ? { ...previous, height } : previous);
      });
    });
    observer.observe(node);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [!!overlay]);

  const classes = `chat-sticky-header ${className}`;
  return <>
    <span ref={markerRef} className="chat-sticky-marker" aria-hidden="true" />
    <div ref={slotRef} className={classes} data-sticky={enabled || undefined}
      style={overlay ? { height: overlay.height } : undefined}>
      {!overlay && children}
    </div>
    {overlay && createPortal(<div ref={overlayRef} className={`${classes} chat-sticky-overlay`}
      data-sticky={enabled || undefined} style={overlay.style}>{children}</div>, overlay.target)}
  </>;
}
