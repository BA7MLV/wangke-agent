import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useMediaPlayer } from '@vidstack/react';
import { liveQuery } from 'dexie';
import { db, type DanmakuRow } from '../store/db';
import { useSettings } from '../store/settings';

/** 飘屏线速度（px/s）。用恒定线速度而不是恒定时长：思考题是句子，长度差好几倍，
 *  固定时长会让长句反而飞得更快、恰好最难读的那条最快 —— 反了。 */
const SCROLL_SPEED = 150;
/** 时长兜底区间（ms）：极端宽度（超短句 / 窄屏长句）下别快成闪一下、也别慢成挂住 */
const MIN_DUR = 7000;
const MAX_DUR = 16000;

/**
 * 思考题弹幕渲染层：挂在 MediaPlayer 内（与 SeekFeedback 同级的绝对定位层）。
 * 数据用 Dexie liveQuery 订阅（面板重新生成后自动刷新）；播放进度经 player.subscribe，
 * 到点自画面右侧向左侧飘过、CSS 动画播完自动移除；seek 跳转（±10s 双击/拖进度条/列表点跳）
 * 时重置待发射指针。暂停时弹幕动画经 CSS [data-paused] 一并暂停；控制栏开关持久化在
 * settings.danmakuEnabled。
 */
export default function DanmakuLayer({ videoId }: { videoId: string }) {
  const player = useMediaPlayer();
  const enabled = useSettings((s) => s.danmakuEnabled);
  const [active, setActive] = useState<{ id: number; text: string } | null>(null);
  const itemsRef = useRef<DanmakuRow[]>([]);
  const ptrRef = useRef(0); // 下一条待发射弹幕的下标（items 按 time 升序）
  const lastTRef = useRef(0);
  const activeRef = useRef(false);
  const layerRef = useRef<HTMLDivElement>(null);
  const itemRef = useRef<HTMLDivElement>(null);

  // 待发射指针归位到 t 之后的第一条，并清掉屏幕上那条
  const resetTo = useCallback((t: number) => {
    const arr = itemsRef.current;
    let i = 0;
    while (i < arr.length && arr[i].time <= t) i++;
    ptrRef.current = i;
    lastTRef.current = t;
    activeRef.current = false;
    setActive(null);
  }, []);

  // 弹幕数据订阅：重新生成后按当前进度重新归位（不重复发射已播过的）
  useEffect(() => {
    const sub = liveQuery(() => db.danmakus.where('videoId').equals(videoId).sortBy('time')).subscribe({
      next: (rows) => {
        itemsRef.current = rows;
        const t = lastTRef.current;
        let i = 0;
        while (i < rows.length && rows[i].time <= t) i++;
        ptrRef.current = i;
      },
    });
    return () => sub.unsubscribe();
  }, [videoId]);

  useEffect(() => {
    if (!player || !enabled) return;
    resetTo(player.currentTime ?? 0);
    return player.subscribe(({ currentTime: t }) => {
      // seek 检测：正常 timeupdate 间隔约 0.25s（3x 倍速约 0.75s），跳跃说明用户 seek
      if (Math.abs(t - lastTRef.current) > 1.5) {
        resetTo(t);
        return;
      }
      lastTRef.current = t;
      const arr = itemsRef.current;
      while (ptrRef.current < arr.length && arr[ptrRef.current].time <= t) {
        const item = arr[ptrRef.current++];
        // 已有弹窗在显示时到点的丢弃（密度约每 5 分钟 1 条，极少发生）
        if (!activeRef.current) {
          activeRef.current = true;
          setActive({ id: item.id ?? Math.round(item.time), text: item.text });
        }
      }
    });
  }, [player, enabled, resetTo]);

  // 量一次宽度，把飘屏的位移与时长写进去（见 player-enhance.css 的推导）。
  // 必须在 paint 之前跑完：动画此刻还是 paused，改 --dm-dur 后进度仍停在 0，不会跳。
  // offsetWidth 量的是布局宽度，与动画施加的 transform 无关，量得到也不受干扰。
  // 用布局副作用 + 直接改 DOM，是为了不为了量宽度多渲染一轮。
  useLayoutEffect(() => {
    const el = itemRef.current;
    const layer = layerRef.current;
    if (!el || !layer) return;
    const dist = layer.clientWidth + el.offsetWidth;
    const dur = Math.min(MAX_DUR, Math.max(MIN_DUR, (dist / SCROLL_SPEED) * 1000));
    el.style.setProperty('--dm-shift', `${dist / 2}px`);
    el.style.setProperty('--dm-dur', `${Math.round(dur)}ms`);
    el.dataset.ready = '';
  }, [active]);

  if (!enabled) return null;
  return (
    <div className="danmaku-layer" ref={layerRef} aria-hidden>
      {active && (
        <div
          key={active.id}
          ref={itemRef}
          className="dm-item"
          onAnimationEnd={() => {
            activeRef.current = false;
            setActive(null);
          }}
        >
          <span className="dm-tag">思考</span>
          {active.text}
        </div>
      )}
    </div>
  );
}
