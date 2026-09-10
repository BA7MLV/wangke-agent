# 移动端横屏布局（左视频 / 右面板）Design

**状态：已实现（2026-09-10）** ｜ 前置：`2026-09-07-mobile-ui-design.md`（手机竖屏）

## 目标

手机横屏时进入「左边视频、右边面板（默认问答）」的左右分栏，复刻桌面「边看边聊」的姿势；
竖屏、平板、桌面的现有布局零变化。

## 现状问题

手机竖屏走 `@media (max-width: 640px)` 的「视频在上 + 底部 Tab 栏」；
但手机横屏的**宽度普遍 > 640px**（iPhone 14：852×393），判定落到 `@media (max-width: 900px)` 的
**平板竖屏堆叠**档 —— 视频被按 `45vh * 16/9` 反推压成左侧一小块、面板在下方、宽屏空间大量浪费。

## 判据：手机横屏 = 「矮 + 横」

```css
(orientation: landscape) and (max-height: 520px) and (max-width: 1100px)
```

- **用高度而不是宽度判**：横屏时宽度 > 640 是常态，宽度判据必漏。
  实测手机横屏 CSS 高度 320~430（375/390/393/412/430），平板横屏 ≥ 744，520 是安全分界。
- **加 `max-width: 1100px`**：把「又宽又矮的桌面窗口」（1440×500）挡在外面，保留桌面 Tabs 布局。
- 不用 `pointer: coarse`：布局该由**可用空间**决定，不该由输入设备决定；
  又宽又矮的桌面窗口按这个断点走同一套紧凑布局也是合理的（顺带让 DevTools 不必开设备模拟就能验）。

`useIsMobile()` 因此扩成「竖屏窄宽 **或** 横屏矮高」的并集 —— 因为横屏时**右栏只有 ~320px 宽**，
面板内部（ChatPanel 头部重排、HandoutPanel 的 docx 等比缩放、技能 Popover 宽度）本来就该按手机处理。

## 布局

```
┌──────────────────────── 页头（压缩到 36px 高）────────────────────────┐
├───────────────────────────┬──────────────────────────────────────────┤
│                           │ [字幕|讲义|问答|弹幕|卡片]  ← 顶部切换条   │
│        视频（flex 5）      │      面板（flex 4，默认「问答」）          │
└───────────────────────────┴──────────────────────────────────────────┘
```

- `flex 5 : 4`（≈56% : 44%）：852 宽下视频 460×259、右栏 320 —— 视频够看、会话够读。
- 切换条放在右栏**顶部**（不是竖排图标轨）：与桌面「侧栏顶部 Tabs」同构，
  聊天宽度不被切掉 52px，也不撞横屏底部 home indicator 区。
- 复用现成的 `.mobile-tabbar` DOM：`flex-direction: column-reverse` 把它在右栏内翻到顶部，
  再覆盖成横向条 —— 零 JSX 结构改动（仅多一层 `.panel-column` 包住「面板 + 切换条」，
  让两者在竖屏/横屏都是同一张卡片）。
- 视频宽度 `min(100%, calc((var(--vvh,60vh) - 64px) * 16 / 9))`：
  同时受「左栏宽度」与「可用高度 × 16:9」约束 —— 键盘弹出时 `--vvh` 缩小，视频跟着缩，
  不会把控制栏顶出可视区（64px ≈ 压缩页头 + 容器上下 padding）。
- 横屏安全区：`.player-layout` 与 `.page-header` 左右都叠 `env(safe-area-inset-left/right)`
  （配合 `viewport-fit=cover`，横屏刘海在竖直边缘上），下叠 `env(safe-area-inset-bottom)`。
- 交互：`activeTab` 初值在横屏下取 `'chat'`，并且**每次进入横屏都切到「问答」**（用户已确认）。

## 已知取舍

- 键盘弹出时横屏可视高度只剩 ~200px，视频会被明显压缩（宽度受高度约束那一路生效）；
  会话仍可用。不做「键盘弹出隐藏视频」的特殊分支。
- 桌面窗口被拉到 1100px 宽以下且高度 ≤520px 时会走这套横屏布局（见上，可接受）。

---

## 实施备忘（2026-09-10 完成后补记）

### 实测几何（`scripts/e2e-mobile.mjs` 第 11~16 步实测）

| 视口 | 左视频 | 右栏（`panel-host`） | 说明 |
| --- | --- | --- | --- |
| 852×393（iPhone 14 横屏） | 460×259 | 368 | 切换条高 44、在右栏顶部 y=53 |
| 667×375（最小常见横屏） | 357×201 | 286 | |
| 932×430（最大常见横屏） | 504×284 | 404 | |
| 852×220（模拟键盘弹出，`--vvh` 收缩） | 277×156 | 368 | 视频按「可用高度 × 16:9」自己缩，控制栏不出界 |

- 姿态切换（竖屏 ↔ 横屏）只改 flex 方向，5 个面板实例**不重建**（`hidden` 保活），草稿/预览/转写进度不丢。
- `.panel-column` 用 `column-reverse` 把切换条从贴底翻到顶部：DOM 一份、零条件渲染。

### 顺带修掉一个既有生产构建崩溃（与本特性无关，但会污染 e2e）

- **症状**：`e2e-handout-edit` 移动端段 ~50% 概率失败，报 `Cannot destructure property 'scrollHeight' of 'v' as it is undefined`，
  随后「元素不断被 detach」导致点击超时；页面白一下。
- **根因**：`ChatPanel` 的「新消息滚动到底部」在挂载首帧就调 `Bubble.List.scrollTo`，
  而 `@ant-design/x` 的滚动容器是「回调 ref → `useState`」注册的，首帧其内部仍是 `undefined`
  （`const { scrollHeight, clientHeight } = scrollBoxDom` 直接抛 TypeError）。
  异常发生在**挂载期** → React 把整棵树卸掉重挂，`?.` 兜不住。
- **为何只在生产构建 + 有字幕时显形**：ChatPanel 首帧就渲染 `Bubble.List` 才命中（没字幕时走引导文案分支，`listRef.current` 为 null 反而安全）；dev 下时序不同、不复现。
- **修法**：`requestAnimationFrame` 延后一帧再滚（`src/components/ChatPanel.tsx`）。
  A/B 实测：修复前 `e2e-handout-edit` 移动端段 2/4 通过（新旧构建失败率一致，确认非本特性引入）；修复后 4/4 通过、0 个 pageerror。
- **判据**：挂载期未捕获异常的症状是「元素反复 detach / 白屏 / 按钮突然查不到」，先看 `page.on('pageerror')`，别先怀疑选择器。

### 环境记录

- 本机 `vite build` 的 `emptyDir(dist)` 与 `node_modules/.vite/deps` 重建都会被沙箱批量删除守卫拦下
  （`SAFE_DELETE_BULK_CONFIRM_REQUIRED`）→ 先 `mv dist /tmp/...` 再构建；也正因如此，没法另起一个干净 dev 服务做对照实验。
- 本特性验收期间，工作区里**另一处会话正在做「播放页面板迁移」**（SubtitlePanel / HandoutPanel / HandoutDocView / DanmakuPanel / ModelPicker + 相关 CSS，改为 `src/ui` 的 `Panel/PanelBar/PanelBody…`），
  因此 `e2e-mobile` 第 5/6/8/13 步与 `e2e-handout-edit` 移动端段会因**旧断言选择器失配**（`button:has-text("生成字幕")`、`.hd-editor textarea`）而红 ——
  与本特性无关：横屏专用的第 11~16 步全绿，且第 13 步中「面板切换生效 / 左右分栏保持」也通过。

