/**
 * UI 适配层的统一入口。
 *
 * 业务代码只从这里取 hook 与封装好的反馈 API：
 * ```ts
 * import { toast, confirmDialog, PageShell, Sym } from '../ui';
 * ```
 *
 * HeroUI 组件本身从 `@heroui/react` 直接引入（`import { Button, Card } from '@heroui/react'`），
 * 不在这里转发 —— 适配层只保留「本项目自己的原语与反馈语义」。
 */
export { applyTheme, useResolvedDark, useDynamicColor, systemPrefersDark } from './theme';
export {
  toast,
  confirmDialog,
  alertDialog,
  promptDialog,
  FeedbackHost,
  type ConfirmOptions,
  type PromptOptions,
} from './feedback';
export {
  PageShell,
  SectionCard,
  Field,
  EmptyState,
  Banner,
  HelpTip,
  AppBarSearch,
  type PageShellProps,
  type SectionCardProps,
  type FieldProps,
  type EmptyStateProps,
  type BannerProps,
  type HelpTipProps,
  type AppBarSearchProps,
  type NavItem,
  type NavConfig,
  type RecentItem,
  type RecentAction,
} from './layout';
export { useRailCollapsed } from './rail';
export {
  Panel,
  PanelBar,
  PanelSpacer,
  PanelProgress,
  PanelBody,
  PanelPlaceholder,
  PanelSpinner,
  CueRow,
  CueSkeleton,
  type PanelProps,
  type PanelBarProps,
  type PanelProgressProps,
  type PanelBodyProps,
  type CueRowProps,
} from './panel';
export { Sym, type SymProps } from './icons';
export { SYMBOL_NAMES, type SymbolName } from './icons';
export { LoadingButton, type LoadingButtonProps } from './loading-button';
export {
  SkeletonReveal,
  useSkeletonGate,
  SKELETON_DELAY_MS,
  SKELETON_MIN_VISIBLE_MS,
  type SkeletonGateOptions,
  type SkeletonRevealProps,
} from './skeleton';
export { MODAL_CONTAINER_CLASS } from './modalContainer';
