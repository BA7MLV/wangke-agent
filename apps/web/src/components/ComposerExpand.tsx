import { useLayoutEffect, useState, type ClipboardEventHandler, type RefObject } from 'react';
import { Button, Drawer, TextArea } from '@heroui/react';
import { Sym } from '../ui';
import SheetChrome from '../ui/SheetChrome';
import './composer-expand.css';

/** Measure wrapping as well as edits: side panels and the software keyboard resize independently. */
export function useComposerSize(ref: RefObject<HTMLTextAreaElement | null>, value: string, active = true) {
  const [overflow, setOverflow] = useState(false);
  useLayoutEffect(() => {
    const input = ref.current;
    if (!input || !active) return;
    const measure = () => {
      input.style.height = '0px';
      const style = getComputedStyle(input);
      const limit = parseFloat(style.maxHeight);
      // A wrapping placeholder must not grow an empty composer on narrow screens.
      const height = input.value ? input.scrollHeight : Math.ceil(parseFloat(style.minHeight));
      input.style.height = `${Math.min(height, limit)}px`;
      setOverflow(height > limit + 1);
    };
    measure();
    let width = input.clientWidth;
    const observer = new ResizeObserver(() => {
      if (input.clientWidth === width) return;
      width = input.clientWidth;
      measure();
    });
    observer.observe(input);
    window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('resize', measure);
    };
  }, [ref, value, active]);
  return overflow;
}

export default function ComposerExpand({ value, onChange, onPaste, visible }: { value: string; onChange: (value: string) => void; onPaste?: ClipboardEventHandler<HTMLTextAreaElement>; visible: boolean }) {
  const [open, setOpen] = useState(false);
  return <Drawer.Root isOpen={open} onOpenChange={setOpen}>
    <Button className="composer-expand" hidden={!visible && !open} isIconOnly size="sm" variant="tertiary" aria-label="展开输入框" aria-haspopup="dialog" aria-expanded={open} data-testid="composer-expand">
      <Sym name="open_in_full" />
    </Button>
    <Drawer.Backdrop variant="opaque" className="composer-sheet__backdrop">
      <Drawer.Content placement="bottom" className="composer-sheet__content">
        <Drawer.Dialog className="composer-sheet" data-testid="composer-sheet">
          <SheetChrome>
            <Drawer.Handle />
            <Drawer.Header className="composer-sheet__header">
              <Drawer.Heading>编辑完整消息</Drawer.Heading>
              <Drawer.CloseTrigger aria-label="收起输入框"><Sym name="fullscreen_exit" /></Drawer.CloseTrigger>
            </Drawer.Header>
          </SheetChrome>
          <Drawer.Body className="composer-sheet__body">
            <TextArea autoFocus aria-label="完整消息" value={value} onChange={(event) => onChange(event.target.value)} onPaste={onPaste}
              className="composer-sheet__input" />
          </Drawer.Body>
          <Drawer.Footer className="composer-sheet__footer"><Button slot="close">完成</Button></Drawer.Footer>
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  </Drawer.Root>;
}
