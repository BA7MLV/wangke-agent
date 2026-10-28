import { useEffect, useRef, type RefObject } from 'react';
import { db } from '../store/db';
import { applyHandoutReadPos, captureHandoutReadPos, type HandoutReadPos } from './readingPos';

/**
 * 讲义的阅读位置：打开时落回上次，滚动时写回。
 *
 * ## 三个必须处理的时机问题
 *
 * 1. **锚点上方的东西会后到**：讲义插图是 blob URL（解码完才有高度），标题字体要异步装。
 *    它们晚到一次，按旧布局算出的落位就偏（实测偏 80px，正好差一个段落）。所以落位不是
 *    「做一次」而是「在布局还在变的窗口里持续纠正」。
 * 2. **纠正不能压过用户**：一旦用户自己滚了，就地停手。判据不是「有没有 scroll 事件」
 *    （我们自己写 scrollTop 也会产生），而是「这次滚动发生在我上次落位后的多久之外」。
 * 3. **写入要有上限**：一次长滚动能触发几百次 scroll，全写就是几百次 IndexedDB 事务。
 *    同一块内小幅移动直接跳过。
 *
 * 窗口与次数都封顶（`SETTLE_WINDOW_MS` / `SETTLE_MAX_PASSES`）：用户一直改窗口大小、
 * 或者网络字体姗姗来迟时，不能没完没了地跳。
 */
const WRITE_IDLE_PX = 120;
const WRITE_THROTTLE_MS = 400;
const SETTLE_WINDOW_MS = 2000;
const SETTLE_MAX_PASSES = 24;
/** 落位后多久内的滚动算「自己写的」，不算用户操作 */
const OWN_SCROLL_GRACE_MS = 80;

interface Args {
  /** 内容是否已就绪（IR 解析完成）。false 时不做任何落位/写入 */
  enabled: boolean;
  handoutId: number | undefined;
  /** 本次打开时的初始位置；内部只在换讲义时取一次快照 */
  readPos: HandoutReadPos | undefined;
  scrollRef: RefObject<HTMLElement | null>;
  docRef: RefObject<HTMLElement | null>;
}

export function useHandoutReadingPos({ enabled, handoutId, readPos, scrollRef, docRef }: Args) {
  /**
   * 初始位置快照。刻意不进依赖：位置是每轮滚动写回的，若参与依赖，写回 → 父组件重读行 →
   * 依赖变化 → 重新落位，会把用户刚滚到的地方又拽回去。
   */
  const initialRef = useRef<{ id: number | undefined; pos: HandoutReadPos | undefined } | null>(null);
  if (!initialRef.current || initialRef.current.id !== handoutId) {
    initialRef.current = { id: handoutId, pos: readPos };
  }

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!enabled || !scroll) return;
    const pos = initialRef.current?.pos ?? null;
    const id = handoutId;

    const settleUntil = performance.now() + SETTLE_WINDOW_MS;
    let ownWriteAt = -Infinity;
    let userMoved = false;
    let passes = 0;
    let last = pos;
    let lastWriteAt = 0;
    let timer = 0;
    let disposed = false;

    const restore = () => {
      // 先归零：浏览器可能已经自己恢复了一个滚动位置（同一份讲义上次停在 60% 处，
      // 而这次锚点根本不存在）——不归零的话「锚点失效应回顶部」这条约定会被它顶掉。
      scroll.scrollTop = 0;
      applyHandoutReadPos(scroll, pos);
      ownWriteAt = performance.now();
    };

    /** 落位 / 纠正。返回 false 表示「已经不该再纠正了」（用户动了 / 窗口用完） */
    const correct = () => {
      if (userMoved || passes >= SETTLE_MAX_PASSES || performance.now() > settleUntil) return false;
      passes++;
      restore();
      return true;
    };

    const write = () => {
      if (id == null) return;
      const next = captureHandoutReadPos(scroll);
      if (!next) return;
      if (last && last.anchor === next.anchor && Math.abs(last.offset - next.offset) < WRITE_IDLE_PX) return;
      last = next;
      void db.handouts.update(id, { readPos: next });
    };

    const onScroll = () => {
      if (performance.now() - ownWriteAt > OWN_SCROLL_GRACE_MS) userMoved = true;
      const due = performance.now() - lastWriteAt >= WRITE_THROTTLE_MS;
      if (due) {
        lastWriteAt = performance.now();
        write();
        return;
      }
      // 节流窗口内也要保证末尾落一次，否则「滚一下就停」的位置不会被记住
      timer ??= window.setTimeout(() => {
        timer = 0;
        lastWriteAt = performance.now();
        write();
      }, WRITE_THROTTLE_MS);
    };

    const first = requestAnimationFrame(restore);
    const ro = new ResizeObserver(() => {
      if (disposed) return;
      if (!correct()) ro.disconnect();
    });
    ro.observe(docRef.current ?? scroll);
    // 字体是最后一块拼图：它落地会一次性改掉整篇的行高（实测就是那 80px 的来源），
    // 而那次变化可能已经把 ResizeObserver 的次数预算用完
    void document.fonts?.ready.then(() => {
      if (!disposed) correct();
    });

    scroll.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      disposed = true;
      cancelAnimationFrame(first);
      ro.disconnect();
      scroll.removeEventListener('scroll', onScroll);
      if (timer) clearTimeout(timer);
      // 卸载时补一次：离开播放页正是「位置需要被记住」的时刻
      write();
    };
  }, [enabled, handoutId, scrollRef, docRef]);
}
