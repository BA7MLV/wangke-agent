/** 并发控制原语：AIMD 自适应限流 + 并发池，供转写/识图等批量调用场景共用 */
import { CancelError } from './cancel';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** AIMD 自适应并发控制（类 TCP 拥塞控制）：连续成功缓慢 +1，遇 429 减半并按 Retry-After 冷却 */
export class AdaptiveLimit {
  private limit: number;
  private streak = 0;
  /** 冷却截止时间戳（ms），此前不再派发新任务 */
  cooldownUntil = 0;

  constructor(initial: number, private min = 1, private max = 12) {
    this.limit = Math.max(min, Math.min(max, Math.round(initial)));
  }

  get current(): number {
    return this.limit;
  }

  /** 每 8 次连续成功 +1（加性增加） */
  onSuccess(): void {
    this.streak++;
    if (this.streak >= 8 && this.limit < this.max) {
      this.limit++;
      this.streak = 0;
    }
  }

  /** 429：并发减半（乘性减少），并按服务端要求冷却 */
  onRateLimit(retryAfterMs?: number): void {
    this.limit = Math.max(this.min, Math.floor(this.limit / 2));
    this.streak = 0;
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + (retryAfterMs ?? 2000));
  }
}

/**
 * 带 AIMD 反馈的重试：429 通知控制器降速并按 Retry-After 等待；400/401/403 不可重试。
 * `shouldAbort` 用于取消：退避 sleep 最长 4s，不检查的话「点了取消要等好几秒才停」。
 */
export async function withAdaptiveRetry<T>(
  fn: () => Promise<T>,
  limiter: AdaptiveLimit,
  retries = 3,
  shouldAbort?: () => boolean,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const err = e as { status?: number; retryAfterMs?: number };
      if (err.status === 400 || err.status === 401 || err.status === 403) throw e; // 不可重试
      if (err.status === 429) {
        // 限流：通知控制器降速，优先按 Retry-After 等待
        limiter.onRateLimit(err.retryAfterMs);
        await sleep(err.retryAfterMs ?? 2000 * 2 ** attempt + Math.random() * 500);
      } else {
        await sleep(1000 * 2 ** attempt + Math.random() * 500);
      }
      if (shouldAbort?.()) throw new CancelError();
    }
  }
  throw lastErr;
}

/**
 * 自适应并发池：在途任务数不超过 limiter.current，冷却期暂停派发。
 * 单任务失败默认整体停止；failFast=false 时收集错误继续跑（调用方自行兜底），池排空后抛首个错误。
 */
export async function adaptivePool<T>(
  items: T[],
  limiter: AdaptiveLimit,
  fn: (item: T, i: number) => Promise<void>,
  opts: { failFast?: boolean } = {},
): Promise<void> {
  const { failFast = true } = opts;
  let i = 0;
  let inflight = 0;
  let failed = false;
  let firstErr: unknown;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (failed) return;
      if (i >= items.length) {
        if (inflight === 0) {
          if (firstErr) reject(firstErr);
          else resolve();
        }
        return;
      }
      const wait = limiter.cooldownUntil - Date.now();
      if (wait > 0) {
        setTimeout(tick, wait);
        return;
      }
      while (inflight < limiter.current && i < items.length) {
        const idx = i++;
        inflight++;
        fn(items[idx], idx).then(
          () => {
            inflight--;
            limiter.onSuccess();
            tick();
          },
          (e) => {
            inflight--;
            if (failFast) {
              failed = true;
              reject(e);
            } else {
              firstErr ??= e;
              tick();
            }
          },
        );
      }
    };
    tick();
  });
}
