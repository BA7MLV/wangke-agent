import type { ReactNode } from 'react';
import { Sym } from '../ui';
import './chat-attachments.css';

/** A sent album has one cover; its viewer owns navigation through every image. */
export default function ImageGallery({ count, children }: { count: number; children: ReactNode }) {
  return <div className={`chat-image-gallery${count > 1 ? ' chat-image-stack' : ''}`} data-count={count}>
    {children}
    {count > 1 && <span className="chat-image-stack__count" aria-hidden="true"><Sym name="image" />{count}</span>}
  </div>;
}
