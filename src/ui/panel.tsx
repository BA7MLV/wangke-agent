import type { ReactNode, RefObject } from 'react';
import './panel.css';

/**
 * 播放页面板的统一骨架原语（阶段 3）。
 *
 * 五个面板（字幕 / 讲义 / 问答 / 弹幕 / 卡片）在被 antd 实现时各自手写了一遍同样的结构：
 * 「固定高度的工具条 + 固定高度的进度区 + flex:1 的滚动区」，还有一批写死颜色的内联样式
 * （`#888` / `#999` / `#1677ff` / `#e6f4ff`…）。收成原语之后：
 *
 * 1. **高度链只有一份实现**：面板内容区一律 `.panel` = `height:100%` + `overflow:hidden`，
 *    内部滚动交给 `.panel-body`。antd 时代侧栏要靠 `.ant-tabs-content{height:100%}` 那一串
 *    覆盖才能接通，现在不需要了。
 * 2. **颜色只走 MD3 令牌**：深色模式因此自动成立（阶段 2 的令牌化只覆盖了外壳，
 *    面板里的内联色值是这次一起清的）。
 * 3. **`.sub-item` 这个类名刻意保留**：`e2e-live-subs` / `e2e-danmaku` / `e2e-cards`
 *    都用 `[role="tabpanel"]:visible .sub-item` 作为「当前面板里的条目行」选择器。
 *    它与 antd 无关、是应用自己的类名，改名只会给最关键的回归测试添乱。
 *    （面板容器上也刻意补了 `role="tabpanel"`，让这三个脚本的行选择器在
 *     桌面 `mdui-tab-panel` 与窄屏 `.panel-slot` 两种容器下都成立。）
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
  /** 百分比（0–100）。**不传即 MD3 的不确定态**（mdui-linear-progress 未设 value 时就是不定的） */
  percent?: number;
  /** 进度条下方的状态文字 */
  text?: ReactNode;
  testId?: string;
}

/** 面板内的任务进度（转写 / 生成讲义 / 生成卡片…） */
export function PanelProgress({ percent, text, testId }: PanelProgressProps) {
  return (
    <div className="panel-progress" data-testid={testId}>
      <mdui-linear-progress max={100} value={percent} />
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
      <mdui-circular-progress />
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
}

/**
 * 「时间 + 文本」的可点击条目：字幕行、弹幕行、卡片行共用。
 *
 * 高亮走 MD3 的 `primary-container` 语义色（原来是 antd 的 `#e6f4ff` 浅蓝），
 * 时间戳用 `primary`。深浅色由令牌自己解决。
 */
export function CueRow({ time, active, onClick, testId, children }: CueRowProps) {
  const cls = active ? 'sub-item sub-item--active' : 'sub-item';
  return (
    <div
      className={cls}
      data-testid={testId}
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
