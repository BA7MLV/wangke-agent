import { useCallback, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

/** Shared dynamic-height window. Stable keys preserve the reading anchor on prepend. */
export default function VirtualMessages<T extends { key: string }>({ items, scrollRef, children }: {
  items: T[];
  scrollRef: RefObject<HTMLDivElement | null>;
  children: (item: T, index: number) => ReactNode;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const positioned = useRef(false);
  const [margin, setMargin] = useState(0);
  const getItemKey = useCallback((index: number) => items[index].key, [items]);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    getItemKey,
    estimateSize: () => 180,
    overscan: 4,
    scrollMargin: margin,
    anchorTo: 'end',
    followOnAppend: true,
    scrollEndThreshold: 80,
  });
  useLayoutEffect(() => {
    const host = hostRef.current;
    const scroll = scrollRef.current;
    if (!host || !scroll) return;
    const measure = () => {
      setMargin(host.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop);
      // Force-mounted tabs initially measure as zero; position only once they become visible.
      if (!positioned.current && scroll.clientHeight > 0) {
        positioned.current = true;
        virtualizer.scrollToEnd();
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroll);
    return () => observer.disconnect();
  }, [scrollRef]);
  useLayoutEffect(() => {
    if (items.length) virtualizer.scrollToEnd();
    // Each mounted session starts at its latest message.
  }, []);
  return (
    <div ref={hostRef} style={{ height: virtualizer.getTotalSize(), position: 'relative', overflowAnchor: 'none' }}>
      {virtualizer.getVirtualItems().map((item) => (
        <div key={item.key} data-index={item.index} ref={virtualizer.measureElement}
          style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${item.start - margin}px)`, display: 'flow-root' }}>
          {children(items[item.index], item.index)}
        </div>
      ))}
    </div>
  );
}
