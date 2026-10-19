import { memo, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Tooltip } from '@heroui/react';
import type { VirtualMessagesHandle } from './VirtualMessages';
import './chat-message-nav.css';

interface NavMessage {
  key: string;
  role: string;
  content: string;
}

/** Only this small index updates while scrolling, not the message tree. */
export default memo(function ChatMessageNav({ messages, scrollRef, virtualRef, onNavigate }: {
  messages: NavMessage[];
  scrollRef: RefObject<HTMLDivElement | null>;
  virtualRef: RefObject<VirtualMessagesHandle | null>;
  onNavigate: () => void;
}) {
  const entries = useMemo(() => messages.flatMap((message, index) => message.role === 'user'
    ? [{ key: message.key, index, label: message.content.replace(/\s+/g, ' ').trim().slice(0, 120) || '附件消息' }]
    : []), [messages]);
  const [activeKey, setActiveKey] = useState<string>();
  const navRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll || !entries.length) return;
    let frame = 0;
    const sync = () => {
      frame = 0;
      const readingTop = scroll.getBoundingClientRect().top + 100;
      let index = 0;
      // Only mounted virtual rows are inspected (bounded even in very long chats).
      for (const row of scroll.querySelectorAll<HTMLElement>('[data-index]')) {
        if (row.getBoundingClientRect().top <= readingTop) index = Number(row.dataset.index);
        else break;
      }
      const atEnd = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 4;
      let current = entries[0];
      for (const entry of entries) {
        if (!atEnd && entry.index > index) break;
        current = entry;
      }
      setActiveKey(current.key);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(sync); };
    schedule();
    scroll.addEventListener('scroll', schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(scroll);
    return () => {
      cancelAnimationFrame(frame);
      scroll.removeEventListener('scroll', schedule);
      observer.disconnect();
    };
  }, [entries, scrollRef]);

  useEffect(() => {
    // Keep the selected tick visible without scrolling any ancestor of the rail.
    const nav = navRef.current;
    const button = nav?.querySelector<HTMLElement>('[aria-current="location"]');
    if (!nav || !button) return;
    const top = button.offsetTop;
    if (top < nav.scrollTop) nav.scrollTop = top;
    else if (top + button.offsetHeight > nav.scrollTop + nav.clientHeight) {
      nav.scrollTop = top + button.offsetHeight - nav.clientHeight;
    }
  }, [activeKey]);

  if (entries.length < 2) return null;
  return (
    <nav className="chat-message-nav" aria-label="用户提问导航" ref={navRef} data-testid="chat-message-nav">
      {entries.map((entry, ordinal) => (
        <Tooltip key={entry.key} delay={200}>
          <Tooltip.Trigger<'button'> render={(props) => <button {...props} type="button" className="chat-message-nav__item"
            aria-label={`第 ${ordinal + 1} 条提问：${entry.label}`}
            aria-current={entry.key === activeKey ? 'location' : undefined}
            onClick={() => {
              onNavigate();
              virtualRef.current?.scrollToIndex(entry.index);
            }}>
            <span className="chat-message-nav__tick" aria-hidden="true" />
          </button>} />
          <Tooltip.Content placement="left" className="chat-message-nav__preview">
            <span className="chat-message-nav__ordinal">提问 {ordinal + 1}</span>
            {entry.label}
          </Tooltip.Content>
        </Tooltip>
      ))}
    </nav>
  );
});
