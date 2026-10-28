import { create } from 'zustand';

/**
 * Bot 辅助栏的开合与「打开哪条线程」。
 *
 * Bot 不再是一个独立页面，而是对话主页右侧的一项功能：宽屏并排、窄屏以全屏面板推入。
 * 宽屏上记住开合（下次进来还在原处）；窄屏每次都从关闭开始 —— 手机上一进来就盖住
 * 主页并不是用户想要的。
 */
const KEY = 'bot-panel-open';
const wide = () => typeof window !== 'undefined' && window.matchMedia('(min-width: 1100px)').matches;
function readOpen(): boolean {
  try { return wide() && localStorage.getItem(KEY) === '1'; } catch { return false; }
}

interface BotPanelState {
  open: boolean;
  /** 外部链接（网关「接管」、#/bot?thread=）要求打开的线程；Bot 栏消费后清空。 */
  requestedThread: string | null;
  setOpen: (open: boolean) => void;
  openThread: (threadId: string | null) => void;
  consumeRequest: () => string | null;
}

export const useBotPanel = create<BotPanelState>()((set, get) => ({
  open: readOpen(),
  requestedThread: null,
  setOpen: (open) => {
    try { if (wide()) localStorage.setItem(KEY, open ? '1' : '0'); } catch { /* private mode */ }
    set({ open });
  },
  openThread: (threadId) => { get().setOpen(true); set({ requestedThread: threadId }); },
  consumeRequest: () => {
    const id = get().requestedThread;
    if (id) set({ requestedThread: null });
    return id;
  },
}));
