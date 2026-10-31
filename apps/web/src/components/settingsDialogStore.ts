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
  | 'websearch'
  | 'models'
  | 'agent'
  | 'bot'
  | 'gateway'
  | 'usage'
  | 'appearance'
  | 'sources'
  | 'live'
  | 'playback'
  | 'shortcuts'
  | 'study'
  | 'skills'
  | 'data';

let openState = false;
let moduleState: SettingsModule = 'models';
/** 调用方是否点名了模块。没点名时手机上先展示模块列表（iOS 设置的根页），点名了直接进模块。 */
let explicitState = false;
const listeners = new Set<() => void>();
let leaveGuard: (() => Promise<boolean>) | undefined;
let pendingLeave: Promise<boolean> | undefined;

/** A module with an in-memory draft can protect explicit close/back/module-switch actions. */
export function registerSettingsLeaveGuard(guard: () => Promise<boolean>): () => void {
  leaveGuard = guard;
  return () => { if (leaveGuard === guard) leaveGuard = undefined; };
}

export async function allowSettingsLeave(): Promise<boolean> {
  if (!leaveGuard) return true;
  if (pendingLeave) return pendingLeave;
  pendingLeave = leaveGuard();
  try { return await pendingLeave; }
  finally { pendingLeave = undefined; }
}

function emit(): void {
  listeners.forEach((listener) => listener());
}

/** 打开设置弹窗；传 module 可直接落到某个模块（默认「模型」） */
export function openSettings(module?: SettingsModule): void {
  moduleState = module ?? 'models';
  explicitState = module !== undefined;
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

const VALID_MODULES: readonly SettingsModule[] = ['models', 'agent', 'bot', 'gateway', 'usage', 'appearance', 'sources', 'live', 'playback', 'shortcuts', 'study', 'skills', 'data', 'websearch'];

/** 根据当前 URL hash 打开设置弹窗（#/settings 或 #/settings/<module>） */
export function openSettingsFromHash(): void {
  const hash = window.location.hash;
  const match = hash.match(/^#\/settings(?:\/(\w+))?/);
  if (!match) return;
  const requested = match[1] as SettingsModule | undefined;
  openSettings(requested && VALID_MODULES.includes(requested) ? requested : undefined);
}

/** 关闭设置弹窗，并清理掉 #/settings 这条 hash */
export function closeSettingsAndClearHash(): void {
  closeSettings();
  if (window.location.hash.startsWith('#/settings')) {
    window.location.hash = '';
  }
}

/** 当前是否开着 + 落在哪个模块 */
export function useSettingsDialog(): { open: boolean; module: SettingsModule; explicit: boolean } {
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
  const explicit = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => explicitState,
    () => false,
  );
  return { open, module, explicit };
}
