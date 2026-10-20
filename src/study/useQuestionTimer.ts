import { useEffect, useRef } from 'react';

/** Count only visible question time, excluding hidden tabs and completed questions. */
export function useQuestionTimer(picks: number[]) {
  const root = useRef<HTMLDivElement>(null);
  const timers = useRef(new Map<number, { elapsed: number; since: number | null; visible: boolean }>());
  const picksRef = useRef(picks);
  picksRef.current = picks;
  useEffect(() => {
    const update = () => {
      const now = performance.now();
      for (const [index, timer] of timers.current) {
        if (timer.since !== null) timer.elapsed += now - timer.since;
        timer.since = !document.hidden && timer.visible && (picksRef.current[index] ?? -1) < 0 ? now : null;
      }
    };
    const observer = new IntersectionObserver((entries) => {
      update();
      for (const entry of entries) {
        const index = Number((entry.target as HTMLElement).dataset.questionIndex);
        const timer = timers.current.get(index) ?? { elapsed: 0, since: null, visible: false };
        timer.visible = entry.isIntersecting;
        timers.current.set(index, timer);
      }
      update();
    });
    root.current?.querySelectorAll('[data-question-index]').forEach((el) => observer.observe(el));
    document.addEventListener('visibilitychange', update);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', update);
      for (const timer of timers.current.values()) {
        if (timer.since !== null) timer.elapsed += performance.now() - timer.since;
        timer.since = null;
      }
    };
  }, []);
  const finish = (index: number) => {
    const timer = timers.current.get(index);
    if (!timer) return 0;
    if (timer.since !== null) timer.elapsed += performance.now() - timer.since;
    timer.since = null;
    timer.visible = false;
    return Math.round(timer.elapsed / 100) / 10;
  };
  return { root, finish };
}
