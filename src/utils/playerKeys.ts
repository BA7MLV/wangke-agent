import type { MediaKeyShortcuts, MediaKeysCallback } from '@vidstack/react';
import { defaultShortcutSettings, toMediaShortcutKeys, type ShortcutSettings } from './shortcutSettings';

const FRAME_STEP = 1 / 30;
const ACCUMULATE_MS = 700;
export const BOOST_DELAY = 450;
export const PLAYER_FEEDBACK_EVENT = 'player-feedback';

export interface PlayerFeedbackDetail {
  text: string;
  boost?: boolean;
}

type KeyContext = Parameters<NonNullable<MediaKeysCallback['onKeyDown']>>[0];
type Player = KeyContext['player'];

interface PlayerActions {
  toggleDanmaku?: () => void;
  toggleWebFullscreen?: () => void;
  toggleTheater?: () => void;
}

function media(player: Player) {
  return player.el?.querySelector<HTMLMediaElement>('[data-media-provider] video, [data-media-provider] audio');
}

function mediaDuration(player: Player): number {
  const duration = media(player)?.duration;
  return typeof duration === 'number' && Number.isFinite(duration) ? duration : Number.POSITIVE_INFINITY;
}

function mediaTime(player: Player): number {
  const current = media(player)?.currentTime;
  return typeof current === 'number' && Number.isFinite(current) ? current : player.currentTime;
}

function consume(event: KeyboardEvent) {
  event.preventDefault();
  event.stopPropagation();
}

function feedback(player: Player, text: string, boost = false) {
  player.el?.dispatchEvent?.(new CustomEvent<PlayerFeedbackDetail>(PLAYER_FEEDBACK_EVENT, { detail: { text, boost } }));
}

function changeRate({ player, remote }: KeyContext, rate: number, event?: KeyboardEvent) {
  remote.changePlaybackRate(rate, event);
  const element = media(player);
  // HTMLMediaElement 的属性先变化、Vidstack store 后收到原生事件。
  // 快速「加速 → 恢复」时 store 可能仍是旧倍率，remote 会误判为无需更新。
  if (element && element.playbackRate !== rate) element.playbackRate = rate;
}

/** B 站式短按快进 / 长按临时倍速；cancel 必须在失焦、切页和禁用快捷键时调用。 */
export function createBilibiliKeyboard(settings: ShortcutSettings = defaultShortcutSettings(), actions: PlayerActions = {}) {
  const keys = Object.fromEntries(Object.entries(settings.bindings).map(([id, value]) => [id, toMediaShortcutKeys(value)])) as ShortcutSettings['bindings'];
  let seekTarget = Number.NaN;
  let until = 0;
  let pendingSeek = false;
  let seekContext: KeyContext | undefined;
  let forward: KeyContext | undefined;
  let boostTimer: ReturnType<typeof setTimeout> | undefined;
  let originalRate: number | undefined;

  const armAccumulator = (target: number) => {
    seekTarget = target;
    until = Date.now() + ACCUMULATE_MS;
  };

  const seekBy = (delta: number, { event, player, remote }: KeyContext) => {
    consume(event);
    const base = Date.now() < until && Number.isFinite(seekTarget) ? seekTarget : mediaTime(player);
    armAccumulator(Math.min(Math.max(0, base + delta), mediaDuration(player)));
    pendingSeek = true;
    seekContext = { event, player, remote };
    remote.seeking(seekTarget, event);
    feedback(player, `${delta > 0 ? '快进' : '快退'} ${Math.abs(delta)} 秒`);
  };

  const commitSeek = ({ event, remote }: KeyContext) => {
    if (!pendingSeek || !Number.isFinite(seekTarget)) return;
    pendingSeek = false;
    consume(event);
    remote.seek(seekTarget, event);
  };

  const cancel = () => {
    clearTimeout(boostTimer);
    if (pendingSeek && seekContext) commitSeek(seekContext);
    if (forward && originalRate !== undefined) {
      changeRate(forward, originalRate);
      feedback(forward.player, `已恢复 ${originalRate} 倍速`);
    }
    boostTimer = undefined;
    originalRate = undefined;
    forward = undefined;
    pendingSeek = false;
    until = 0;
  };

  const holdSeek = (binding: string, delta: number): MediaKeysCallback => ({
    keys: binding,
    onKeyDown: (context) => seekBy(delta, context),
    onKeyUp: commitSeek,
  });

  const seekOnce = (binding: string, resolve: (player: Player) => number): MediaKeysCallback => ({
    keys: binding,
    onKeyDown: ({ event, player, remote }) => {
      consume(event);
      const time = resolve(player);
      if (!Number.isFinite(time)) return;
      armAccumulator(time);
      remote.seek(time, event);
    },
  });

  const once = (binding: string, action: (context: KeyContext) => void): MediaKeysCallback => ({
    keys: binding,
    onKeyDown: (context) => {
      consume(context.event);
      if (!context.event.repeat) action(context);
    },
  });

  const volume = (binding: string, delta: number): MediaKeysCallback => ({
    keys: binding,
    onKeyDown: ({ event, player, remote }) => {
      consume(event);
      const element = media(player);
      const next = Math.round(Math.min(1, Math.max(0, (element?.volume ?? player.volume) + delta)) * 100) / 100;
      remote.changeVolume(next, event);
      // 同样处理快速反向调音量时的 store 延迟，原生事件会同步滑块与持久化。
      if (element && element.volume !== next) element.volume = next;
      if (element && next > 0 && element.muted) element.muted = false;
      feedback(player, `音量 ${Math.round(next * 100)}%`);
    },
  });

  const speed = (rate: number, { event, player, remote }: KeyContext) => {
    changeRate({ event, player, remote }, rate, event);
    feedback(player, `${rate} 倍速`);
  };

  const shortcuts: MediaKeyShortcuts = {
    // 默认按钮重挂时会把 aria-keyshortcuts 注册回同名动作并覆盖回调。
    // 自定义动作先匹配，标准动作只为按钮提供正确的可访问性提示。
    biliTogglePaused: once(keys.togglePaused, ({ event, player, remote }) => {
      const element = media(player);
      if (element?.paused ?? player.paused) {
        remote.play(event);
        if (element?.paused && element.readyState >= 2) void element.play().catch(() => {});
      } else {
        remote.pause(event);
        if (element && !element.paused) element.pause();
      }
    }),
    biliToggleMuted: once(keys.toggleMuted, ({ event, player, remote }) => {
      const element = media(player);
      const muted = element?.muted ?? player.muted;
      if (muted) remote.unmute(event);
      else remote.mute(event);
      if (element && element.muted === muted) element.muted = !muted;
      if (element && muted && element.volume === 0) element.volume = 0.25;
    }),
    togglePaused: keys.togglePaused,
    toggleMuted: keys.toggleMuted,
    toggleFullscreen: keys.toggleFullscreen,
    togglePictureInPicture: keys.togglePictureInPicture,
    toggleCaptions: keys.toggleCaptions,
    toggleDanmaku: once(keys.toggleDanmaku, () => actions.toggleDanmaku?.()),
    toggleWebFullscreen: once(keys.toggleWebFullscreen, () => actions.toggleWebFullscreen?.()),
    toggleTheater: once(keys.toggleTheater, () => actions.toggleTheater?.()),
    normalSpeed: once(keys.normalSpeed, (context) => speed(1, context)),
    doubleSpeed: once(keys.doubleSpeed, (context) => speed(2, context)),
    volumeUp: volume(keys.volumeUp, 0.1),
    volumeDown: volume(keys.volumeDown, -0.1),
    speedUp: once(keys.speedUp, (context) => speed(Math.min(4, (media(context.player)?.playbackRate ?? context.player.playbackRate) + 0.25), context)),
    slowDown: once(keys.slowDown, (context) => speed(Math.max(0.25, (media(context.player)?.playbackRate ?? context.player.playbackRate) - 0.25), context)),
    seekForward: holdSeek(keys.seekForward, settings.keySeek),
    seekBackward: holdSeek(keys.seekBackward, -settings.keySeek),
    arrowSeekBackward: holdSeek(keys.arrowSeekBackward, -settings.arrowSeek),
    arrowSeekForward: {
      keys: keys.arrowSeekForward,
      onKeyDown: (context) => {
        consume(context.event);
        if (forward || context.event.repeat) return;
        forward = context;
        boostTimer = setTimeout(() => {
          // 暂停时仍允许单次快进，但不意外开始播放。
          if (!forward || (media(forward.player)?.paused ?? forward.player.paused)) return;
          originalRate = media(forward.player)?.playbackRate ?? forward.player.playbackRate;
          changeRate(forward, 3, forward.event);
          feedback(forward.player, '3 倍速播放中 · 松开恢复', true);
        }, BOOST_DELAY);
      },
      onKeyUp: (context) => {
        consume(context.event);
        if (!forward) return;
        if (originalRate !== undefined) {
          cancel();
        } else {
          clearTimeout(boostTimer);
          forward = undefined;
          seekBy(settings.arrowSeek, context);
          commitSeek(context);
        }
      },
    },
    seekToStart: seekOnce(keys.seekToStart, () => 0),
    seekToEnd: seekOnce(keys.seekToEnd, (player) => mediaDuration(player)),
    frameForward: seekOnce(keys.frameForward, (player) => (media(player)?.paused ?? player.paused) ? Math.min(mediaDuration(player), mediaTime(player) + FRAME_STEP) : Number.NaN),
    frameBackward: seekOnce(keys.frameBackward, (player) => (media(player)?.paused ?? player.paused) ? Math.max(0, mediaTime(player) - FRAME_STEP) : Number.NaN),
  };

  // Shift 等修饰键先松开时，Vidstack 的组合键匹配可能收不到原动作的 keyup。
  const release = (event: KeyboardEvent) => {
    if (!forward || (event.key !== forward.event.key && (!event.code || event.code !== forward.event.code))) return;
    const callback = shortcuts.arrowSeekForward as MediaKeysCallback;
    callback.onKeyUp?.({ ...forward, event });
  };

  return { shortcuts, cancel, release };
}
