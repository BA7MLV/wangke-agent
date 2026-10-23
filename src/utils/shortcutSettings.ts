/** 持久化结构与 UI/播放器共用的快捷键登记表。空字符串表示禁用单项。 */
export const SHORTCUT_ACTIONS = [
  { id: 'togglePaused', label: '播放 / 暂停', keys: 'k Space' },
  { id: 'toggleMuted', label: '静音 / 取消静音', keys: 'm' },
  { id: 'toggleFullscreen', label: '进入 / 退出全屏', keys: 'f' },
  { id: 'togglePictureInPicture', label: '画中画', keys: 'i' },
  { id: 'toggleCaptions', label: '显示 / 隐藏字幕', keys: 'c' },
  { id: 'toggleDanmaku', label: '开启 / 关闭弹幕', keys: 'd' },
  { id: 'toggleWebFullscreen', label: '网页全屏', keys: 'w' },
  { id: 'toggleTheater', label: '宽屏模式', keys: 't' },
  { id: 'normalSpeed', label: '恢复正常速度', keys: 'Shift+1' },
  { id: 'doubleSpeed', label: '切换二倍速', keys: 'Shift+2' },
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

const KEY = /^(?:(?:Ctrl|Alt|Meta|Shift)\+)*(?:[a-zA-Z,./;\[\]\\'`=\-<>]|Space|ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End|Shift\+[0-9])$/;

const SHIFT_DIGITS = ')!@#$%^&*(';

/** Vidstack 会把 Shift+数字替换成符号但丢掉 Shift 条件；显式保留它。 */
export function toMediaShortcutKeys(keys: string): string {
  return keys.replace(/Shift\+(\d)/g, (_, digit: string) => `Shift+${SHIFT_DIGITS[Number(digit)]}`);
}

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
    const explicit = new Set<ShortcutAction>();
    for (const { id } of SHORTCUT_ACTIONS) {
      const keys = raw.bindings[id];
      if (typeof keys === 'string' && (keys === '' || keys.split(' ').every((key) => KEY.test(key)))) {
        result.bindings[id] = keys;
        explicit.add(id);
      }
    }
    // 先保留合法的显式绑定，再补默认值：升级时新增的默认键不能抢占旧自定义键。
    // 显式配置内部若有重复，仍按登记顺序确定唯一动作。
    const used = new Set<string>();
    const ordered = [...SHORTCUT_ACTIONS.filter(({ id }) => explicit.has(id)), ...SHORTCUT_ACTIONS.filter(({ id }) => !explicit.has(id))];
    for (const { id } of ordered) {
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
  const shiftedDigit = event.shiftKey ? SHIFT_DIGITS.indexOf(event.key) : -1;
  const key = event.key === ' ' ? 'Space' : shiftedDigit >= 0 ? String(shiftedDigit) : event.key;
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
