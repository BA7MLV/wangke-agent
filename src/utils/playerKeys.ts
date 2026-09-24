import type { MediaKeyShortcuts, MediaKeysCallback } from '@vidstack/react';

/**
 * YouTube 式键盘映射。
 *
 * vidstack 自带的默认表（`MEDIA_KEY_SHORTCUTS`）与 YouTube 有四处差异，这里逐一对齐；
 * 另外 `keyShortcuts` 这个 prop 是**整体替换**而不是深合并，所以默认项必须一条条照抄回来。
 *
 * | 键 | vidstack 默认 | YouTube | 本文件 |
 * | --- | --- | --- | --- |
 * | ← / → | 与 j/l 同档，走布局的 `seekStep`（10s） | ±5s | ±5s |
 * | j / l | ±10s | ±10s | ±10s |
 * | Home / End | 无 | 跳到开头 / 结尾 | 有 |
 * | , / . | 无 | 暂停时逐帧 | 有 |
 * | k / Space · m · f · i · c · ↑↓ · < > · 0-9 | 有 | 同 | 原样保留 |
 *
 * 为什么 ←/→ 与 j/l 不能都交给 vidstack 的 `seek*` 方法：那两条路最终都会把步长落到同一个
 * `seekStep` 上（方向键靠转发合成键盘事件给滑块，j/l 靠 `remote.seeking`），一个值拆不成 5 和 10。
 * 代价是这两组键不再写 `lastKeyboardAction`，因此不触发中央的按键反馈动画
 * （播放/音量/全屏/字幕那几档仍走默认方法，动画照旧）。
 */

/** ← / → 的步长（YouTube 是 5 秒） */
const ARROW_SEEK = 5;

/** j / l 的步长（YouTube 是 10 秒） */
const KEY_SEEK = 10;

/**
 * 逐帧步长。YouTube 是「一帧」，但本地文件拿不到真实帧率，
 * 按常见 30fps 退一档 —— 比按 25fps 算更不容易一次跨两帧。
 */
const FRAME_STEP = 1 / 30;

/**
 * 连按同方向的累加窗口。
 *
 * 不加这个会退化成「按 5 次才前进一点点」：每次 `seeking` 请求落地都有延迟，
 * 下一次按键若以「当前时间」为基准，基准其实还停在原地。
 * 窗口内改成以上一次的**目标时间**为基准，就是 YouTube 那种 5s → 10s → 15s。
 */
const ACCUMULATE_MS = 700;

type KeyDownContext = Parameters<NonNullable<MediaKeysCallback['onKeyDown']>>[0];
type KeyUpContext = Parameters<NonNullable<MediaKeysCallback['onKeyUp']>>[0];

/**
 * 播放器实例。
 *
 * 不能直接写 `import type { MediaPlayer }`：`@vidstack/react` 把同名的 **React 组件** 导出成了
 * 值，把 vidstack 内部那个 `MediaPlayer` 类类型遮住了（TS 报「refers to a value」）。
 * 从快捷键回调的上下文里取类型，拿到的是同一个类，且不依赖内部路径。
 */
type Player = KeyDownContext['player'];

/**
 * 取总时长做上界。
 *
 * vidstack 的 TS 类型里 `MediaPlayer` 只公开 `currentTime / paused / volume / playbackRate`
 * （`MediaStateAccessors`），`duration` 运行时才有、类型上没有，所以退一步从媒体元素上读；
 * 读不到就不夹上界（把 `currentTime` 设到时长之外时浏览器自己会夹到末尾）。
 */
function mediaDuration(player: Player): number {
  const duration = player.el?.querySelector('video')?.duration;
  return typeof duration === 'number' && Number.isFinite(duration) ? duration : Number.POSITIVE_INFINITY;
}

/**
 * 取播放位置做基准。
 *
 * 优先读媒体元素：vidstack 的 store 在「刚跳转完」那一小段时间里可能还是旧值
 * （`remote.seek()` 的落地是异步的），拿旧值当基准会让下一次 ±5s 直接算到旧位置上去 ——
 * 实测「End 跳到末尾 → Home 回到 0 → 立刻按 →」会一次冲到末尾。
 * 读媒体元素是即时的（`currentTime` 在 seek 请求发出的当下就变了），也是唯一真相；
 * 读不到时才退回 store。
 */
function mediaTime(player: Player): number {
  const current = player.el?.querySelector('video')?.currentTime;
  return typeof current === 'number' && Number.isFinite(current) ? current : player.currentTime;
}

export function createYoutubeKeyShortcuts(): MediaKeyShortcuts {
  // 连按累加的游标。本项目同页只有一个播放器，闭包单例足够；
  // 700ms 窗口一过就以「当前时间」为基准，所以不需要在换视频时重置。
  let seekTarget = Number.NaN;
  let until = 0;

  const armAccumulator = (target: number) => {
    seekTarget = target;
    until = Date.now() + ACCUMULATE_MS;
  };

  /** 按住时只发「正在拖动」请求，松手才落定 —— 与 vidstack 自己那套累加逻辑同款。 */
  const seekBy = (delta: number, { event, player, remote }: KeyDownContext) => {
    const base = Date.now() < until && Number.isFinite(seekTarget) ? seekTarget : mediaTime(player);
    armAccumulator(Math.min(Math.max(0, base + delta), mediaDuration(player)));
    remote.seeking(seekTarget, event);
  };

  const commitSeek = ({ event, remote }: KeyUpContext) => {
    if (!Number.isFinite(seekTarget)) return;
    remote.seek(seekTarget, event);
  };

  /** 按住连续的键（j/l 与 ←/→）：按下累加、松开落定 */
  const holdSeek = (keys: string, delta: number): MediaKeysCallback => ({
    keys,
    onKeyDown: (context) => seekBy(delta, context),
    onKeyUp: commitSeek,
  });

  /** 一次性跳转（Home / End / 逐帧）。`resolve` 返回非有限值时不动。 */
  const seekOnce = (keys: string, resolve: (player: Player, event: KeyboardEvent) => number): MediaKeysCallback => ({
    keys,
    onKeyDown: ({ event, player, remote }) => {
      const time = resolve(player, event);
      if (!Number.isFinite(time)) return;
      // 把跳转目标也当成累加基准：紧跟着按方向键时不会被「还没落地的旧位置」带偏
      armAccumulator(time);
      remote.seek(time, event);
    },
  });

  return {
    // ── 与 vidstack 默认一致（整体替换后必须显式写回） ─────────────
    togglePaused: 'k Space',
    toggleMuted: 'm',
    toggleFullscreen: 'f',
    togglePictureInPicture: 'i',
    toggleCaptions: 'c',
    volumeUp: 'ArrowUp',
    volumeDown: 'ArrowDown',
    // '>' / '<' 就是 Shift+. / Shift+,（vidstack 的按键匹配对这两个字符隐含要求 Shift）
    speedUp: '>',
    slowDown: '<',
    // 0-9 跳到百分比由 vidstack 内部处理（mediaKeyboardController），无需也无法在这里覆盖

    // ── 与 YouTube 对齐的部分 ────────────────────────────────────
    seekForward: holdSeek('l L', KEY_SEEK),
    seekBackward: holdSeek('j J', -KEY_SEEK),
    arrowSeekForward: holdSeek('ArrowRight', ARROW_SEEK),
    arrowSeekBackward: holdSeek('ArrowLeft', -ARROW_SEEK),
    seekToStart: seekOnce('Home', () => 0),
    seekToEnd: seekOnce('End', (player) => mediaDuration(player)),
    frameForward: seekOnce('.', (player) => (player.paused ? player.currentTime + FRAME_STEP : Number.NaN)),
    frameBackward: seekOnce(',', (player) => (player.paused ? Math.max(0, player.currentTime - FRAME_STEP) : Number.NaN)),
  };
}
