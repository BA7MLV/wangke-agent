import { useEffect, useState } from 'react';
import { Button, Tooltip } from '@heroui/react';
import { IconSwap, SuccessCheck } from './motion';
import { Sym } from '../ui';
import type { CompressionState } from '../store/contextCompression';
import './context-usage.css';

export interface ContextUsageButtonProps {
  /** 本轮输入的 token 估算量（系统提示词 + 历史 + 草稿） */
  tokens: number;
  /** 上下文窗口（输入 + 输出的总容量），取设置里的 `contextWindow` */
  windowTokens: number;
  testId?: string;
  compression?: CompressionState;
  onCompress?: () => void;
  isDisabled?: boolean;
}

/** `12.3k` / `980`：小数值不拖一串没意义的小数位，k 之后留一位就够看趋势 */
function compact(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
}

/**
 * 上下文用量指示器：输入卡工具行右端的一枚**环形进度**图标。
 *
 * ## 为什么是环而不是文字
 * 工具行的宽度是稀缺资源（模型 chip / 技能 / 发送键都在抢），常驻的
 * 「≈32.5k / 128k」会把这一行撑到换行。环把「还剩多少」压进一颗图标的大小：
 * 抬眼一看填充比例就够了，精确数字悬停才报出来 —— 需要它的人自然会悬停。
 *
 * ## 三档口径与 ChatPanel 对齐
 * >70% 变 `--warning`、>90% 变 `--danger`，与视频问答面板底部那行用量文字
 * （`chat-ctx--warn` / `chat-ctx--bad`）用同一组阈值与同一组语义令牌 ——
 * 两处告警各说各话的话，用户会以为其中一个在骗人。tooltip 给出精确估值与压缩状态。
 *
 * 按下立即筛选旧上下文；图标使用 transitions.dev 的 Icon swap / Success check，
 * 与发送管线共享状态。忙碌时防重复点击，完成后环形用量按真实保留文本下降。
 */
export default function ContextUsageButton({ tokens, windowTokens, testId, compression, onCompress, isDisabled }: ContextUsageButtonProps) {
  const compressing = compression?.phase === 'compressing';
  const [showResult, setShowResult] = useState(false);
  useEffect(() => {
    setShowResult(compression?.phase === 'success');
    if (compression?.phase !== 'success') return;
    // 完成反馈停留时间，不是动画时长；动效仍由 transitions.dev CSS 令牌控制。
    const timer = setTimeout(() => setShowResult(false), 1800);
    return () => clearTimeout(timer);
  }, [compression?.phase, compression?.revision]);
  const ratio = windowTokens > 0 ? tokens / windowTokens : 0;
  const filled = Math.min(1, Math.max(0, ratio));
  const pct = Math.round(ratio * 100);
  const level = ratio > 0.9 ? 'bad' : ratio > 0.7 ? 'warn' : 'normal';
  // r=8 的周长；进度靠 dashoffset 倒着画，配 rotate(-90) 让弧从 12 点方向起笔。
  const circumference = 2 * Math.PI * 8;
  const offset = circumference * (1 - filled);
  const detail = `上下文用量 ≈${compact(tokens)} / ${compact(windowTokens)}（${pct}%）`;
  const message = compression?.message ?? '';
  const label = `${detail} · ${compressing ? '正在压缩上下文…' : message || '点击立即压缩上下文（保留聊天记录）'}`;
  const ring = (
    <svg className="ctx-usage__ring" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <circle className="ctx-usage__track" cx="10" cy="10" r="8" />
      <circle className="ctx-usage__fill" cx="10" cy="10" r="8"
        strokeDasharray={circumference.toFixed(2)} strokeDashoffset={offset.toFixed(2)} transform="rotate(-90 10 10)" />
    </svg>
  );

  return (
    <Tooltip>
      <Tooltip.Trigger>
        <Button
          isIconOnly
          variant="tertiary"
          size="sm"
          className="ctx-usage"
          data-level={level}
          data-testid={testId}
          aria-label={`${detail} · ${compressing ? '正在压缩上下文' : '立即压缩上下文'}`}
          aria-busy={compressing}
          data-compression={compressing ? 'compressing' : showResult ? 'success' : compression?.phase === 'error' ? 'error' : 'idle'}
          isDisabled={isDisabled || compressing || !onCompress}
          onPress={onCompress}
        >
          <IconSwap active={compressing || showResult ? 'b' : 'a'} a={ring} b={
            <IconSwap active={showResult ? 'b' : 'a'}
              a={<span className="ctx-usage__spinner"><Sym name="refresh" size={18} /></span>}
              b={showResult ? <SuccessCheck key={compression?.revision} size={18} color="currentColor" /> : <span />}
            />
          } />
        </Button>
      </Tooltip.Trigger>
      <Tooltip.Content>
        <p>{label}</p>
      </Tooltip.Content>
      <span className="sr-only" role="status" aria-live="polite">{message}</span>
    </Tooltip>
  );
}
