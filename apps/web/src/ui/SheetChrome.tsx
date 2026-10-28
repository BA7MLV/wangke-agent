import { useLayoutEffect, useRef, type ReactNode } from 'react';
import './sheet-chrome.css';

/** Overlay the real scroll surface; a blur over an in-flow header samples only
 * the sheet's empty background. Measure on resize, never on scroll. */
export default function SheetChrome({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const header = ref.current;
    const dialog = header?.closest<HTMLElement>('[role="dialog"]');
    if (!header || !dialog) return;
    const measure = () => dialog.style.setProperty('--sheet-chrome-height', `${header.offsetHeight}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    return () => { observer.disconnect(); dialog.style.removeProperty('--sheet-chrome-height'); };
  }, []);
  return <div ref={ref} className="sheet-chrome">
    <div className="sheet-chrome__blur" aria-hidden="true"><span /><span /><span /><span /></div>
    {children}
  </div>;
}
