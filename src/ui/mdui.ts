/**
 * mdui 的统一接入点（副作用模块）。
 *
 * 只在 `src/main.tsx` 里 `import './ui/mdui'` 一次即可，业务代码不要各自深链 node_modules：
 * - 自定义元素必须先注册再使用（import 即注册），散落各处极易漏注册、且难排查；
 * - `mdui.css` 与语言包必须在组件首次渲染前就位；
 * - 集中一处才能一眼看清体积来源（每个 import 只带一个自定义元素，Vite 各自成一个模块）。
 *
 * 这里注册的是**整个迁移最终会用到的组件清单**（设计文档 §2.5 的组件缺口盘点）。
 * 若后续实测首屏体积吃紧，再按阶段裁剪——但请不要删除本文件里的注册项而不跑构建，
 * 漏注册的组件在运行时会渲染成空标签且不报错（Web Components 的典型故障形态）。
 */

// ⚠️ 必须排在组件注册之前：语言包要先配置好，组件内部文案才会走中文
import './locale';

// 设计令牌 / 工具类 / 组件基样式（约 22KB）。
// 已核实它**没有全局元素 reset**：顶层规则只有 `:root` 变量、`.mdui-*` 工具类与 `mdui-*`
// 组件选择器，唯一外溢的是 `:root { color / background-color / color-scheme: light }`，
// 因而可以与尚未迁移的 antd 部分共存。
import 'mdui/mdui.css';

/* ------------------------------------------------------------------ *
 * 组件注册：布局与骨架
 * ------------------------------------------------------------------ */
import 'mdui/components/layout.js';
import 'mdui/components/layout-item.js';
import 'mdui/components/layout-main.js';
import 'mdui/components/top-app-bar.js';
import 'mdui/components/top-app-bar-title.js';
import 'mdui/components/bottom-app-bar.js';
import 'mdui/components/fab.js';

/* 导航 */
import 'mdui/components/navigation-bar.js';
import 'mdui/components/navigation-bar-item.js';
import 'mdui/components/navigation-rail.js';
import 'mdui/components/navigation-rail-item.js';
import 'mdui/components/navigation-drawer.js';
import 'mdui/components/tabs.js';
import 'mdui/components/tab.js';
import 'mdui/components/tab-panel.js';
import 'mdui/components/dropdown.js';
import 'mdui/components/menu.js';
import 'mdui/components/menu-item.js';

/* 容器与展示 */
import 'mdui/components/card.js';
import 'mdui/components/list.js';
import 'mdui/components/list-item.js';
import 'mdui/components/list-subheader.js';
import 'mdui/components/collapse.js';
import 'mdui/components/collapse-item.js';
import 'mdui/components/divider.js';
import 'mdui/components/chip.js';
import 'mdui/components/avatar.js';
import 'mdui/components/badge.js';
import 'mdui/components/icon.js';

/* 表单与操作 */
import 'mdui/components/button.js';
import 'mdui/components/button-icon.js';
import 'mdui/components/text-field.js';
import 'mdui/components/switch.js';
import 'mdui/components/checkbox.js';
import 'mdui/components/radio.js';
import 'mdui/components/radio-group.js';
import 'mdui/components/select.js';
import 'mdui/components/slider.js';
import 'mdui/components/range-slider.js';
import 'mdui/components/segmented-button.js';
import 'mdui/components/segmented-button-group.js';

/* 反馈 */
import 'mdui/components/dialog.js';
import 'mdui/components/snackbar.js';
import 'mdui/components/tooltip.js';
import 'mdui/components/linear-progress.js';
import 'mdui/components/circular-progress.js';

/* ------------------------------------------------------------------ *
 * 图标（Material Symbols）
 * 元素由 scripts/gen-material-symbols.mjs 从 @material-symbols/svg-400 生成，
 * 清单在 src/ui/symbols.ts（新增图标改那里，再按顺序重跑两个生成器）。
 * 为什么不用现成图标包：npm 上的 Web Components 图标包给的都是 **Material Icons**（MD2 时代那套，
 * 每个图标只有实心一种形态），而 MD3 要的是 **Material Symbols**（有描边/实心双态）。
 * 注意：**不要**用 <mdui-icon name="xxx">（那走 Material Icons 字体，本项目没装那个字体，会渲染成文字）。
 * ------------------------------------------------------------------ */
import './symbols.generated';

/* ------------------------------------------------------------------ *
 * 函数式 API 再导出
 * 业务侧一律 `import { snackbar } from './ui'`，不要直接写 'mdui/functions/xxx.js'：
 * 便于将来换实现，也让「哪些 mdui 能力在用」可被一次 grep 出来。
 * ------------------------------------------------------------------ */
export { getColorFromImage } from 'mdui/functions/getColorFromImage.js';
export { getLocale } from 'mdui/functions/getLocale.js';
export { getTheme } from 'mdui/functions/getTheme.js';
export { setColorScheme } from 'mdui/functions/setColorScheme.js';
export { removeColorScheme } from 'mdui/functions/removeColorScheme.js';
export { setLocale } from 'mdui/functions/setLocale.js';
export { setTheme } from 'mdui/functions/setTheme.js';
export { alert } from 'mdui/functions/alert.js';
export { confirm } from 'mdui/functions/confirm.js';
export { dialog } from 'mdui/functions/dialog.js';
export { prompt } from 'mdui/functions/prompt.js';
export { snackbar } from 'mdui/functions/snackbar.js';
export { breakpoint } from 'mdui/functions/breakpoint.js';
export { observeResize } from 'mdui/functions/observeResize.js';

/** 语言包是否已就绪（应用启动时 await 它，避免首帧闪一下英文） */
export { mduiLocaleReady } from './locale';
