import { Button, Tooltip } from '@heroui/react';
import './context-usage.css';

export interface ContextUsageButtonProps {
  /** 本轮输入的 token 估算量（系统提示词 + 历史 + 草稿） */
  tokens: number;
  /** 上下文窗口（输入 + 输出的总容量），取设置里的 `contextWindow` */
  windowTokens: number;
  testId?: string;
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
 * 两处告警各说各话的话，用户会以为其中一个在骗人。>90% 时 tooltip 补一句
 * 「建议开启新话题」，把「该怎么办」也一并给到。
 *
 * ## 它是只读的
 * 环只**展示**进度，按下去不该发生任何事 —— 所以这里刻意不挂 `onPress`。
 * 用 Button 而不是裸 `<span>` 是顺着 HeroUI 的 Tooltip：它的 Trigger 固定渲染
 * 一层 `role="button"` 的包装元素，孩子换成可按键的 Button 才与该包装的语义相符
 * （裸元素会与包装的 role 打架，也会漏出「无法聚焦」的边框）。删除会话已经不在
 * 这一行，所以工具行里再没有破坏性动作，这颗只读控件放在最右端也不会被误触。
 */
export default function ContextUsageButton({ tokens, windowTokens, testId }: ContextUsageButtonProps) {
  const ratio = windowTokens > 0 ? tokens / windowTokens : 0;
  const filled = Math.min(1, Math.max(0, ratio));
  const pct = Math.round(ratio * 100);
  const level = ratio > 0.9 ? 'bad' : ratio > 0.7 ? 'warn' : 'normal';
  // r=8 的周长；进度靠 dashoffset 倒着画，配 rotate(-90) 让弧从 12 点方向起笔。
  const circumference = 2 * Math.PI * 8;
  const offset = circumference * (1 - filled);
  const detail = `上下文用量 ≈${compact(tokens)} / ${compact(windowTokens)}（${pct}%）`;
  const label = level === 'bad' ? `${detail} · 建议开启新话题` : detail;

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
          aria-label={detail}
        >
          <svg className="ctx-usage__ring" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
            <circle className="ctx-usage__track" cx="10" cy="10" r="8" />
            <circle
              className="ctx-usage__fill"
              cx="10"
              cy="10"
              r="8"
              strokeDasharray={circumference.toFixed(2)}
              strokeDashoffset={offset.toFixed(2)}
              transform="rotate(-90 10 10)"
            />
          </svg>
        </Button>
      </Tooltip.Trigger>
      <Tooltip.Content>
        <p>{label}</p>
      </Tooltip.Content>
    </Tooltip>
  );
}
