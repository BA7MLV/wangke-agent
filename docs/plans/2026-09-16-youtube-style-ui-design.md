# YouTube 式 UI 改造设计（全站视觉语言对齐）

- 状态：**阶段 1~3 已实现并回归**（控制栏 / 资料库网格 / 设置页行式 + 播放页居中 + 面板密度）；
  仅剩「导航 rail 与顶栏密度」这一档细节未动（见 §3 末尾）
- 日期：2026-09-16
- 需求：整站向 YouTube 的观感靠拢 —— **借视觉语言，保留全部功能**（用户明确选定，不照抄 YouTube 红、不删自研控件）

## 1. 不变量（改版过程中必须守住）

1. **不推翻 MD3 / mdui**：阶段 0~5 的 Material You 迁移成果（深浅色 + 动态取色 + 设计令牌）是底座，YouTube 化只在**布局、密度、层级、hover 反馈**这一层动，不引入第二套配色体系。
2. **不用 YouTube 红**：强调色一律用主题令牌 `rgb(var(--mdui-color-primary))`（动态取色后随课程封面变化）。进度条已播部分、选中态、徽标都用它。
3. **功能只增不减**：倍速快捷栏、弹幕开关、字号按钮、拖拽排序、文件夹分组、导入区、状态标签、批量操作全部保留。
4. **e2e 契约不变**（这是硬约束，48 个用例大量依赖）：
   - 资料库：`video-item` / `drag-handle` / `btn-play` / `btn-rename|btn-move|btn-delete` / `btn-more` / `menu-rename|menu-move|menu-delete` / `video-job` / `group-header`
   - 播放页：`panel-tab-*` / `panel-slot-*` / `[role="tabpanel"]` / `chat-msg-ai|user` / `chat-composer` / `confirm-dialog(-danger)` / `player-file-missing`
   - 导航：`nav-rail-*` / `nav-bottom-*` / `nav-back`
   - 结构语义：面板容器必须仍是 `role="tabpanel"`，切换器仍是 `panel-tab-*`

## 2. YouTube 视觉语言 → 本项目映射

| YouTube 的做法 | 本项目怎么落 | 阶段 |
| --- | --- | --- |
| 进度条静止 3px，hover / 拖动加到 6px | `--media-slider-track-height: 3px` + `--media-slider-focused-track-height: 6px`（vds 在 `[data-active]` 时自动用后者） | 1 ✅ |
| 进度条 hover 时冒出白色圆点播放头 | `--media-slider-thumb-size: 13px`（vds 的 thumb 默认 `opacity:0`，`[data-active]` 才现，天然对齐） | 1 ✅ |
| 已播部分用品牌色 | `--media-slider-track-fill-bg: rgb(var(--mdui-color-primary))`；剩余轨道 `rgb(255 255 255 / .25)` | 1 ✅ |
| 时间显示「当前 / 总长」 | **vidstack 默认就是这个格式**（`DefaultTimeGroup` = current + `/` + duration），不用改 | 1 ✅ |
| 控制栏按钮 40px、图标约 24px、间距松 | `--media-button-size: 40px` / `--media-button-icon-size: 60%` / `--media-button-hover-bg: rgb(255 255 255 / .12)` / `.vds-button { margin-right: 6px }`（默认 38px + 2.5px 偏挤） | 1 ✅ |
| 悬停才出现的控制栏 | 已完成（`hideControlsOnMouseLeave` + hover CSS），见 `2026-09-16` 日志 | 1 ✅ |
| 网格卡片：16:9 缩略图 + 右下时长徽标 | 资料库改网格：`minmax(240px,1fr)`，封面取 `db.frames` 里该视频第一帧的 `thumb`（320px dataURL）；无帧则主题色底 + 图标占位<br>**（2026-09-17 订正）**：`frames.thumb` 从未落地，且「取 frames 第一帧」意味着**只有跑过讲义的视频才有封面**。现已改为独立的封面链路（`covers` 表 + `pipelines/cover.ts`，入库即生成），见 `2026-09-17-cover-design.md` | 2 |
| 标题两行截断、元信息 12px secondary | 卡片标题 `-webkit-line-clamp: 2` + 15px/500；元信息行沿用现有「时长 · 大小 · 日期」文案改 12px secondary | 2 |
| 卡片无描边，靠表面色差分层 | 卡片去掉 border，用 `--mdui-color-surface-container` / `-low`，radius 12px | 2 |
| hover：缩略图轻微变化 + 卡片提亮 | 缩略图 `transform: scale(1.02)`，卡片底色提亮一档，标题不变色 | 2 |
| 次要操作收进右上角三点菜单 | 保留桌面上的三个图标按钮，但改为**未 hover 时半透明、hover 才全亮**（不删任何按钮） | 2 |
| 下划线式 tab 指示器 | 播放页 `mdui-tabs` 的指示器压到 3px 圆头下划线；右侧面板行高收到 YouTube 侧栏的 56~64px 节奏 | 3 |
| 设置页：左侧分类 + 右侧行式设置项（左标签右控件 + 细分隔线） | 设置页由「大卡片 + 大填充输入框」改为「分组卡片内行式设置项」，输入框换紧凑尺寸（mdui 的 `variant="outlined"` 或缩高），1px 分隔线 | 3 |
| 顶栏高度收紧、标题 15px/500 | PageShell 的 app bar 与 rail 项间距按 YouTube 收一档（rail 项 icon 上 label 下已是同构） | 3 |

## 3. 分阶段清单

- **阶段 1（已完成）**：播放器控制栏 —— 进度条、按钮、hover 反馈；全部在 `src/player-enhance.css` 里以 CSS 变量覆盖（vds 默认样式都包在 `:where()` 里，0 特异性，直接覆盖即可）。
- **阶段 2（进行中）**：资料库网格卡片 —— 封面（`db.frames.thumb`）、16:9、时长徽标、标题两行、元信息、hover 态；`VideoRow` 的 markup 改卡片布局，**所有 `data-testid` 原样保留**。
- **阶段 3（已完成，导航密度除外）**：
  - **设置页行式**：所有设置项都走 `Field` 原语，所以只在 `.page-settings .field` 上加一段 grid 两列样式
    就全站生效（不必逐个改 12 个 Field）。左列 label + hint、右列控件、行间细线；需要整行的例外
    （滑块、chips 列表）用 `className="field--stack"`。作用域必须限定设置页 —— `.field` 同时被
    讲义面板复用。**塌陷的项靠截图一眼看出来，比事前读 TSX 快**。
  - **播放页**：`.video-pane` 加 `justify-content: center`（16:9 在更高的视口里顶对齐会留大片空白，
    实测居中后上下各 189px）、~~播放器圆角收到 12px~~（**2026-09-23 已改回直角，见变更记录**）、
    `.sub-item` 与 `.panel-bar` 密度各收一档。
  - **库页细节**：卡片底部 `> mdui-button { margin-right: auto }` 让主操作靠左、图标靠右；
    导入区从纵向大虚线块收成横排提示条（1327×88），testid 与整页拖拽不变。
  - **未做**：导航 rail 与顶栏（`.app-bar` / `.nav-rail`）的间距与选中态微调 —— 收益偏细节，
    且要动 `probe-rail-pages` 与移动端回归，留待确认。

## 4. 验证方式

- 每个阶段都出「改前 / 改后」截图到 `e2e-shots/youtube-ui/`（浅色 + 深色各一组）。
- 相关 e2e 必跑：阶段 1 → `e2e-player-enhance` / `e2e-danmaku` / `e2e-mobile` / `e2e-resume`；阶段 2 → `e2e-library` / `e2e-import` / `e2e-mobile` / `e2e-bg-transcribe`；阶段 3 → `e2e-settings-skills` / `e2e-material-you` / `e2e-live-subs`。
- 新增量测脚本：`scripts/probe-controls-hover.mjs`（阶段 1，已有）、阶段 2 计划加 `scripts/probe-library-grid.mjs`（量网格列数 / 卡片高宽比 / 标题行数 / 徽标位置）。

## 5. 风险与取舍

- **资料库从行式改网格会损失信息密度**（一行能看到的状态标签、进度条、操作按钮都要重新安排）。取舍：元信息与状态标签保留在卡片下方一行，转写进度条移到缩略图底部（更像 YouTube 的上传进度），详情仍可进播放页看。
- **缩略图取帧有性能成本**：`db.frames` 里每帧都有 320px dataURL，一次性读全表在视频多时会有内存压力。做法：只取每个视频的**第一帧**，用 Dexie 查询按 `videoId` 分组后再取 `thumb`；渲染用懒加载（`loading="lazy"`），失败静默占位。
- **移动端不做网格**：手机竖屏保持单列大卡片（YouTube 移动端也是单列），复用同一套卡片样式。

## 6. 变更记录

- 2026-09-23：**播放器改回直角**（用户要求）。

  ```
  - style={{ borderRadius: 12, overflow: 'hidden' }}
  ```
  这行从初版就在（`borderRadius: 8`），2026-09-16 收到 12px。用户明确提出不要圆角后一起删掉：`overflow: hidden` 当初**只是为了**让圆角能裁住视频、没有别的用途，留着会让人以为它在挡什么。

  ⚠️ **删内联样式只做了一半，这是这次最值得记的一步**：vidstack 的默认视频布局**自己在宿主元素上**写了圆角 ——

  ```css
  /* node_modules/@vidstack/react/player/styles/default/layouts/video.css */
  [data-media-player][data-layout=video]:not([data-fullscreen]) {
    border-radius: var(--video-border-radius, 6px);
    border: var(--video-border, 1px solid rgb(255 255 255 / .1));
  }
  ```

  内联的 12px 只是把它**盖住**了，删掉之后那 6px 立刻顶上来（肉眼在浅色背景上仍看得出圆角，`getComputedStyle` 一量就是 6px）。而且这条规则**不在 `:where()` 里**，特异性是 3 个选择器单位，用 `[data-media-player]` 去覆盖会被压过去。所以真正的修法是把变量置 0：`[data-media-player] { --video-border-radius: 0 }`（写在 `player-enhance.css`，变量在元素自身上解析，不必拼特异性）。

  实测：宿主与内部 `<video>` 的计算圆角均为 `0px`；顺带删掉 `overflow: hidden` 后（`overflow: visible`）**打开播放器设置菜单也没有任何元素溢出播放器边界**（`probe-overflow` 量过，越界元素 0 个），所以那次删除没有副作用。只改了圆角，**那圈 1px 描边保留** —— 请求只说不要圆角。

  ⚠️ 一条反面提示：这份文档的主旨是「向 YouTube 的观感靠拢」，但**不是所有 YouTube 特征都该跟** —— 播放器圆角是它明确不要的一条（"借视觉语言"当初就写明了不照抄 YouTube 红，圆角同理）。将来若有人拿着这份文档来"补齐 YouTube 特征"，别顺手把它加回去。
