import type { ReactNode, RefObject } from 'react';
import { ProgressBar, Spinner } from '@heroui/react';
import './panel.css';

/**
 * 播放页面板的统一骨架原语（HeroUI 版）。
 *
 * 五个面板（字幕 / 讲义 / 问答 / 弹幕 / 卡片）共用同一套结构：
 * 「固定高度的工具条 + 固定高度的进度区 + flex:1 的滚动区」。
 *
 * 1. **高度链只有一份实现**：面板内容区一律 `.panel` = `height:100%` + `overflow:hidden`，
 *    内部滚动交给 `.panel-body`。
 * 2. **`.sub-item` 这个类名刻意保留**：`e2e-live-subs` / `e2e-danmaku` / `e2e-cards`
 *    都用 `[role="tabpanel"]:visible .sub-item` 作为「当前面板里的条目行」选择器。
 *    面板容器上也刻意补了 `role="tabpanel"`，让这三个脚本的行选择器在
 *    桌面 Tabs 面板与窄屏 `.panel-slot` 两种容器下都成立。
 */

export interface PanelProps {
  children: ReactNode;
  /** 追加类名 */
  className?: string;
  testId?: string;
}

/** 面板根：占满容器高度，滚动交给内部的 PanelBody */
export function Panel({ children, className, testId }: PanelProps) {
  return (
    <div className={className ? `panel ${className}` : 'panel'} data-testid={testId}>
      {children}
    </div>
  );
}

export interface PanelBarProps {
  children: ReactNode;
  /** 默认允许换行（工具条按钮多、面板又窄，不换行会溢出） */
  wrap?: boolean;
  testId?: string;
}

/** 面板顶部工具条（主操作 + 次级操作） */
export function PanelBar({ children, wrap = true, testId }: PanelBarProps) {
  return (
    <div className={wrap ? 'panel-bar panel-bar--wrap' : 'panel-bar'} data-testid={testId}>
      {children}
    </div>
  );
}

/** 工具条里的弹性空隙：把后面的内容推到右端 */
export function PanelSpacer() {
  return <div className="panel-bar__spacer" />;
}

export interface PanelProgressProps {
  /** 百分比（0–100）。**不传即不确定态**（HeroUI ProgressBar 不设 value 时就是循环动画） */
  percent?: number;
  /** 进度条下方的状态文字 */
  text?: ReactNode;
  testId?: string;
}

/** 面板内的任务进度（转写 / 生成讲义 / 生成卡片…） */
export function PanelProgress({ percent, text, testId }: PanelProgressProps) {
  return (
    <div className="panel-progress" data-testid={testId}>
      <ProgressBar
        value={percent}
        maxValue={100}
        aria-label={typeof percent === 'number' ? `进度 ${Math.round(percent)}%` : '进行中'}
        className="panel-progress__bar"
      />
      {text != null && <div className="panel-progress__text">{text}</div>}
    </div>
  );
}

export interface PanelBodyProps {
  children: ReactNode;
  /** 需要编程式滚动（如字幕自动滚到当前条）时传入 */
  bodyRef?: RefObject<HTMLDivElement | null>;
  className?: string;
  testId?: string;
}

/** 面板的滚动内容区：面板里唯一会滚的地方 */
export function PanelBody({ children, bodyRef, className, testId }: PanelBodyProps) {
  return (
    <div className={className ? `panel-body ${className}` : 'panel-body'} ref={bodyRef} data-testid={testId}>
      {children}
    </div>
  );
}

/** 面板内的空态/引导文案（比 EmptyState 轻，用于面板这种窄容器） */
export function PanelPlaceholder({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div className="panel-placeholder" data-testid={testId}>
      {children}
    </div>
  );
}

/** 面板内的居中加载态 */
export function PanelSpinner({ testId }: { testId?: string }) {
  return (
    <div className="panel-spinner" data-testid={testId}>
      <Spinner size="lg" color="accent" />
    </div>
  );
}

export interface CueRowProps {
  /** 左侧时间戳（已格式化） */
  time: string;
  /** 是否为播放进度所在的那一条（高亮 + 自动滚动） */
  active?: boolean;
  /** 点击跳转（字幕/卡片/弹幕都是这个交互） */
  onClick?: () => void;
  testId?: string;
  children: ReactNode;
  /**
   * 选区提问的定位信息（可选）。带上后这一行就支持划词提问 ——
   * 全局浮层（SelectionAsk）靠这几个 data 属性反查「选中的是哪一段、在什么位置」，
   * 不需要把回调一层层传上去。不带则行为与从前完全一致。
   */
  ask?: {
    /** 来源标识：subtitle / handout */
    source: string;
    /** 定位值（字幕是秒） */
    time?: number;
    /** 展示用位置描述（如 03:25） */
    label?: string;
  };
}

/**
 * 「时间 + 文本」的可点击条目：字幕行、弹幕行、卡片行共用。
 *
 * 高亮走 accent 浅底（原来是 antd 的 `#e6f4ff` 浅蓝），时间戳用主色。深浅色由令牌自己解决。
 */
export function CueRow({ time, active, onClick, testId, children, ask }: CueRowProps) {
  const cls = active ? 'sub-item sub-item--active' : 'sub-item';
  return (
    <div
      className={cls}
      data-testid={testId}
      data-askable={ask?.source}
      data-ask-time={ask?.time}
      data-ask-label={ask?.label}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
    >
      <span className="sub-item__time">{time}</span>
      <span className="sub-item__text">{children}</span>
    </div>
  );
}

/**
 * 面板条目行的**同形**骨架：字幕 / 弹幕 / 卡片共用。
 *
 * ⚠️ 刻意**不用** `.sub-item` 这个类名。它是 e2e-live-subs / e2e-danmaku / e2e-cards
 * 判断「列表出来了」的选择器（`[role="tabpanel"]:visible .sub-item`），骨架冒用类名
 * 会让它们在骨架阶段就误判（不变量 I8）。几何靠 panel.css 里把 `.sub-item` 与
 * `.skel-cue__row` **分组进同一组选择器**来保证同源 —— 改了真行，骨架跟着改，不会漂。
 *
 * 高度按真内容实测：`.sub-item` 是 `padding: 8px 10px` + `13px × 1.55`（单行 ≈ 36px），
 * 时间列是 `mm:ss`（≈ 34px 宽）。每三行给两行文本，模拟真字幕里的换行。
 */
export function CueSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="skel-cue" data-testid="cue-skeleton" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div className="skel-cue__row" key={i}>
          <span className="skel-cue__time">
            <span className="skel-bar skel-cue__bar--time" />
          </span>
          <span className="skel-cue__text">
            <span className="skel-bar skel-cue__bar--line" />
            {i % 3 === 0 && <span className="skel-bar skel-cue__bar--line skel-cue__bar--short" />}
          </span>
        </div>
      ))}
    </div>
  );
}
