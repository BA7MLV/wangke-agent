import { useLayoutEffect, useState, type RefObject } from 'react';
import { Button, Modal, TextArea } from '@heroui/react';
import { Sym } from '../ui';
import './composer-expand.css';

/** Measure wrapping as well as edits: side panels and the software keyboard resize independently. */
export function useComposerSize(ref: RefObject<HTMLTextAreaElement | null>, value: string, active = true) {
  const [overflow, setOverflow] = useState(false);
  useLayoutEffect(() => {
    const input = ref.current;
    if (!input || !active) return;
    const measure = () => {
      input.style.height = '0px';
      const limit = parseFloat(getComputedStyle(input).maxHeight);
      // A wrapping placeholder must not grow an empty composer on narrow screens.
      const height = input.value ? input.scrollHeight : parseFloat(getComputedStyle(input).minHeight);
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

export default function ComposerExpand({ value, onChange, visible }: { value: string; onChange: (value: string) => void; visible: boolean }) {
  const [open, setOpen] = useState(false);
  return <Modal isOpen={open} onOpenChange={setOpen}>
    <Button hidden={!visible && !open} isIconOnly size="sm" variant="tertiary" aria-label="展开输入框" data-testid="composer-expand">
      <Sym name="open_in_full" />
    </Button>
    <Modal.Backdrop>
      <Modal.Container placement="bottom" size="lg" scroll="inside" className="composer-sheet-container">
        <Modal.Dialog className="composer-sheet" data-testid="composer-sheet">
          {({ close }) => <>
            <Modal.Header><Modal.Heading>编辑完整消息</Modal.Heading></Modal.Header>
            <Modal.Body className="composer-sheet__body">
              <TextArea autoFocus aria-label="完整消息" value={value} onChange={(event) => onChange(event.target.value)}
                className="composer-sheet__input" />
            </Modal.Body>
            <Modal.Footer><Button onPress={close}>完成</Button></Modal.Footer>
          </>}
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  </Modal>;
}
