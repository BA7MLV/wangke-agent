import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface ChatNotifications {
  unreadIds: number[];
  /** activeId 在资料页仍会保留，只有对话页实际展示才算查看。 */
  viewingId: number | null;
  setViewing: (id: number | null) => void;
  complete: (id: number) => void;
  dismiss: (id: number) => void;
}

export const useChatNotifications = create<ChatNotifications>()(persist((set, get) => ({
  unreadIds: [],
  viewingId: null,
  setViewing: (id) => set((state) => ({
    viewingId: id,
    unreadIds: id != null && state.unreadIds.includes(id)
      ? state.unreadIds.filter((unread) => unread !== id) : state.unreadIds,
  })),
  complete: (id) => {
    const state = get();
    if (id <= 0 || state.unreadIds.includes(id)) return;
    if (state.viewingId === id && document.visibilityState === 'visible') return;
    set({ unreadIds: [...state.unreadIds, id] });
  },
  dismiss: (id) => {
    if (get().unreadIds.includes(id)) {
      set((state) => ({ unreadIds: state.unreadIds.filter((unread) => unread !== id) }));
    }
  },
}), {
  name: 'deepstudent-chat-notifications',
  version: 1,
  partialize: (state) => ({ unreadIds: state.unreadIds }),
}));
