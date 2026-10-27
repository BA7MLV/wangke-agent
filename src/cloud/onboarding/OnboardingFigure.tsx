import { useEffect, useRef } from 'react';
import type { FigureName } from './flow';

type Loaded = typeof import('./figures');
let loading: Promise<Loaded> | null = null;
/** 模块级缓存：换步骤时不重复请求。welcome 页渲染时就开始加载。 */
export const loadFigures = () => (loading ??= import('./figures'));

/**
 * 2.5D 线稿图形。hairline 自己处理了：
 * - prefers-reduced-motion 时停在静止姿态；
 * - 不在视口内时暂停帧循环；
 * - 指针 / 键盘交互，以及 play 时的自动演示。
 * 这里只负责挂载、跟随 intensity 更新、卸载时清理。
 */
export default function OnboardingFigure({ name, intensity = 0.5, label }: { name: FigureName; intensity?: number; label: string }) {
  const host = useRef<HTMLDivElement>(null);
  const figure = useRef<import('./figures').Figure | null>(null);
  const latest = useRef({ intensity, label });
  latest.current = { intensity, label };

  useEffect(() => {
    let cancelled = false;
    void loadFigures().then((mod) => {
      if (cancelled || !host.current) return;
      figure.current = mod[name](host.current, { play: true, intensity: latest.current.intensity, label: latest.current.label });
    }).catch(() => { /* 图形只是装饰，加载失败时留一块空白也不影响初始化 */ });
    return () => {
      cancelled = true;
      figure.current?.destroy();
      figure.current = null;
    };
  }, [name]);

  useEffect(() => {
    figure.current?.update({ intensity, label });
  }, [intensity, label]);

  return <div ref={host} className="ob-figure__art" />;
}
