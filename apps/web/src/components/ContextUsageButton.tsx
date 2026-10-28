import { useEffect, useState } from 'react';
import { Button, Popover } from '@heroui/react';
import { IconSwap, MatrixDots, SuccessCheck } from './motion';
import { Sym } from '../ui';
import type { CompressionState } from '../store/contextCompression';
import './context-usage.css';

export interface ContextUsageButtonProps {
  /** 本轮输入的 token 估算量（系统提示词 + 历史 + 草稿） */
  tokens: number;
  /** 上下文窗口（输入 + 输出的总容量），取设置里的 `contextWindow` */
  windowTokens: number;
  breakdown?: { system: number; history: number; current: number };
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
 * 抬眼一看填充比例就够了，点击后再查看具体估值与用量构成。
 *
 * ## 三档口径与 ChatPanel 对齐
 * >70% 变 `--warning`、>90% 变 `--danger`，与视频问答面板底部那行用量文字
 * （`chat-ctx--warn` / `chat-ctx--bad`）用同一组阈值与同一组语义令牌 ——
 * 两处告警各说各话的话，用户会以为其中一个在骗人。详情给出估值与压缩状态。
 *
 * 按下先查看详细用量，再在详情中主动压缩；忙碌时仍可查看，只有压缩动作禁用。
 */
export default function ContextUsageButton({ tokens, windowTokens, breakdown, testId, compression, onCompress, isDisabled }: ContextUsageButtonProps) {
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
  const ring = (
    <svg className="ctx-usage__ring" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <circle className="ctx-usage__track" cx="10" cy="10" r="8" />
      <circle className="ctx-usage__fill" cx="10" cy="10" r="8"
        strokeDasharray={circumference.toFixed(2)} strokeDashoffset={offset.toFixed(2)} transform="rotate(-90 10 10)" />
    </svg>
  );

  return (
    <Popover>
        <Button
          isIconOnly
          variant="tertiary"
          size="sm"
          className="ctx-usage"
          data-level={level}
          data-testid={testId}
          aria-label={`${detail} · 查看上下文详情`}
          aria-busy={compressing}
          data-compression={compressing ? 'compressing' : showResult ? 'success' : compression?.phase === 'error' ? 'error' : 'idle'}
        >
          <IconSwap active={compressing || showResult ? 'b' : 'a'} a={ring} b={
            <IconSwap active={showResult ? 'b' : 'a'}
               a={<MatrixDots className="ctx-usage__spinner" />}
              b={showResult ? <SuccessCheck key={compression?.revision} size={18} color="currentColor" /> : <span />}
            />
          } />
        </Button>
      <Popover.Content placement="top end" className="ctx-usage-details">
        <Popover.Dialog className="flex flex-col gap-3 p-4">
          <Popover.Heading>上下文详情</Popover.Heading>
          <dl className="ctx-usage-details__data">
            <div><dt>已用（估算）</dt><dd>≈{Math.round(tokens).toLocaleString()} tokens · {pct}%</dd></div>
            <div><dt>上下文窗口</dt><dd>{Math.round(windowTokens).toLocaleString()} tokens</dd></div>
            <div><dt>剩余容量</dt><dd>≈{Math.max(0, Math.round(windowTokens - tokens)).toLocaleString()} tokens</dd></div>
            {breakdown && <>
              <div><dt>系统提示词</dt><dd>≈{Math.round(breakdown.system).toLocaleString()}</dd></div>
              <div><dt>历史消息</dt><dd>≈{Math.round(breakdown.history).toLocaleString()}</dd></div>
              <div><dt>当前输入 / 附件</dt><dd>≈{Math.round(breakdown.current).toLocaleString()}</dd></div>
            </>}
          </dl>
          <p className="text-xs text-muted">用量为估算值，剩余容量还需容纳模型回复。压缩仅筛选旧上下文，完整聊天记录会保留。</p>
          {message && <p className="text-xs" role="status" data-error={compression?.phase === 'error'}>{message}</p>}
          <Button size="sm" variant="secondary" isDisabled={isDisabled || compressing || !onCompress}
            onPress={onCompress} data-testid={testId ? `${testId}-compress` : undefined}>
            {compressing ? '正在压缩…' : '压缩上下文'}
          </Button>
          {isDisabled && !compressing && <p className="text-xs text-muted">当前暂不可压缩，请在会话就绪且回复结束后重试。</p>}
        </Popover.Dialog>
      </Popover.Content>
      <span className="sr-only" role="status" aria-live="polite">{message}</span>
    </Popover>
  );
}
