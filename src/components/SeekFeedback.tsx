import { useEffect, useRef, useState } from 'react';
import { useMediaPlayer } from '@vidstack/react';

interface Pulse {
  id: number;
  side: 'left' | 'right';
  seconds: number;
}

/**
 * 双击画面左右两侧 ±10s 的涟漪反馈。
 * 手势本身由 Vidstack 默认布局内置（dblpointerup → seek:∓10，左/右各 20% 区域，
 * 触屏自动转 touchend 且带滚动/捏合排除），这里只补视觉反馈：
 * 监听 gesture 动作执行后派发的 trigger 事件——该事件不冒泡，须在捕获阶段监听。
 */
export default function SeekFeedback() {
  const player = useMediaPlayer();
  const [pulses, setPulses] = useState<Pulse[]>([]);
  const idRef = useRef(0);
  const accRef = useRef<{ side: '' | 'left' | 'right'; total: number; until: number }>({
    side: '',
    total: 0,
    until: 0,
  });

  useEffect(() => {
    const el = player?.el;
    if (!el) return;
    const onTrigger = (e: Event) => {
      const action = (e as CustomEvent<string>).detail;
      if (action !== 'seek:-10' && action !== 'seek:10') return;
      const side: Pulse['side'] = action === 'seek:-10' ? 'left' : 'right';
      const now = Date.now();
      const acc = accRef.current;
      // 1s 内同侧连续双击累加秒数（YouTube 风格：-10s → -20s → -30s）
      const total = acc.side === side && now < acc.until ? acc.total + 10 : 10;
      accRef.current = { side, total, until: now + 1000 };
      const id = ++idRef.current;
      // 同侧替换旧脉冲（key 变化重新挂载 → 动画重新播放）
      setPulses((prev) => [...prev.filter((p) => p.side !== side), { id, side, seconds: total }]);
    };
    el.addEventListener('trigger', onTrigger, true);
    return () => el.removeEventListener('trigger', onTrigger, true);
  }, [player]);

  return (
    <div className="seek-feedback" aria-hidden>
      {pulses.map((p) => (
        <div
          key={p.id}
          className={`seek-pulse seek-pulse-${p.side}`}
          onAnimationEnd={() => setPulses((prev) => prev.filter((x) => x.id !== p.id))}
        >
          {p.side === 'left' ? `−${p.seconds}s` : `+${p.seconds}s`}
        </div>
      ))}
    </div>
  );
}
