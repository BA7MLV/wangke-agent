import { useEffect, useRef } from 'react';
import type { FigureName } from './flow';

type Loaded = typeof import('./figures');
let loading: Promise<Loaded> | null = null;
/** 模块级缓存：换步骤时不重复请求。welcome 页渲染时就开始加载。 */
export const loadFigures = () => (loading ??= import('./figures'));

/** 提交时立即启动锁扣，避免 Hairline 自动演示的起播等待；填写时不驱动图形。 */
function submissionPose(element: HTMLDivElement, name: FigureName, play: boolean) {
  if (name !== 'padlock') return;
  if (!play || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    element.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' }));
    return;
  }
  const bounds = element.getBoundingClientRect();
  element.dispatchEvent(new PointerEvent('pointermove', {
    pointerType: 'mouse',
    clientX: bounds.left + bounds.width * 0.5,
    clientY: bounds.top + bounds.height * 0.4375,
  }));
}

/**
 * 2.5D 线稿图形。hairline 自己处理了：
 * - prefers-reduced-motion 时停在静止姿态；
 * - 不在视口内时暂停帧循环；
 * - play 时的自动演示。
 * 表单页的 play 只由提交状态驱动。
 */
export default function OnboardingFigure({ name, intensity = 0.5, label, play = false }: {
  name: FigureName;
  intensity?: number;
  label: string;
  play?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const figure = useRef<import('./figures').Figure | null>(null);
  const latest = useRef({ intensity, label, play });
  latest.current = { intensity, label, play };

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let cancelled = false;
    void loadFigures().then((mod) => {
      if (cancelled) return;
      figure.current = mod[name](element, latest.current);
      submissionPose(element, name, latest.current.play);
    }).catch(() => { /* 图形只是装饰，加载失败时留一块空白也不影响初始化 */ });
    return () => {
      cancelled = true;
      figure.current?.destroy();
      figure.current = null;
    };
  }, [name]);

  useEffect(() => {
    figure.current?.update({ intensity, label, play });
    if (host.current && figure.current) submissionPose(host.current, name, play);
  }, [intensity, label, play, name]);

  return <div ref={host} className="ob-figure__art" />;
}
