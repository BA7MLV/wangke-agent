import { useEffect, useRef, useState, type RefObject } from 'react';
import { Button } from '@heroui/react';
import { transcribe } from '../api/siliconflow';
import { getSettings, targetOrNull } from '../store/settings';
import { wavBlob } from '../media/wav';
import { Sym } from '../ui/icons';
import { IconSwap } from './motion';
import './voice-input.css';

// Web Speech is prefixed in Safari and some Chromium versions; lib.dom omits it.
interface LiveRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

/** One stable action slot: microphone when empty, send when populated. Never auto-send. */
export default function VoiceInput({ onText, onStart, disabled, hasText = false, onSend, sendLabel = '发送', editVersion = 0, holdTargetRef }: {
  onText: (text: string) => void;
  onStart?: () => void;
  disabled?: boolean;
  hasText?: boolean;
  onSend?: () => void;
  sendLabel?: string;
  editVersion?: number;
  holdTargetRef?: RefObject<HTMLDivElement | null>;
}) {
  const [phase, setPhase] = useState<'idle' | 'permission' | 'recording' | 'transcribing'>('idle');
  const [error, setError] = useState('');
  const recorder = useRef<MediaRecorder | null>(null);
  const recognition = useRef<LiveRecognition | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const limit = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generation = useRef(0);
  const held = useRef(false);
  const suppressPress = useRef(false);
  const busy = useRef(false);
  const root = useRef<HTMLSpanElement>(null);
  const gesture = useRef<{ pointerId: number; x: number; y: number; target: HTMLElement } | null>(null);
  const [holding, setHolding] = useState(false);
  const [cancelHint, setCancelHint] = useState(false);
  const cancelHold = useRef(false);
  const holdSession = useRef(false);
  const holdTranscript = useRef('');
  const liveStarted = useRef(false);
  const onTextRef = useRef(onText);
  const previousEdit = useRef(editVersion);
  onTextRef.current = onText;

  const stop = (cancel = false) => {
    if (timer.current) clearTimeout(timer.current);
    if (limit.current) clearTimeout(limit.current);
    if (cancel) {
      held.current = false;
      gesture.current = null;
      holdSession.current = false;
      holdTranscript.current = '';
      setHolding(false);
    }
    if (recognition.current) {
      if (cancel || !liveStarted.current) {
        generation.current++;
        recognition.current.abort();
        recognition.current = null;
        busy.current = false;
        setPhase('idle');
      } else {
        setPhase('transcribing');
        recognition.current.stop();
      }
      return;
    }
    if (cancel || !recorder.current) {
      generation.current++;
      busy.current = false;
      setPhase('idle');
    }
    if (recorder.current?.state === 'recording') recorder.current.stop();
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
  };

  // Manual edits take ownership of the draft. Late interim/final results must
  // not overwrite a correction or refill the composer after keyboard sending.
  useEffect(() => {
    if (previousEdit.current !== editVersion || disabled) stop(true);
    previousEdit.current = editVersion;
  }, [editVersion, disabled]);

  useEffect(() => {
    const onHidden = () => { if (document.hidden) stop(true); };
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      generation.current++;
      recognition.current?.abort();
      if (timer.current) clearTimeout(timer.current);
      if (limit.current) clearTimeout(limit.current);
      recorder.current?.state === 'recording' && recorder.current.stop();
      stream.current?.getTracks().forEach((track) => track.stop());
      document.removeEventListener('visibilitychange', onHidden);
    };
  }, []);

  const start = async () => {
    if (disabled || busy.current) return;
    if (!held.current) { holdSession.current = false; holdTranscript.current = ''; }
    setError('');
    const speechWindow = window as unknown as {
      SpeechRecognition?: new () => LiveRecognition;
      webkitSpeechRecognition?: new () => LiveRecognition;
    };
    const Recognition = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
    if (Recognition) {
      const id = ++generation.current;
      const live = new Recognition();
      liveStarted.current = false;
      recognition.current = live;
      busy.current = true;
      setPhase('permission');
      onStart?.();
      live.lang = document.documentElement.lang || 'zh-CN';
      live.continuous = true;
      live.interimResults = true;
      live.onstart = () => {
        if (id !== generation.current) return;
        liveStarted.current = true;
        setPhase('recording');
        limit.current = setTimeout(() => stop(), 60_000);
      };
      // Results contain the whole session, including revisions of interim words.
      // Replace this session's text instead of appending every partial result.
      live.onresult = (event) => {
        if (id !== generation.current) return;
        const text = Array.from(event.results, (result) => result[0]?.transcript ?? '').join('').trim();
        if (text) {
          if (holdSession.current) holdTranscript.current = text;
          else onTextRef.current(text);
        }
      };
      live.onerror = (event) => {
        if (id !== generation.current || event.error === 'aborted') return;
        setError(event.error === 'not-allowed' || event.error === 'service-not-allowed'
          ? '未获语音识别权限，请在浏览器设置中允许。'
          : event.error === 'no-speech' ? '没有听到语音，请再试一次。'
            : '实时语音识别不可用，请检查网络或改用文字输入。');
      };
      live.onend = () => {
        if (id !== generation.current) return;
        if (limit.current) clearTimeout(limit.current);
        recognition.current = null;
        busy.current = false;
        setPhase('idle');
        if (holdSession.current && holdTranscript.current) onTextRef.current(holdTranscript.current);
        holdSession.current = false;
      };
      try { live.start(); } catch {
        recognition.current = null;
        busy.current = false;
        setPhase('idle');
        setError('无法启动实时语音识别，请检查浏览器权限。');
      }
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('当前浏览器不支持录音，请使用 HTTPS 下的 Safari 或 Chrome。');
      return;
    }
    const settings = getSettings();
    const target = targetOrNull(settings, settings.asrModel);
    if (!target?.model || !target.apiKey) {
      setError('请先在设置 → 模型中配置语音识别。');
      return;
    }
    busy.current = true;
    onStart?.();
    const id = ++generation.current;
    setPhase('permission');
    try {
      const audio = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (id !== generation.current) {
        audio.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.current = audio;
      const recording = new MediaRecorder(audio);
      recorder.current = recording;
      const chunks: Blob[] = [];
      recording.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      recording.onerror = () => {
        stop(true);
        setError('录音中断，请检查麦克风后重试。');
      };
      recording.onstop = () => {
        audio.getTracks().forEach((track) => track.stop());
        recorder.current = null;
        if (id !== generation.current) return;
        setPhase('transcribing');
        void (async () => {
          // Normalize browser-specific WebM/MP4 recording to the ASR slot's WAV input.
          const context = new AudioContext({ sampleRate: 16000 });
          try {
            const decoded = await context.decodeAudioData(await new Blob(chunks, { type: recording.mimeType }).arrayBuffer());
            if (decoded.duration < 0.3) throw new Error('录音太短，请按住后说话。');
            const pcm = new Int16Array(decoded.length);
            for (let i = 0; i < pcm.length; i++) {
              let sample = 0;
              for (let ch = 0; ch < decoded.numberOfChannels; ch++) sample += decoded.getChannelData(ch)[i];
              sample = Math.max(-1, Math.min(1, sample / decoded.numberOfChannels));
              pcm[i] = sample * (sample < 0 ? 32768 : 32767);
            }
            if (id !== generation.current) return;
            const result = await transcribe(target, wavBlob(pcm, decoded.sampleRate), 'voice.wav');
            if (id !== generation.current) return;
            if (!result.text.trim()) throw new Error('没有识别到语音，请再试一次。');
            onTextRef.current(result.text.trim());
          } finally {
            await context.close();
          }
        })().catch((reason: unknown) => {
          if (id === generation.current) setError(reason instanceof Error ? reason.message : '语音识别失败，请重试。');
        }).finally(() => {
          if (id === generation.current) { busy.current = false; setPhase('idle'); }
        });
      };
      recording.start();
      setPhase('recording');
      limit.current = setTimeout(() => stop(), 60_000);
    } catch (reason) {
      if (id !== generation.current) return;
      stream.current?.getTracks().forEach((track) => track.stop());
      busy.current = false;
      setPhase('idle');
      setError(reason instanceof DOMException && reason.name === 'NotAllowedError'
        ? '麦克风权限未开启，请在浏览器设置中允许录音。'
        : '无法启动麦克风，请检查设备后重试。');
    }
  };

  // Bind the whole composer without stealing short taps, typing or toolbar actions.
  // Keep listeners stable while permission/recognition updates re-render the component.
  const handlers = useRef({ down: (_event: PointerEvent) => {}, move: (_event: PointerEvent) => {}, end: (_event: PointerEvent) => {} });
  handlers.current = {
    down: (event) => {
      if (disabled || busy.current || gesture.current || event.button !== 0 || !event.isPrimary) return;
      const target = event.target as HTMLElement;
      const voiceButton = target.closest('[data-testid="chat-voice"]');
      if (!voiceButton && target.closest('button, a, [role="button"], [role="combobox"], [contenteditable="true"]')) return;
      const captureTarget = holdTargetRef?.current ?? root.current;
      if (!captureTarget) return;
      gesture.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, target: captureTarget };
      suppressPress.current = false;
      timer.current = setTimeout(() => {
        if (!gesture.current) return;
        held.current = true;
        holdSession.current = true;
        holdTranscript.current = '';
        cancelHold.current = false;
        setCancelHint(false);
        setHolding(true);
        captureTarget.setPointerCapture(event.pointerId);
        if (document.activeElement instanceof HTMLElement && captureTarget.contains(document.activeElement)) document.activeElement.blur();
        window.getSelection()?.removeAllRanges();
        void start();
      }, 350);
    },
    move: (event) => {
      const active = gesture.current;
      if (!active || active.pointerId !== event.pointerId) return;
      if (!held.current) {
        if (Math.hypot(event.clientX - active.x, event.clientY - active.y) > 12) {
          if (timer.current) clearTimeout(timer.current);
          gesture.current = null;
        }
        return;
      }
      event.preventDefault();
      cancelHold.current = active.y - event.clientY > 64;
      setCancelHint(cancelHold.current);
    },
    end: (event) => {
      const active = gesture.current;
      if (!active || active.pointerId !== event.pointerId) return;
      gesture.current = null;
      if (timer.current) clearTimeout(timer.current);
      if (held.current) {
        suppressPress.current = true;
        held.current = false;
        setHolding(false);
        const cancelled = event.type !== 'pointerup' || cancelHold.current;
        if (cancelled) { holdTranscript.current = ''; holdSession.current = false; }
        stop(cancelled);
      }
      if (active.target.hasPointerCapture(event.pointerId)) active.target.releasePointerCapture(event.pointerId);
    },
  };
  useEffect(() => {
    const target = holdTargetRef?.current ?? root.current;
    if (!target) return;
    target.classList.add('voice-input-target');
    const down = (event: PointerEvent) => handlers.current.down(event);
    const move = (event: PointerEvent) => handlers.current.move(event);
    const end = (event: PointerEvent) => handlers.current.end(event);
    const context = (event: Event) => { if (gesture.current || held.current) event.preventDefault(); };
    const click = (event: MouseEvent) => {
      if (!suppressPress.current) return;
      event.preventDefault();
      event.stopPropagation();
      suppressPress.current = false;
    };
    target.addEventListener('pointerdown', down, true);
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', end, true);
    window.addEventListener('pointercancel', end, true);
    target.addEventListener('lostpointercapture', end);
    target.addEventListener('contextmenu', context);
    target.addEventListener('click', click, true);
    return () => {
      target.classList.remove('voice-input-target');
      target.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end, true);
      window.removeEventListener('pointercancel', end, true);
      target.removeEventListener('lostpointercapture', end);
      target.removeEventListener('contextmenu', context);
      target.removeEventListener('click', click, true);
    };
  }, [holdTargetRef]);

  return (
    <span className="voice-input" ref={root}>
      <Button isIconOnly variant={hasText ? 'primary' : 'tertiary'} size="sm" className="voice-input__button"
        aria-label={hasText ? sendLabel : phase === 'recording' || phase === 'permission' ? '结束语音输入' : '语音输入'}
        aria-pressed={!hasText && phase === 'recording'} isDisabled={disabled || (!hasText && phase === 'transcribing')}
        data-testid={hasText ? 'chat-send' : 'chat-voice'} onPress={() => {
          if (held.current) return;
          if (suppressPress.current) { suppressPress.current = false; return; }
          if (hasText && onSend) { stop(true); onSend(); }
          else if (phase === 'recording' || phase === 'permission') stop();
          else void start();
        }}>
        <IconSwap active={hasText ? 'b' : 'a'}
          a={<Sym name={phase === 'recording' || phase === 'permission' ? 'stop' : 'mic'} />}
          b={<Sym name="arrow_upward" />} />
      </Button>
      {holding && <span className="voice-input__hold" data-cancel={cancelHint} role="status" data-testid="chat-voice-hold">
        <Sym name={cancelHint ? 'close' : 'mic'} />
        <strong>{cancelHint ? '松开取消' : phase === 'permission' ? '正在开启麦克风…' : phase === 'idle' ? error || '语音未启动' : '松开完成'}</strong>
        <span>{cancelHint ? '下滑继续说话' : '上滑取消 · 最长 60 秒'}</span>
      </span>}
      {!holding && (phase !== 'idle' || error) && <span className="voice-input__status" role="status" data-error={!!error}>
        {error || (phase === 'permission' ? '请允许麦克风与语音识别权限…' : phase === 'recording'
          ? recognition.current ? '实时转写中 · 点击停止或松开结束 · 最长 60 秒（使用浏览器语音服务）'
            : '此浏览器不支持实时识别，结束录音后转写 · 最长 60 秒'
          : '正在完成转写…')}
        {(phase === 'recording' || phase === 'permission') && hasText &&
          <button type="button" className="voice-input__finish" onClick={() => stop()}>结束语音</button>}
      </span>}
    </span>
  );
}
