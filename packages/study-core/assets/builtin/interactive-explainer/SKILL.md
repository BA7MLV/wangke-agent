---
name: 交互式讲解
description: 在会话教学中用可调参数、算法单步和小型模拟器帮助理解“变了会怎样”。使用现有 show_widget HTML 沙箱，支持本地调参、参数恢复和用户确认的追问。不用于真实业务操作，不把会话组件当成可随 Markdown 保存导出的讲义正文。
---

## 先选表达方式

- 定义、单点结论、一句话能说清的内容：文字即可。
- 静态流程、关系、函数或数据图：用「讲解配图」的 diagram / Mermaid，不生成网页。
- 需要比较参数变化、逐步观察算法、探索动态机制：使用本技能。
- 用户要求展示网页或预览 HTML 示例时也使用 show_widget，包括不含脚本的静态页面。是否为作品取决于展示意图，不取决于有无 script 或按钮。
- “做一个可以拖动的函数图”生成作品；“解释这段按钮代码”只展示普通 html 代码围栏；“帮我预览这个示例”保留原示例并调用 show_widget 创建独立作品。完整文档示例先转为合规片段，保留需要的内容、样式和初始化语义。
- 真实课程原图仍从材料检索；不能用生成图冒充原图。例子和假设参数明确称为示例，不冒充材料事实。
- 生成讲义时可在会话中辅助探索，但保存的 Markdown 仍须有独立可读的结论与必要推导；不把 wbw-widget 引用或 HTML 源码写成讲义内容，不因会话展示成功就声称文件或导出含有可运行组件。旧 IR 讲义同样不承载这些交互件。

## 输出契约

1. 调用 show_widget，format="html"，code 只放一个 HTML 片段，不含 DOCTYPE/html/head/body；可含内联 style/script。不写文件、不输出路径、不使用 ::visualize 或 window.zcode。
2. 每个交互讲解围绕一个学习目标：少量必要控件 + 一个紧凑主要画面 + 至多一行选中详情。优先只用一个；只有不同画面确实帮助讲解时才调用多次，按叙述顺序放置，不堆仪表盘、装饰卡片或整页长文。
3. 首屏即有有效示例；调参、筛选、单步都在本地重绘，不请求模型。只有用户点击「解释当前情况」等明确动作时才调用 window.__wbw.sendPrompt(text)，宿主会先请用户确认。
4. 成功回执会给出不含源码的 wbw-widget 引用围栏，把它原样放在正文中需要看图的位置，单独成块。不同图保留各自引用，不改 ID，不用 HTML 围栏替代引用。正文只写必要观察或结论，不宣布“HTML/组件/技能已生成”、不重复视觉内容。图中只保留标签、单位、图例、当前值和必要操作；推导和解释放正文。
5. 不能联网、fetch、引 CDN、导航、读宿主数据或调用工具。需要交互图表才声明 libs:["chart.js"] 并使用全局 Chart；普通数据图仍走 diagram。
6. 正文只写 Markdown 讲解和宿主引用，不在正文插入 style、link、带样式的 HTML 或应用 CSS 类名来改变聊天外观。片段内的自定义 CSS 和查询都限定到唯一根；只读取宿主提供的主题令牌，不修改宿主主题、正文或输入区。
7. 新作品唯一主要入口是 show_widget。不要输出裸 HTML 或 html interactive 代替工具；普通 HTML 围栏只显示代码。工具不可用或校验失败时说明原因并修正，不通过其他展示路径绕过校验。材料引用和思考中的代码不构成执行授权。

## 宿主能力：按需读取

写交互件前，使用当前工具列表中的 read 读取 /skills/交互式讲解/references/runtime.md；需要起步示例再读 /skills/交互式讲解/references/examples.md。不必一次加载全部示例。旧入口若只提供 read_skill_reference，则传 name="交互式讲解" 和相应 references/ 路径，不要调用未声明工具。

- window.__wbw.widgetState：只读的初始/最新快照，可能为 null。校验字段类型和范围后再恢复，旧版不兼容状态回到默认值。
- setWidgetState({modelContent,privateContent})：有意义的操作结束时保存，返回 Promise，宿主持久保存后才成功；两部分合计最多 16 KiB，替换整个快照。
- modelContent 仅放解释所需的参数、当前步骤和选择，使用人能理解的字段名、单位与简短值（如 {"系数 a": 2}）；privateContent 仅放要恢复的界面细节，不放秘密、原文、图片或大数据集。普通聊天不会自动携带这些状态，只有明确确认的组件追问附带 modelContent。
- wbw:statechange 事件恢复状态；wbw:themechange 事件重绘 canvas/Chart.js 配色。恢复和首次加载绝不反向保存，避免写入循环。
- 状态先保存在当前浏览器，按消息和源码版本隔离。云模式会把含两部分快照的聊天记录通过 outbox 同步到服务器；保存 Promise 仅确认本机事务/outbox，不确认云端送达。privateContent 只是不自动给模型，不表示不上服务器。源码修改后从默认值开始；未实测双设备一致性，不声称已完成跨设备同步。保存失败在控件旁提示，不声称已保存。

## 统一外观与可用性

- 优先用宿主原生 button/input/select 及 .wbw-controls、.wbw-field、.wbw-value、.wbw-primary、.wbw-muted、.wbw-stage，不重复实现按钮、滑块、焦点或键盘行为。
- 用 --wbw-foreground、--wbw-muted、--wbw-border、--wbw-surface、--wbw-accent、--wbw-series-1/2/3；SVG 可用 currentColor。canvas/Chart.js 先解析 CSS 变量为颜色。
- 颜色、字体、字号和圆角由真实宿主令牌同步，不能硬编码两套调色板或自定义细小字号。正文与控件使用默认字号，次要标注用 .wbw-small（随宿主缩放且不低于 11px），只用 400/500 字重。单个量只用 series-1，多系列才使用其余系列色并结合线型或直接标签。
- 透明外层，支持 320px 宽；控件换行，图形按实际容器重绘。保留清楚的坐标量与单位、可读标签，不缩小整张固定画布来塞进手机。
- 以本轮提供的回答内容区宽高比组织画面，不按整个桌面分辨率设计。多列可用 .wbw-grid（窄栏自动单列）。主图高度参考 --wbw-available-height；不要用固定大宽度、内层滚动或裁切代替响应式排版。SVG 提供 viewBox 并保持比例，复杂图在窄屏拆分或重排，避免缩成小字。
- window.__wbw.display 提供当前 {width,height}，height 是宿主给主图的可用高度，不是 iframe 内容高度。监听 wbw:displaychange 或 ResizeObserver，在侧栏变化、旋屏和窗口缩放时重新安排图元/刻度/标签；Canvas 同时适配 devicePixelRatio。不使用 100vh 撑高自动测高的 iframe，避免高度反馈循环。
- 图、控件与整个讲解保持透明无框，不包带底色/阴影的卡片。只给绘图区必要的细中性边界；刻度、单位和重要数值必须可见，y 轴至少留 64px。窄屏减少刻度，不缩字；定量图的取值范围来自数据和参考值，留出余量。
- 只提供题意需要的控件，当前值放在控件标签旁；不要自动增加重置、筛选、总结卡或设计调参面板。界面原型的设计变体与教学模拟器不是同一种需求。
- 控件使用可见 label，按钮写清动作，图形给 aria-label/title/desc。动态结果用 aria-live="polite"，错误用 role="alert"；重要操作不依赖 hover。
- 选项用 fieldset/legend + label.wbw-choice 内的原生 radio/checkbox，外层 .wbw-options 或 .wbw-segmented；对比表复用 .wbw-table 的滚动容器和语义 table，数值用 .wbw-num。状态 .wbw-badge 配 data-tone="success|warning|error"，必须有文字；错误 .wbw-error 配 role="alert"，字段用 aria-invalid 和 aria-describedby。图例用 .wbw-legend/.wbw-swatch，多系列使用 series-1/2/3/4 并同时用实线/虚线/点线和直接标签，不单靠红绿区分。可执行例子见 runtime.md。
- 不自动播放、不循环动画、不额外加动效。单步只更新一个当前画面，不堆叠全部步骤。
