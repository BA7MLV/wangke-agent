import { useCallback, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type Ref, type RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

export interface VirtualMessagesHandle {
  scrollToIndex: (index: number) => void;
  cancelScroll: () => void;
}

/** Shared dynamic-height window. Stable keys preserve the reading anchor on prepend. */
export default function VirtualMessages<T extends { key: string }>({ items, scrollRef, children, ref, onResize, scrollPaddingStart = 0 }: {
  items: T[];
  scrollRef: RefObject<HTMLDivElement | null>;
  children: (item: T, index: number) => ReactNode;
  ref?: Ref<VirtualMessagesHandle>;
  onResize: () => void;
  scrollPaddingStart?: number;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [margin, setMargin] = useState(0);
  const [positioned, setPositioned] = useState(false);
  const getItemKey = useCallback((index: number) => items[index].key, [items]);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    getItemKey,
    estimateSize: () => 180,
    overscan: 4,
    scrollMargin: margin,
    scrollPaddingStart,
    anchorTo: 'end',
    // useChatScroll owns end-following, including the scrollport's CSS padding.
    // The virtual distance excludes that padding, so even a zero threshold can
    // pull readers back after an upward gesture. A negative threshold disables
    // end-following while anchorTo still preserves keyed anchors on prepend.
    followOnAppend: false,
    scrollEndThreshold: -1,
  });
  useImperativeHandle(ref, () => ({
    scrollToIndex: (index) => virtualizer.scrollToIndex(index, { align: 'start', behavior: 'auto' }),
    cancelScroll: () => virtualizer.cancelScroll(),
  }), [virtualizer]);
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    const host = hostRef.current;
    if (positioned || !scroll || !host || scroll.clientHeight === 0) return;
    // A virtual window initially contains estimates (and may not contain the
    // last row at all). Keep it unpainted until the measured tail is committed.
    virtualizer.scrollToEnd();
    const tailMounted = host.querySelector(`[data-index="${items.length - 1}"]`) != null;
    if (tailMounted && Math.abs(host.offsetHeight - virtualizer.getTotalSize()) < 1) {
      setPositioned(true);
    }
  });
  // Virtualizer commits can adjust the offset without changing total height.
  // Reassert the reading mode after those commits too, not only on resize.
  useLayoutEffect(onResize);
  useLayoutEffect(() => {
    const host = hostRef.current;
    const scroll = scrollRef.current;
    if (!host || !scroll) return;
    const measure = () => {
      setMargin(host.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop);
      onResize();
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroll);
    // The scrollport's height does not change when an answer, image, preview or
    // final action row grows. Observe the virtual content's actual height too.
    observer.observe(host);
    return () => observer.disconnect();
  }, [scrollRef, onResize]);
  return (
    <div ref={hostRef} data-chat-positioned={positioned ? 'true' : 'false'}
      style={{ height: virtualizer.getTotalSize(), position: 'relative', overflowAnchor: 'none' }}>
      {virtualizer.getVirtualItems().map((item) => (
        <div key={item.key} data-index={item.index} ref={virtualizer.measureElement}
          style={{ position: 'absolute', top: item.start - margin, left: 0, width: '100%', display: 'flow-root' }}>
          {children(items[item.index], item.index)}
        </div>
      ))}
    </div>
  );
}
