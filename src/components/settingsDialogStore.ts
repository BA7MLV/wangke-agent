import { useSyncExternalStore } from 'react';

/**
 * 设置弹窗的全局开关（命令式 API，与 ui/feedback.tsx 的 confirmDialog 同一套思路）。
 *
 * 为什么不用 context：设置入口散落在顶栏、侧栏底部、播放页等多个不共祖宗的组件里，
 * 而弹窗本体只想在 App 根部挂一次。事件 + 全局订阅最短，也不用给整棵树套 Provider。
 *
 * 刻意**不记忆上次打开的模块**：设置是偶尔才进的界面，每次都从「模型」这个
 * 最常改的模块开始，比记住上次停在哪儿更可预期。
 */

export type SettingsModule =
  | 'models'
  | 'appearance'
  | 'sources'
  | 'live'
  | 'playback'
  | 'study'
  | 'data';

let openState = false;
let moduleState: SettingsModule = 'models';
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((listener) => listener());
}

/** 打开设置弹窗；传 module 可直接落到某个模块（默认「模型」） */
export function openSettings(module: SettingsModule = 'models'): void {
  moduleState = module;
  if (openState) {
    // 已经开着时只换模块，不重复触发一次挂载动画
    emit();
    return;
  }
  openState = true;
  emit();
}

export function closeSettings(): void {
  if (!openState) return;
  openState = false;
  emit();
}

const VALID_MODULES: readonly SettingsModule[] = ['models', 'appearance', 'sources', 'live', 'playback', 'study', 'data'];

/** 根据当前 URL hash 打开设置弹窗（#/settings 或 #/settings/<module>） */
export function openSettingsFromHash(): void {
  const hash = window.location.hash;
  const match = hash.match(/^#\/settings(?:\/(\w+))?/);
  if (!match) return;
  const requested = (match[1] as SettingsModule) ?? 'models';
  openSettings(VALID_MODULES.includes(requested) ? requested : 'models');
}

/** 关闭设置弹窗，并清理掉 #/settings 这条 hash */
export function closeSettingsAndClearHash(): void {
  closeSettings();
  if (window.location.hash.startsWith('#/settings')) {
    window.location.hash = '';
  }
}

/** 当前是否开着 + 落在哪个模块 */
export function useSettingsDialog(): { open: boolean; module: SettingsModule } {
  const open = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => openState,
    () => false,
  );
  const module = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => moduleState,
    () => 'models' as SettingsModule,
  );
  return { open, module };
}
