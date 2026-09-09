import { useCallback, useEffect, useRef, useState } from 'react';
import { useMediaPlayer } from '@vidstack/react';
import { liveQuery } from 'dexie';
import { db, type DanmakuRow } from '../store/db';
import { useSettings } from '../store/settings';

/**
 * 思考题弹幕渲染层：挂在 MediaPlayer 内（与 SeekFeedback 同级的绝对定位层）。
 * 数据用 Dexie liveQuery 订阅（面板重新生成后自动刷新）；播放进度经 player.subscribe，
 * 到点弹出、CSS 动画播完自动移除；seek 跳转（±10s 双击/拖进度条/列表点跳）时重置待发射指针。
 * 暂停时弹幕动画经 CSS [data-paused] 一并暂停；控制栏开关持久化在 settings.danmakuEnabled。
 */
export default function DanmakuLayer({ videoId }: { videoId: string }) {
  const player = useMediaPlayer();
  const enabled = useSettings((s) => s.danmakuEnabled);
  const [active, setActive] = useState<{ id: number; text: string } | null>(null);
  const itemsRef = useRef<DanmakuRow[]>([]);
  const ptrRef = useRef(0); // 下一条待发射弹幕的下标（items 按 time 升序）
  const lastTRef = useRef(0);
  const activeRef = useRef(false);

  // 待发射指针归位到 t 之后的第一条，并清掉当前弹窗
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

  if (!enabled) return null;
  return (
    <div className="danmaku-layer" aria-hidden>
      {active && (
        <div
          key={active.id}
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
