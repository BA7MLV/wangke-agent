import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

interface FolderHistory {
  entries: (string | null)[];
  index: number;
}

interface LibraryNavigation {
  folderHistory: FolderHistory;
  setFolderHistory: (update: (history: FolderHistory) => FolderHistory) => void;
}

/** 目录历史不随资料库页面卸载而清空；同一标签页刷新播放器后仍能返回原目录。 */
export const useLibraryNavigation = create<LibraryNavigation>()(persist(
  (set) => ({
    folderHistory: { entries: [null], index: 0 },
    setFolderHistory: (update) => set((state) => ({ folderHistory: update(state.folderHistory) })),
  }),
  {
    name: 'wangke-library-navigation',
    version: 1,
    storage: createJSONStorage(() => sessionStorage),
    partialize: (state) => ({ folderHistory: state.folderHistory }),
  },
));
