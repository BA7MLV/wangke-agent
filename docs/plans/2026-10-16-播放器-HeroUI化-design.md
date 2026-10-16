# 播放器 HeroUI 化（换皮 + 自研按钮换组件）

## 背景与目标

播放页的控制栏是 **Vidstack 默认主题 + `player-enhance.css` 覆盖层**，走的是 YouTube 那套
直角黑底控制栏；而应用其余部分是 **HeroUI v3（语义令牌 + 药丸按钮 + 动态主色）**。
两者气质不统一：紧挨着的「讨论区」是圆角 MD3 卡片，播放器却是硬边黑矩形；顶栏的
倍速档位是自绘文本按钮，与应用里的 `Button` / `ToggleButtonGroup` 不是一套东西。

本次只优化样式，**不做库迁移**（Vidstack 已进入 security-only 维护，继任者 Video.js 10
是另一笔工作，见 README 的播放与媒体一节）。

**目标**：控制栏在观感与交互规格上向 HeroUI 对齐，且尽量复用 HeroUI 组件本身。

## 范围

- 改：`src/player-enhance.css`、`src/components/RateButtons.tsx`、
  `src/components/DanmakuToggleButton.tsx`、`src/components/CaptionSizeButton.tsx`、
  `src/components/TheaterModeButton.tsx`、`src/components/PlayerBigPlayButton.tsx`。
- 不动：弹幕层（`DanmakuLayer`）、涟漪反馈（`SeekFeedback`）、字幕机制
  （`Player.tsx` 的增量字幕轨）、Vidstack 的布局 / 键盘 / 手势 / 无障碍、**视频画面直角**。

## 关键做法：复用 HeroUI 的「颜色契约」，只换色

HeroUI 的 `Button` / `ToggleButton` 把**全部颜色收敛到自身的自定义属性**：

- `.button`：`--button-bg` / `--button-bg-hover` / `--button-bg-pressed` / `--button-fg`
- `.toggle-button`：再加 `--toggle-button-bg-selected` / `-selected-hover` / `-selected-pressed` /
  `-fg-selected`

形状（`rounded-3xl` 药丸）、尺寸（`h-10 md:h-9`）、按下 `scale(0.97)`、焦点环、缓动
（`--ease-smooth` / `--ease-out`）全部由 HeroUI 提供。因此**只在播放器作用域覆盖这几个变量**
为「压在视频上的半透明白」，就能白拿 HeroUI 的外观与交互，而不与它的浅色表面色打架。

选 / 开启态用动态主色 `--accent` 填充，与 HeroUI `primary` 一致（`--accent` 在本项目随封面动态取色）。

## 组件替换

| 位置 | 现在 | 换成 |
| --- | --- | --- |
| 顶栏倍速档位 | 自绘文本按钮横排 | `ToggleButtonGroup`（`selectionMode="single"`）+ `ToggleButton`，活动档 `--accent` 填充 |
| 窄屏倍速 | 自绘循环按钮 | `Button`（循环到下一档） |
| 弹幕开关 | `<button class="vds-button">弹</button>` | `Button` + `Tooltip`，开启态 `--accent` |
| 字幕字号 | `<button class="vds-button"><Sym/></button>` | `Button isIconOnly` + `Tooltip` |
| 影院模式 | `<button class="vds-button">` | `Button isIconOnly` + `Tooltip` |
| 中央大播放键 | 自绘 68px 圆键 | `Button isIconOnly size="lg"`（圆），保留定位类与图标 |
| 所有 tooltip | vidstack `DefaultTooltip` | HeroUI `Tooltip` |

Vidstack 内置控件（播放 / 音量 / 时间 / 设置 / PiP / 全屏）**无法换成 HeroUI 组件**
（它们是默认布局的一部分，换掉等于重写布局），只调令牌：按钮尺寸、hover 底色、
图标占比、时间字号；进度条填充已用 `--accent`，保留。

## 形状与焦点

- 视频画面保持**直角**（`--video-border-radius: 0`），不在四角露出底色；只有控件 HeroUI 化。
- 悬停预览卡圆角 → `--radius-lg`；时间胶囊 → `--radius-sm`。
- 键盘焦点环：**`--focus`（= `--accent`）内环 + 半透明白外描边**——主色环压在浅色画面上
  可能不够显眼，白描边兜底对比度。

## 已知风险

HeroUI 的 `Tooltip` 经 RAC 会 **portal 到播放器之外**。控制栏是「鼠标离开播放器就隐藏」，
若 tooltip 内容可交互，鼠标移到浮层会触发播放器 `mouseleave`，控制栏消失。
本次只用到**非交互的 Tooltip**（`pointer-events` 不接管指针），预期不受影响；
实现后必须用浏览器实测「悬停顶栏按钮时控制栏不消失」，不通过则回退 vidstack tooltip。

## 验证（已执行）

方式：`vite build` 出产物 → `vite preview` → Chrome（Playwright，`serviceWorkers: 'block'`）导入
本地测试视频 → 播放页截图 + 断言。截图在 `e2e-shots/heroplayer-*.png`（该目录被 gitignore）。

**通过**

- 顶栏三组控制统一为 32px（`size="sm"`）：倍速药丸 39×32、弹幕 38×32、字号 32×32；影院
  （底栏）36×36；大播放键 56px 圆。
- 倍速 `ToggleButtonGroup` 5 档、当前档 `data-selected`、点击 4x/2x 真的改 `video.playbackRate`。
- `Tooltip` 正常弹出（「关闭思考题弹幕」），**悬停时控制栏不消失** —— 前面担心的 portal
  风险没有发生（Tooltip 内容不接管指针，鼠标并未离开播放器）。
- 键盘焦点环：`outline: 2px solid <accent>` + `box-shadow: 0 0 0 4px rgba(255,255,255,.55)`，
  `:focus-visible` 命中。
- 窄屏（`data-sm`）：档位组折叠为循环按钮，点击可切档。
- 播放后大播放键消失。

**验证中发现并修掉的两处**

1. HeroUI 的 `Tooltip.Trigger` 固定是 `role=button + tabindex=0`。桌面端「循环按钮」被 CSS
   藏了按钮本体，包装层却仍在 Tab 链里 —— 成为一个看不见的停靠点。改为连包装层一起藏
   （`.vds-video-layout:not([data-sm]) .tooltip__trigger:has(.player-rate-cycle)`）。影院按钮同理。
2. 档位组有 `overflow-x: auto`（会滚动），而 `overflow-x` 非 visible 时另一轴也会按 `auto`
   算出并裁剪 —— 焦点环画在药丸之外，被裁掉了。给组加 `padding: 6px; margin: -6px` 留出
   绘制空间，布局不变。

**与本次改动无关、但同样会红的既有问题**（已用 `git stash` 只暂存本站改动做对照确认）

- `e2e-player-enhance.mjs` 步骤 4/5（双击 ±10s 涟漪）：**不含本站改动时同样失败**
  （`currentTime 0 → 0`，无 `.seek-pulse-right`），属既有问题。
- 步骤 8：设置页已迁成弹窗（`SettingsModal`），脚本仍在找 `nav-rail-settings` 与 `mdui-chip`，
  是迁移期的历史遗留。
- 已顺手修正脚本里与本站改名相关的选择器、入口路由（应用现在默认落在问答页，
  需 `#/library`）、以及视口宽度（1280 下播放器面板仅 606px，会被判成 `data-sm` 而折叠档位组）。

**给后续验证的坑**：应用是 PWA，Service Worker 会 precache 上一轮构建的资源，导致断言读到旧样式。
验证脚本必须设 `serviceWorkers: 'block'`（`e2e-player-enhance.mjs` 已加）。
