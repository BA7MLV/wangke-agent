import { useCallback, useEffect, useState, type RefObject } from 'react';
import type { MediaPlayerInstance } from '@vidstack/react';

/** 网页全屏不重挂播放器；保留媒体、字幕轨和学习面板的状态。 */
export function usePlayerWebFullscreen(playerRef: RefObject<MediaPlayerInstance | null>) {
  const [webFullscreen, setWebFullscreen] = useState(false);
  const toggleWebFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().then(() => setWebFullscreen(true)).catch(() => {});
    } else {
      setWebFullscreen((active) => !active);
    }
  }, []);

  useEffect(() => {
    const player = playerRef.current?.el;
    if (!webFullscreen || !player) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    player.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !(event.target instanceof Node) || !player.contains(event.target)) return;
      if (player.querySelector('.vds-menu-items[data-open]')) return;
      if (event.key === 'Escape' && !document.fullscreenElement) {
        setWebFullscreen(false);
        event.preventDefault();
      }
      if (event.key !== 'Tab') return;
      const controls = Array.from(player.querySelectorAll<HTMLElement>('button, [href], [tabindex="0"], input'))
        .filter((el) => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' && !el.matches(':disabled, [aria-disabled="true"]'));
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === player)) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [webFullscreen, playerRef]);

  return { webFullscreen, setWebFullscreen, toggleWebFullscreen };
}
