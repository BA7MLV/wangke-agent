// npx tsx scripts/test-player-shortcuts.mjs
import assert from 'node:assert/strict';
import { defaultShortcutSettings, normalizeShortcutSettings, recordedShortcut, shortcutConflict, formatShortcut } from '../src/utils/shortcutSettings.ts';
import { createYoutubeKeyShortcuts } from '../src/utils/playerKeys.ts';

const defaults = defaultShortcutSettings();
assert.deepEqual(normalizeShortcutSettings(null), defaults);
assert.deepEqual(normalizeShortcutSettings({ bindings: { togglePaused: 123 } }), defaults);
const normalized = normalizeShortcutSettings({ enabled: false, arrowSeek: -2, keySeek: 999, bindings: { togglePaused: 'p', toggleMuted: 'p', seekForward: 'Tab' } });
assert.equal(normalized.enabled, false);
assert.equal(normalized.arrowSeek, 1);
assert.equal(normalized.keySeek, 120);
assert.equal(normalized.bindings.togglePaused, 'p');
assert.equal(normalized.bindings.toggleMuted, '');
assert.equal(normalized.bindings.seekForward, defaults.bindings.seekForward);
assert.equal(shortcutConflict(defaults.bindings, 'togglePaused', 'm'), '静音 / 取消静音');
assert.equal(shortcutConflict(defaults.bindings, 'togglePaused', 'Shift+>'), '加快播放速度');
assert.equal(shortcutConflict(defaults.bindings, 'togglePaused', 'p'), undefined);
assert.equal(recordedShortcut({ key: ' ', shiftKey: false }), 'Space');
assert.equal(recordedShortcut({ key: 'P', shiftKey: true, ctrlKey: true }), 'Ctrl+Shift+P');
assert.equal(recordedShortcut({ key: '>', shiftKey: true }), '>');
assert.equal(recordedShortcut({ key: '7' }), undefined);
assert.equal(formatShortcut('ArrowRight Space'), '→ / 空格');

const media = { currentTime: 20, duration: 100 };
const calls = [];
let prevented = 0;
const context = {
  event: { preventDefault: () => prevented++, stopPropagation() {} },
  player: { el: { querySelector: () => media }, currentTime: 5, paused: true },
  remote: { seeking: (time) => calls.push(['seeking', time]), seek: (time) => { calls.push(['seek', time]); media.currentTime = time; } },
};
const keys = createYoutubeKeyShortcuts({ ...defaults, arrowSeek: 2, keySeek: 7 });
keys.arrowSeekForward.onKeyDown(context);
keys.arrowSeekForward.onKeyDown(context);
keys.arrowSeekForward.onKeyUp(context);
assert.deepEqual(calls.splice(0), [['seeking', 22], ['seeking', 24], ['seek', 24]]);
keys.seekForward.onKeyDown(context);
keys.seekForward.onKeyUp(context);
assert.equal(media.currentTime, 31);
keys.seekToEnd.onKeyDown(context);
assert.equal(media.currentTime, 100);
keys.arrowSeekForward.onKeyDown(context);
keys.arrowSeekForward.onKeyUp(context);
assert.equal(media.currentTime, 100, '快进不越过时长');
keys.seekToStart.onKeyDown(context);
keys.arrowSeekBackward.onKeyDown(context);
keys.arrowSeekBackward.onKeyUp(context);
assert.equal(media.currentTime, 0, '快退不越过开头');
keys.frameForward.onKeyDown(context);
keys.frameForward.onKeyDown(context);
assert.ok(Math.abs(media.currentTime - 2 / 30) < 1e-6, '逐帧优先使用真实媒体位置，而非滞后的 store');
context.player.paused = false;
keys.frameForward.onKeyDown(context);
assert.ok(Math.abs(media.currentTime - 2 / 30) < 1e-6, '播放中不逐帧');
assert.ok(prevented >= 10, '自定义跳转阻止浏览器滚动等默认动作');
const custom = createYoutubeKeyShortcuts({ ...defaults, bindings: { ...defaults.bindings, togglePaused: 'p', toggleMuted: '' } });
assert.equal(custom.togglePaused, 'p');
assert.equal(custom.toggleMuted, '');
console.log('✓ 快捷键默认值、配置归一化、录入、冲突、步长、连续跳转、边界与逐帧');
