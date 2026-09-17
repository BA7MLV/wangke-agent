import { create } from 'zustand';

/**
 * 封面刷新令牌。
 *
 * 存在的理由：封面是**异步补上**的派生资源（导入后几百毫秒到几秒），而资料库列表的
 * 数据来自一次性的 `reload()`。没有这个令牌，新导入的卡片会一直停在占位图上，
 * 直到用户切走再回来 —— 而那时封面其实早就生成好了。
 *
 * 刻意做得极轻：只递增一个数字，`useThumb` 订阅它，+1 就重查自己那一张
 * （`covers.get(id)` 是主键查询，一屏几十张也就几十次 O(1)）。
 * **不去调整个列表的 reload** —— 那要把 `videos` 整表读进内存，正是拆出独立
 * `covers` 表要躲开的开销。
 */
interface CoverStore {
  revision: number;
  bump: () => void;
}

export const useCoverStore = create<CoverStore>()((set) => ({
  revision: 0,
  bump: () => set((s) => ({ revision: s.revision + 1 })),
}));

/** 订阅刷新令牌（只取数字，避免消费者因 store 里其它字段变化而重渲染） */
export function useCoverRevision(): number {
  return useCoverStore((s) => s.revision);
}
