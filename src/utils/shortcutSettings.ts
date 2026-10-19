/** 持久化结构与 UI/播放器共用的快捷键登记表。空字符串表示禁用单项。 */
export const SHORTCUT_ACTIONS = [
  { id: 'togglePaused', label: '播放 / 暂停', keys: 'k Space' },
  { id: 'toggleMuted', label: '静音 / 取消静音', keys: 'm' },
  { id: 'toggleFullscreen', label: '进入 / 退出全屏', keys: 'f' },
  { id: 'togglePictureInPicture', label: '画中画', keys: 'i' },
  { id: 'toggleCaptions', label: '显示 / 隐藏字幕', keys: 'c' },
  { id: 'volumeUp', label: '提高音量', keys: 'ArrowUp' },
  { id: 'volumeDown', label: '降低音量', keys: 'ArrowDown' },
  { id: 'speedUp', label: '加快播放速度', keys: '>' },
  { id: 'slowDown', label: '减慢播放速度', keys: '<' },
  { id: 'arrowSeekForward', label: '小幅快进', keys: 'ArrowRight' },
  { id: 'arrowSeekBackward', label: '小幅快退', keys: 'ArrowLeft' },
  { id: 'seekForward', label: '大幅快进', keys: 'l L' },
  { id: 'seekBackward', label: '大幅快退', keys: 'j J' },
  { id: 'seekToStart', label: '跳到开头', keys: 'Home' },
  { id: 'seekToEnd', label: '跳到结尾', keys: 'End' },
  { id: 'frameForward', label: '下一帧（暂停时）', keys: '.' },
  { id: 'frameBackward', label: '上一帧（暂停时）', keys: ',' },
] as const;

export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number]['id'];
export interface ShortcutSettings {
  enabled: boolean;
  arrowSeek: number;
  keySeek: number;
  bindings: Record<ShortcutAction, string>;
}

export function defaultShortcutSettings(): ShortcutSettings {
  return {
    enabled: true,
    arrowSeek: 5,
    keySeek: 10,
    bindings: Object.fromEntries(SHORTCUT_ACTIONS.map(({ id, keys }) => [id, keys])) as Record<ShortcutAction, string>,
  };
}

const KEY = /^(?:(?:Ctrl|Alt|Meta|Shift)\+)*(?:[a-zA-Z,./;\[\]\\'`=\-<>]|Space|ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End)$/;

/** 与 vidstack 的 Shift 隐含匹配一致，供冲突检查使用。 */
function canonicalKey(key: string): string {
  if (key === '>') return 'Shift+>';
  if (key === '<') return 'Shift+<';
  return key;
}

export function shortcutConflict(bindings: ShortcutSettings['bindings'], action: ShortcutAction, keys: string): string | undefined {
  const candidates = new Set(keys.split(' ').filter(Boolean).map(canonicalKey));
  return SHORTCUT_ACTIONS.find(({ id }) => id !== action && bindings[id].split(' ').some((key) => candidates.has(canonicalKey(key))))?.label;
}

export function normalizeShortcutSettings(value: unknown): ShortcutSettings {
  const result = defaultShortcutSettings();
  if (!value || typeof value !== 'object') return result;
  const raw = value as Partial<ShortcutSettings>;
  if (typeof raw.enabled === 'boolean') result.enabled = raw.enabled;
  for (const key of ['arrowSeek', 'keySeek'] as const) {
    const n = raw[key];
    if (typeof n === 'number' && Number.isFinite(n)) result[key] = Math.min(120, Math.max(1, Math.round(n)));
  }
  if (raw.bindings && typeof raw.bindings === 'object') {
    for (const { id } of SHORTCUT_ACTIONS) {
      const keys = raw.bindings[id];
      if (typeof keys === 'string' && (keys === '' || keys.split(' ').every((key) => KEY.test(key)))) result.bindings[id] = keys;
    }
    // 损坏或外部导入的重复映射不能让同一键静默执行另一动作。
    const used = new Set<string>();
    for (const { id } of SHORTCUT_ACTIONS) {
      result.bindings[id] = result.bindings[id].split(' ').filter((key) => {
        if (!key || used.has(canonicalKey(key))) return false;
        used.add(canonicalKey(key));
        return true;
      }).join(' ');
    }
  }
  return result;
}

export function recordedShortcut(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey'>): string | undefined {
  const key = event.key === ' ' ? 'Space' : event.key;
  const parts = [event.ctrlKey ? 'Ctrl' : '', event.altKey ? 'Alt' : '', event.metaKey ? 'Meta' : '',
    event.shiftKey && key !== '<' && key !== '>' ? 'Shift' : '', key].filter(Boolean);
  const combo = parts.join('+');
  return KEY.test(combo) ? combo : undefined;
}

export function formatShortcut(keys: string): string {
  if (!keys) return '未设置';
  const labels: Record<string, string> = { Space: '空格', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓' };
  return keys.split(' ').map((combo) => combo.split('+').map((key) => labels[key] ?? key).join(' + ')).join(' / ');
}
