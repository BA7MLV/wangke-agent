import type { ReactNode } from 'react';
import './layout.css';

/**
 * MD3 页面骨架与表单布局原语。
 *
 * 为什么自己写这一层：antd 的 `Card` / `Form.Item` 在这个项目里**只承担布局职责**
 * （`.page` 里没有任何 rules/校验配置，唯一的错误态是 Settings 手写的 keyError）。
 * 换成 mdui 后不存在等价组件，与其硬凑，不如把这几行布局收成三个原语，让各页面写法一致。
 *
 * 结构（与设计文档 §3.1 的 MD3 骨架一致；宽屏侧边导航见 2026-09-10-navigation-rail-design.md）：
 *   .page（沿用既有 CSS，负责 --vvh 高度链）
 *     └ mdui-layout（mdui 官方布局：自己测量 mdui-layout-item 并给 mdui-layout-main 补间距）
 *         ├ mdui-navigation-rail（宽屏左侧，CSS 控制显隐；必须排在标题栏之前）
 *         ├ mdui-layout-item[placement=top] → mdui-top-app-bar
 *         ├ mdui-layout-item[placement=bottom] → mdui-navigation-bar（窄屏）
 *         └ mdui-layout-main → .page-inner → 各 SectionCard
 *
 * 注：本文件会从外部样式表改 mdui 组件的宿主属性（如 .section-card 的 display）。
 * 已实测**文档树的规则优先于 shadow DOM 里的 `:host` 规则**，包括同属性覆盖，因此这是安全做法。
 * 详见 src/ui/layout.css 顶部注释。
 */

export interface NavItem {
  /** 与 `NavConfig.value` 比对来决定哪一项高亮 */
  value: string;
  label: string;
  /** 未激活时的图标元素（放 mdui-sym-*） */
  icon: ReactNode;
  /** 激活时的图标元素，可选 */
  activeIcon?: ReactNode;
  onClick: () => void;
  testId?: string;
}

/** 旧名保留：底部导航与 rail 共用同一份条目结构 */
export type BottomNavItem = NavItem;

export interface NavConfig {
  items: NavItem[];
  value: string;
}

export interface PageShellProps {
  /** TopAppBar 标题 */
  title: string;
  /** 传了就显示返回按钮（左上角，回调里自己 navigate） */
  onBack?: () => void;
  /** TopAppBar 右侧操作区（放 mdui-button-icon / mdui-button） */
  actions?: ReactNode;
  /** 内容区收窄并居中（表单页用，原 Settings 的 maxWidth: 640） */
  narrow?: boolean;
  /** 内容区放宽并居中（列表页用，原 Library 的 maxWidth: 860）；与 narrow 互斥 */
  wide?: boolean;
  /**
   * 内容区**不滚动也不加内边距**，由页面自己接管整块空间（播放页用）。
   * 默认的 `.page-inner` 是「有内边距、随内容增高、由 mdui-layout-main 滚动」，
   * 而播放页要的是「整块铺满 + 内部面板各自滚动」，两者必须二选一。
   */
  fill?: boolean;
  /**
   * 挂到根 `.page` 上的 **callback ref**。
   * 播放页用它接 Material You 的动态取色（配色要作用在整页上）。
   * 传 callback ref 而不是 RefObject，是因为根节点可能晚于数据出现（见 ui/theme.ts 的 useDynamicColor）。
   */
  rootRef?: (el: HTMLDivElement | null) => void;
  /** 追加到根 `.page` 上的类名（页面级的样式挂载点） */
  rootClassName?: string;
  /**
   * 宽屏左侧导航轨（MD3 NavigationRail）。窄屏由 CSS 隐藏，此时导航走 `bottomNav`。
   * ⚠️ 必须直接放在 mdui-layout 下、且排在标题栏之前 —— 实测见
   * docs/plans/2026-09-10-navigation-rail-design.md「一」。
   */
  rail?: NavConfig;
  /** 窄屏底部导航（MD3 应用外壳）。宽屏由 CSS 隐藏，mdui 的布局助手会随之把内容区的 padding 归零。 */
  bottomNav?: NavConfig;
  children: ReactNode;
}

export function PageShell({
  title,
  onBack,
  actions,
  narrow,
  wide,
  fill,
  rootRef,
  rootClassName,
  rail,
  bottomNav,
  children,
}: PageShellProps) {
  const innerClass = [
    'page-inner',
    narrow ? 'page-inner--narrow' : wide ? 'page-inner--wide' : '',
    fill ? 'page-inner--fill' : '',
  ]
    .filter(Boolean)
    .join(' ');
  // 标题栏按这个变量对齐内容列左边界（见 layout.css 的 .app-bar 与 .page-shell--*）
  const shellClass = narrow ? 'page-shell--narrow' : wide ? 'page-shell--wide' : 'page-shell--fill';
  return (
    <div
      className={rootClassName ? `page page-mdui ${shellClass} ${rootClassName}` : `page page-mdui ${shellClass}`}
      ref={rootRef}
    >
      <mdui-layout>
        {rail && (
          /* rail 必须是 mdui-layout 的直接子元素且排在标题栏之前：
             布局助手按 DOM 顺序累加偏移，rail 的 80px 宽度会写进标题栏 item 的 left
             与 main 的 padding-left；display:none 时量到 0，偏移自动归零（实测）。 */
          <mdui-navigation-rail className="nav-rail" value={rail.value} divider data-testid="nav-rail">
            {rail.items.map((it) => (
              <mdui-navigation-rail-item
                key={it.value}
                value={it.value}
                data-testid={it.testId}
                onClick={it.onClick}
              >
                <span slot="icon">{it.icon}</span>
                {it.activeIcon && <span slot="active-icon">{it.activeIcon}</span>}
                {it.label}
              </mdui-navigation-rail-item>
            ))}
          </mdui-navigation-rail>
        )}
        <mdui-layout-item placement="top">
          <mdui-top-app-bar className="app-bar" data-testid="top-app-bar">
            {onBack && (
              <mdui-button-icon data-testid="nav-back" aria-label="返回" onClick={onBack}>
                <mdui-sym-arrow-back />
              </mdui-button-icon>
            )}
            <mdui-top-app-bar-title>{title}</mdui-top-app-bar-title>
            <div className="app-bar__spacer" />
            {actions}
          </mdui-top-app-bar>
        </mdui-layout-item>
        {bottomNav && (
          <mdui-layout-item placement="bottom" className="bottom-nav">
            <mdui-navigation-bar value={bottomNav.value} data-testid="bottom-nav">
              {bottomNav.items.map((it) => (
                <mdui-navigation-bar-item
                  key={it.value}
                  value={it.value}
                  data-testid={it.testId}
                  onClick={it.onClick}
                >
                  {/* 图标走 icon / active-icon **插槽**而不是 `icon` 属性：
                      属性值是 Material Icons 字体里的字形名，本项目没装那个字体。
                      也不需要自己传 `active`：mdui-navigation-bar 会按自己的 value 给各项打标记
                      （而且官方 JSX 类型里没有 `active`，硬传反而编译不过）。 */}
                  <span slot="icon">{it.icon}</span>
                  {it.activeIcon && <span slot="active-icon">{it.activeIcon}</span>}
                  {it.label}
                </mdui-navigation-bar-item>
              ))}
            </mdui-navigation-bar>
          </mdui-layout-item>
        )}
        <mdui-layout-main className={fill ? 'page-main page-main--fill' : 'page-main'}>
          <div className={innerClass}>{children}</div>
        </mdui-layout-main>
      </mdui-layout>
    </div>
  );
}

export interface SectionCardProps {
  /** 卡片标题 */
  title: string;
  /** 标题右侧操作区（原 antd Card 的 extra） */
  actions?: ReactNode;
  /** 标题下方的说明段落 */
  subtitle?: ReactNode;
  /** 给 e2e 用的稳定选择器 */
  testId?: string;
  children: ReactNode;
}

/** 页面的一个内容分区（替 antd Card 的 title + extra）。
 *  变体用 elevated：卡片是 surface-container-low，比页面背景略深 + 有阴影，
 *  而卡内的 mdui-text-field（filled 变体）是 surface-container-highest —— 三层色阶拉开，
 *  输入框的填充区才能从卡片上认出来。若卡片也用 filled，会与输入框同色、填充区彻底看不见（实测）。 */
export function SectionCard({ title, actions, subtitle, testId, children }: SectionCardProps) {
  return (
    <mdui-card variant="elevated" className="section-card" data-testid={testId}>
      <div className="section-card__head">
        <div className="section-card__title">{title}</div>
        {actions && <div className="section-card__actions">{actions}</div>}
      </div>
      {subtitle && <div className="section-card__subtitle">{subtitle}</div>}
      <div className="section-card__body">{children}</div>
    </mdui-card>
  );
}

export interface FieldProps {
  /** 控件上方的标签 */
  label: ReactNode;
  /** 控件下方的说明（替 antd Form.Item 的 extra） */
  hint?: ReactNode;
  /** 追加类名（错误态等） */
  className?: string;
  /** 给 e2e 用的稳定选择器 */
  testId?: string;
  children: ReactNode;
}

/** 一个表单行：标签 + 控件 + 说明（替 antd Form.Item 的纵向布局） */
export function Field({ label, hint, className, testId, children }: FieldProps) {
  return (
    <div className={className ? `field ${className}` : 'field'} data-testid={testId}>
      <div className="field__label">{label}</div>
      {children}
      {hint && <div className="field__hint">{hint}</div>}
    </div>
  );
}

export interface EmptyStateProps {
  /** 顶部大图标（放 mdui-icon-* 元素） */
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  /** 主操作按钮 */
  action?: ReactNode;
  testId?: string;
}

/** 空状态（替 antd Empty）。mdui 没有 Empty 组件，MD3 规范里也只是一个居中图标 + 文案 + 可选主操作 */
export function EmptyState({ icon, title, description, action, testId }: EmptyStateProps) {
  return (
    <div className="empty-state" data-testid={testId}>
      {icon && <div className="empty-state__icon">{icon}</div>}
      <div className="empty-state__title">{title}</div>
      {description && <div className="empty-state__desc">{description}</div>}
      {action && <div className="empty-state__action">{action}</div>}
    </div>
  );
}

export interface HelpTipProps {
  /** 气泡标题（rich 变体才有的第一行） */
  headline: string;
  /** 气泡正文，可多段（用 <p>） */
  children: ReactNode;
  /** 触发按钮的无障碍标签，默认「说明」 */
  label?: string;
  /** 给 e2e 用的稳定选择器（挂在触发按钮上） */
  testId?: string;
}

/**
 * 问号图标 + 点击展开的富文本气泡 —— 长说明的收纳处。
 *
 * 手机上把补充说明整段铺开会把版面吃掉好几行（甚至像投放区那样被挤成竖排），
 * 所以约定：**当场要决策的留正文，解释性的收进这里**。
 *
 * 两个已实测的坑，改这个组件前先看：
 * 1. `trigger` 是触发**方式**（click / hover / focus），不是选择器；默认是 hover focus，
 *    手机上悬浮不存在，所以这里必须显式写 click。
 * 2. `placement` 不能交给 auto，正文也**必须给确定宽度**（见 layout.css 的 .help-tip__body）。
 *    mdui 在算位置之前先量气泡的 offsetWidth，那一刻气泡还停在触发元素的静态位置上，
 *    可用宽度只有「视口 − 触发元素左边距」；问号通常落在偏右的位置，手机上只剩一百来像素，
 *    正文会被压成一条竖条。
 */
export function HelpTip({ headline, children, label = '说明', testId }: HelpTipProps) {
  return (
    <mdui-tooltip variant="rich" trigger="click" placement="bottom-end" className="help-tip">
      <mdui-button-icon data-testid={testId} aria-label={label} onClick={(e) => e.stopPropagation()}>
        <mdui-sym-help />
      </mdui-button-icon>
      <div slot="headline">{headline}</div>
      <div slot="content" className="help-tip__body">
        {children}
      </div>
    </mdui-tooltip>
  );
}

export interface BannerProps {
  /** 语义：info 用主色，warning / error 用对应的会话色 */
  variant?: 'info' | 'warning' | 'error';
  /** 左侧图标（放 mdui-icon-* 元素） */
  icon?: ReactNode;
  title: ReactNode;
  /** 标题右侧的问号（放 <HelpTip>）；解释性文案收在这里，正文只留结论 */
  help?: ReactNode;
  description?: ReactNode;
  /** 右下角操作区 */
  action?: ReactNode;
  testId?: string;
}

/**
 * 页面内提示条（替 antd Alert 的 message + description + showIcon）。
 *
 * 为什么不用 snackbar：这个提示需要**常驻**（PWA 存储可能被清理的提醒），
 * 而 mdui 的 snackbar 是短暂的浮层，还会和别的提示抢队列。
 */
export function Banner({ variant = 'info', icon, title, help, description, action, testId }: BannerProps) {
  return (
    <div className={`banner banner--${variant}`} data-testid={testId} role="note">
      {icon && <div className="banner__icon">{icon}</div>}
      <div className="banner__main">
        <div className="banner__title">
          <span className="banner__title-text">{title}</span>
          {help}
        </div>
        {description && <div className="banner__desc">{description}</div>}
      </div>
      {action && <div className="banner__action">{action}</div>}
    </div>
  );
}
