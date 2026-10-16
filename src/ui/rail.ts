import { useSyncExternalStore } from 'react';

/**
 * 宽屏侧栏的折叠状态。
 *
 * **为什么是模块级变量而不是 settings store 里的一个字段**：那是**视口偏好**，不是
 * 用户资料 —— 换台设备、换个浏览器就该各自展开，而 `store/settings.ts` 是跟着云同步走的，
 * 在那儿加字段等于让「这台机器的屏幕窄」变成「所有设备都不显示侧栏」。
 * 折叠就是纯本机的东西，localStorage 一行就够。
 *
 * **为什么不住在 store 里**（第二条约束）：`ui/` 是适配层，不该反向依赖 `store/`。
 * 同 `components/settingsDialogStore.ts` 的思路：事件 + 全局订阅最短，也不用给整棵树套 Provider。
 *
 * **为什么全局一份而不是每个 PageShell 各存各的**：侧栏是同一个东西，跨页面折叠状态必须一致 ——
 * 否则「在对话页收起 → 去课程库 → 侧栏又冒出来」会被读成那个按钮坏了。
 */

const KEY = 'wangke:rail-collapsed';

/** 无痕/隐私模式下 localStorage 会抛；记忆不了而已，不该让一次点击崩掉整页 */
function read(): boolean {
  try {
    return window.localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

function write(next: boolean): void {
  try {
    window.localStorage.setItem(KEY, next ? '1' : '0');
  } catch {
    /* 同上：存不进去就只丢记忆，不丢功能 */
  }
}

let collapsed = read();
const listeners = new Set<() => void>();

function toggle(): void {
  collapsed = !collapsed;
  write(collapsed);
  listeners.forEach((listener) => listener());
}

/**
 * 宽屏侧栏是否收起。`rail` 不存在的页面（没有侧栏可收）忽略返回值即可。
 *
 * 服务端/预渲染快照给 false：折叠是纯本机偏好，SSR 阶段一律按「展开」渲染，
 * 挂载后再由 `getSnapshot` 的真实值校正。
 */
export function useRailCollapsed(): [boolean, () => void] {
  const value = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => collapsed,
    () => false,
  );
  return [value, toggle];
}