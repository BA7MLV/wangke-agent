import { useEffect, useRef, useState } from 'react';
import { Button } from '@heroui/react';
import { transcribe } from '../api/siliconflow';
import { getSettings, targetOrNull } from '../store/settings';
import { wavBlob } from '../media/wav';
import { Sym } from '../ui/icons';
import { IconSwap } from './motion';
import './voice-input.css';

/** Hold to dictate; tap (or keyboard activation) also toggles recording. Never auto-send. */
export default function VoiceInput({ onText, disabled }: { onText: (text: string) => void; disabled?: boolean }) {
  const [phase, setPhase] = useState<'idle' | 'permission' | 'recording' | 'transcribing'>('idle');
  const [error, setError] = useState('');
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const limit = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generation = useRef(0);
  const held = useRef(false);
  const suppressPress = useRef(false);
  const busy = useRef(false);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  const stop = (cancel = false) => {
    if (timer.current) clearTimeout(timer.current);
    if (limit.current) clearTimeout(limit.current);
    if (cancel || !recorder.current) {
      generation.current++;
      busy.current = false;
      setPhase('idle');
    }
    if (recorder.current?.state === 'recording') recorder.current.stop();
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
  };

  useEffect(() => {
    const onHidden = () => { if (document.hidden) stop(true); };
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      generation.current++;
      if (timer.current) clearTimeout(timer.current);
      if (limit.current) clearTimeout(limit.current);
      recorder.current?.state === 'recording' && recorder.current.stop();
      stream.current?.getTracks().forEach((track) => track.stop());
      document.removeEventListener('visibilitychange', onHidden);
    };
  }, []);

  const start = async () => {
    if (disabled || busy.current) return;
    setError('');
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

  return (
    <span className="voice-input" onPointerDownCapture={(event) => {
      if (disabled || phase !== 'idle' || event.button !== 0) return;
      held.current = false;
      suppressPress.current = false;
      (event.target as HTMLElement).closest('button')?.setPointerCapture(event.pointerId);
      timer.current = setTimeout(() => { held.current = true; void start(); }, 350);
    }} onPointerUpCapture={() => {
      if (timer.current) clearTimeout(timer.current);
      if (held.current) { suppressPress.current = true; held.current = false; stop(); }
    }} onPointerCancelCapture={() => { held.current = false; suppressPress.current = true; stop(true); }}
      onContextMenu={(event) => event.preventDefault()}>
      <Button isIconOnly variant="tertiary" size="sm" className="voice-input__button"
        aria-label={phase === 'recording' ? '结束录音' : '长按语音输入，或点击开始录音'}
        aria-pressed={phase === 'recording'} isDisabled={disabled || phase === 'transcribing'}
        data-testid="chat-voice" onPress={() => {
          if (held.current) return;
          if (suppressPress.current) { suppressPress.current = false; return; }
          if (phase === 'recording' || phase === 'permission') stop();
          else void start();
        }}>
        <IconSwap active={phase === 'recording' ? 'b' : 'a'} a={<Sym name="mic" />} b={<Sym name="stop" />} />
      </Button>
      {(phase !== 'idle' || error) && <span className="voice-input__status" role="status" data-error={!!error}>
        {error || (phase === 'permission' ? '请允许麦克风权限…' : phase === 'recording' ? '正在聆听，松开结束 · 最长 60 秒' : '正在转写…')}
      </span>}
    </span>
  );
}
