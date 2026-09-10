# 宽屏 NavigationRail + 标题栏与内容列对齐设计

日期：2026-09-10
状态：**已落地**（`src/ui/layout.tsx` / `layout.css` / 三页 + `useAppNav`；实测截图见「六」）

## 背景与目标

两个问题一起解决：

1. **宽屏没有侧边导航**。现状是「顶部应用栏 + 居中内容」，窄屏才有 `mdui-navigation-bar`；宽屏的「设置」入口是标题栏右上角一个齿轮图标。`layout.css:86` 的注释里当时就写了「宽屏应当换成 NavigationRail」，这轮补上。
2. **首页标题栏显示很奇怪**。两个原因叠加：
   - **语义**：标题栏放的是**应用名**（「网课学习助手」），文案还长；MD3 里 TopAppBar 的 headline 是**当前页名**，应用级导航归 rail。
   - **几何**：内容列是**居中**的（`.page-inner--wide` 宽 892 + `margin: auto`），而标题固定在视口最左 8px —— 1000px 视口下标题在 x≈13、内容列左边界在 x≈70，两条竖线差了 57px，加上标题栏未滚动时背景与页面同色、没有下边线，看起来就是「飘在空白里的一行小字」。

目标：宽屏加 MD3 NavigationRail（含播放页），标题栏改当前页名，并把**标题栏的文字对齐到内容列左边界**。

## 一、实测结论：rail 放进 `mdui-layout` 的行为

探针 `scripts/probe-rail.mjs`（Playwright + 真实页面动态插入 DOM 后测量，1280×800）：

| 观察项 | 实测结果 |
| --- | --- |
| rail 作为 `mdui-layout` 的**直接子元素** | 助手给它写内联 `position:absolute; top:0; bottom:0; left:0`，宽 80px（`5rem`）、高撑满 |
| 紧接着的 `mdui-layout-item[placement=top]` | 内联 `left:80px`，即**自动避让 rail** |
| `mdui-layout-main` | 内联 `padding: 64px 0 0 80px`，left 偏移正确 |
| rail 自身 `:host{position:fixed}` | **不需要外部覆盖** —— 助手的内联 `absolute` 已经把它拉回文档流（与 top-app-bar 的情况不同，那个必须自己改 `relative`） |
| rail `style.display='none'`（模拟窄屏） | `offsetWidth=0` → main 的 `padding-left` 归零，观测到 `padding: 64px 0 0 0` |
| `mdui-navigation-rail-item` 的 ARIA | **一个都没有**（`role` / `aria-checked` 均为 null），和 `mdui-tabs` 一样要手动补 |
| 图标插槽 `::slotted([slot=icon])` | `font-size: inherit` —— 和 `mdui-navigation-bar-item` 同一个坑，得自己补 `1.5rem` |

推论（都写进了代码注释）：

- **rail 必须是 `mdui-layout` 的直接子元素**。包进 `mdui-layout-item` 会走 `isParentLayout=false` 那条分支 —— 它会给 `document.body` 补 padding，而 layout-item 量到的高度是 0。
- **DOM 顺序必须在 `mdui-layout-item` 之前**：助手是按 DOM 顺序累加 top/left 偏移的，rail 放前面，后面的标题栏与主区的 `left` 才从 80px 起算。
- 显示/隐藏仍用 **CSS 媒体查询**（不用 JS 判断视口）：`display:none` 时助手量到 0，内边距自动归零，切窗口不用重挂载。

## 二、断点与信息架构

| 断点 | 导航 |
| --- | --- |
| ≤640px（手机竖屏） | 底部 `mdui-navigation-bar`（首页 / 设置）；播放页这条位置让给**面板切换** |
| >640px 且高度 >520px | 左侧 `mdui-navigation-rail`（首页 / 设置），带 `divider` |
| 手机横屏（`orientation:landscape` + 高 ≤520 + 宽 ≤1100） | 两者都不显示，仍走标题栏按钮 —— 判据与 `useIsPhoneLandscape` 一致：横屏宽度普遍 >640，用宽度判会把 rail 放进只有 300~500px 高的视口 |

播放页的 rail 选中项是 **`home`**（播放页是课程库的下级页面），返回按钮仍在标题栏左上角。

标题栏右上角的「设置」齿轮**宽屏不再显示**（rail 里已有，重复入口），窄屏本来就被 `.app-bar__action-mobile-hidden` 隐藏。

## 三、PageShell 的 API

```ts
export interface NavItem { value; label; icon; activeIcon?; onClick; testId? }
export interface NavConfig { items: NavItem[]; value: string }

// PageShellProps 新增
rail?: NavConfig;      // 宽屏左侧（窄屏 CSS 隐藏）
bottomNav?: NavConfig; // 窄屏底部（宽屏 CSS 隐藏，播放页借它做面板切换）
```

两者互斥显示、共用同一份 `NavItem` 结构；「首页 / 设置」这两个条目的定义收在 `src/components/appNav.tsx` 的 `useAppNav(active)` 里，三页共用，避免同一条导航在两个 DOM 里各写一遍。

testId 契约（e2e 用）：

| 位置 | testId |
| --- | --- |
| rail 容器 | `nav-rail` |
| rail 项 | `nav-rail-home` / `nav-rail-settings` |
| 底部导航容器 / 项 | `bottom-nav` / `nav-bottom-home` / `nav-bottom-settings`（不变） |
| 面板切换（播放页） | `panel-tab-*`（不变） |

## 四、标题栏对齐内容列

在 `.page` 上按模式给一个变量：

```css
.page-shell--wide   { --page-content-max: 892px; }
.page-shell--narrow { --page-content-max: 672px; }
/* fill（播放页）不设 → 落到 var() 的默认值 100% */
```

标题栏则补左侧内边距使标题落在内容列左边界上：

```css
.app-bar { padding-left: max(16px, calc((100% - var(--page-content-max, 100%)) / 2 + 16px)); }
```

- 宽度够时（`W > 内容列`）：标题落在 `(W - 892)/2 + 16`，与 `.page-inner` 的文字左边界**完全同一条竖线**（实测 1280×800：标题 x=251 = 内容列 x=251）；
- 宽度不够时：`max()` 回落到 16px，也就是原来 `:host` 的 8 + 8（**这条 padding-left 会覆盖** `mdui-top-app-bar` 自带的 `.5rem` 左内边距，标题 x = 标题栏左缘 + 该值，实测窄屏 x=16）；
- 有 rail 时标题栏的可用宽度已经是 `W - 81`（与主区一致），公式不用改；
- `fill`（播放页）默认 100% → 恒为 16px，返回按钮照旧贴左；
- 横屏那档（`orientation: landscape`）原本写死的 `padding-left: env(safe-area-inset-left)` 改成与公式取 `max()`：刘海避让与内容对齐谁大听谁的。

**实测揪出的一个潜伏 bug**：`.page-inner` 一直是 `content-box`（项目**并没有**全局 `box-sizing: border-box` 规则，旧注释是想当然），`max-width: 892` 实际是内容盒宽、总宽 924，居中偏移与标题栏公式整整差了 16px。已给 `.page-inner` 显式补 `box-sizing: border-box`（这也让 672/892 回到设计意图的内容宽 640/860）。

## 五、改动清单

| 文件 | 改动 |
| --- | --- |
| `src/ui/layout.tsx` | `NavItem` / `NavConfig` 类型；`rail` prop 与渲染；`.page-shell--*` 类名 |
| `src/ui/layout.css` | `.nav-rail` 断点与图标字号；`.app-bar` 对齐公式；`.page-mdui{position:relative}`（给 rail 的 `absolute` 兜一个定位祖先）；`.page-shell--*` 变量 |
| `src/components/appNav.tsx` | 新增：`useAppNav(active)` |
| `src/pages/Library.tsx` | 标题「网课学习助手」→「课程库」；接 rail；去掉宽屏齿轮 |
| `src/pages/Settings.tsx` | 接 rail（`value=settings`） |
| `src/pages/Player.tsx` | 接 rail（`value=home`）；底部导航仍是面板切换 |
| `scripts/*.mjs` | `e2e-player-enhance.mjs` 的 `nav-settings` → `nav-rail-settings` |

## 六、实测验收（Playwright + 生产构建，2026-09-11 全绿）

- `scripts/probe-rail.mjs`：rail 在 mdui-layout 下的布局数值（见「一」）；
- `scripts/probe-rail-pages.mjs`（默认打 4173）：四个视口断言全部通过 ——
  - 1280×800 首页：rail 可见、`main.paddingLeft=81px`、**标题 x=251 = 内容列 x=251**、标题栏无重复的设置入口；
  - 390×844 首页：rail 隐藏、底部导航可见，标题回落 x=16；
  - 1280×800 播放页：rail 常驻且「课程库」`active`，视频区左缘 x=93（rail 右侧）；
  - 844×390（手机横屏）：rail 与底部导航都不显示；
- 既有回归：`e2e-mobile` / `e2e-player-enhance` / `e2e-material-you` / `e2e-settings-skills` / `e2e-storage-card` / `motion-smoke` 全绿（`e2e-material-you` 的底部导航图标断言改成按 `mdui-sym-*` 前缀匹配，不再写死图标名）。截图：`e2e-shots/rail-*.png`。
