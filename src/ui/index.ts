/**
 * UI 适配层的统一入口。
 *
 * 业务代码只从这里取 hook 与封装好的反馈 API：
 * ```ts
 * import { toast, confirmDialog, useMduiEvent, useMduiProperty } from '../ui';
 * ```
 *
 * 副作用模块 `./mdui`（样式 + 组件注册 + 语言包）由 `src/main.tsx` 单独引入，不在这里 re-export，
 * 避免 tree-shaking 之外的隐式依赖——想让 mdui 组件可用，就应该显式 import 那一次。
 */
export { useMduiEvent, type MduiElementOf, type MduiEventHandler } from './useMduiEvent';
export { useMduiProperty } from './useMduiProperty';
export { applyTheme, useResolvedDark, useDynamicColor, systemPrefersDark } from './theme';
export { toast, confirmDialog, alertDialog, type ConfirmOptions } from './feedback';
export {
  PageShell,
  SectionCard,
  Field,
  EmptyState,
  Banner,
  type PageShellProps,
  type SectionCardProps,
  type FieldProps,
  type EmptyStateProps,
  type BannerProps,
  type NavItem,
  type NavConfig,
} from './layout';
export {
  Panel,
  PanelBar,
  PanelSpacer,
  PanelProgress,
  PanelBody,
  PanelPlaceholder,
  PanelSpinner,
  CueRow,
  type PanelProps,
  type PanelBarProps,
  type PanelProgressProps,
  type PanelBodyProps,
  type CueRowProps,
} from './panel';
export { snackbar, confirm, alert, prompt, dialog, setTheme, getTheme, setColorScheme, getColorFromImage, mduiLocaleReady } from './mdui';
