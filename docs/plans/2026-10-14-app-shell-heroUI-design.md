# 应用外壳全面 HeroUI 化：侧栏常驻 + 去自写 CSS

- 状态：**已实现**（tsc 与构建通过；探针见 §5）
- 日期：2026-10-14
- 需求：外壳这一层还在用 `app-sidebar__*` / `app-bar__*` / `page-inner--*` 这一整套
  自写类名描述版式，改一处要同时改 `layout.tsx` 与 `layout.css`，两边的值还会漂移
  （断点 900px 就写在两个地方）。要求：**全部改用 HeroUI 组件，不要自写的 CSS**。
  同时删掉侧栏顶部的身份块（「AI 助手 / 随时可问 · 有课更好答」）与底部的
  「收起侧边栏」按钮。

---

## 0. 一句话方案

`PageShell` 的版式与配色全部改写成 HeroUI 组件 + Tailwind 工具类，配色只读
`@heroui/styles` 注册进 Tailwind `@theme` 的语义令牌；`layout.css` 删掉约 550 行
外壳规则（含 `.page-settings` 的 69 行死规则）。**侧栏改为常驻不可折叠** ——
折叠功能整个移除，不只是删那个按钮。

## 1. 改动清单

| 位置 | 改动 |
|---|---|
| `src/ui/layout.tsx` | 外壳（`.page` / `.app-shell` / 侧栏 / 顶栏 / 内容列 / skip-link / Drawer）全部改为 HeroUI 组件 + Tailwind 类；删除折叠状态、localStorage 记录、身份块；Drawer 改条件渲染（窄屏才挂载） |
| `src/ui/layout.css` | 删除第 1–548 行（外壳）、第 624–692 行（`.page-settings` 死规则）、横屏 `.app-bar` 与 reduced-motion 里的 `.app-sidebar__*`；新增文件头说明本文件现在只装什么 |
| `src/theme.css` | 删除 `.page` 规则（高度链已并入 Tailwind 类），保留 `--vvh` 的说明 |
| `src/components/SettingsModal.tsx` | `SettingsButton` 的 rail / icon 两变体不再引用 `app-sidebar__collapse` / `app-bar__icon-button` |
| `src/pages/Library.tsx` | 拖动自动滚动的滚动容器从 `.page-main` 类名改为 `[data-testid="page-main"]` |
| `src/ui/icons.tsx` | 修正注释里指向已删除规则的引用 |
| `scripts/probe-rail-pages.mjs` | 重写：去掉折叠断言与 mdui 残留元素，改守「宽屏常驻 / 窄屏抽屉」；读 `BASE_URL` 与 `TEST_FILE`，挂进一键跑分 |
| `scripts/probe-app-shell-material.mjs` | 重写：原来选择器全指向已删除的 mdui 元素（早已跑不通），改为四路由 × 三视口 × 明暗的外壳完整性验证 |
| `scripts/e2e-all.mjs` | 两个探针登记进 META（`probe-app-shell-material` 此前**根本没登记**，等于永远不跑） |

## 2. 关键决策

### 2.1 折叠功能整个删掉，而不是只删那个按钮

侧栏原来有**两个**折叠入口，语义还不一样：侧栏底部的按钮（宽屏收侧栏）、
顶栏的汉堡（宽屏收侧栏 / 窄屏开抽屉）。收起态另有一整套版式（图标竖排 + 11px 标签 +
隐藏身份块与 Recent），`layout.css` 里 `.app-sidebar[data-collapsed='true']` 一族
共 8 条规则在描述它。

删掉按钮而保留折叠，等于把这套版式继续留在 Tailwind 类里（`group-data-[collapsed=true]:*`），
自写 CSS 换个写法而已。**判据收敛成「视口宽度」一条**之后，这一整族规则和
`NAV_RAIL_COLLAPSED_KEY` / `readNavRailCollapsed` / `toggleRail` 一起消失，
顶栏汉堡也退化成只在窄屏出现的「打开导航」。

代价：宽屏用户不能再把侧栏收起来给内容让位。库页的网格已经把内容列放宽到 1360px，
这个代价在 1280 以上的视口上基本不痛。

### 2.2 用 Tailwind 工具类，而不是「只用组件 props」

HeroUI v3 **没有 Sidebar / Navigation 组件**（组件清单里最接近的是 `list-box` 与
`surface`）。所以外壳骨架必然要靠工具类表达。这不是绕过要求：
`@heroui/styles` 通过 `@theme inline` 把语义令牌注册成了 Tailwind 主题
（`--color-surface-secondary` → `bg-surface-secondary`、`--color-muted` → `text-muted`…），
写 Tailwind 类就是在读 HeroUI 的令牌，换主题时侧栏、顶栏、内容列一起变。

顺带解决了旧写法的两个毛病：
- 自绘的 `background` / `border` 会与组件的 `[data-hovered]` / `[data-selected]`
  规则打架（组件那份特异性更高，自绘的会莫名其妙失效）；
- 断点写在 CSS 与 tsx 两处，改一处忘一处。现在 900px 只出现在
  `layout.tsx` 的 `NARROW_QUERY` 与 Tailwind 的 `min-[901px]:` 里，且成对出现。

### 2.3 保留 `SectionCard` / `Field` / `EmptyState` / `Banner` / `HelpTip` 的类名

这几个的类名不是「自写 CSS 的残留」，而是**组件 API 的一部分**：设置弹窗
（`settings-modal.css`）按 `.section-card__head` / `.field` 做窄屏版式覆盖
（标题换行、行式表单回落到纵向），`Field` 还接受调用方传的 `field--stack`。
把它们的样式写死成 Tailwind 工具类，等于**删掉外层的覆盖能力** —— 那是重写设计，
不是迁移。本次不动它们，`layout.css` 的文件头写明了这条边界。

### 2.4 测试钩子从类名换成 data-testid

外壳的类名全部消失后，`Library.tsx` 的 `querySelector('.page-main')` 与探针脚本里
的 `.app-bar` / `.page-inner` / `.skip-link` 会一起失效。统一改为 `data-testid`
（`page-main` / `top-app-bar` / `skip-link` / `nav-rail` / `nav-rail-open`）——
它本来就只承担「稳定选择器」这一个职责，不会随版式改动漂移。

### 2.5 顶栏汉堡按钮只在窄屏渲染

宽屏没有可开合的东西，留一个点了没反应的按钮比没有按钮更伤信任（同一取舍见
`AppBarSearch` 的注释）。所以 `isNarrow` 为 false 时它**不渲染**，探针据此断言
宽屏的 `nav-rail-open` 计数为 0。

## 3. 结构

```
.page（h-[var(--vvh,100%)]，flex column，bg-background-secondary）
  ├ skip-link（focus-visible 时从视口外滑入）
  └ .app-shell（flex row，flex-1，min-h-0）
      ├ aside[data-testid=nav-rail]（hidden min-[901px]:flex，w-[16.5rem]）
      └ .app-shell__main（flex column，flex-1，min-w-0）
          ├ header[data-testid=top-app-bar]（min-h-[60px]，横屏刘海避让）
          └ main[data-testid=page-main]（滚动容器）
              └ 内容列（narrow / wide / fill 三档）
```

导航项是 `ListBox.Item`：选中态走 `data-[selected=true]:bg-accent-soft`
（HeroUI 的 soft 语义色，15% 透明主色），hover / 键盘 / `aria-current` 全由
React Aria 承担。

## 4. 验证

| 手段 | 覆盖 |
|---|---|
| `tsc -b` | 全量类型检查通过 |
| `vite build` | 生产构建通过（本次因宿主的批量删除守卫改用独立输出目录 `dist-shell-check`，不影响 `dist/`） |
| `probe-app-shell-material.mjs` | 四路由 × 三视口 × 明暗：H1 唯一、分区标题是原生 H2、导航可达、外壳不越出视口、内容无横向溢出、skip-link 保路由且焦点落到内容区 |
| `probe-rail-pages.mjs` | 宽屏侧栏常驻且宽度 264px、标题与内容列同线、宽屏无汉堡；窄屏侧栏隐藏、抽屉承载同一份导航、跳转后自动收起；播放页「课程库」高亮、视频区从侧栏右侧开始 |

## 5. 已知未做

- **内容原语（`SectionCard` / `Field` / `EmptyState` / `Banner` / `HelpTip`）仍是
  自写 CSS**，理由见 §2.3。要彻底去掉，需要先给它们设计变体 API
  （`Field layout="row"`、`SectionCard` 的窄屏档），再改设置弹窗与四个调用点。
- 库页（`.video-row` / `.drop-zone`）、播放页（`.player-layout`）、技能列表
  （`.skill-row`）等**页面专属**样式仍在 `layout.css`，本次未动。
- ~~侧栏底部「设置」入口的类名已换成 Tailwind，但它与导航项在视觉上是否要完全对齐，
  没有截图比对~~：**2026-10-16 已逐项对齐**（`SettingsModal.tsx` 的 rail 变体按
  `layout.tsx` 的导航项补齐了圆角 `rounded-full`、文字色 `text-muted`、悬浮底色，
  `layout.tsx` 的 `railFooter` 外层补 `px-1` 抵掉 ListBox 自带的 `p-1` 内缩）。
  实测「设置」与导航项的 `bounds.x / width` 完全一致（x=16 / 232px）。
