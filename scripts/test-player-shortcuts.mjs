// npx tsx scripts/test-player-shortcuts.mjs
import assert from 'node:assert/strict';
import { defaultShortcutSettings, normalizeShortcutSettings, recordedShortcut, shortcutConflict, formatShortcut, toMediaShortcutKeys } from '../src/utils/shortcutSettings.ts';
import { createBilibiliKeyboard, BOOST_DELAY } from '../src/utils/playerKeys.ts';

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
assert.equal(recordedShortcut({ key: '!', shiftKey: true }), 'Shift+1');
assert.equal(recordedShortcut({ key: '@', shiftKey: true }), 'Shift+2');
assert.equal(toMediaShortcutKeys('Shift+1 Shift+2'), 'Shift+! Shift+@');
assert.equal(normalizeShortcutSettings({ bindings: { normalSpeed: 'Shift+3' } }).bindings.normalSpeed, 'Shift+3');
assert.equal(normalizeShortcutSettings({ bindings: { normalSpeed: '7' } }).bindings.normalSpeed, 'Shift+1');
assert.equal(normalizeShortcutSettings({ bindings: { togglePaused: 'p' } }).bindings.toggleDanmaku, 'd', '旧配置补齐新增动作');
const upgraded = normalizeShortcutSettings({ bindings: { seekForward: 'd', seekBackward: 'w', toggleTheater: '', slowDown: 'm' } });
assert.equal(upgraded.bindings.seekForward, 'd', '新增弹幕默认键不抢占旧自定义绑定');
assert.equal(upgraded.bindings.toggleDanmaku, '');
assert.equal(upgraded.bindings.seekBackward, 'w');
assert.equal(upgraded.bindings.toggleWebFullscreen, '');
assert.equal(upgraded.bindings.toggleTheater, '', '显式禁用不被默认值覆盖');
assert.equal(upgraded.bindings.slowDown, 'm');
assert.equal(upgraded.bindings.toggleMuted, '', '已有动作的默认键也不能抢占显式绑定');
assert.deepEqual(normalizeShortcutSettings(upgraded), upgraded, '归一化保持幂等');
assert.equal(formatShortcut('ArrowRight Space'), '→ / 空格');

const media = { currentTime: 20, duration: 100, volume: .5, playbackRate: 1.5, paused: true, muted: false, readyState: 4,
  play() { this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; } };
const calls = [];
let prevented = 0;
const context = {
  event: { key: 'ArrowRight', code: 'ArrowRight', preventDefault: () => prevented++, stopPropagation() {} },
  player: { el: { querySelector: () => media }, currentTime: 5, paused: true, playbackRate: 1.5 },
  remote: {
    seeking: (time) => calls.push(['seeking', time]),
    seek: (time) => { calls.push(['seek', time]); media.currentTime = time; },
    changePlaybackRate: (rate) => { calls.push(['rate', rate]); media.playbackRate = rate; },
    changeVolume: (volume) => { media.volume = volume; },
    // 模拟 store 滞后导致 remote 忽略快速反向操作。
    play() {}, pause() {}, mute() {}, unmute() {},
  },
};
const keyboard = createBilibiliKeyboard({ ...defaults, arrowSeek: 2, keySeek: 7 });
const keys = keyboard.shortcuts;
keys.arrowSeekForward.onKeyDown(context);
keys.arrowSeekForward.onKeyUp(context);
keys.arrowSeekForward.onKeyDown(context);
keys.arrowSeekForward.onKeyUp(context);
assert.deepEqual(calls.splice(0), [['seeking', 22], ['seek', 22], ['seeking', 24], ['seek', 24]]);
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
media.paused = false;
keys.frameForward.onKeyDown(context);
assert.ok(Math.abs(media.currentTime - 2 / 30) < 1e-6, '播放中不逐帧');
assert.ok(prevented >= 10, '自定义跳转阻止浏览器滚动等默认动作');
const custom = createBilibiliKeyboard({ ...defaults, bindings: { ...defaults.bindings, togglePaused: 'p', toggleMuted: '' } });
assert.equal(custom.shortcuts.togglePaused, 'p');
assert.equal(custom.shortcuts.toggleMuted, '');
assert.equal(custom.shortcuts.biliTogglePaused.keys, 'p');
assert.equal(custom.shortcuts.biliToggleMuted.keys, '');
media.paused = true;
keys.biliTogglePaused.onKeyDown(context);
assert.equal(media.paused, false, '播放不依赖滞后的 store');
keys.biliTogglePaused.onKeyDown(context);
assert.equal(media.paused, true, '快速反向暂停不丢失');
keys.biliTogglePaused.onKeyDown({ ...context, event: { ...context.event, repeat: true } });
assert.equal(media.paused, true, '长按播放键不反复切换');
keys.biliToggleMuted.onKeyDown(context);
assert.equal(media.muted, true);
keys.biliToggleMuted.onKeyDown(context);
assert.equal(media.muted, false, '快速反向静音不丢失');
keys.volumeUp.onKeyDown(context);
assert.equal(media.volume, .6, 'B 站音量步长 10%');
keys.volumeDown.onKeyDown(context);
assert.equal(media.volume, .5);
media.paused = false;
const beforeBoostTime = media.currentTime;
keys.arrowSeekForward.onKeyDown(context);
await new Promise((resolve) => setTimeout(resolve, BOOST_DELAY + 30));
assert.equal(media.playbackRate, 3, '长按临时三倍速');
assert.equal(media.currentTime, beforeBoostTime, '长按不叠加跳转');
keyboard.release(context.event);
assert.equal(media.playbackRate, 1.5, '松开恢复原倍速');
keys.arrowSeekForward.onKeyDown(context);
keyboard.cancel();
await new Promise((resolve) => setTimeout(resolve, BOOST_DELAY + 30));
assert.equal(media.playbackRate, 1.5, '失焦取消待触发倍速');
keys.arrowSeekForward.onKeyDown(context);
await new Promise((resolve) => setTimeout(resolve, BOOST_DELAY + 30));
keyboard.cancel();
assert.equal(media.playbackRate, 1.5, '切页恢复已触发的倍速');
keys.doubleSpeed.onKeyDown(context);
assert.equal(media.playbackRate, 2);
keys.normalSpeed.onKeyDown(context);
assert.equal(media.playbackRate, 1);
keys.speedUp.onKeyDown(context);
keys.speedUp.onKeyDown(context);
assert.equal(media.playbackRate, 1.5, '连按加速读取真实倍率');
keys.slowDown.onKeyDown(context);
assert.equal(media.playbackRate, 1.25, '快速反向减速不丢失');
keyboard.cancel();
custom.cancel();
console.log('✓ 快捷键归一化、旧配置兼容、Shift 数字、步长、边界、逐帧、音量与长按倍速生命周期');
