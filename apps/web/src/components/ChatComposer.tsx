import { forwardRef, type ComponentProps } from 'react';
import { TextArea, Toolbar, cn } from '@heroui/react';
import './chat-composer.css';

/** Shared input primitives: course chat and Bot supply their own tools and send pipeline. */
export const ChatComposer = forwardRef<HTMLDivElement, ComponentProps<'div'>>(function ChatComposer({ className, ...props }, ref) {
  return <div {...props} ref={ref} className={cn('study-composer', className)} />;
});

export const ChatComposerInput = forwardRef<HTMLTextAreaElement, ComponentProps<typeof TextArea>>(function ChatComposerInput({ className, ...props }, ref) {
  return <TextArea rows={1} fullWidth enterKeyHint="send" {...props} ref={ref} className={cn('study-composer__input', className)} />;
});

export function ChatComposerTools({ className, ...props }: ComponentProps<typeof Toolbar>) {
  return <Toolbar orientation="horizontal" {...props} className={cn('study-composer__tools', className)} />;
}
