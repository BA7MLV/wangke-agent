import { useEffect, useState } from 'react';
import { useMediaPlayer } from '@vidstack/react';
import { PLAYER_FEEDBACK_EVENT, type PlayerFeedbackDetail } from '../utils/playerKeys';

/** 键盘反馈独立订阅，不让每次跳转 / 音量变化重渲染整页。 */
export default function PlayerFeedback() {
  const player = useMediaPlayer();
  const [feedback, setFeedback] = useState<PlayerFeedbackDetail | null>(null);
  useEffect(() => {
    const el = player?.el;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const show = (event: Event) => {
      const detail = (event as CustomEvent<PlayerFeedbackDetail>).detail;
      clearTimeout(timer);
      setFeedback(detail);
      if (!detail.boost) timer = setTimeout(() => setFeedback(null), 1400);
    };
    el.addEventListener(PLAYER_FEEDBACK_EVENT, show);
    return () => {
      clearTimeout(timer);
      el.removeEventListener(PLAYER_FEEDBACK_EVENT, show);
    };
  }, [player]);

  return <div className="player-feedback" data-active={!!feedback || undefined} data-boost={feedback?.boost || undefined} role="status" aria-live="polite">{feedback?.text}</div>;
}
