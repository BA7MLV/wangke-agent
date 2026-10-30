# 全站圆角调整清单

范围：`apps/web` 的应用界面及内嵌教学控件。以下数值按默认 16px 根字号换算；随用户字号缩放。
格式：`元素: old -> new`。包含显式修改和共享 token 联动；同一选择器的响应式规则单独标明。

## 当前规则与兼容

- 基础档位：4 / 8 / 12 / 16 / 20 / 24 / 32px。圆角以 `apps/web/src/theme.css` 中的 token 为准；20px 预留为 `--corner-20`，不新增公共组件 API。
- 语义默认：control 12、panel 16、dialog 24px；紧凑控件/菜单项 8px、微型元素 4px。尺寸 token 保持兼容，32px 不再是通用容器默认。
- 嵌套：仅真正沿边的内外表面参考 `max(0, 外圆角 - 内边距)`，再按语义就近取档；不强制所有子按钮同心，也不为公式改间距。
- 静态 padding / gap 按 4px 网格整理。视口响应值、实际测量值和系统安全区不强制量化，避免破坏适配。
- 图标内部几何不属于布局间距：加载点阵保留 2px 点与 2px 间距，整体固定 14×14px，避免套用 4px 网格后放大。
- 连续圆角：仅 `.ui-smooth` 在 `@supports (corner-shape: superellipse(1.25))` 内增强；保留 `border-radius`，不支持时正常回退。它只是视觉近似，不等于 Lisse/Figma 60% smoothing。
- 普通按钮默认 12px；显式胶囊、头像、圆点、圆形图标按钮、单选标记、开关、滑块不选择平滑，保持原生 round。
- 贴边全屏、列表拼接边继续为 0，不把刻意的直角变成圆角。
- HeroUI 和应用主题合并到同一 CSS 编译入口，同时覆盖 `@theme inline`，确保 Tailwind 工具类不再固化旧比例。

## 2026-10-30 语义规范化

### 实现与覆盖

- `theme.css`：control 16 → 12、panel 保持 16、dialog 32 → 24px；`field` 跟随 control。HeroUI 的普通 Button/ToggleButton 12、icon-only 圆形、Card 16、Modal/AlertDialog 24（full 模态保持 0）、Popover/Dropdown/Select/ComboBox/Tooltip 12、紧凑 MenuItem/ListBoxItem 8px。在组件层覆盖库默认，业务样式及工具类可明确选择例外。
- `@theme inline` 增加 `rounded-control/panel/dialog` 语义映射；`@source inline` 保留公开尺寸与语义工具类的编译产物（即使某档暂时不被业务引用）。旧 xs/sm/md/lg/xl/2xl/3xl 的 4/8/8/12/16/24/32 映射不变。
- 设置桌面弹窗和移动底部面板 24px，底部贴边仍为 0；移动设置导航 16/8px，桌面导航拼接表面仍为 0。composer-expand 与 md-table 底部面板通过 dialog token 同步为顶部 24px。
- ProviderPresets、ModelsModule 的服务商卡片 32 → 16px；模型字段面板、模型编辑表单、MCP 服务卡片、ArtifactEditor 编辑面板 32 → 16px，改用 panel 语义。服务商图标独立保留 16px，不套用同心减法。
- 项目卡片 32 → 16px，原生选择框 16 → 12px；提问/计划卡、思考题卡、材料图片卡、密码恢复内容卡 24 → 16px。课程聊天发送提示条与排队条 24 → 16px，导入条内常规标签按钮 16 → 12px。
- 平滑选择范围：共享 `SectionCard`、设置桌面弹窗/移动面板、服务商卡片。仅这些入口挂 `.ui-smooth`；没有给所有 `.card` 或所有模态隐式增强。
- 删除应用主题以及独立教学控件样式内的全局 `corner-shape` 通配增强。不向后代/伪元素传播；用户 HTML、作品、图表、内容图片不被平滑覆盖。未引入 Lisse、路径重算、mask 或额外 overflow 裁切，也未改变现有动效。

### 保留的几何例外

- 聊天气泡与文件气泡、聊天主输入工作区、导入条、Bot 大面板、应用大画布/侧面板保留现有方向性或 24px 大面板几何；不因 panel 默认收缩而全站替换 `--radius-2xl`。
- 紧凑资源工具栏/搜索、附件缩略图、问答选项继续 8px；复选框及其选中底色 4px。
- 标签/徽章、显式胶囊分段控件、快捷提问、头像、发送/圆形图标按钮继续圆形或 full；手机贴边、列表拼接边保持 0。32px 尺寸 token 保留兼容，但本次涉及的普通卡片/弹窗已无 32px 默认。

### 实现核验与验证（2026-10-30）

- 查阅 HeroUI v3 当前样式定制文档和已安装组件 CSS，以及 Tailwind v4 `@theme inline` / `@source inline` 文档。使用同一编译入口，浏览器实测默认值和显式工具类例外。
- 查阅 [MDN corner-shape](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/corner-shape) 与 [BCD 兼容数据](https://github.com/mdn/browser-compat-data/blob/main/css/properties/corner-shape.json)：Chrome 139 起支持，Firefox/Safari 数据仍为 preview，非 Baseline。因此只做 `@supports` 渐进增强，不声称跨浏览器精确 Figma 曲线。
- `npm run typecheck -w @wangke/web`：通过（首次后台运行被 SIGTERM，前台重跑通过）。`npm run build:web`：通过，含边界检查/i18n/TypeScript/Vite/PWA；仍有构建 CSS `:is()` 空选择器及动态/静态混合导入警告，未在此任务中改动相关规则或打包策略。
- `npm run test:ui-radii:e2e`：通过。实测 8 组父子语义、16 项 HeroUI/Tailwind 默认、复选框、胶囊/圆形、20px 根字号缩放、平滑仅作用于被选表面；设置桌面 1440×1000 / 手机 390×844、浅深主题、Tab 焦点、ComboBox 端口浮层未裁切/未越界，以及移除增强后的 24px 普通圆角回退。Chrome 原生增强实测支持；回退为 CSSOM 移除 `@supports` 模拟，未声称做过 Safari/Firefox 真机验收。
- 课程聊天、资源库（`#/library`）、侧栏、Bot 入口均做两种视口/浅深主题截图和文档无横向溢出检查。已目视抽查设置边缘/阴影、焦点环、浮层、资源页手机布局。截图位于 `test-results/ui-radii/`。
- 构建后再以 `BASE_URL=http://localhost:5194 SHOTS=test-results/ui-radii-production npm run test:ui-radii:e2e` 检验生产静态产物：通过同一套断言；生产截图位于 `test-results/ui-radii-production/`。
- Bot 服务本地不可达，实际浏览器只覆盖 Bot 面板断连态；文件气泡几何由 CSS fixture 回归覆盖，真实 Bot 消息流/子菜单尚未完成后端联调验收。
- `npx tsx scripts/test-widget.mjs`：24/24 通过。`git diff --check`：通过。
- 完整 `npm run test:ui-radii`：新增平滑范围与语义映射两项通过，但原有网格项仍因两处既有值失败：`pages/course-chat.css:26` 的 `gap: 0.375rem`（6px）、`ui/layout.css` 的 `.page-shell__brand { padding-left: 13px }`。两值在 `git show HEAD:<path>` 中均可复现，本次未修改；保留原断言，没有为通过而删除或豁免它们。

## 历史清单（此前的尺寸档位迁移）

以下逐元素 old → new 记录保留原貌以便追溯，不是当前默认值；与上方冲突时以「当前规则」及「2026-10-30 语义规范化」为准。

### 共享 token 与基础组件

- `--radius-sm`（普通 CSS）: 6px -> 8px
- `--radius-md`: 6px -> 8px
- `--radius-lg`: 8px -> 12px
- `--radius-xl`: 12px -> 16px
- `--radius-2xl`: 16px -> 24px
- `--radius-3xl`: 24px -> 32px
- `--field-radius` / `--radius-field`（输入、选择、搜索控件）: 12px -> 16px
- `rounded-xs`（工具类）: 2px -> 4px
- `rounded-sm`（工具类）: 4px -> 8px
- `rounded-md`（工具类）: 6px -> 8px
- `rounded-lg`（工具类）: 8px -> 12px
- `rounded-xl`（工具类）: 12px -> 16px
- `rounded-2xl`（工具类）: 16px -> 24px
- `rounded-3xl`（工具类）: 24px -> 32px
- HeroUI `.card`、`.modal__dialog`、`.alert-dialog__dialog`、`.popover`: 24px -> 32px
- HeroUI `.menu-item`、`.list-box-item`（非显式胶囊）: 16px -> 16px（独立使用 control token，不随外层 token 增长）
- HeroUI `.checkbox__control`、`.checkbox__control::before`: 6px -> 4px（避免 16px 复选框变圆）
- HeroUI 默认按钮、头像、标签徽章等全圆形状: 全圆 -> 全圆（token 数值联动，但不改变全圆外形）
- `--wbw-radius`（内嵌教学控件独立文档的默认值）: 6px -> 8px

`--radius` 8px、`--radius-xs` 4px、`--radius-4xl` 32px、`--radius-full` 保持不变。

## 普通 CSS 元素

### cards.css
- `.deck:focus-visible`: 12px -> 16px
- `.deck-card`: 12px -> 16px
- `.face-tag`: 10px -> 8px
- `.cards-row__seek`: 6px -> 8px
- `.quiz-card`: 8px -> 24px
- `.quiz-option`: 6px -> 8px
- `.quiz-order-item > button`: 4.8px -> 4px

### cloud/onboarding/onboarding.css
- `.ob-figure__art`: 20px -> 24px
- `.ob__group`: 12px -> 16px
- `.ob__primary`: 14px -> 16px

### components/ask-cards.css
- `.ask-card, .plan-card`: 8px -> 24px
- `.ask-option__num`: 6px -> 4px
- `.ask-card__custom`: 6px -> 8px
- `.plan-folder__course`: 6px -> 8px

### components/chat-attachments.css
- `.chat-attachments__item`: 12px -> 16px
- `.chat-image--draft.chat-image--draft`: 12px -> 16px

### components/chat-composer.css
- `.study-composer__input`: 8px -> 12px

### components/chat-message-nav.css
- `.chat-message-nav .chat-message-nav__item`: 6px -> 8px

### components/chat-panel.css
- `.chat-bubble--ai`: 8px -> 12px
- `.chat-bubble--user`: 16px -> 24px
- `.chat-msg[data-error='true'] .chat-bubble--ai`: 8px -> 12px
- `.chat-frame-img`: 6px -> 8px
- `.chat-ts-chip`: 2px -> 4px
- `.chat-shot__img`: 6px -> 8px
- `.chat-ref`: 6px -> 8px
- `.chat-note`: 6px -> 8px

### components/composer-expand.css
- `.composer-sheet[data-placement='bottom']`: 24px 24px 0 0 -> 32px 32px 0 0

### components/handout-panel.css
- `.hp-skel__img`: 6px -> 8px
- `.hd-hover-actions .hd-act`: 6px -> 8px

### components/live-chat-panel.css
- `.live-chat__note`: 未定义旧 token（直角回退） -> 16px

### components/markdown/markdown.css
- `.x-markdown :where(code):not(:where(.md-embedded-ui *))`: 2px -> 4px

### components/material-image.css
- `.material-image`: 12px -> 24px

### components/mermaid/mermaid.css
- `.xmd-mermaid`: 8px -> 16px

### components/password-access.css
- `.password-access__icon`: 20px -> 16px
- `.password-access__secret input`: 12px -> 16px
- `.password-recovery__body`: 16px -> 24px

### components/reasoning-chain.css
- `.reasoning-chain .reasoning-chain__toggle`: 10px -> 8px

### components/selection-ask.css
- `.ask-float`: 8px -> 12px

### components/settings-sheet.css
- `.settings-module-nav`: 16px -> 24px
- `.settings-module-nav .settings-module-nav__item`: 12px -> 16px
- `.settings-sheet__dialog[data-placement='bottom']`: 24px 24px 0 0 -> 32px 32px 0 0
- `.settings-list`: 12px -> 16px
- `.settings-list__tile`: 7px -> 8px
- `.settings-list__tile--sm`: 6px -> 8px

### components/skill-picker.css
- `.skill-picker__icon`: 6px -> 8px
- `.skill-picker .skill-picker__content`: 8px -> 12px

### components/streaming-html-preview.css
- `.widget-stream-preview`: 8px -> 16px

### components/study-assistant.css
- `.study-assistant__content`: 16px -> 24px

### components/tool-trace.css
- `.tool-trace__toggle`: 6px -> 8px
- `.tool-trace__item[data-status='running']::after`: 6px -> 8px

### components/widget-block.css
- `.widget-block--loading, .widget-block--error`: 6px -> 8px

### handout-doc.css
- `.hd-ai-panel`: 6px -> 16px

### materials/material-reader.css
- `.mr-area__rect`: 2px -> 4px
- `.mr-md__block--mark`: 6px -> 8px
- `.mr-html__block--mark`: 6px -> 8px
- `.mr-html pre`: 6px -> 8px

### md-table.css
- `.md-table-sheet__dialog[data-placement='bottom']`: 24px 24px 0 0 -> 32px 32px 0 0

### pages/bot.css
- `.bot-access__group`: 12px -> 16px
- `.bh-segment`: 10px -> 12px
- `.bh-pin`: 12px -> 16px
- `.bh-thread`: 12px -> 16px
- `.bh-chat`: 16px -> 24px（移动端贴边仍为 0）
- `.imsg-row--mine .imsg-bubble`: 16px -> 24px
- `.imsg-bubble--file`: 14px -> 24px
- `.imsg-file__icon`: 10px -> 12px
- `.imsg-bubble--action`: 14px -> 24px
- `.imsg-bubble--code pre`: 12px -> 16px

### pages/course-chat.css
- `.course-chat__history-skel-bar`: 6px -> 8px
- `.course-chat__starter-icon`: 6px -> 8px
- `.course-chat__composer-wrap .course-chat__import`（桌面）: 22px 22px 0 0 -> 24px 24px 0 0
- `.course-chat__import .course-chat__import-label`: 10px -> 16px
- `.course-chat__bubble--user`: 16px -> 24px
- `.course-chat__message[data-error='true'] .course-chat__bubble--ai`: 8px -> 12px
- `.course-chat__delivery-bar`: 16px -> 24px
- `.course-chat__queue`: 16px -> 24px
- `.course-chat__queue-input`: 8px -> 12px
- `.course-chat__composer-wrap .course-chat__import`（手机）: 20px 20px 0 0 -> 24px 24px 0 0

### pages/library.css
- `.finder-toolbar [data-slot='button'], .finder-tool`: 6px -> 8px
- `.finder-view-switch [data-slot='toggle-button']`: 6px -> 8px
- `.finder-search [data-slot='search-field-group']`: 7px -> 8px
- `.finder-window[data-mobile='true'] .finder-search [data-slot='search-field-group']`: 10px -> 16px
- `.finder-item__icon`: 6px -> 8px
- `.finder-document`: 3px 14px 3px 3px -> 4px 16px 4px 4px
- `.finder-document::after`: 0 0 0 3px -> 0 0 0 4px
- `.finder-items--list .finder-document`: 2px -> 4px

### pages/live-guest.css
- `.live-guest__cover`: 12px -> 16px
- `.live-guest__video video`: 12px -> 16px
- `.live-guest__pending`: 未定义旧 token（直角回退） -> 16px

### pages/projects-home.css
- `.ph-list`: 14px -> 16px
- `.ph-row__icon`: 10px -> 8px

### pages/resources.css
- `.resource-tile`: 12px -> 16px
- `.resource-open`: 12px -> 16px
- `.resource-grid[data-view='list'] .resource-file-icon .finder-document`: 2px -> 4px

### pages/widget-preview.css
- `.widget-preview-page__widget`: 8px -> 12px

### player-enhance.css
- `.bili-player .vds-video-layout` 的 `--media-slider-track-border-radius`: 2px -> 4px
- `.bili-player .player-big-play`: 12px -> 16px
- `.bili-player .vds-time-slider .vds-slider-value`: 2px -> 4px
- `.dm-item`: 18px -> 24px

### projects/projects.css
- `.project-card`: 16px -> 32px
- `.project-path`: 10px -> 16px
- `.project-form select, .project-controls select, .bot-scope-bar select`: 8px -> 16px

### study.css
- `.study-tile`: 8px -> 16px
- `.study-tile .skel-bar`: 6px -> 8px
- `.heat-scroll:focus-visible`: 6px -> 8px
- `.heat-cell`: 2px -> 4px
- `.study-recent__bar`: 5px -> 4px
- `.study-recent__fill`: 5px -> 4px

### ui/layout.css
- `.player-layout .side-pane`: 12px -> 16px
- `.sub-item`: 6px -> 8px
- `.app-aside`: 16px -> 24px
- `.page-shell__surface`: 18px -> 24px

### ui/panel.css
- `.sub-item, .skel-cue__row`: 6px -> 8px

### ui/skeleton.css
- `.skel-bar`: 6px -> 8px

## Tailwind 元素

按修改前文件行号定位，路径相对于 `apps/web/src`。同一行的响应式档位分别列出。

- `cloud/BotManagement.tsx:74` 模型提示卡: 12px -> 16px
- `cloud/BotManagement.tsx:75` 整理配置区: 12px -> 16px
- `cloud/BotManagement.tsx:83` 运行条目: 8px -> 12px
- `cloud/BotManagement.tsx:87` 运行详情: 12px -> 16px
- `cloud/BotManagement.tsx:101` 记忆编辑区: 12px -> 16px
- `cloud/BotManagement.tsx:112` 记忆条目: 8px -> 12px
- `cloud/BotSettings.tsx:101` 请求参数代码块: 8px -> 12px
- `cloud/GatewaySettings.tsx:54` 渠道图标: 8px -> 12px
- `cloud/GatewaySettings.tsx:308` 配置步骤: 12px -> 16px
- `cloud/GatewaySettings.tsx:430` 配对指令: 12px -> 16px
- `cloud/GatewaySettings.tsx:521` 二维码卡片: 16px -> 24px
- `cloud/Models.tsx:128` 问题提示区: 12px -> 16px
- `components/ArtifactEditor.tsx:122` 编辑状态: 12px -> 16px
- `components/ArtifactEditor.tsx:127` 编辑面板: 12px -> 32px
- `components/ArtifactEditor.tsx:135` 运行状态: 8px -> 16px
- `components/HtmlAnswer.tsx:37` HTML 源码块: 8px -> 12px
- `components/ModelCapabilities.tsx:25` 推理标签: 6px -> 8px
- `components/ModelCapabilities.tsx:26` 工具调用标签: 6px -> 8px
- `components/ModelCapabilities.tsx:42` 模型详情: 8px -> 12px
- `components/SettingsModal.tsx:189` 桌面设置弹窗: 14px -> 32px
- `components/SettingsModal.tsx:189` ≤760px 贴边弹窗规则: 14px -> 0px（手机实际使用独立的顶部 32px 抽屉）
- `components/SkillsCard.tsx:295` 技能列表: 8px -> 12px
- `components/SkillsCard.tsx:353` 技能条目: 6px -> 8px
- `components/mermaid/DiagramBlock.tsx:161` 图表骨架: 8px -> 12px
- `components/settings/ModelLibrary.tsx:74` 模型编辑表单: 12px -> 32px
- `components/settings/ModelLibrary.tsx:146` 发现模型列表: 12px -> 16px
- `components/settings/ModelLibrary.tsx:147` 发现列表标题: 12px -> 16px
- `components/settings/ModelsModule.tsx:151` 模型行: 4px -> 8px
- `components/settings/ModelsModule.tsx:346` 模型字段面板: 12px -> 32px
- `components/settings/ModelsModule.tsx:397` 模型选择入口: 8px -> 16px
- `components/settings/ModelsModule.tsx:430` 模型选择浮层: 12px -> 16px
- `components/settings/ModelsModule.tsx:674` 服务商卡片（桌面）: 16px -> 32px
- `components/settings/ModelsModule.tsx:674` 服务商卡片（手机）: 16px -> 32px
- `components/settings/ModelsModule.tsx:686` 服务商图标（桌面）: 16px -> 16px（改用 panel 档）
- `components/settings/ModelsModule.tsx:686` 服务商图标（手机）: 12px -> 16px
- `components/settings/ModelsModule.tsx:783` 表单反馈区域: 6px -> 8px
- `components/settings/ProviderPresets.tsx:44` 添加服务商卡片（桌面）: 16px -> 32px
- `components/settings/ProviderPresets.tsx:44` 添加服务商卡片（手机）: 16px -> 32px
- `components/settings/ProviderPresets.tsx:49` 添加图标（桌面）: 16px -> 16px（改用 panel 档）
- `components/settings/ProviderPresets.tsx:49` 添加图标（手机）: 12px -> 16px
- `components/settings/ProviderPresets.tsx:58` 预设卡片（桌面）: 16px -> 32px
- `components/settings/ProviderPresets.tsx:58` 预设卡片（手机）: 16px -> 32px
- `components/settings/ProviderPresets.tsx:63` 预设图标（桌面）: 16px -> 16px（改用 panel 档）
- `components/settings/ProviderPresets.tsx:63` 预设图标（手机）: 12px -> 16px
- `mcp/McpSettings.tsx:69` MCP 服务面板: 12px -> 32px
- `mcp/McpSettings.tsx:85` MCP 工具面板: 8px -> 16px
- `pages/Library.tsx:214` 视频缩略图: 16px -> 24px
- `pages/Library.tsx:221` 视频列表骨架: 6px -> 8px
- `pages/Library.tsx:1975` 拖动预览卡片: 16px -> 24px
- `pages/Library.tsx:1990` 置顶放置区: 16px -> 24px
- `pages/Library.tsx:1998` 删除放置区: 16px -> 24px
- `pages/Library.tsx:2661` 时长标签: 6px -> 8px
- `pages/ResourceLibrary.tsx:35` 资源骨架图标: 8px -> 12px
- `ui/layout.tsx:424` 最近会话操作: 6px -> 8px
- `ui/layout.tsx:480` 辅助操作: 6px -> 8px
- `ui/layout.tsx:1093` 导航浮层: 8px -> 12px

## 等值迁移（数值不变，改为共享 token）

- `.deck-hint`: 8px -> 8px（`--radius-chip`）
- `.quiz-text`: 8px -> 8px（`--radius-chip`）
- `.chat-attachments__thumb`: 8px -> 8px（`--radius-chip`）
- `.chat-image`: 16px -> 16px（`--radius-panel`）
- `.study-composer`、`.chat-composer__row`: 24px -> 24px（`--radius-2xl`）
- `.chat-user-expand`、`.chat-ref__img`、`.course-chat__user-expand`: 4px -> 4px（`--radius-xs`）
- `.material-image__preview`、`.material-image__placeholder`: 8px -> 8px（`--radius-chip`）
- `.bot-access__icon`: 16px -> 16px（`--radius-panel`）
- `.bh-segment__item`: 8px -> 8px（`--radius-chip`）
- `.voice-input__hold`、`.voice-input__status`: 16px -> 16px（`--radius-panel`）
- `.password-recovery__body pre`: 8px -> 8px（`--radius-chip`）
- `.course-chat__empty-skel__head`: 8px -> 8px（`--radius-chip`）
- `.course-chat__composer`（桌面、手机、空状态）: 24px -> 24px（`--radius-2xl`）
- `.ph-empty__icon`: 24px -> 24px（`--radius-2xl`）
- `.project-file-open`、`.project-download`: 8px -> 8px（`--radius-chip`）

## 验证

```sh
npm run test:ui-radii
BASE_URL=http://localhost:5193 npm run test:ui-radii:e2e
```

当前端到端覆盖与未通过项见上方「实现核验与验证」；不再强制所有父子控件满足同心减法，也不再绑定全局平滑/普通卡片 32px。
