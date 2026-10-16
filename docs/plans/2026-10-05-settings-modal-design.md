# 设置改成弹层：中枢列表 + 分区弹层

日期：2026-10-05
状态：方案（**未落地**，本文只定方案不改代码）

## 问题

`src/pages/Settings.tsx` 1315 行，11 个分区（外加一行页脚构建信息）全部铺在一条长滚动里：

| # | 分区 | testId | 大致体量 |
|---|---|---|---|
| 1 | 模型供应商 | `card-api` | 每家一个 `ProviderCard`，还有「检查模型可用性」「刷新能力数据」两个动作 |
| 2 | 模型配置 | `card-models` | 三个槽位各一行 |
| 3 | 模型收藏夹 | `card-favorites` | 三页签 + 搜索 + 按供应商 sticky 分组 |
| 4 | 外观 | `card-appearance` | 2 行 |
| 5 | 阅读材料 | `card-material` | 1 行 |
| 6 | 哔哩哔哩导入 | `card-bilibili` | 最长的一块：桥安装、代理地址、Cookie 读取、备用出口折叠 |
| 7 | 播放 | `card-rates` | 自定义倍速 |
| 8 | 学习时长 | `card-study-time` | （已是独立组件） |
| 9 | 存储占用 | `card-storage` | （已是独立组件） |
| 10 | 数据迁移 | `card-migration` | （已是独立组件） |
| 11 | 写作技能 | `card-skills` | （已是独立组件，自带一个二级 `mdui-dialog`） |

痛点不是「长」本身，而是**长且平**：

- 一次只想改主题或倍速，却要滚过模型供应商的每一家 Key 才能到底；
- `.page-settings .field` 的行式网格（`src/ui/layout.css:510` 起，左标题 / 右控件）是为
  「一条设置一行」设计的，但在 640px 内容列里 11 张卡片串成一条，视觉上只有一条线，
  分区与分区之间没有任何视觉分组感；
- 11 个分区里 4 个已经是独立组件（`SkillsCard` / `StorageCard` / `StudyTimeCard` /
  `MigrationCard`），另 7 个还焊在 `Settings.tsx` 的单个组件函数里 —— 1315 行里
  有 440 行是纯 state 与回调，真正的问题不是行数，是**没有「打开哪一块」的入口**。

## 业界怎么做

看了四类实现，收敛到同一条：**设置项按「分组列表 → 详情」两层走，详情可以是独立页面、
可以是二级弹层，取决于详情本身有多重**。

| 实现 | 中枢 | 详情 |
|---|---|---|
| macOS System Settings | 左栏固定分组（侧栏） | 右栏整页，常带二级页（⌘→ 前进/后退） |
| Windows 11 设置 | 左栏分组导航 | 右栏整页，点进去仍是右栏内的下一个层级 |
| Android / Material You Settings | 「建议」+ 分类列表 | 点一项 → **独立页面**（full-screen），返回走顶栏箭头 |
| VS Code 设置 | 一页 + 顶部搜索框 | 点分组 → **同页内联展开**（不是二级界面） |
| Chrome 设置 | 一页 + 搜索框 | 点一项 → **同页锚点滚动 + 高亮** |

规律：**中枢永远是「列表」，详情才决定是弹层还是整页**。而「详情要不要再分层」看详情里
有没有嵌套表单 —— 有（二级弹窗、要确认的破坏性操作）就该用弹层的弹层，没有就用内联。

对本项目最贴的是 **Android Settings**：中枢是一张可滚的分类列表，点某项进一个
full-screen 页、顶栏带返回箭头。理由和它们一样 —— 设置是**低频、按需**的操作，
用户带着一个明确目标（「把倍速改成 1.25」）进来，不该在 11 张卡片里找。

MD3 也有对应的组件：`mdui-dialog` 的 `fullscreen` 变体就是 MD3 的 **Full-screen dialog**，
正是「Android 设置点一项」的那个形态。项目里已经注册（`src/ui/mdui.ts:75`）且有 4 处
用法（`SkillsCard` / `MigrationCard` / `SkillPicker` / `HandoutPanel`），不引入新依赖。

### 备选与为什么不选

- **A：整页包进一个 fullscreen 弹层**（还是 11 张卡一条长滚动）。改动最小，但没解决
  「按需打开某一块」，长滚动照旧。
- **C：只给「快捷设置」加弹层**，长表单仍留页面。会在「哪些算快捷」上撕扯，
  而且设置页仍是主入口，弹层变成第二套心智模型。

## 实测结论（Playwright + dev server，探针已删除）

改造前先把 `mdui-dialog` 的真实行为测了一遍，免得方案建在猜测上：

| 测项 | 结论 |
|---|---|
| 弹层打开时背景能不能透滚 | **不能**。`<html>` 拿到 `mdui-lock-screen`，遮罩区滚轮后 `mdui-layout-main.scrollTop` 恒为 0；对照关闭时同位置可滚到 1500 |
| `fullscreen` 几何 | 正确。面板 `max-width` 560px→100%、高 100%，宿主 padding 48px→0；`.body` 自己 `overflow:auto` |
| `slot="header"` 的 top-app-bar | 项目 `.app-bar` 是 `position:relative`，留在文档流里，不遮挡正文（实测 `coveredPx: 0`）；`--page-content-max` 未定义时 `padding-left` 公式退化成 16px，**不需要额外覆盖** |
| 面板宽度能否改 | 能，`::part(panel)` 正当可用；项目已有先例 `src/components/mermaid/mermaid.css:246`（92vw / 1400px） |
| **嵌套弹层**（分区弹层里再开技能编辑框） | **可用**。两层同为 `z-index:2300`，靠 DOM 顺序决定谁盖谁；内层输入框能真正聚焦并键入（`elementFromPoint` 命中 `mdui-text-field`，`page.keyboard.type` 值正确落进 `.value`） |
| 嵌套时外层还能点吗 | **不能**，且这是对的。内层宿主是 `position:fixed; inset:0`，点外层按钮的位置 `elementFromPoint` 返回 `mdui-dialog/inner` —— 内层是真正的模态 |
| 点内层遮罩 | 只派发 `overlay-click`，**不自动关闭**（`closeOnOverlayClick` 默认 `false`） |
| 关掉外层后 `<html>` 还锁着吗 | 会锁 —— 因为内层仍开着。`lockScreen`/`unlockScreen` 是按元素做的 `Set`（`@mdui/shared/helpers/scroll.js`），逐个配对，行为正确 |

从源码补三条**必须照办**的约束（`node_modules/mdui/components/dialog/index.js`）：

1. **`closed` 事件要把 `open` 同步回 React state**。mdui 是自改宿主的 `open` 属性，
   React state 不知道；不接回来的话下一次任意 re-render 会把 `open={true}` 重新写上去，
   弹层「关掉又自己弹回」。项目里四处用法都这么做（`SkillsCard.tsx:23` 等），
   新弹层必须照此办理，事件名要经 `useMduiEvent`（React 19 不做驼峰转换）。
2. **Esc 的层级**。每个 dialog 在 `firstUpdated` 里给自己挂 `keydown`，仅当
   `closeOnEsc` 为真才 `stopPropagation()`。嵌套时要**两层都开 `close-on-esc`** ——
   否则内层（技能编辑框）按 Esc 会把外层分区弹层一起关掉，草稿全丢。
3. **不要在打开状态下卸载 dialog**。`disconnectedCallback` 只补了 `unlockScreen(this)`，
   **没有** `modalHelper.deactivate()`：`activeModals` 里会永远留着那个元素，
   `document` 上的 `focusin` / `keydown` / `keyup` 三个监听也不会摘，于是此后每次按键
   都会多跑一次 `requestAnimationFrame(checkFocus)`。所以中枢必须**常驻挂载**、
   只切 `open`（见下）。

## 方案

### 路由与打开方式

保留 `/#/settings` 这个地址，但页面组件不再渲染 `PageShell`，而是：

- `App.tsx` 里把 `SettingsHub` 挂在 `<Routes>` **外面**、`HashRouter` **里面**
  （要在 Router 内是因为要 `useLocation`；要在 Routes 外是因为上一条 —— 路由切走时
  不能卸载正在打开的 dialog）。
- `Hub` 的 `open = location.pathname === '/settings'`。路由就是唯一的真相来源。
- `/settings` 这条路由本身保留，`element={null}`：留着是为了不触发 react-router
  的「无匹配路由」告警，页面内容全部由中枢弹层提供。
- `src/components/appNav.tsx` **一个字都不用改** —— 它现在是
  `onClick: () => navigate('/settings')`，正好把中枢弹层打开。
- 关闭（点遮罩 / Esc / 返回箭头）→ `navigate(lastNonSettings)`。`lastNonSettings` 是
  模块级变量，由中枢在每次 `location.pathname !== '/settings'` 时记一笔，
  初值 `/`：深链直接进 `/#/settings` 时关掉回课程库，而不是 `navigate(-1)`
  （后者在深链场景会把用户踢出应用）。
- `useAppNav('settings')` 连同 `PageShell` 一起消失。中枢盖住了导航栏，
  「设置」这个 nav 项永远不会处于选中态 —— 这是对的，弹层不是一级页面。

### 中枢弹层

- **宽屏**：`mdui-dialog` 不加 `fullscreen`。mdui 默认面板 `max-width: 35rem`（560px），
  正好是列表的合适宽度，**不需要改 `::part(panel)`**；面板 `max-height:100%` + `.body`
  自己滚，在矮窗口里自动变成可滚列表。
- **手机**（`useIsMobile()`）：加 `fullscreen`，占满屏，和 Android 设置的分类页一致。
- 结构：`headline="设置"` + 正文 `mdui-list`，四个分组标题，每行
  `图标 + 标题 + 一行摘要 + chevron_right`。
- 底部常驻那行构建信息（`build-info`）—— 它描述的是「这个设置弹层属于哪个构建」，
  放中枢底部比塞进某个分区更贴切，也让 `e2e-build-info.mjs` 的几何断言还能成立。

分组与顺序（组内保持现状顺序；`testId` 一律不动，所以 e2e 不感知重排）：

| 组 | 分区 |
|---|---|
| 模型 | 模型供应商 · 模型配置 · 模型收藏夹 |
| 内容与外观 | 外观 · 阅读材料 · 写作技能 |
| 导入与播放 | 哔哩哔哩导入 · 播放 · 学习时长 |
| 数据 | 存储占用 · 数据迁移 |

分组意味着「写作技能」从第 11 位挪到第 3 组 —— 这是有意的取舍：它属于内容创作，
和外观/材料是同一类心智；原先排最后只是因为它后加的。

需要一个搜索框吗？11 项、标题唯一、分组清晰，第一版**不做**。真要加就是
`mdui-text-field` 一行 + 过滤 `SECTIONS`，但那是给分区数涨到 20 以后准备的。

### 分区弹层

- 宽屏：`::part(panel)` 改成 `width/min-width/max-width: min(720px, 92vw)` +
  `height: min(760px, 88vh)`。**注意必须同写 `max-width`**：mdui 的
  `.panel{max-width:35rem}` 会压住只写 `width` 的值（实测内层面板就是被这条卡在 280px）。
- 手机：加 `fullscreen`，顶栏带返回箭头。
- 顶栏用真的 `mdui-top-app-bar slot="header"`（`className="app-bar"`）：返回箭头 +
  分区名 + 关闭。**配套要 `::part(panel){padding:0}` + `::part(body){padding:16px}`**
  —— 因为 `::slotted(mdui-top-app-bar[slot=header])` 是 `position:absolute`，
  不清掉面板的 24px padding，标题栏会变成「浮在面板里、四周露白」的一块。
  mdui 自己在检测到 top-app-bar 时会把 `.body` 的 `margin-top` 写成 0 且把
  `scrollTarget` 指向 `.body`，这两件事不用管。
- 关闭走**返回箭头**回中枢（保留分区里的草稿，因为分区组件只在打开时挂载），
  分区弹层**不开** `close-on-overlay-click`：误触遮罩丢掉半屏表单是纯亏，
  而且非 fullscreen 时遮罩可用区域只有 48px 宽，本来也不该指望它。
- 中枢**开** `close-on-overlay-click` + `close-on-esc`（用户预期「点外面就关」），
  两层都开，所以内层（技能编辑框）按 Esc 只会关自己。

### `Settings.tsx` 的拆分边界

路由组件 `Settings.tsx` 缩到只剩 `<SettingsHub />`（约 40 行，含中枢的路由/开关逻辑）。
新增 `src/components/settings/`：

| 文件 | 内容 | 从哪来 |
|---|---|---|
| `SettingsHub.tsx` | 中枢弹层：分组列表、`openSection` state、关闭回退 | 新写 |
| `sections.tsx` | 分区登记表：`id` / `title` / `icon` / `summary` / `group`（含 JSX 图标，所以是 `.tsx`） | 新写 |
| `useModelCheck.ts` | 「检查模型可用性」的全部逻辑（`checking` / `modelOptions` / `checkResult` / `providerNotes` / `handleCheck`）+ 刷新 models.dev | 从 `Settings.tsx:466-473, 548-552, 658-717` 抽出 |
| `ProvidersSection.tsx` | 分区 1，含 `ProviderCard` | `Settings.tsx:295-453` + `:909-967` |
| `ModelsSection.tsx` | 分区 2，含 `SlotField` / `ModelField` | `:75-179` / `:225-294` + `:969-1043` |
| `FavoritesSection.tsx` | 分区 3，含 `FavRow` | `:180-224` + `:1045-1062` |
| `AppearanceSection.tsx` | 分区 4 | `:1064-1094` |
| `MaterialSection.tsx` | 分区 5 | `:1096-1113` |
| `BilibiliSection.tsx` | 分区 6（最重的一块，独立出来收益最大） | `:1115-1251` |
| `PlaybackSection.tsx` | 分区 7，含 `RateChip` | `:454-462` + `:1253-1292` |
| `useBilibili.ts` | B 站登录态探测 / 读本机 Cookie / 备用出口展开态（`bridgeTick` / `cookieReading` / `cookieNote` / `cookieNoteLevel` / `advOverride` / `biliLogin`） | `:482-495, 500-544, 554-576` |
| `settings.css` | `.settings-hub-*` / `.settings-section-dialog` 的 `::part` | 新写 |

**留在原地的 4 个卡片组件**（`StudyTimeCard` / `StorageCard` / `MigrationCard` /
`SkillsCard`）：它们本来就是自洽的一整块，各自带 `data-testid="card-*"`，
分区弹层里直接渲染即可，**不改一行**。`SkillsCard` 自带的技能编辑 `mdui-dialog`
就是本文实测过的嵌套弹层场景 —— 这条链路已有 e2e（`e2e-settings-skills.mjs`）守着。

**唯一跨分区的耦合**：`useModelCheck()` 产出的 `modelOptions` 被「收藏夹」消费，
`checkResult` 被「模型配置」消费，而按钮在「模型供应商」上 —— 一次检查喂三个分区。
所以它的**实例建在中枢**，结果对象当一个 prop 传给这三个分区（单层传参，不引 context）。
拆开各拉一次 `/models` 是最直观的错法：请求翻三倍，且三处候选可能不一致。

`settings.css` 需要从 `layout.css` 接管的样式：

```css
/* 分区弹层：面板清零 padding 让顶栏贴边，正文自己给内边距。
   mdui 的 .panel 默认 padding:1.5rem，而 ::slotted(mdui-top-app-bar[slot=header])
   是 position:absolute（相对面板的 padding box 定位）—— 不清零的话标题栏会变成
   「浮在面板里、四周露白 24px」的一块。 */
.settings-section-dialog::part(panel) {
  padding: 0;
  width: min(720px, 92vw);
  max-width: min(720px, 92vw);   /* ⚠️ 必须同写：默认 max-width:35rem 会压住 width */
  height: min(760px, 88vh);
}
.settings-section-dialog::part(body) { padding: 16px; }

/* 中枢列表：行高给到 56px 以上（iOS/MD3 的可点区域下限），摘要单行省略 */
.settings-hub-item { min-height: 56px; }
.settings-hub-item__summary {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

**`.page-settings` 这个类要跟着搬家**：它之前挂在 `PageShell` 的 `rootClassName` 上
（`Settings.tsx:905`），而 `layout.css:510` 的行式网格是 `.page-settings .field`
后代选择器 —— 弹层正文是 light DOM 插槽，后代选择器照常生效，所以把这个类原样挂到
`<div className="page-settings">`（包住分区内容）即可，`.field` 那些规则一行不用改。
`.settings-section-body` 只需要负责「首张卡别顶着顶栏」：
`.section-card` 只有 `margin-bottom`，所以给正文加 `padding-top: 16px` 就够了。

`.page-inner--narrow`（672px 内容列）随之不再参与 —— 内容列宽度由面板的 720px 决定。
`.page-inner` 依赖显式 `border-box` 这条注释只对 `PageShell` 仍然成立，迁移时别把
`.page-inner` 的样式顺手抄过来。

图标：11 个分区需要 6 个新 Material Symbols —— `dns`（模型供应商）/ `tune`（模型配置）/
`bookmark`（收藏夹）/ `style`（外观）/ `article`（阅读材料）/ `login`（哔哩哔哩导入）/
`speed`（播放）/ `schedule`（学习时长）/ `database`（存储占用）/
`swap_horiz`（数据迁移）/ `extension`（写作技能）。后 5 个现有清单里已经有了，
只缺前 6 个 —— 已核对 `node_modules/@material-symbols/svg-400/outlined/` 下 6 个 svg 都在。

按 `src/ui/symbols.ts` 头部注释里的既定流程：先改该文件，再依次跑
`node scripts/gen-material-symbols.mjs` 与 `node scripts/gen-mdui-types.mjs`，顺序不能反。

## 改动清单

| 文件 | 改什么 |
|---|---|
| `src/App.tsx` | 中枢挂到 `Routes` 外、`HashRouter` 内；`/settings` 路由改为 `element={null}` |
| `src/pages/Settings.tsx` | 缩成 `<SettingsHub />`，1315 行拆进 `components/settings/*` |
| `src/components/appNav.tsx` | **不改**（`navigate('/settings')` 已经是对的） |
| `src/ui/layout.css` | `.page-settings` 相关的注释改成「设置分区正文」，`.field` 选择器不变 |
| `src/components/settings/settings.css` | 新增：中枢列表样式 + 分区弹层 `::part` |
| `README.md` | 见下 |

`/#/settings` 这个地址本身照留（深链仍然有效），要改的只是「设置**页**」这个说法。

- **必须改的措辞**（`grep -n "设置页" README.md` 现在 15 处命中）：
  第 117 行「打开『设置』页（`/#/settings`）」→ 改成「点导航栏的『设置』；
  深链 `/#/settings` 也行」；第 124 行「其余设置项都在同一页」→ 改成
  「其余设置项在中枢列表里各自成一块，点进去单独调」。
  其余 13 处（第 32、208、321、334、346、347、349、437、461、482、510、518、730 行）
  是「设置页可一键关掉」「设置页底部」这类行文，改法统一成
  「设置里…（哪个分区）」—— 因为「页面底部」这个方位词已经不成立了，
  构建信息那行现在在中枢列表底部。
- **第 573 行**的目录树 `pages/ … Settings(设置)`：`Settings.tsx` 不再是页面，
  改成 `components/settings/`（中枢 + 11 个分区）。
- **第 696 行**的脚本清单描述：`# 设置页写作技能列表 + 新建对话框`
  → `# 设置中枢 → 写作技能分区 + 新建对话框（第三层嵌套）`。

## 测试影响

`# /settings` 这条地址不变是这次方案最大的收益：**12 处 `goto` 一处都不用删**。
但 12 处全部要多一个「点进分区」的步骤，所以要加一个共享 helper（目前
`scripts/` 下没有共享工具模块，这是第一个，但 9 个脚本各抄一遍更糟）：

```js
// scripts/e2e-settings-nav.mjs（新增）—— base 由调用方传入，与各脚本现有的 BASE 保持一致
/** 打开设置中枢并进入某个分区。返回后分区弹层已开完、等内容渲染好。 */
export async function openSettingsSection(page, base, section) {
  await page.goto(`${base}/#/settings`, { waitUntil: 'networkidle' });
  await page.locator(`[data-testid="hub-item-${section}"]`).click();
  await page.locator(`[data-testid="section-${section}"]`).waitFor({ state: 'visible' });
}
```

`hub-item-<id>` / `section-<id>` 两个 `data-testid` 是**新增**的稳定钩子，
而 11 个分区各自原有的 `card-*` 全部保留 —— 现有断言写在卡片内部，切到分区后照样命中，
一行选择器都不用改。

| 脚本 | 现状 | 要改什么 |
|---|---|---|
| `e2e-providers.mjs` | 5 处 `goto`，依赖 `card-api` / `btn-check-models` / `provider-note-*` | 每处换成 `openSettingsSection(page, 'providers')`；跨分区行为（检查 → 收藏夹）要连着点两个分区，state 由中枢那个 `useModelCheck` 实例持有 —— **这正好是「检查结果在切分区后还在」的新覆盖** |
| `e2e-settings-skills.mjs` | `card-skills` + 新建对话框 | 换成 `openSettingsSection(page, 'skills')`；额外断言**技能编辑框叠在分区弹层之上**且按 Esc 只关自己 |
| `e2e-skills-dedupe.mjs` | `card-skills [data-testid=skill-row]` | 同上 |
| `e2e-storage-card.mjs` | `card-storage` | `openSettingsSection(page, 'storage')` |
| `e2e-study.mjs` | 第 237 行 `card-study-time` | `openSettingsSection(page, 'study-time')` |
| `e2e-bili-cookie.mjs` | 第 179 行 | `openSettingsSection(page, 'bilibili')` |
| `motion-smoke.mjs` | 第 13 行等 `[data-testid=api-key]` | `openSettingsSection(page, 'providers')` |
| `e2e-build-info.mjs` | 断言「footer 在 `card-skills` 下方」 | 改成「footer 在中枢最后一行（`hub-item-migration`）下方」—— 几何断言的写法与理由（顺序对了但被盖住同样是不合格）不变 |
| `probe-app-shell-material.mjs` | 第 14 行把 `/settings` 当普通路由遍历，四主题 × 三视口逐个断言 | **改动最重的一个**。settings 不再是页面，4 处要重写：① 第 14 行路由表摘掉 settings，另加一条「中枢列表 11 项齐全 + 点第 1 项能进分区」；② 第 74 行 `mdui-top-app-bar > mdui-top-app-bar-title > h1` 数量 === 1 对 settings 不再成立（分区弹层里确实有顶栏，但那个 h1 只在分区打开时存在）；③ 第 78 行 `aria-current === 'page'` 对 settings 不再成立 —— `useAppNav('settings')` 整个消失，`/settings` 时选中的是底层那一页的 nav 项；④ 第 79 行 `.section-card h2` 数量 > 0 换成中枢列表项数 |
| `probe-rail-pages.mjs` | 第 65 行断言宽屏标题栏没有 `nav-settings` 齿轮 | **不受影响**（rail 结构没动） |

新增一条针对本方案本身的 e2e（并入 `e2e-settings-skills.mjs` 或新起
`e2e-settings-modal.mjs`）：中枢开合、中枢 Esc、分区返回、分区 Esc、
两层都开时内层 Esc 只关内层、关闭后 `<html>` 不残留 `mdui-lock-screen`、
`document.querySelectorAll('mdui-dialog')` 里没有开着却被卸载的僵尸。

## 已知风险

- **焦点回收**。mdui 在关闭时把焦点还给 `originalTrigger`（打开时 `document.activeElement`）。
  枢纽弹层的 trigger 是导航栏按钮，被 `mdui-lock-screen` 挡住但仍在 DOM 里，能拿到焦点；
  分区弹层的 trigger 是中枢那一行，同样在 DOM 里。**但**中枢是被路由驱动的，
  路由切走时底层页面会重渲染，理论上存在焦点落到 `<body>` 的窗口。落地点：
  中枢 `closed` 里 `navigate()` 之后不用额外管，`skip-link` 与导航栏按钮都在，
  真实焦点结果需要用探针确认，不能假设。
- **滚动位置丢失**。原来滚到第 9 个分区再关页，位置本来也会丢（路由切走），
  所以这不是回退；但**在分区里滚到一半按返回**会丢草稿（分区组件卸载）。
  接受这个取舍：分区都是「改完即存」的短表单，没有长文本编辑
  （唯一例外是技能正文，但那在第三层弹层里，它自己的 state 独立于分区）。
- **`fullscreen` 不能动画切换**。手机横竖屏切换会让面板几何硬跳。可接受。
- **iPad 桌面档**。iPad Pro 竖屏 1024×1366 走宽屏分支，弹层 720px 居中，
  两侧留白比现在的整页窄列明显更多。这是弹层形态的固有代价，
  用 `.body` 的 16px 内边距和卡片阴影缓解，不额外做全屏分支。