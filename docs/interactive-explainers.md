# 交互式讲解

普通聊天与课程问答复用 `show_widget(format="html")`，新增内置「交互式讲解」技能。静态结构、函数和普通数据图继续使用 diagram / Mermaid；只有参数探索、算法单步等确实有助于理解时才生成交互件。

## HTML 作品与代码示例（2026-10-29）

新 HTML 作品统一经 `show_widget(format="html")` 创建，包含没有脚本的页面作品。模型根据用户意图选输出：做可拖动函数图→工具；解释按钮代码→普通 HTML 围栏；要求预览示例→保留示例，通过工具创建独立作品。工具不可用或校验失败不能改用裸 HTML 绕过。是否有 script、按钮、事件处理器不参与意图判断。

- 普通 html/htm 围栏默认展示源码，不自动运行；用户点击预览才在隔离 iframe 中打开。裸 HTML 作品形态显示转义源码；普通语义 HTML 仍遵循正文净化规则。
- 新载荷在原 `WidgetPayload` 上增加 `kind: html`、`schemaVersion: 1`、`revision`、`source`。宿主分配 `ref` 稳定引用和 `id` 修订身份；编辑/撤销递增 revision、更换 id、清除旧状态，单次重试还有独立桥接令牌。模型不能指定宿主身份。布局短 hash 不用于授权。
- 类型和已保存标记均不代表可信。每次构造运行文档仍校验结构、协议版本、源码与依赖白名单及文档大小；未知版本显示失败且允许看源码。源码只进入隔离 iframe。
- 完整工具调用校验通过后，浏览器编排先提交本机消息；服务器编排先提交服务器消息，再返回工具成功引用，不等待整段回答结束。云端进度中的作品同步到本机消息后才交付预览，避免本机还没有持久化归属的时序错误。后续文字、停止或收尾更新同一行，避免重复消息；临时检查点标明后续回答未完成。本机状态提交不代表云端已确认。未完成参数、取消或校验失败不执行脚本；独立编辑预览仍是临时内容。
- 旧 `widget`/`widgets` 缺失元数据时，在原消息事务内幂等补齐。旧 `html interactive` 继续作为显式兼容声明，按精确原源码在 `legacyHtmlWorks` 缓存惰性解析结果；源码保留不改写，当前运行策略仍生效。只读/未落库展示在内存适配。编辑预览不写兼容缓存。
- 完整校验并保存的 HTML 作品以独立可视化展示，不套普通代码卡；保留作品菜单、查看源码、编辑/撤销、独立窗口及运行诊断。普通 HTML 示例继续走源码优先的代码栏。失败直接给原因及“重试预览”；重试不请求模型、不修复源码、不放宽权限。ready 只说明运行环境已启动，不证明作品业务正确。
- 普通代码栏与展开的“已思考”标题在各自内容范围内吸顶。消息区仍保留输入区裁剪，仅吸顶工具栏通过 portal 提升到渐进模糊之上，且不覆盖导航按钮；离开当前块后恢复原位。

### 安全声明与实测限制

iframe 的不透明源、禁同源权限、CSP、受限消息桥继续构成运行边界。增加了从持久化载荷到运行文档的预检，并拒绝 meta/base/iframe/object/embed 等文档级重定向/嵌套入口。但源码正则不是 JavaScript 沙箱，不能禁止所有间接导航。

本次 Chromium 与 WebKit 探针验证了宿主 DOM/存储访问拒绝、fetch/资源连接限制、受限桥、内联脚本与 Chart.js 正常工作。间接 `globalThis['loc'+'ation']` 自导航在 WebKit 到达了测试请求拦截器（测试主动 abort，未真实外发），Chromium 本次未到达。**不承诺绝对零外发**；运行时拿得到的数据也可能被生成脚本读取。普通 iframe 不提供硬 CPU/内存配额，超时提示不能强制终止任意死循环。

新增 `scripts/e2e-widget-protocol.mjs` 直接走真实 show_widget 执行器，覆盖静态/交互作品、先保存再交付、同版本不重挂、脚本错误、源码、本地重试、未知版本、宿主提交失败与窄屏。支持 `BROWSER=webkit`。测试使用固定源码/假模型，不代表真实模型已稳定选对工具入口。

验收：协议、流式拆块、DOM 惰性解析、状态与持久化、局部编辑、课程执行器测试通过；HTML 示例/旧作品、连续多作品、状态恢复、布局、样式隔离、阅读与编辑浏览器回归通过；新协议及恢复流程在 Chromium/WebKit 均通过。Web 构建与类型检查通过。构建仍输出现有 UI 依赖 CSS 压缩及混合动态/静态导入警告。课程执行器额外采用已有 nextChatTurnTimes 保证相邻快速回合的历史顺序，避免同毫秒排序误删上一轮回答。

## 服务器编排链路

- `apps/api/runtime/node.ts` 的 `chat` / `qa` 均注册 `show_widget`，包括空资料库、视频课程和阅读材料。工具定义、HTML 参数校验、载荷类型及流式 JSON 字符串前缀解码来自 `packages/study-core`，API 不引用 Web 应用源码或 DOM 运行时。
- HTML 通过校验后由服务器分配独立 `id/ref`，按调用顺序追加 `widgets`，并保留最后一幅的 `widget` 兼容别名；同一用户/助手消息对持续更新。源码不塞进展示正文，引用在交付处固定，模型重复引用不会重复展示。任务 `progress`、`result` 和同步消息均带作品载荷和消息 ID。
- 流式参数只提供去脚本、样式、SVG、URL 与事件处理器的静态预览，不生成作品或执行脚本。完整校验并落库后才切换为作品 iframe。断线、停止和服务重启不会删除已交付作品；下一轮从持久化工具记录恢复上下文。已删除的回答不会被后续快照重建，后续写入保留已同步的交互快照。
- 服务器没有浏览器技能读取器，因此在系统提示词中直接提供作品契约。Node 侧 `diagram` 校验共享 schema 和安全表达式；SVG / Mermaid 只做结构预检，回执明确完整语法、净化和渲染仍由客户端执行；不声称服务器已经渲染成功。已保存 HTML 作品进入原有隔离运行文档。
- `scripts/test-server-widgets.mjs` 覆盖实际 Node 任务执行器、三种模型协议、校验失败及重试、多作品、流式参数、保存时序、取消/断线/重启和视频/材料问答。`scripts/e2e-server-widgets.mjs` 使用实际本地 API、数据库和生产 Web 产物，仅外部模型为固定假流，覆盖云端进度、生成中刷新、静态预览、独立作品、状态恢复、原消息续写去重和课程侧栏；不消耗真实模型 tokens，也不证明真实模型一定选对工具。测试仅在主动刷新/导航前暂停旧页面的新轮询并等待已有请求完成，避免 WebKit 卸载请求时产生原生 access-control 通知；不忽略任何 access-control 错误，不修改 API 响应。

### 中断与续写

- 网络失败、SSE 错误事件、缺少完成标记的断流及 `error/aborted` 结束保留已输出正文和已保存作品；错误说明走消息元数据，不混入正文。残缺工具不执行、不进入后续自动收尾请求。
- 用户主动停止不等同于网络中断；纯正文 `length` 不自动标为可续写，带工具的 `length` 不执行该批调用，并返回明确失败回执要求重发完整参数。
- 普通聊天本机与云端续写均更新原回答，不新增空提问、不执行工具；保留断点处空格、换行和缩进。共享过滤器只剔除已证实的精确完整前缀或至少 12 字符的尾部重叠，不做语义改写或模糊去重。课程问答失败保留正文和独立提示，重试仍明确为重新生成。

## 交互与费用边界

- 调参和步骤切换只在 iframe 内重绘，不调用模型。
- `window.__wbw.widgetState` 读取快照，`setWidgetState({modelContent,privateContent})` 保存当前参数。
- 用户点击追问后出现可取消、可改写问题的确认框，以“当前情况”展示本次发送的参数，原始数据按需展开；确认前不调用聊天发送入口。
- 独立预览的追问会等待原会话接收回执；原窗口关闭或暂不能发送时明确报错，不会声称已经送达。
- 只附带 `modelContent`，并标记为不可信数据。不自动附带 `privateContent`、HTML、库源码或操作历史；普通输入消息也不自动注入组件快照。
- `privateContent` 的含义是“宿主不自动发送模型”，**不是不上服务器**，也不是秘密保险箱。生成的组件脚本能看到自己的整个快照，因此两部分都不要存秘密。用户显式导出数据时，快照可随消息一起导出。

## 持久化

快照首先写入当前浏览器 IndexedDB 的消息行。云模式安装 `installCloudCache` 后，`chats` 属于 `CLOUD_TABLES`，完整聊天记录的 before/after（含快照两部分）会进入 outbox 并由通用云同步链路上传。`saveWidgetState` 成功只确认本机事务及云模式下的 outbox 写入，**不表示服务器已经确认，也不保证另一设备此时可见**；跨设备一致性尚未做双设备实测。通过宿主分配的 widget ID、消息 ID、会话和源码绑定，iframe 不能指定要访问的记录。旧消息第一次打开时补齐实例 ID，无须数据库索引迁移。

保存只更新快照，不覆盖正文、思考或工具记录。宿主在事务提交后 ACK；失败会拒绝 Promise 并显示错误。缺少持久消息的临时组件不能声称已经保存。源码修改会更换 ID 并清空快照，避免重放不兼容状态；旧 iframe 的迟到写入、已删除消息的写入会被拒绝。分支新消息不会继承原消息快照。

刷新、虚拟列表重挂和独立预览可恢复快照；同一组件的窗口通过数据库订阅同步，整份快照以最后成功提交为准。主题变化通过消息与 CSS 变量同步，不重载 iframe。组件通过 `wbw:statechange` 恢复、通过 `wbw:themechange` 重绘 canvas；恢复事件不得触发保存。

快照只接受 JSON，两部分合计不超过 16 KiB（UTF-8），嵌套最多 16 层。宿主只提供小型控件样式，不新增任意工具调用、文件访问或宿主数据读取能力。`sandbox="allow-scripts"`、不透明源、禁外网 CSP 与本地按需内联库保持不变。

## 当前范围

### 可视化提问

`ask_user` 可附带 `presentation: {html}`，使用同一 HTML 校验、沙箱、主题与 UI kit；非法可选 HTML 被丢弃，原生问题仍可回答。结构化 question/type/options（稳定 ID）是唯一题面来源，HTML 不能改变它们。

页面从 `window.__wbw.answerInput` 读取 `{answer, submitted, question}`，监听 `wbw:answerchange`。`setAnswerDraft(answer)` 更新原生题卡的同一份草稿；`submitAnswer(answer)` 要求点击/键盘动作，并在可信宿主中展示从原问题校验得到的文案，用户再点“确认回答”后调用原 `answerAsk`，解除原工具挂起并按既有 `TurnResume` 续跑。它不是 `sendPrompt`。宿主校验来源、可见性、iframe 焦点、当前待答状态及重复请求；最终确认不依赖 iframe 对用户激活的自证。

原生输入始终可用。页面只传稳定 selectedIds 或 text/note，selectedLabels 由宿主重新计算；答案不得含宿主操作权限。取消视觉确认只回到修改，不结束问题；停止、在聊天里回复、过期和重载恢复沿用原提问状态机。已提交答案随原问题保存并回放；未提交草稿是易失的，刷新后重新填写。正式 `present_quiz` 只允许 `setAnswerDraft`，不能使用 `submitAnswer` 绕过宿主提交、判分和错题链路。

### 阅读融合

按消息/组件/源码版本的短布局提示键缓存最近 200 个高度（80–2000px，内存中，不是数据库快照）；短版本 hash 只影响布局估计，不用于授权或 React 重挂身份，后者仍使用精确源码。重挂先占位，文档 ready 后显露 iframe，主题/状态变化不重建。测量 body 和可见后代边界而不是被旧 viewport 撑住的根 scrollHeight；包含未裁切的正常流/absolute 溢出，尊重 hidden/clip/auto/scroll 裁切，排除 fixed 子树，因此内容可缩短；横向滚动条计入高度。生成内容应有正常流根节点，浮层限制在根内，不用 100vh/height:100% 制造测高反馈。

iframe 内未被可滚动控件消费的 wheel/touch/阅读键意图会暂停聊天跟随。正文选区只桥接限长文本，不访问宿主 DOM；宿主提供“引用提问”，通过既有可编辑、可取消的追问框适配聊天入口，附带宿主消息/组件身份和源码版本标记。引用来自不可信页面，不能当材料证据。源码更新会使旧桥接与未发送选区失效。

`show_widget` 返回不含源码的 `wbw-widget` 引用围栏，模型把引用原样放在正文相应位置。多个调用按 `widgets` 顺序保留，不再互相覆盖；每幅图有独立快照。只能引用当前消息自身的载荷，重复引用只展示一次；旧消息与遗漏引用的图形仍在末尾兼容显示。`widget` 保留为最后一幅图的旧客户端兼容别名，不重复渲染。

源码局部编辑通过作品菜单进入，普通 HTML 示例则通过代码栏菜单进入；编辑只失效该图的快照，保留引用位置及同消息其他图的快照。技术操作不再占据两行常驻工具栏，不依赖悬停发现。

外层透明无框，主图占据视觉中心；教学参数与设计原型调参不是同一种需求，不给模拟器自动加 Tweak 面板。字体、字号、强调色、前景、边界、表面色与控件圆角读取实际宿主表面的令牌并实时同步，独立预览保留原表面样式；不是另维护固定的深浅色板。示例图按实际宽度绘制，有数值刻度、量与单位，窄屏减少刻度而不缩字。

通用宿主设计调参面板、原型变体轮播和独立 HTML 导出未实现；这不是 ZCode 全量 API 移植。沙箱和本地内联库策略仍采用本项目更严格的离线边界，不开放原 skill 的 CDN 白名单。

## 样式边界

- 正式交互件及局部修改预览都在各自的隔离 iframe 中执行，宿主只向内同步主题令牌，不接受修改宿主 CSS 的消息。
- 正文不是另一种组件宿主。普通聊天、课程问答与 LiveLink 共用 Markdown 净化策略：移除 style/link 等标签、内联样式、class/id 和任意 data 属性；只保留公式、围栏与流式占位所需的内部字段。安全的语义 HTML 仍可阅读，已有消息源码不改写。需要样式和脚本的内容应走 show_widget，而不是混进正文。
- 流式 show_widget 参数使用去样式、去脚本的静态预览，完成校验并保存后才切换到隔离 iframe。宿主编辑面板、代码卡、图块与预览通过 `md-embedded-ui` 标明正文样式的终点，Markdown 的段落、列表、表格和代码块规则不再深入这些界面。
- 普通 HTML 代码围栏在生成中也保持代码展示，不自动变成作品。

## 验证

```sh
npx tsx scripts/test-widget-state.mjs
npx tsx scripts/test-widget.mjs
node scripts/test-ask-visual.mjs
npx tsx scripts/test-artifact-edit.mjs
npx tsc -b apps/web --pretty false
# 自建临时 API/数据库/生产预览，执行后自行关闭；不部署、不使用线上数据
npm run test:server-widgets
npm run test:server-widgets:e2e
BROWSER=webkit npx tsx scripts/e2e-server-widgets.mjs
# 先运行 npm run dev；以下使用独立浏览器上下文和假模型，不消耗真实 API tokens
node scripts/e2e-widget-state.mjs
node scripts/e2e-ask-visual.mjs
node scripts/e2e-widget-reading.mjs
node scripts/e2e-widget-layout.mjs
node scripts/e2e-widget-style-isolation.mjs
node scripts/probe-widget-sandbox.mjs
BROWSER=webkit node scripts/probe-widget-sandbox.mjs
node scripts/e2e-widget-protocol.mjs
BROWSER=webkit node scripts/e2e-widget-protocol.mjs
node scripts/e2e-code-toolbar.mjs
BROWSER=webkit node scripts/e2e-code-toolbar.mjs
# 或只跑本轮新增验证（编排器会使用正确 TS loader）
node scripts/e2e-all.mjs --only=test-widget-state,e2e-widget-state,e2e-widget-layout,e2e-widget-style-isolation
```
