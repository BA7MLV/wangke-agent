/**
 * Wake Lock：长任务（转写/讲义生成）期间保持屏幕常亮，防 iPad 熄屏中断。
 * Safari 16.4+ 支持；不支持的浏览器静默降级。与 releaseWakeLock 配对使用。
 */

interface WakeLockSentinelLike extends EventTarget {
  release(): Promise<void>;
}

let wanted = false;
let sentinel: WakeLockSentinelLike | null = null;

async function acquire() {
  const nav = navigator as Navigator & {
    wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> };
  };
  if (!nav.wakeLock) return;
  try {
    sentinel = await nav.wakeLock.request('screen');
    sentinel.addEventListener('release', () => {
      sentinel = null;
    });
  } catch {
    // 低电量等情况下系统会拒绝，忽略
  }
}

function onVisibilityChange() {
  // 切回前台时系统可能已释放锁，需要重新申请
  if (document.visibilityState === 'visible' && wanted && !sentinel) void acquire();
}

export async function acquireWakeLock() {
  wanted = true;
  document.addEventListener('visibilitychange', onVisibilityChange);
  await acquire();
}

export async function releaseWakeLock() {
  wanted = false;
  document.removeEventListener('visibilitychange', onVisibilityChange);
  try {
    await sentinel?.release();
  } catch {
    /* ignore */
  }
  sentinel = null;
}
