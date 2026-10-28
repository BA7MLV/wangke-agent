import { useEffect, useRef, useState, type RefObject } from 'react';
import { confirmDialog, toast } from '../ui/feedback';
import { prepareMessageDust, type MessageDust } from '../utils/messageDust';

/** Shared by the library assistant and the course-side chat panel. */
export function useMessageDeletion(
  listRef: RefObject<HTMLElement | null>,
  scope: number | null,
  remove: (key: string) => Promise<boolean>,
) {
  const [deleting, setDeleting] = useState(false);
  const pending = useRef(false);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const active = new AbortController();
    controller.current = active;
    return () => active.abort();
  }, [scope]);

  const deleteMessage = async (key: string) => {
    if (pending.current) return;
    pending.current = true;
    setDeleting(true);
    const signal = controller.current?.signal;
    let dust: MessageDust | undefined;
    let committed = false;
    try {
      const ok = await confirmDialog({ headline: '删除这条消息？',
        description: '只删除这一条消息及其中的图片，后续对话不受影响。此操作不可撤销。',
        confirmText: '删除', danger: true });
      if (!ok || !signal || signal.aborted || currentScope.current !== scope) return;
      const node = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-chat-message]') ?? [])
        .find((element) => element.dataset.chatMessage === key);
      // Capture the mounted bubble before removing its DOM. Racing these operations
      // makes the particle effect lose its source on virtually every local deletion.
      // Preparation has a bounded timeout and fails open when WebGL is unavailable.
      dust = node ? await prepareMessageDust(node, signal) : undefined;
      if (signal.aborted || currentScope.current !== scope) return;
      const removed = await remove(key);
      if (removed) {
        committed = true;
        dust?.play();
        toast.success('已删除这条消息');
        // The triggering button is gone; keep keyboard navigation in the chat.
        if (listRef.current && !listRef.current.contains(document.activeElement)) {
          if (!listRef.current.hasAttribute('tabindex')) listRef.current.tabIndex = -1;
          listRef.current.focus({ preventScroll: true });
        }
      } else {
        toast.info('消息已变化或正在生成，请稍后再试');
      }
    } catch (error) {
      toast.error(`删除失败：${error instanceof Error ? error.message : '请重试'}`);
    } finally {
      if (!committed) dust?.dispose();
      pending.current = false;
      setDeleting(false);
    }
  };
  return { deleteMessage, deleting };
}
